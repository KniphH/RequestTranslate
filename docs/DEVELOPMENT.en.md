# RequestTranslate — Development Notes

[简体中文](DEVELOPMENT.md) · **English**

For people changing this repo. **The README explains how to use it; this explains how it's built and how it's verified.**

Zero dependencies, zero build step, MV3, loaded directly via "Load unpacked".

---

## Layout

```
manifest.json          MV3 manifest
background.js          Request forwarding, streaming push, context menus, clipboard read + OCR calls
content.js             Selection dot + Shadow DOM result panel
offscreen.html/js      Temporary offscreen document: clipboard reading only (closed right after)
popup.html/js          Toolbar popup: quick config switch + manual translate
options.html/js/css    Settings: configs, variables, OCR providers, tests
lib/
  request-parser.js    curl / raw message parsing: quotes, line continuations, comments, JSON repair
  template.js          Placeholder substitution + context-aware escaping
  extract.js           Response path extraction and auto-detection
  engine.js            Send + read response (SSE / NDJSON / JSON / plain text); readResponseBody is the only reader
  adapters.js          Built-in adapters (Bing's two-step flow); returns the same shape as engine
  trigger-styles.js    Translation-button styles and three presets (mirrored in content.js, compared by tests)
  clipboard.js         Clipboard images: MIME sniffing (incl. magic bytes) and data-URL conversion
  ocr.js               OCR provider state, the three built-ins, request bodies, text extraction, error wording
  store.js             Config storage, built-in samples, import/export, version migration
tools/
  make-icons.py        Icons from the standard library only
  pack.py              Build dist/*.zip (runs the full test suite first; --skip-test for emergencies, --no-strip keeps comments)
  strip-comments.mjs   Comment stripper used when packing (lexical, see below) + test-strip.mjs for its self-test
  verify-pack.py       Post-pack checks: syntax / line-number preservation / clean stripping (idempotent)
  check-globals.mjs    Static check: calls to functions that were never defined
  check-dom.mjs        Static check: ids/classes referenced from JS actually exist
  test-lib.mjs         Unit tests for parsing / escaping / extraction / adapters / OCR
  test-engine.mjs      Spins up a local fake API and runs end-to-end (including a fake Bing two-step flow)
  e2e-ui.mjs           Launches a real Edge with the extension loaded and runs UI regression
  perf-probe.mjs       Measures main-thread task time + sampled process CPU across four load levels
```

---

## Built-in adapter: the free Bing channel

Bing's web translator is a **two-step** flow: first GET `bing.com/translator` and regex `IG` / `IID` / `key` / `token` out of 630 KB of HTML; then POST those to `ttranslatev3`. The second step's inputs come from the first, so **this can't be expressed as a request template** — it lives in code.

- The token is cached for an hour. When it expires, Bing returns `HTTP 200` with an **empty body** (the status code alone tells you nothing), so the extension re-fetches and retries once.
- The adapter's return value must be **exactly** the same shape as `engine.runRequest` — panel / diagnostics / "…" details / error handling are all reused, no second implementation.
- The adapter only hits `cn.bing.com` twice (`/translator` + `/ttranslatev3`); there's no MET mode. So in the README's direct-rule list, the first entry (`bing.com`) is everything this extension needs; the rest are for other Bing tools in the same client.
- `www.bing.com` and `cn.bing.com` resolve to the same IP (measured: `202.89.233.101`), but the former 302s — hence the hard-coded `cn.`.

Other services that need multiple steps or dynamic tokens go through `lib/adapters.js` too. Don't add special cases to `engine.js`.

---

## Result panel: implementation notes

### Zoom compensation

The panel is `fixed` + `transform: scale(1/zoom)` with `transform-origin` at the top-left — scaling **doesn't move the top-left corner**, but width and height must be multiplied by `1/zoom`. `chrome.tabs.getZoom` gives the tab's real zoom factor.

Buttons don't use `transform`; their sizes are CSS variables (`--rt-tr-size` / `--rt-tr-radius` / `--rt-tr-font`; for the circular preset the background / icon / border colours are `--rt-tr-bg` / `--rt-tr-fg` / `--rt-tr-bd`) scaled by `1/zoom` — that way hover growth (×1.08) still works and sizes aren't baked into inline styles.

Clamping must use "layout size × 1/zoom". Comparing `offsetWidth` with `innerWidth` directly makes the panel slide off the right or bottom edge as soon as the page is zoomed.

### The body area's height cap comes from `panelMaxHeight`

In adaptive mode `.rt-out`'s cap is **not** a hard-coded `46vh`; it reads `--rt-max-h` from the panel (`applyPanelSize()` writes it from `prefs.panelMaxHeight`, in vh). Default **46** — the same value as before, so existing users see no change (`test-lib` pins that number).

vh rather than px: the point of the cap is "don't push past the viewport", so it must follow the window (px is wrong on every other screen). `0` means unlimited, implemented by **explicitly disabling** via `.rt-panel.no-max-h .rt-out { max-height: none }` — don't set the variable to `none`, because `calc(none * 1)` is invalid and kills the whole `max-height` (surprising behaviour).

The `34vh` on `.rt-diag` is a **separate** cap and doesn't follow this setting (the diagnostics area is secondary and scrolls on its own).

### Where the model name in "…" comes from

`extractModelName(requestInfo)` in `lib/engine.js` is the only source, with two **definite** inputs, in order: `model` in the request body JSON → `/models/<name>` in the URL path (Gemini-style; strip everything after `:` since that's the action). Only if neither exists does it fall back to **the response echo** (`pickDataModel(finalData)`, which many proxies include on every frame). If all fail, the string is empty and the panel **hides the row entirely** — no "unknown" placeholder taking up space.

The built-in adapter (Bing) has no editable request text (`result.request` is `null`), and `emptyResult()` leaves `model` empty too — that path is explained by the "matched path" row (`Bing ttranslatev3`). The adapter's shape must match `runRequest`, **so add fields to both**.

### Scroll containers must explicitly reset `scrollbar-color: auto`

All three scroll containers — `.rt-out` / `.rt-src` / `.rt-diag` — need `scrollbar-color: auto; scrollbar-width: auto;`.

`scrollbar-color` is an **inherited property that crosses shadow DOM**. If the host page's value isn't `auto`, the browser ignores the custom `::-webkit-scrollbar` block entirely and the panel sprouts a scrollbar in the page's colours. Writing `auto` ≠ giving up customisation, it just severs inheritance. `color-scheme` behaves the same way (it affects `<select>` light/dark). **Add it when adding a scroll container.**

Firefox needs a separate branch: it has no `::-webkit-scrollbar`, so `scrollbar-width: auto` leaves a ~17px native bar. `@supports (-moz-appearance: none) { scrollbar-width: thin; scrollbar-color: var(--rt-scroll) transparent }` narrows it to ~8px, matching Chromium's custom bar.

### Streaming render throttling

Cost is proportional to "renders × text length", so `RENDER_INTERVAL` (50 ms, ~20 fps) throttles streaming output. When chunks arrive more than 50 ms apart, each one renders immediately — identical to no throttling. It only kicks in when chunks pour in (local models, reasoning models). On completion, `done` writes the final text immediately, so no characters are lost at the tail.

**No auto-scroll while streaming** (`.rt-out` never touches `scrollTop`) — being dragged down the page makes it impossible to read from the top.

### Positioning the selection dot

**Mouse selection: stick to the mouse.** Not a single measurement of the selection geometry is used — on mouseup, place at `MOUSE_GAP` (14 physical px) down-right of the pointer; if it doesn't fit, flip the whole block up-left (still 14 px away, so the pointer is never inside the button). Selection geometry can't be trusted: across lines, the bounding box's right edge lands at the end of the **longest line**; after a double-click, on element-heavy pages, or when dragging up/down in empty space, the "corner" picked from the selection can be hundreds of pixels from the finger.

**Keyboard-extended selection: stick to the caret line** (`caretRect()`, the `focusNode` / `focusOffset` end), bottom-right. Browsers **offer no API** for "where is the mouse now" — coordinates only exist on event objects, so in practice `lastMouse` holds the **stale** position from the previous mouse action; anchoring to it points somewhere unrelated. That's why `keyup` (the Shift / arrow-key path) **clears it to null**, and `readSelection()` branches on that.

- `MOUSE_GAP` must be non-zero: a button under the pointer immediately matches `:hover`, so "mouse is over the button" stays true forever and the hide timer never fires. The "ignore hover within the first 250 ms" check in `mousemove` is a fallback for tiny viewports where clamping can't keep the gap.
- **Both timers share one event source** (`mousemove`). Don't split into `mouseenter` / `mouseleave`: when the pointer leaves the button, the browser emits `mouseleave` **immediately followed by a `mousemove`**, and that `mousemove` clears the "short hide timer" just armed — so "hide on leave" never works (measured). Use `composedPath().includes(trigger)` inside `mousemove` to decide whether the pointer is over the button.
- On show (`armTriggerIdle`), clear **both** timers: a leftover "short hide timer" from the previous round silently kills the button you just showed (hit by reselecting right after the mouse grazed the button).
- When recomputing position after a zoom change, **don't re-read the selection** (`setZoom` → `placePanel(lastAnchor)`): re-reading returns the mouse position and the panel jumps there. Also note: **tab zoom changes the viewport size only; element CSS coordinates don't move** (`window.innerWidth` 1170 → 780, same character still at x = 104), so the anchor can be reused as-is without scaling.
- Copy rects with `copyRect()`, **not `{ ...rect }`**: `DOMRect` keeps `left/top/right/bottom` on the prototype, so spreading yields only `x/y/width/height`.

### Selection: where the selection survives

`readSelection()` has a counter-intuitive trap: **geometry can be lost while the text is still there.** So the criterion must hang on text, not geometry.

- **Shadow DOM (Web Components)**: a selection inside a shadow root gets **retargeted** to the document level — `isCollapsed` becomes `true`, `range.getBoundingClientRect()` is all zeros, `getClientRects()` is empty, and **only `toString()` still returns the text**. Bilibili's comment section (`<bili-comments>`) and its comment box behave this way; the symptom is "selecting a video title shows the button, selecting a comment doesn't". Current handling: an empty string is the only "nothing selected" signal; when all geometry is zero, fall back to **the mouseup position** (`pointRect`, the same shape the context-menu path uses, and `placePanel` already accepts it).
- **`<input>` / `<textarea>`**: `window.getSelection()` returns the text, but geometry is all zeros and `anchorNode` becomes `BODY` — meaning `isEditable()` **doesn't recognise them** (it only really blocks `contenteditable` in normal DOM). These also take the "fall back to mouse position" path.
- **`contenteditable` in normal DOM** (Zhihu / Weibo-style editors): text and geometry are both fine and `anchorNode` is a text node, but it's **still deliberately excluded** by `isEditable()` — selecting text there usually means you're about to edit it, and a button only gets in the way.

**Script-built selections don't reproduce real behaviour**: `document.createRange()` + `selection.addRange()` holds shadow-internal nodes itself, so the browser doesn't retarget and geometry looks fine. Reproducing the symptom **requires a real mouse drag** (`page.mouse`); otherwise the precondition never holds — that's how e2e section 1.5 is written.

### Config dropdown caching rules

Each config keeps its own result (`resultCache`, keyed by configId, storing `{r, ocr, action, fatal}`):

- **Already translated**: switching back restores it as-is (lamp and diagnostics included), **without sending anything**
- **Never translated**: translate on the spot — don't just clear and wait for the user to hit ↻
- "↻" = **resend the same request**
- Invalidation is **data-driven**: `translate` compares `cacheKey` (source text; for direct image mode "length + last 64 chars") and calls `resultCache.clear()` when it changes
- Archiving uses `pendingConfigId` (the one at send time); when `pendingConfigId !== currentConfigId`, `start` / `delta` must be dropped

All rendering funnels through `renderResult(r, ocr, action, fatal)`.

### The header config dropdown has two modes

The panel's header dropdown doesn't always list every config:

| What this screen is doing | List | Selected |
|---|---|---|
| Selection / text recognised by OCR | all of `state.configs` | `currentConfigId` (panel-local, **not persisted**) |
| **Direct image** (screenshot with "Disable external OCR") | only image-capable configs (`canTranslateImage` = non-empty image request template) | `imageConfigId`, i.e. **`state.ocr.imageConfigId` in storage** |

- The mode follows **this translation**: as soon as `translate()` computes `hasImage`, it switches `cfgMode` and redraws the dropdown **before picking a config** — the other order sends with the previous screen's config.
- `shownConfigId()` answers "which config is this screen using"; all cache and status-lamp guards use it (they used to read `currentConfigId` directly).
- **The two modes remember selections separately**: translating an image must not change "which config for text". But changing the dropdown on the image screen **must be written to storage** (`saveImageConfigId`) — the background only reads `state.ocr.imageConfigId`, so not writing it back makes the switch appear to do nothing. Same trap as changing the target language: **`await` the write, then send**.
- Callers **must not pass the dropdown's current value to `translate()`** (`cfgSelect.value` may belong to the previous screen) — pass `''` and let `translate` read it after switching modes.
- If no config can translate images, it falls back to the full list and the `title` says where to fill it in, because the background likewise falls back to the header config — the dropdown must show the truth.

The header language dropdown follows the same rules, plus it hangs off `applyState` (`prevLang !== prefs.targetLang` → clear), so changing the language in Settings invalidates too. **A language change must `await saveSetting('targetLang', v)` before sending** — the background calls `loadState()` and reads storage to render `{{target}}`, so an unflushed write sends this request in the previous language.

---

## Translation button (`lib/trigger-styles.js`)

- Presets are all compiled to `.rt-trigger:where(.s-xxx)` (`:where()` contributes zero specificity), so later overrides via plain `.rt-trigger { … }` win without `!important`.
- The `custom` preset carries `bare: true`; its CSS **explicitly zeroes** `background / border / box-shadow` and sets `.rt-ico { padding: 0 }` (explicitly clearing, not omitting).
- `custom` **deliberately has no `svg` field** — the settings card shows the icon you'll actually use, and stays empty if you didn't supply one; the preview and the on-page button fall back to `TRIGGER_SVG_SAMPLE` (three lines + arrow). **Removing the field affects the preview**; before touching this data shape, enumerate everything that depends on the fallback.
- Old archives may contain `nib`, which must be normalised: `loadState` maps anything unrecognised to `DEFAULT` and sets `migrated = true` to write back. **This doesn't bump `STORAGE_VERSION`** (no new field, no changed default), so archives already at the latest version still go through it.

**Why SVG is rejected wholesale rather than sanitised**: a content script can touch `chrome.*`, so letting executable markup in is too expensive; and "strip the dangerous parts" leaks — case variations, the `xlink:` namespace, `<use>` referencing external symbols… one miss and the guard is worthless. The rules live in `SVG_GUARDS` (shape requirements + reject-on-match, with `negate` carrying the meaning).

**Content scripts can't `import`** → CSS / preset SVGs / `SVG_GUARDS` are mirrored in `content.js` and must be covered by byte-for-byte comparisons (`test-lib.mjs` section 17 reads `content.js` with `fs`). **Trap**: the comparison uses the **raw file text**, so SVGs containing newlines must be written as **template literals** (`'\n'` in raw text means "backslash + n", and whitespace squashing won't match either).

---

## OCR implementation notes

- **OCR providers are editable request templates too** (v7, same pipeline as configs): `fillOcrTemplate` fills `{{image}}` / `{{imageBase64}}` / `{{imageUrlEncoded}}` → `parseRequest` → fetch → `extractContent(json, responsePath, '\n')`. The prompt is **not a placeholder** — it's written directly into the template text. Only when `request` is empty does the old field path run as a fallback (`buildOcrBody`, kept purely for odd archives).
- **The prompt wording is not free-form**: DeepSeek-OCR only recognises the fixed presets it was trained on; the official one is the `<image>` marker + newline + `Free OCR.`. **Changing the wording (even a Chinese sentence with identical meaning) pushes it out of the training distribution and degrades output** — measured: it starts emitting `<table>` markup and recognition accuracy drops. That's why the built-in template's sentence is fixed, and `test-lib` pins that literal.
  - **It takes two levels of escaping** to land in the template: inside a JS template literal you write `\\n` (two backslashes) so the generated template text contains a literal `\n`, which `JSON.parse` then turns into a real newline. **One backslash short = raw newline → JSON parsing fails outright.** The old field path's `DEFAULT_OCR_PROMPT` is the opposite: there the value is real (a JS `\n` is a newline) and `JSON.stringify` escapes it.
- **`buildOcrRequest()` (internal) + `previewOcrRequest()` (masking layer) are the single assembly point**; `runOcr` sends the same thing the Settings preview shows. Presentation masking always goes through `maskRequest` (URL / headers / body, by variable names containing key — see "Storage"), and real requests must never be sent from the masked copy. `.preview` must be `flex: none`.
- **Response reading also has exactly one place: `readResponseBody()` in `lib/engine.js`** — monolithic JSON / SSE with `Content-Type: event-stream` / NDJSON / plain text, four-way inference plus cross-chunk reassembly, all in there; `runRequest` (translation) and both Settings tests (`runOcr` / `runImageTranslate`) call it. The OCR tests used to do `JSON.parse(await res.text())` themselves and broke on real endpoints whose **image template carries `"stream": true`** (Ling returns SSE): the panel translated fine through the engine while the Settings "Test" reported "not JSON". It returns plain data (`mode` / `text` / `raw` / `finalData` / `aborted` / `error` / a few stats) and **doesn't throw** on mid-transfer AbortError — "stopped manually, here's what arrived" is the engine's own wording, which OCR doesn't need. OCR decides "this wasn't JSON at all" via `mode === 'text'` (or `mode === 'json'` with no parsed object); it passes `joiner: '\n'` because Baidu's `words_result` is a line array. **Any change here requires a full `test-engine` run plus the two SSE cases in `test-lib`.**
- **Lossless migration from old fields to templates** happens in one place (`normalizeOcrProvider` → `ocrProviderToTemplate`): the rendered result is byte-identical to the old `buildOcrBody` (key order model→messages→max_tokens?→temperature; `{{image}}` lands inside shell single quotes + JSON double quotes, and the data-URL escaping is an identity at both levels). **Old-shaped archives (no `request` field) take precedence**, otherwise the built-in template's `{{apiKey}}` would override the real key the user stored in a field.
- **Baidu OCR is the immediate payoff of templating**: token in the URL query, `x-www-form-urlencoded` body, `words_result` line array — this used to need an adapter, now it's just a template (`builtin-baidu-ocr`). `extractContent`'s auto-detection learned `words_result`. The template's form body carries `language_type=auto_detect`: **omit it and Baidu assumes `CHN_ENG` (Chinese/English mixed), so Japanese kana get read as Chinese** (reported by the maintainer after real testing) — Baidu has no OpenAI-style automatic detection. With it you can pin one language (`JAP` / `KOR` / `DUT` …).
- **The clipboard can only be read from an offscreen document**: a content script can't (no focus, no permission), so a temporary `offscreen.html` is opened and closed right after (to save memory) — not persistent.
- **Don't guess `blob.type`**: the entry produced by the Windows Snipping Tool may have an **empty** type, which would build `data:;base64,…` and be rejected by the endpoint. Sniff the MIME from **magic bytes** instead (PNG / JPEG / GIF / BMP / WEBP).
- **Large base64 must be converted in chunks**: a few hundred KB through one `String.fromCharCode.apply` blows the call stack.
- **The OCR column and the config column share one UI skeleton** (maintainer request, 2026-10-14: "carry the config column's improvements over to OCR"): the request template is the same `details.preview.tpl-fold` (same skeleton, same CSS, same collapse gesture; placeholder chips live in `.fold-body` as its first child), **OCR providers get "main + fallbacks" too** (`#btn-ocr-add-fallback` + `normalizeOcrItem`; the chain model is shared via `lib/requests.js`; `runOcr` tries them in order and reports `from` = "Fallback N"), and test results use the config column's `resultBlockHtml` (collapsed when no text was recognised, header carries the reason).
  - ⚠️ **Direct-image mode (`#ocr-editor.is-imgcfg`) needs `#ocr-blocks` / `#btn-ocr-add-fallback` added to its hide list** — that hiding walks `#editor`'s **direct children one by one**, and after replacing `.field` with a group of request blocks they're no longer in the list; the symptom is "mode changed but the old stuff is still there" (first recorded 2026-10-09).
  - ⚠️ **Don't test "is this `<details>` collapsed" with `offsetParent`**: on this Edge a collapsed `<details>` still has a non-null `offsetParent` (content is hidden via `content-visibility`), so e2e must measure **geometry** (height shrinks to the title row).
- **Area selection = frame directly over the page; the bitmap is only cropped at mouseup** — the overlay **does not lay down a screenshot** (early versions did; see below), just a dimmed cut-out (`.sel` with `box-shadow: 0 0 0 100000px rgba(0,0,0,.45)`) plus a hint bar. The page sits underneath, fully visible, so the user is framing the page, not a screenshot. Upside: **you can scroll and page through while framing** (the crop always targets whatever is on screen at mouseup). Downside: dynamic content (video, carousels) moves during the drag — same as OS screenshot tools (explicitly accepted).
  - **"Dimming" and "receiving pointer events" must be two layers** (`.veil` in `content.js`): the cut-out layer needs `pointer-events: none` (otherwise it blocks the page and you can't scroll), and `box-shadow` **isn't part of hit testing** — with only that layer, **a human can't drag to select at all** (reported as "nothing happens no matter how I click"; script-dispatched events pass, so e2e stays green while the bug ships). Hence a separate `.veil` layer (`position: fixed; inset: 0`, transparent, `cursor: crosshair`) that takes the pointer.
  - **Attach events to `hostEl`, not the shadow root**: a shadow root **isn't an event target**; listeners there only fire when the event bubbles up from a **hit-testable** element inside. `hostEl` is hit-testable and keeps events even when a drag starts inside the mask and ends outside it; combined with `hostEl.setPointerCapture(e.pointerId)` it also gets `pointerup` outside the window.
  - **Testing this class of bug requires a real mouse**: `shotDrag`'s `dispatchEvent` bypasses hit testing and can't detect "the overlay never receives the mouse". Two e2e cases cover it: `document.elementFromPoint(x, y)` must point back to the mask, and a Playwright **real mouse** `mouse.down/move/up` drag must dismiss the overlay and actually send a request.
  - **Why it must be "capture the whole screen, then crop"**: `chrome.tabs.captureVisibleTab` **has no region parameter** — it captures the entire visible area. `getDisplayMedia` / `chrome.tabCapture` need a permission prompt and return a stream; redrawing the DOM loses images / canvas / cross-origin iframes. OS `Win+Shift+S` has the same constraint.
  - **The coordinate mismatch (bitmap includes the scrollbar, drag coordinates don't)**: the `captureVisibleTab` bitmap is `innerWidth × innerHeight × dpr` (**including the page's own scrollbar**), while drag coordinates are measured in the **content area** (`documentElement.clientWidth`, scrollbar excluded). The difference is exactly that strip (measured: `innerW 1178 / clientW 1163` → bitmap `1767×1214`). The correction happens **once, in `cropShot()`**: first trim the right/bottom strip using `cutX/cutY = Math.round((inner − client) × dpr)`, then scale against "bitmap − strip" (`kx = srcW / viewW`, `ky = srcH / viewH`, clamped inside the bitmap). **With no scrollbar both are 0**, i.e. a no-op (`test-lib` section 23 pins this invariant).
  - **`cropShot()` is async (returns a Promise)**: the overlay is torn down **before** cropping, so the user can keep paging while the image goes to OCR. `new Image()` load failures and canvas cross-origin errors both `resolve(null)`, which the caller turns into `ocr-error` instead of throwing.
  - **Old design (deleted — don't revive it)**: early versions captured the screen first, laid the bitmap into the overlay, and let the user crop against it. Two defects: ① the bitmap was stretched with `width:100%; height:100%` over the content area, so a bitmap containing the scrollbar got squashed (~1.3% horizontally) and the scrollbar showed up inside the frame — **looks like "a strip leaked in"**; ② source rectangles were computed in bitmap coordinates, so the whole image shifted and `drawImage` scaled it → **the picture jumps** (reported). The old patch trimmed the strip off the overlay bitmap; scheme A removes the bitmap entirely, which kills both defects at the root.
  - **The test must create a real scrollbar in a headed window** (`documentElement.style.overflowY = 'scroll'`, classic scrollbar taking layout space): content scripts run in an **isolated world**, so faking `window.innerWidth` on the page is invisible to them and can't reproduce "bitmap wider than content area". Only one hard assertion: **framing the full screen yields a crop as wide as the content area**, and the width difference between "no scrollbar" and "with scrollbar" equals the scrollbar width. Sizes are read from the PNG header of the body **received by the fake OCR endpoint** — `canvas.toDataURL` can't be hooked from a content script.
- **"The mechanism failed" and "there is no image" are reported separately**: an unreadable clipboard (permission denied) never masquerades as "no image in the clipboard".
- **In direct-image mode, "which config translates images" is selected independently**: after ticking "Disable external OCR", the OCR column's left list becomes "Image configs" — a **filtered view** of `state.configs` (single criterion: `canTranslateImage`, i.e. a non-empty image request template), with the selection stored in `state.ocr.imageConfigId`, independent of the header's `activeConfigId`. **It is not a second set of config data** — create/edit/delete happen only in the "Configs" column ("＋ New config" is hidden in direct mode). So you don't have to switch the header config to a vision-capable one before translating an image, and images can't be sent to text-only endpoints. A wrong pick can't blow up: `background.js` uses `pickRequestConfig()`, and if the target's `imageRequest` is empty (or the id is gone) it falls back to the header config. The left-column switch funnels through `renderOcrDisabled()` (the `#ocr-editor.is-imgcfg` CSS hides the provider fields on the right, leaving one explanatory line).
- **The same list is reachable from the panel header**: on the image screen the header dropdown lists these configs (`ready` messages carry an `img` flag per config) and selects `state.ocr.imageConfigId` — changing it there equals changing the selection in Settings, so it must be written back (see "two modes" above). The criterion lives in `canTranslateImage` (`lib/store.js`); `content.js`'s `imageCapable()` is a mirror (content scripts can't import; `test-lib` pins the shape).
- **In direct mode, the OCR column's "Test" and "Request preview" switch targets**: instead of testing the OCR provider, they test the selected **image config's image request template** (`runImageTranslate`, sharing `buildOcrRequest`'s image placeholder assembly; only the wording says "translation"). Rationale: with the box ticked there was previously no way to test this path at all — you had to right-click a screenshot to find out whether it was configured. Implementation is **the same UI block** (`#o-test-field` / `.preview` stay visible under `.is-imgcfg`, other `.field`s hide), just different labels / hints / data source; the CSS rule `> .field:not(#o-test-field)` exists to let it through. **All three switches must refresh it**: toggling the box, switching back to the OCR tab, and picking another item in the left list (the latter two also collapse the previous test result — it no longer belongs to this one).
  - The "dim unused fields" `.is-off` rule **was deleted**: it shared the same toggle as `.is-imgcfg`, and provider fields are already `display: none` for the whole column, so dimming only hit the "Test" and preview blocks — which **are still in use** at that point, looking disabled but responding. `e2e-ui` pins `getComputedStyle().opacity === 1` in both modes.
- **`↻` resends "the image from last time"**: when the capture step itself failed (including direct mode), `currentText` is still empty and retry goes through `content.js`'s `retryShot()`. In direct mode content keeps the image itself (`lastOcr.image`, see `translate`) and resends locally; on the two OCR paths (clipboard / area) the image never entered the page, so it sends `{type:'ocr', reuse:true}` and lets the background reuse **the one actually used last time** (the port-scoped `lastShot` in `background.js`) instead of re-reading the clipboard. The old implementation sent `{type:'ocr'}` with no image, forcing the background to read the clipboard — if the user had copied something else by then, retry sent a completely unrelated image (reported). `lastShot` is only written when an image was really obtained (failed attempts don't count); after MV3's SW is reclaimed or the port is rebuilt it's empty and the clipboard is read again. Both paths are pinned by `test-lib` section 27 and `e2e-ui` section 10 (**swap the clipboard for another image before retrying**, then assert the original one was sent).
- **The direct-mode source area shows the screenshot itself** (`renderSrcImage`): the source *is* the image, so pasting text makes no sense. On the OCR path the source is the recognised text and text is pasted as usual — hence `renderSrcImage` has **exactly one call site** (`test-lib` pins it). Page CSP may block `data:` images: on `img` `error`, drop the image and keep only the explanatory line ("no external OCR was run") — that line must survive, it's the only thing explaining why the source is an image. Images cap at 11em; `.rt-src.has-img` raises the container's 6em cap to 14em, otherwise image + line don't fit.

---

## Storage and migration (`lib/store.js`)

- Placeholder escaping looks at **how many quote layers it sits inside** and escapes per layer, inside-out (`quoteStackAt` / `escapeInContext`) — **not** at "what characters are adjacent". Companion: `tokenize` recognises `\'` in normal state. **Any change here requires `test-lib` section 21 plus the e2e "OCR text with an apostrophe" case.**
- **`{{targetCode}}` can be remapped per config** (endpoints differ: DeepL wants `ZH-HANS`, Google `zh-CN`, Baidu `zh`): write a `#@lang` block in the request text — `#@lang` on its own line, followed by `# key = value` lines, **terminated by a blank line**; keys accept language names or codes, case-insensitive; misses fall back to the built-in `TARGET_LANG_CODES`, so **you never have to copy the whole table** (the DeepL preset demonstrates only 4 lines).
  - **The whole block must be consumed in `renderTemplate` and never reach the output** — raw-HTTP style treats "everything after the blank line" as the body (`parseRawHttp` in `request-parser.js`), so a trailing declaration block would be **swallowed into the body** (only `repairJsonBody` rescuing `#` lines on JSON parse failure, which you can't rely on). Once stripped, its position is free, so keeping it at the end as an appendix is safe. Stripping at render time has a useful side effect: the Settings preview shows exactly what gets sent.
  - **`TARGET_LANG_CODES` can't be deleted**: its identity is "**used by the Bing adapter + as the fallback**". Bing configs have an empty `request`, and `runRequest` ignores `requestText` when an adapter is present (`engine.js`); the adapter only receives `vars` (language names only) — **there is no request text to put `#@lang` in**. Configs without a table also rely on it, otherwise `{{targetCode}}` would become an empty string (`missing` is only recorded when "key not in table", so injecting an empty string is a silent failure). The README's "Writing a config" section has the full table to copy.
- A config carries two templates: `config.request` for text, `config.imageRequest` for images. Which one to use is decided **only** by `requestTemplateFor(item, context)` — don't re-decide elsewhere. `{{imagePart}}` is the alternative for "one template, two uses": it must be bare and last. **The parameter is a "request item", not a config** — main and fallbacks share the same shape (see below).
- Picking **which config** is decided **only** by `pickRequestConfig(state, configId, hasImage)` (right after `requestTemplateFor`): text uses the passed id or the stored `activeConfigId`; images prefer `state.ocr.imageConfigId` when "Disable external OCR" is ticked, **and only reroute if that one can translate images** (`canTranslateImage`), otherwise fall back. `background.js` has exactly one entry point (its imports no longer include `getConfig`). Unit tests in `test-lib` section 15d.
- **Fallback requests** (several requests per config; the main one failing moves down the list): the main request's fields stay at the config's **top level** (`adapter` / `request` / `imageRequest` / `path` / `responseMode`), fallbacks live in `config.fallbacks[]`, each a **complete request** (its own `id` / `enabled` + the same named fields, **no `name`**), plus `config.mainEnabled` (default true). **Old archives without these fields behave identically, byte for byte.**
  - Three exit points in `lib/store.js`: `mainRequest(config)` wraps the top-level fields into an item **shaped like a fallback** (`main: true`); `allRequests(config)` returns "main + all fallbacks, checked or not" (Settings draws blocks from it); `requestChain(config)` returns only **checked** ones; **if nothing is checked it falls back to the main request** — a config that exists but sends nothing is a dead state nobody can read.
  - **Fallbacks have no name field**: their name comes from **position in the chain**, computed in `allRequests` as `Fallback ${i + 1}` (so reordering renumbers). Letting users rename would require handling duplicates and empties, and the name only shows in the status line and block headers — changing it has no value (decided 2026-10-13).
  - **`enabled !== false`, not `!!enabled`**: a missing field means checked. `normalizeRequestItem` / `allRequests` / the `imageCapable` mirror in `content.js` must agree — this semantic drift was caught by a shape test that **extracts the function and runs it**, not by comparing source literals.
  - Two nested loops: outer `requestChain`, inner "rotate the model variable's lines" (`modelVarFor` + `splitVarValues`). **The success criterion remains a single `if (result && result.text) break;`** — after the inner break, check once more and break the outer. Both loops running one round each = old behaviour.
  - Status line: the main request reports only the model (as before); switching to a fallback adds its name (the `Fallback N` computed by `allRequests`) — `bits = [item.main ? '' : item.name, model].filter(Boolean).join(' · ')`, empty if nothing can be joined.
  - `canTranslateImage(config)` = **any entry in the chain** has a non-empty `imageRequest`. Three consumers share it: the Settings "Image configs" list, the panel header's image-mode dropdown, and `pickRequestConfig`'s eligibility test (`content.js` has a mirror of the same line).
  - Settings puts templates into `#req-blocks`; one `blockHtml()` template renders main and fallbacks (request template → image template → response format → response path, see below). Collapse state `blockFold` (`Map`) is **in memory only, never persisted**, and **anything unrecorded starts collapsed (main request included)** — you land on a tidy column of headers and the page is much shorter. The enable checkbox is `.rb-enable`; fallbacks also get ↑↓×.
  - The "Image configs" line always goes through the chain: criterion `canTranslateImage`, template from `imageItem(c)` in `options.js` (**the first** entry in the chain with an image template, possibly a fallback), and `runImageTranslate` receives that same item (reading `imageRequest` / `path`). **Don't read `c.responsePath` again** — configs have no such field (the top-level path is `path`; `responsePath` belongs to OCR providers), and that read was always `undefined`.
  - Real-world rotation is proven by `e2e-ui` section 7's chain case: the main request points at `/chainfail` (always 500), checked fallbacks really fire, unchecked ones never do, order is main-then-fallbacks; with nothing checked it falls back to main. `test-lib` sections 15e / 15f pin the data shape and the Settings wiring. **The block header geometry in Settings (no overflow, ▾ × clickable with a real mouse, collapses and deletes) is pinned by the real-browser assertions at the end of `e2e-ui` section 7** — they measure `scrollWidth - offsetWidth` and `elementFromPoint`, not "is a handler bound" (bound-but-unclickable is exactly the shape of the two reported bugs).
  - **The two templates (text / image) render through one function**: `templateFieldHtml()` in `options.js`, skeleton `details.preview.tpl-fold > summary + .fold-body > textarea + .hint`. Previously two completely different implementations (`.field` + `<label>` + bare textarea vs `details` + `.fold-body`), each with its own font size, hint spacing and textarea minimum height (300 vs 150) — "two entirely different layouts when one code path would do". Only four parameters: class attribute string, title, default open state, and `hidden` for adapter entries. **Class names are passed as a whole attribute string** (`'class="preview tpl-fold rb-only-request"'`), **not interpolated**: `check-dom` collects class names from `class="…"` literals and can't see interpolated ones (same trap as `renderBlocks`).
  - **Collapse gesture unified site-wide: click that entry's header bar.** Request blocks collapse from `.rb-head` (the ▾ in the corner is downgraded to an **indicator**; clicking it bubbles along the same path and no longer has its own toggle branch); the template section, preview block and test-result block use native `<details>`. This resolves "some places respond at the top, others in the corner". Controls inside the header must be let through: `.rb-on` (checkbox) and `.rb-mini` (↑↓×) don't collapse — criterion `!e.target.closest('.rb-on, .rb-mini')`.
  - Before inserting a chip into a template box (`insertAtCursor`), **expand that template's fold block**: inside a collapsed `<details>`, `selectionStart` is always 0 and `focus()` is a no-op, so text gets inserted at the very front and stays invisible (same trap as "clicking a chip while collapsed", one fold deeper).
- **New config-level fields** get defaults via `normalizeConfig` — **no migration needed**; brand-new archives use `freshConfigs()`.
- **Adding a new built-in config** is what requires `STORAGE_VERSION + 1` and a migration (v3→v4 added `builtin-deepl`, inserted after the built-in DeepSeek, appending if the anchor is missing; user-defined ordering is never touched).
- **Changing an existing built-in's default** only needs migration while "the field still exists on its own". Since v7 OCR providers are fully templated and old-field conversion lives in the single source `normalizeOcrProvider`, so v4→v5's "compare old default verbatim, then reposition" field surgery is gone — existing PaddleOCR users are converted to a template as-is rather than being forced onto a new model.
- **v7→v8 was the first default-template change after templating** (SiliconFlow gained the `<image>\n` prompt prefix; Baidu gained `language_type=auto_detect`). The criterion is still "still equals the old default verbatim": the two old templates in `lib/store.js` are **frozen literals** (they can't be derived from `OCR_PROVIDERS`, which already changed). **You can't `delete` the field the way `configs` does** — with `request` gone, `normalizeOcrState` treats it as the "old shape", runs `ocrProviderToTemplate`, and rebuilds a junk template from an empty endpoint; write the new default explicitly. Users who pinned `language_type=JAP` themselves must not be touched at all.
- New settings just merge `{...defaults, ...stored}` — no migration. But **changing an existing field's default** does need one. **Changing an existing field's type/shape** (e.g. `ocrHintHidden` boolean → `hiddenHints` array) is **not** a migration either: map it once when reading in `loadState` / `importState` (see `normalizeHiddenHints` in `store.js`) — and `delete` the old key rather than leaving debris in storage.
- **Export / import**: the three meta fields `kind` / `version` / `exportedAt` must come **after** `...state` — reversed, an old `exportedAt` from the file overrides the newly written one (`version` is the **file format** version, not `STORAGE_VERSION`). In `options.js`, destructure `exportedAt` out of `importState`'s result rather than spreading it into state.
- **API keys surface in three places**: the Variables column's values (**masked by default only when the name contains key**; click the eye to reveal), config / OCR request previews and test results (`maskRequest` in `lib/engine.js`), and **the request template text itself** (an editable block where hard-coded keys can't be masked — the user can only be warned). Variables masking uses `-webkit-text-security: disc`, **not `<input type="password">`** — the latter triggers password-manager save prompts and Edge's own reveal eye, duplicating our button. Note this is **shoulder-surfing protection, not encryption**: values are still plaintext and still present in exported files.
- **Each variable takes two lines: name, then value** (`.var-row` > two `.var-line` + `.var-k` labels in `renderVars`; maintainer, 2026-10-14: "a column of custom variables is just too cramped"). It used to be a table (name | value | eye ✕): auto layout squeezed the name column to roughly 100px (`SILICONFLOW_CN_API_KEY`-style 21-character names were cut on sight) and left roughly 400px for the value — which is the only column that grows (multi-line model lists, long keys, prompts). Now the name box is a fixed `260px` (fits long names), the value owns the whole line (602px measured), the eye sits next to the value it controls, and `✕` is tucked at the end. **The built-in read-only table is unchanged** (`.vars.builtin`, 170px name column).
  - Values are still `textarea`s grown by JS from `scrollHeight` (`growTextarea` / `growVarValues` only look at `[data-kind="value"]` inside `#vars-body`, regardless of `tr` vs `div`).
- **Masking follows variables, not field names** (decided 2026-10-13): the criterion is "the variable name contains key" (case-insensitive, `isSecretVar`), and **every occurrence** of those values is replaced — URL query strings (`?key=…`), any header, the body, all at once. The old implementation only recognised the `Authorization` header, leaving keys in URLs in plain sight (exactly how `...streamGenerateContent?alt=sse&key=AQ.Ab8RN6..` leaked). Three details:
  - **Two passes: value replacement, then header fallback**: first scan values by variable, then handle `Authorization` once more (for hard-coded keys that never went through a variable). Before the second pass it checks for a `…(hidden)` marker so **already-masked text isn't masked again** — otherwise you get stacked suffixes.
  - **Very short values aren't replaced** (under 4 characters): a 2-character "secret" would paint over every matching fragment in the preview and make it unreadable.
  - **Empty values replace nothing**: an unfilled `{{apiKey}}` leaves the URL as-is; `Authorization: Bearer ` becomes `Bearer (not set yet)` — the prefix is normalised to a single space (parsed header values are already trimmed, so naive concatenation would drop it).
  - `maskRequest(req, vars)` returns a **new object** and never mutates the input: the real request is `parseRequest`'s result, and the two must never share a reference.
- **A multi-line model variable = retry with another model** (one value per line). Values split by **line** (`splitVarValues`: one per line, blanks dropped, ends trimmed but inner spaces kept — model ids may contain `/` and spaces). A single line is an ordinary value with **no new behaviour** and zero migration; if the variable isn't found, callers don't enable rotation at all.
  - **"Which variable drives the model" = the placeholder used in this request's template whose name contains `model`** (case-insensitive: `model` / `MODEL` / `Model` / `GEMINI_MODEL` / `model_name` all count — `modelVarFor(template, vars)` in `lib/template.js`). It used to accept only the **hard-coded name** `model`, so `{{GEMINI_MODEL}}` ended up with the whole multi-line value shoved into the URL and the user wondering why rotation did nothing (reported).
    - **Look at the template, not the variables table**: variables are **global** (one table shared by all configs), so a user can keep both `GEMINI_MODEL` and `DEEPSEEK_MODEL`; scanning the table can't tell which one to rotate. The template always can. With several model-ish placeholders, take the **first**; if a placeholder is referenced but missing from the table, it **doesn't count** (a typo shouldn't conjure a retry round).
  - ⚠️ **Overrides must use the matched key name**: `background.js` does `{ ...vars, [mkey]: model }`, **not** `{ ...vars, model }` — hard-coding `model` leaves `{{GEMINI_MODEL}}` untouched and looks like "rotation doesn't work" (same report as above). Candidates are therefore computed **inside the chain loop** (each fallback may have a different template), not hoisted.
  - **Every render boundary must run `firstModelVars(template, vars)`** (`runRequest` / `previewRequest` in engine, `buildOcrRequest` in OCR): one request uses one model. Miss it and the whole multi-line value is **inserted verbatim**, putting four model ids in the URL and making the request unsendable. The collapse lives at render boundaries rather than in Settings because Settings is only one of many entry points (the OCR path used to miss it).
  - **The rotation loop lives in `background.js`'s translate branch, never in `lib/engine.js`'s `runRequest`**: `runRequest` is "one call = one request" and its result is shared by the panel, diagnostics and Settings tests; making it loop internally would scramble streaming `onDelta` plus the semantics of `result.model` / `ttfbMs`. The background calls `runRequest` once per candidate with a single value, so `firstModelVars` is a no-op there.
  - **One success criterion only**: `if (result && result.text) break;`. HTTP errors, empty results and parse failures all leave `text` empty and naturally fall through to "try the next".
  - **"Cancelled" (abort) must exit the loop immediately**: it comes from "the background aborted the previous translate upon receiving a new one" (config switch or retrigger), not from a user stop (**this extension has no stop button**). Treating it as a failure and trying the next model just wastes extra requests (and the result would be discarded by `if (mySeq !== seq)` anyway).
  - Status line: each time a model starts, `statusText` (like `(Qwen3-32B)`) rides along with `start`; **if no model name can be built it's an empty string** and the status reverts to plain "Translating…". The panel doesn't track "which attempt".
  - The Settings "Send" test **runs the whole chain in order under the same rules as the panel**: iterate `requestChain(cfg)`, and inside each request rotate models (which variable drives it comes from the template, see above), stopping at the first translation. It used to send **only the first** model — if that one happened to be down, everything went red and the user concluded "this config is broken" while the panel rotated fine (reported 2026-10-14).
    - Implementation first computes `plan[i] = { item, requestText, mkey, attempts }` via `chain.map()` **outside the loop** — the badge's "total attempts" and the real number of sends must be the same number.
    - The badge **doesn't say "tries N in order"** (read as "all N will be sent" — reported ambiguity). **Without rotation** (`total === chain.length`) the wording is unchanged: "N requests in the chain" + "got a translation at #i, the remaining N didn't run" / "none of the N returned a translation". **With rotation** the unit becomes **sends** (one request may be sent several times; mixing units misreads): "models tried one by one, up to N sends" + "got a translation on request #i, model #j; N sends left".
    - With rotation, each result block header carries a model badge (`opts.model` in `testItemHtml`) — several blocks look identical without it.
    - **Blocks with no translation start collapsed** (`<details class="test-fold">`, criterion `!r.text`): a test may try several models and fully expanded that's several screens of "error + full request body + raw response" (reported as "a wall of text appears after testing"). The block that succeeded stays open — that's the one to read. Its header line uses `shortError()` to explain why: error bodies are usually `HTTP 503` followed by JSON, and truncating the first characters shows only `{`, so parse it as JSON first and take `error.message`, falling back to squashed whitespace only if that fails.
    - The config preview shows one model at a time (one request = one model) and notes "the `model` variable has N candidates, the first is shown above" — otherwise seeing only the first in the URL looks like the extension ignores the rest.

---

## Settings right column: a column of request blocks

The config column's right side is a `#req-blocks` container plus **one template** rendering several blocks: the first is the main request (the config's top-level fields), followed by fallbacks. `blockHtml(item, idx, lastIdx)` draws one block (**field order: the two templates adjacent, the two "response" fields adjacent at the end** — the response pair governs everything coming back and is shared by both templates, so sandwiching it between templates reads as "only applies to the one above", reported 2026-10-14); `renderBlocks(cfg)` draws the whole batch from `allRequests(cfg)`; `readBlock()` / `collectEditor()` write back in DOM order (first block → config top level, the rest → their own fallback). **Main and fallbacks share one shape**, so one template and one set of rules for the two templates.

- **The block no longer has a "type" dropdown** (`Custom request / Built-in adapter`, removed 2026-10-13): there's exactly one adapter (`bing`), only the built-in preset `builtin-bing` uses it, and every user-created config is a custom request — a two-way choice with one non-default value doesn't deserve a row. The type is now **read from the data**: a non-empty `data-adapter` on `.req-block` means the built-in channel (`isAdapter` in `blockHtml`), empty or absent means a request template. `data-adapter` is also the **only source** for `adapter` in `readBlock()`. Built-in channel blocks no longer offer a dropdown, just one read-only `.rb-adapter-note` + hint; `syncBlockMode()` and the `rb-kind` / `rb-adapter` branches in the change handler were deleted with it. **Adding a second adapter means bringing this type selector back first.**
- **Collapse state `blockFold` (`Map`) lives in memory only, never persisted**: `foldOpen(id)` is exactly `blockFold.get(id) === true` — **anything unrecorded starts collapsed, main request included** (2026-10-13; the main request used to start open, making the page long on arrival). Collapsed blocks are `display: none`, so **expand before touching fields inside**: "＋ Add fallback" does `blockFold.set(newId, true)`, and clicking the chip row above expands the target block too (otherwise `selectionStart` is always 0, `focus()` is a no-op, and text lands at the front, invisible).
- **The "Main request / Fallback N" in the header is a read-only `<span class="rb-tag">`; it must never become an `<input>` again.** It used to be `<input type="text" class="rb-name">` for renaming, which the global `input[type="text"] { width: 100% }` in this file (specificity 0,1,1 beating a single class's 0,1,0) stretched across the row, pushing ↑↓×▾ outside the block where `.req-block`'s `overflow: hidden` clipped them — measured at 1527px header inside a 1370px container, with `elementFromPoint` at the buttons' coordinates returning `#editor`, hence "can't collapse, can't delete". Once the name became position-derived (`Fallback ${i + 1}` in `allRequests`), the input disappeared at the root. `test-lib` section 15f pins that `.rb-name` appears in neither JS nor CSS.
- **⚠️ All events must be delegated to `els.blocks`** (blocks are drawn dynamically; don't attach per block), with two traps:
  - `dispatchEvent(new Event('input'))` inside `insertAtCursor()` **must pass `{ bubbles: true }`**. After delegation, a non-bubbling synthetic event never reaches the container — the symptom is "text changed in the box but storage and preview didn't follow" (`e2e-ui` caught `grew=8` while `imageRequest` still held the old value).
  - `check-dom.mjs` **collects class names from `class="…"` literals**, so interpolated classes in template strings are missed. Therefore the two states ("collapsed" / "disabled by unchecking") are **not written into the template**: `renderBlocks` applies them with `classList.toggle('open' / 'rb-off', …)`, leaving the literal `class="req-block"` in the template.
- **The placeholder chip row lives inside each template** (first child of `.fold-body`; maintainer, 2026-10-14: "variables belong inside the request template — can't you move them all in there?"): both templates (request / image request) get their own row, and the OCR column has its own (`CHIPS` 8 items / `OCR_CHIPS` 4). `bindChips(container)` inserts into **the currently focused box** (`focusedTemplate`, only recognised within the same `container`), defaulting to the main request's template; called once per column so they never cross-talk.
- "Test" runs `requestChain(cfg)` **in order**, stopping at the first translation; the result header badges read "N requests in the chain" + "got a translation at #i, the remaining N didn't run" (**never "tries N in order"**, which reads as "will send N"). The request preview expands **all blocks** (each with its own vars).

---

## Both right-column heads: one function, two calls (+ fixed-height hint slots)

**Right-column head = one hint line → name → one hint line**, rendered in **one place** (`editorHeadHtml()` in `options.js`), called once per column (containers `#cfg-head` / `#ocr-head` in HTML). This came from a maintainer complaint (2026-10-14) about things being off by a hair: the two heads were written separately, so patches landed separately too (config column added a sentence, OCR column gave the note a `min-height`) — "fixes the head but not the tail", request blocks started 76px apart (140 vs 216) and the whole area jumped when switching tabs.

- **Change one, both follow** — they can't even be made unequal. e2e pins it: with ids and text wiped, both heads' `innerHTML` must be **character-for-character identical** (`#cfg-head` vs `#ocr-head`).
- Each hint sits in a **fixed-height slot** (`.hint-slot { min-height: 39px }`, inner `.hint` without bottom margin). Why a slot: hints **can be dismissed** (`.hint-off` = `display: none`) and notes **come and go** (the self-built one has none) — relying on natural text height means dismissing one hint breaks the alignment.
- A slot can hold **mutually exclusive** lines (OCR column switches between `#o-hint` / `#imgcfg-hint`); same slot ⇒ switching text never moves anything.
- ⚠️ The inputs in the head (`#f-name` / `#o-name` / `#o-note` / `#imgcfg-hint`) are **looked up after rendering** (`els.cfgHead.querySelector('#f-name')`). **Don't grab them by id elsewhere** — `check-dom.mjs` trusts "ids written literally in HTML" and can't see script-built ones (classes it can), so it reports "no such id in HTML".
- **Known limit**: the slot is a floor, not a fixed height. A narrow window that wraps a hint, or a note longer than one line, still differs by one line (~21px). Eliminating it would require fixing the head's height and clipping text — not worth it.

## Settings left column: items must be `width: 100%`

Each "Configs" entry is wrapped in `.cfg-row` (`display: flex`), and `.cfg-item`'s `flex: 1` evens out widths; the left column (OCR providers) puts entries **directly in `.list-body` (`display: block`)** — there `flex: 1` does nothing, and `.cfg-item`'s `width: auto` on a **`<button>`** means "**shrink to content width**" (buttons don't fill like block-level boxes; they're fit-content). So long names made wide rows and short names made narrow ones — measured in one render: `84 / 206 / 310 px` (the 310 one overflowing the list). The fix is `.list-body > .cfg-item { width: 100% }` (only applies to entries sitting directly in a list; the config column is unaffected).

The left column has two shapes, and the criterion must cover both: OCR providers are `.list-body > .cfg-item` (relying on that `width: 100%`), "Image configs" are `.list-body > .cfg-row > .cfg-item` (the row fills, entries rely on `flex: 1`). Hence `e2e-ui` measures "the item plus everything else in its row" = row width, and the criterion is **every row fills the list's usable width** (not "they're equal to each other") — that also works **with a single item** (a bug makes it a narrow sliver).

---

## The three left columns share one row implementation (sorting included: all three drag)

The "Configs" column, OCR providers and "Image configs" look and behave the same, so `options.js` has one implementation: `sortableRow()` (handle + item + ↑↓), `moveButton()`, `dropSpot()`, `bindSortDrag()`. `listEl` / `onMove` are parameters — pass them for a new list instead of copying the code.

- **All three sort** (maintainer, 2026-10-14: "unify the purpose of sorting too"). The provider column used to be a special case ("order is meaningless → `canSort: false` + `.cfg-slot` spacer for alignment"); keeping it meant **one branch hiding inside otherwise shared logic**, so it was deleted entirely (e2e now **really clicks ↓ and really drags**; checking "the button exists" doesn't count). `.cfg-mv` is a fixed `width: 39px` so row widths match across all three, otherwise the list "jumps" when switching modes.
  - ⚠️ **After unification, CSS must not special-case one of them by id.** Two old patches (width / margin for when the OCR list had no `.cfg-row`) became one dead rule and one adding `margin-bottom: 3px` to items — making rows 3px taller than the other two columns (63 vs 60), which the eye reads as "the three lists aren't the same height". e2e now **measures row heights too**, and test-lib statically forbids `#ocr-list .cfg-item` / `.list-body > .cfg-item` from reappearing.
  - ⚠️ A row's `data-id` lives on **`.cfg-row`**, not `.cfg-item` (consistent across all three). To find a row by id, read `.cfg-row` (e2e hit this once: id not found → provider not switched → OCR test sent with an empty provider → a wall of 401s).
- Since all three sort, the left column's `.list-tip` ("drag to reorder") is **shown in both modes** (no longer `hidden` in HTML nor toggled in JS).
- The footer has one "Saved" indicator per column (`#save-status` / `#o-save-status`), and `setSaveStatus()` **writes every `.save-status` at once** — both columns share one archive, so the indicator must stay in sync.

Drag sorting uses **pointer events**, not HTML5 `draggable` (the latter never fires on touch, and the native drag ghost looks dirty in Settings). The cost is drawing the insertion indicator yourself (`.drop-before` / `.drop-after` / `.dragging`) and computing the drop target from coordinates (`dropSpot`) rather than hit testing — the pointer is "grabbed" by the handle during a drag, so `elementFromPoint` just returns the handle.

**`to` has two different meanings**: the "Configs" column passes a full-array index; "Image configs" is a **filtered view** of `state.configs` and passes a filtered index, which must go through `moveVisibleItem(all, visibleIds, from, to)` to become a full-array position. **Sorting always mutates `state.configs` itself** (keeping a second ordering is a second source of truth); the side effect is that the "Configs" column order changes too — same data, expected, so both lists redraw.

## Hint dismissal ("don't show again")

Settings has a lot of explanatory text, and each hint can be dismissed on its own (maintainer, 2026-10-14: "there are too many of these notes").

- Give the hint `data-hint="<stable id>"` in HTML; **the button is added centrally by `applyHintHides()`** (pasting a button in a dozen places is verbose and eventually misses one). Ids must be **stable**: they go into storage (`settings.hiddenHints`), and position-derived ids shift when a hint is added.
- Hiding uses the **`.hint-off` class** (`display: none !important`), **not the `hidden` attribute** — some hints have their `hidden` managed by **mode logic** (the OCR vs direct-image test note), and one attribute with two owners eventually fights.
- State lives in `settings.hiddenHints` (array). The legacy boolean `ocrHintHidden` (from when only the top of the OCR column could be dismissed) is mapped once in `normalizeHiddenHints()` in `store.js` into `['ocr']` and the old key is removed — **this isn't a version migration**, it's a compatibility read for a changed field type (`{...defaults, ...stored}` can't save you).
- **No restore UI** (only "don't show again" was asked for): to restore, clear `hiddenHints`. Don't add a "restore all" button without confirming first.

`moveItem` / `moveVisibleItem` take `to` as a position **after removal**, which is one lower than before removal when moving down (classic off-by-one). Both return **the original array reference** when nothing moved, so callers skip re-rendering via `next === arr`.

---

## Performance

`npm run perf` loads the extension in the system Edge and measures real main-thread task time. Measured:

| Scenario | Main-thread duty cycle |
|---|---|
| Idle (page still, no selection, no panel) | **0.0%** (2ms total in 5 s) |
| Continuous scrolling, 3 s | 0.9% |
| 40 consecutive selections | 3.0% (~0.7ms each) |
| Streaming translation: 800 chars / 100 chunks | 3.4% |
| Streaming translation: 8000 chars / 500 chunks | 4.0% |

**Zero cost when idle.** No `setInterval`, no `MutationObserver`, no persistent animation — work happens only on selection and button clicks.

**The only real cost is streaming rendering** (rationale and throttling approach above).

| Load | Before throttling | After |
|---|---|---|
| 800 chars / 100 chunks | 52ms | **37ms** |
| 1000 chars / 500 chunks | 115ms | **45ms** |
| 8000 chars / 500 chunks | 435ms | **142ms** |

Approaches tried and **measured as ineffective**: reducing two forced layouts to one, merging via `requestAnimationFrame`, rewriting text nodes in place — all within noise (±3%). Chunk intervals are already near the refresh rate, so merging buys little. The only effective lever is "render less often".

---

## Development and verification

**Run only the layer affected by your change; save the full run for packing** (decided 2026-10-14 — running `npm test` on every edit means waiting on the real browser every time). Rough mapping:

| Changed | Run |
| --- | --- |
| `lib/*.js` | `npm run test:lib` (add `npm run test:engine` if `engine.js` / `adapters.js` changed) |
| `options.js` / `options.html` / `options.css` | `npm run test:ui` (+ `npm run check`; it reports mismatched selectors/classes first) |
| `content.js` / `popup.js` | `npm run test:ui` + `npm run check` |
| About to pack / release | **`npm test` full run** (all four layers) |

```bash
npm test              # full run: static checks + all test layers; counts live in .test-counts.json
                      # trust the trailing summary (timestamped, pinned to HEAD); archived in .test-counts.json

# packing (runs the full suite first)
python tools/pack.py          # produces dist/request-translate-<version>.zip
python tools/pack.py --xpi    # also produces an identical-content .xpi (for Firefox / AMO)
npm run check         # static checks only
npm run test:lib      # parser / templates / extraction
npm run test:engine   # local mock server, verifies every response format
npm run test:ui       # real Edge with the extension, measures real DOM sizes
npm run perf          # main-thread task time + process CPU across four streaming loads
npm run icons         # regenerate icons
npm run pack          # npm test → strip comments → build → verify (syntax / line numbers / clean strip)
```

`npm run perf` can run a single load level for speed: `PERF_ONLY=heavy npm run perf` (`normal` / `fewLong` / `manyShort` / `heavy`).

### Environment requirements (read this when changing machines or harnesses)

Three external dependencies; missing any one breaks scripts **with errors that don't point at the real cause**:

1. **Node on PATH** — npm scripts run `node tools/xxx.mjs`, and `verify-pack.py` inside `npm run pack` also runs `node --check`. Without node, the Python side reports `FileNotFoundError: [WinError 2]` (no hint that node is missing).
2. **`PYTHONIOENCODING=utf-8`** — pack output contains characters like `✓`, and a default GBK Windows console dies mid-way with `UnicodeEncodeError: 'gbk' codec can't encode character '\u2713'`.
3. **playwright-core** (only `test:ui`) — e2e doesn't download browsers and uses the system Edge; the module is resolved from `~/.workbuddy/binaries/node/workspace/node_modules/playwright-core`.

```bash
# one-time setup under the DSH sandbox (node not on PATH, GBK console)
export PATH="$HOME/.workbuddy/binaries/node/versions/22.22.2-6:$PATH"
export PYTHONIOENCODING=utf-8
```

**Two extra things when running from PowerShell** (measured 2026-10-18 — don't mistake them for "not installed"):

- PowerShell **blocks `npm.ps1` by default** (execution policy `UnauthorizedAccess`), and `& npm ...` resolves to the `.ps1`. **Write `npm.cmd` explicitly**: `& "$nb\npm.cmd" run pack`. The error reads "cannot be loaded because running scripts is disabled on this system", which looks nothing like "command not found".
- `$env:PATH` must include the node directory first, otherwise the `npm test` inside `pack.py` still hits `FileNotFoundError: [WinError 2]` (same root cause as #1, different host). `python` itself is on PATH.

3. **Subprocess output decoding** (already fixed — no manual step) — `subprocess.run(..., text=True)` in `pack.py` / `verify-pack.py` decodes child output as ANSI (GBK) on Windows by default, while test output contains UTF-8 characters like `= · ✓`, so the decoding thread throws `UnicodeDecodeError`. Both sites got explicit `encoding="utf-8", errors="replace"` on 2026-10-17. **Copy those two arguments into any new Python code that calls `node`/`npm`**, or another machine will greet you with a screen of red.

**Sandbox note**: `test:ui` launches Edge with `--remote-debugging-pipe`, which is "pipe capture" — a file sandbox that forbids it shows `spawn EPERM` (a sandbox boundary, not a missing dependency). It works under `danger-full-access`; under `workspace-write` e2e can't run, and the other four layers are unaffected.

Read `.test-counts.json` for the per-layer counts (plus two static checks); the documents do not keep a second copy. Each layer covers a different blind spot:

- **`check-globals`** — syntax checking can't see a call to `bindConfigList()` that was never written; only runtime blows up. It strips comments, strings and regex literals, then compares every call against every declaration. You can also target files: `node tools/check-globals.mjs lib/engine.js`. Add new `lib/*.js` to the target list (including `offscreen.js`). Recognising **destructured object parameters** (`function f({ a, b })`) needs its own regex — with only `\(([^()]*)\)` the whole `{ a, b }` remains, every piece keeps its braces, nothing is recognised, and `a` / `b` get reported as undefined (`moveButton({ … onMove })` hit this).
- **`check-dom`** — compares JS's `$('#id')` / `querySelector('.x')` / `closest('.x')` against class names **written in HTML plus** those built in JS, guarding against "selector points at nothing, startup dies on null". Regex trap: `querySelectorAll?` makes the `?` apply only to the last `l`, so **plain `querySelector('.x')` was never scanned at all** — write `querySelector(?:All)?`.
- **`e2e-ui`** — the first two only prove "code runs, selectors resolve"; they can't judge **whether it looks right**. The script loads the extension in the system Edge (`playwright-core`, no downloaded browser), really selects text, really clicks buttons, and measures header height, panel width and post-zoom sizes with `getBoundingClientRect`. It skips automatically if Edge isn't installed. Key points:
  - **The body is one big `try` with shared `const` scope**: grep a name before adding it; duplicates are an instant `SyntaxError` (exits after 1 s).
  - **Sections contaminate each other**: a section that writes a switch to storage and doesn't clean up sends later sections down another path, **without any error**. Transient states are sampled via the fake `/slow` route (1.2 s) + `waitForFunction`, never `sleep`; failures report "class | status text | lastPath".
  - The three lamp states (purple/green/red) are only observable by freezing the "request in flight" moment with `/slow`.
  - The screenshot-OCR section **really puts a PNG on the system clipboard** (PowerShell `-STA` + `System.Windows.Forms.Clipboard::Set*`) and runs the whole chain, and it must run in a **headed** window — headless Chromium's clipboard is a stub that always reads empty.
  - The "switch config" section uses two fake configs each carrying `?tag=`, pinning three things via hit counts and markers in the text: switching back to a translated config **sends nothing**, switching to an untranslated one **translates immediately**, and a stream from a config the user switched away from must not bleed onto the current screen.
  - It writes a `scrollbar-color` onto the test page's `html` to verify the panel's scrollbar **doesn't inherit the page's colours**.
  - **Two cases at the end of the area-selection section** (verifying "the right-hand scrollbar isn't cropped in"): first `overflow-y: hidden`, asserting "framing the full screen crops the whole image unchanged (old behaviour)"; then `overflow-y: scroll` to create a **real** scrollbar and assert the crop is exactly that much narrower (measured 1178 → 1163, a 15px difference). Two hard constraints: ① content scripts run in an **isolated world**, so faking `window.innerWidth` is invisible — create a real scrollbar; ② crop dimensions can only be read by parsing the PNG header of the body **the fake OCR endpoint received** (`canvas.toDataURL` can't be hooked). After scheme A the overlay has **no `.img`**, so scaffolding assertions became "a `.veil` pointer layer + `.sel` cut-out layer" and "the hint bar mentions scrolling".
  - **The area-selection section must include a real-mouse case**: `shotDrag()`'s `dispatchEvent` **bypasses hit testing** and can't detect "the overlay never receives the mouse" (this shipped once: humans couldn't frame, scripts were green). So two more assertions: `document.elementFromPoint(x, y)` must return the mask (`hitIsHost`), and a Playwright **real mouse** `mouse.down/move/up` drag must dismiss the overlay and actually send a request.
  - The button-style section runs both `custom` branches (icon supplied / falling back to the sample) and measures computed styles on the page to confirm there's **really no background**.
  - "Export / import" really clicks export, reads and parses the downloaded file, edits it into "exported from another device" and imports it back, plus the three failure paths: "cancel changes nothing", "bad file", "some other app's JSON".
  - The last two sections: **switching the target language in the header** (the `{{targetCode}}` is wired into the fake endpoint's query string; changing the dropdown must resend with `tag=EN`), and **streaming doesn't run off with the scrollbar** (`/streamlong` produces a long stream that makes the panel scrollable; assert `scrollTop` is 0 both mid-stream and after — asserting "didn't scroll" alone isn't enough, you must also assert "the content really is long enough to scroll", otherwise it's a vacuous pass).
  - The long-stream section's tail also measures **the result area's max height**: change `panelMaxHeight` in Settings (through storage + `onChanged`, the real path), then check `getComputedStyle('.rt-out').maxHeight` in px against `vh × innerHeight × --rt-zoom`, **and** assert `clientHeight` actually changed — checking max-height alone misses "wrote a variable that never took effect".
  - The final section measures **where the button sits and when it disappears**: the mouse path asserts "exactly 14px from the mouseup point" (vertically too); the keyboard path uses a **real mouse drag** to build a selection (Chrome won't let synthetic selections be extended by keys), parks the mouse at `(900, 600)`, presses a real Shift key, then asserts the button hugs the measured caret line and is 100px+ away from the stale mouse position. The auto-hide cases temporarily set the two timers to `2.5 / 1.5` s and check, in order: "stays while hovering the button", "disappears on leave", "returning cancels the hide", "disappears on its own when idle", "setting 0 never hides". Three notes:
    - **Press Esc to close the panel before moving the mouse onto the button** — both are `fixed`, the panel covers the button and the mouse lands on the panel (this produced green-but-wrong assertions once).
    - **Call `page.bringToFront()` first**: this section has already opened `opt` / `opt2` / `opt3` tabs, so `page` is backgrounded, and mouse events on a background page get throttled to **one per second** (`steps:6` measured 6 s; the same page alone takes 60ms) — timer-based cases collapse under that.
    - **The "returning cancels" case races the timer**: always move in **one step** (a single mousemove) and add a scaffolding assertion "round trip < timer" — on a slow machine it must report "scaffolding too slow" rather than let "the button expired" masquerade as "cancel worked".
- When measuring the panel, **don't let requests reach the real network** — build a local fake endpoint and point it there.

### How changes take effect

Click "Reload" on the extensions page, **then refresh the target page** — both steps.

Reloading the extension alone isn't enough: an already-open page keeps running **the old content script** (and once the extension reloads, the old script's `chrome.*` calls stop working). The symptom is easy to recognise: Settings looks new and the preview is right, but the page behaves as before.

### The packaged source has comments stripped; the repo copy is complete

`npm run pack` strips comments from `.js/.css/.html` before zipping. **Comments in the repo are untouched** — they're for people who clone the repo, not for users who never open `content.js`.

- **Stripping must be lexical, not regex**: `//` inside `"https://a.com"`, regex literals `/a\/b/`, and template strings with `${x} // text` all get mangled by regex. `tools/strip-comments.mjs` is a character-by-character lexer (distinguishing code / line comment / block comment / string / regex / template), and `tools/test-strip.mjs` is its self-test (19 cases, focused on "everything that should stay, stayed").
  `check-globals.mjs` has a lexer too, but it **also erases string contents** (it only cares about structure), so it can't be used for packing.
- After esbuild minification **line numbers are no longer preserved** (packaged `content.js` is 34 lines, `background.js` 1 line) — debug in production by function name / string, or cross-reference the repo source. The comment-stripping pass alone keeps newlines, so line numbers survive it.
- **Syntax is verified on the spot**: every `.js` goes through `node --check`, and breaking one exits non-zero immediately — finding out the panel won't open after installing is too late.
- **`tools/verify-pack.py` checks three things**: ① all 15 JS files pass `node --check`; ② every file's line count matches the repo; ③ **idempotence** — stripping the packaged copy again must produce byte-identical output.
  The third is the only defensible criterion for "stripped cleanly". **Don't use "anything in the repo must appear in the package"**: examples in comments (`{{var}}`, `https://x`) are supposed to disappear, and that check produces a pile of false positives (tried it).
- Want a package with comments: `npm run pack -- --no-strip`.

---

## Guards that look right but never actually fire (2026-10-18 review)

Common theme here: **the code exists, the comment states the intent, and it never once took effect.** Assertions should prioritise this class.

- **Always-false guard = dead branch**: `parseCurl`'s "check combined short options individually" used `inlineValue === null && tok.length > 2` — when `tok.length > 2`, `inlineValue` is never null; when `inlineValue === null`, `tok.length <= 2`. **Always false.** The consequence isn't "a missed optimisation" but wrong parsing: in `curl -sd 'a=1'` the `d` was dropped and `a=1` became the URL. It now follows curl semantics ("value-taking flags consume the rest of the characters"). **Find this class by scanning unexecuted lines in `lib/*.js` with coverage — more reliable than eyeballing.**

- **Regexes written from imagined wording never match real errors**: `ocrErrorHint`'s model-name branch used `model.{0,24}(…)`, while the real message is `The model `X` does not exist` (32 characters between "model" and "does not exist"); the Baidu branch matched `access_token` while the real text is `Access token` (**with a space**). **Write these criteria by running the vendor's actual error text through them** — don't invent a sentence. And when widening a window, guard against false positives (a body echoing `model` plus an unrelated `invalid` isn't a model-name error).

- **Fields collected but never consumed**: `parseCurl`'s `warnings` was never pushed to and `engine` never read it — so "`-d @file` gets sent verbatim" happened **silently**. Parse-time notes now reach the panel's "…" and the Settings preview (`runRequest` / `previewRequest` / `buildOcrRequest` must all merge them in).

- **Read-modify-write must be queued**: `chrome.storage`'s "read → modify → write" spans an `await`, so concurrent callers read a copy someone hasn't written back yet. Hit twice: `background.js` writing history (a 2–4 way comparison left 1 entry) and `content.js`'s `mutateState` (double-clicking a switch). Both fixed by **chaining promises into a queue** — `clipboardRead` / `saveChain` / `historyQueue` are the same pattern.

- **Two writers + whole-object overwrite = mutual clobbering**: the panel writes `showOriginal` / `targetLang` / `ocr.imageConfigId` with per-key RMW, while Settings overwrites the **entire state**. Before saving, Settings calls `adoptPanelOwned()` to take storage's values for "keys the panel also writes and this page didn't touch". **Any key the panel writes must be added to `PANEL_OWNED_SETTING_KEYS`.**

- **SSE's `\r\n` can be split across TCP reads**: normalisation can't be per-chunk, nor "push the previous chunk's `\r` back into the buffer, then process this one" — the pushed-back `\r` isn't in this chunk's replacement scope, the buffer ends up with `\n\r\n` (should be `\n\n`), events never split, and the whole stream gets concatenated by the tail fallback. The fix is to **hold back the trailing `\r`** (`carryCr`) and normalise it together when the next chunk arrives. `test-lib` asserts five split patterns (including "one chunk per byte").

- **`postMessage` itself can throw**: a port that "exists but is disconnected" throws `Attempting to use a disconnected port object`. `content.js`'s `postOrFail` was the only send point in that file without try/catch (the two bare aborts and the background's `safePost` were covered).

- **Hand-copied code needs value/verbatim assertions**: `formatBytes` had two implementations with different decimal rules, so the same image read "49 KB" in Settings and "48.8 KB" in the panel. Same for the two panel CSS copies (inline in `content.js` vs `lib/panel-styles.js`).

- **Don't hard-code a default elsewhere after adding a user setting**: `frame-bridge.js` hard-coded `slice(0, 8000)`, so users who raised "max characters per send" above 8000 had iframe selections silently truncated to 8000. Keep exactly one enforcement point (`translate()` in `content.js`).

---

## Custom panel styling (2026-10-18)

Settings' "Panel" group has a CSS textarea whose contents are **appended to the end of the panel's shadow root**.

- **Why we must inject it**: the panel lives in shadow DOM, so page-level CSS (Stylus / user.css / browser user stylesheets) **can't get in**. Tools like hcfy, where you can write `#translate-panel` directly, have their panel in the page DOM — ours isn't. This must be said in the UI, or people will paste into Stylus and report "doesn't work".
- **Why append at the end**: at equal specificity with the preset themes it wins by "coming later", giving a natural `defaults < preset theme < user CSS` layering without `!important`.
- **`#rt-panel` is an id selector**, outranking our `.rt-panel` class — so changing background, radius or shadow usually needs no `!important`.

### Available hooks (these names won't change; renames ship an alias)

| Selector | What it is |
| --- | --- |
| `#rt-panel` | The panel itself (width / radius / shadow / background / padding) |
| `[data-rt-theme="dark"]` / `[data-rt-theme="light"]` | Per-theme rules (hcfy's `.bp6-dark` equivalent) |
| `.rt-head` | Header (config dropdown + language dropdown + eye/close) |
| `.rt-cfg` / `.rt-lang` | Those two dropdowns |
| `.rt-src` | Source area (`hidden` class means collapsed) |
| `.rt-out` | Result area (scroll container) |
| `.rt-slot` / `.rt-slot-h` / `.rt-slot-name` / `.rt-slot-b` | Comparison slot: block / header / config name / translation |
| `.rt-acts` / `.rt-act` | The copy / read-aloud / retry row under each translation |
| `.rt-foot` / `.rt-msg` / `.rt-more` | Footer: status text / "⋯" diagnostics button |
| `.rt-diag` / `.d-k` / `.d-v` | Diagnostics panel (first byte, total time, response format… and their values) |
| `.rt-btn` / `.rt-dot` | Header icon buttons / the status lamp |

### Built-in sample: warm eye-friendly palette

Settings has "Fill in sample: warm" which injects this variable set (Gruvbox Dark's warm browns; **contrast verified: body 11.2, secondary 6.7**):

```css
#rt-panel {
  --rt-bg: #181713;        --rt-bg-head: #1f1e19;
  --rt-bg-sub: #1b1a16;    --rt-bg-diag: #151410;
  --rt-border: #332f27;    --rt-border-soft: #2a2721;
  --rt-slot-line: #453f34; --rt-hover: #282520;
  --rt-scroll: #3b372e;    --rt-accent: #b8863b;
  --rt-accent-soft: #2a2118; --rt-accent-text: #d9a95a;
}
```

**Override colours only — don't touch layout and don't change text colours**: text colours reuse the dark preset (whose contrast is computed and asserted; casual edits break readability). To add a fourth palette, put another sample next to `PANEL_CSS_WARM` in `options.js`; no theme logic changes needed.

### Two known limits

- Some sites (e.g. mikanani.me) **embed Dark Reader themselves** (`/js/darkreader.min.js`), which injects four `darkreader--*` stylesheets into our shadow root and recolours with `!important`. User CSS without `!important` loses to it — third-party behaviour, not our bug.
- Broken CSS can wreck the panel, so the "Clear" button must stay; stylesheets above 200k characters also stall rendering, so `panelCss` is truncated to 20000 characters in `normalizeThemeAndCss`.

---
## Hard boundaries

- **The `proxy` permission has been removed from `manifest.json` entirely** (it only ever served "temporary direct connect"). Don't bring it back — proxy routing belongs in the proxy client's rules, and this permission makes Edge show "read and change your proxy settings".
- The Bing channel **always gets an empty body when a proxy is on**. The fix is `DOMAIN-SUFFIX,bing.com,DIRECT` in the proxy client; the extension has no fallback of its own.
- API keys are stored in plaintext in `chrome.storage.local`. **Except for config files exported with encryption enabled** (passphrase-derived key, PBKDF2 600k iterations + AES-GCM, see `lib/crypto.js`) — that's opt-in; skip it and the keys leak.
