/**
 * popup：配置快切 + 手动翻译
 */

import { loadState, saveState, buildVars, getConfig } from './lib/store.js';
import { orderedLangCodes, langDisplayName } from './lib/template.js';
import { maskRequest, runRequest } from './lib/engine.js';
import { requestFields } from './lib/request-fields.js';

import { fillUiIcons } from './lib/ui-icons.js';

fillUiIcons();
const $ = (s) => document.querySelector(s);

const sel = $('#sel');
const langSel = $('#lang');

/**
 * popup 没有 T()（那套只在 content/options 里有），但**不能只查 chrome.i18n**：
 * chrome.i18n 读的是 _locales/，而语言包是运行时从 GitHub 下载的（rt_i18n）——
 * 只查 chrome.i18n 的话，用户装了英文包 popup 仍然全中文（第十一版 §1 指出）。
 *
 * 顺序和 lib/i18n.js 的 t() 一致：**下载包 → chrome.i18n → key**。
 */
let packStrings = null;

async function loadPopupPack() {
  try {
    const got = await chrome.storage.local.get('rt_i18n');
    const p = got && got.rt_i18n;
    packStrings = p && p.strings ? p.strings : null;
  } catch {
    packStrings = null;
  }
}

function uiText(key, params, fallback = key) {
  let out = null;
  if (packStrings && typeof packStrings[key] === 'string') out = packStrings[key];
  if (out == null) {
    try {
      const got = chrome.i18n && chrome.i18n.getMessage(key, params);
      if (got) out = got;
    } catch { /* 忽略 */ }
  }
  if (out == null) out = fallback;
  if (params && params.length) {
    out = String(out).replace(/\$(\d+)\$?/g, (m, n) => {
      const v = params[Number(n) - 1];
      return v == null ? m : String(v);
    });
  }
  return out;
}
/** 语言代码在当前语言下该显示成什么（用户改过的名字优先） */
/**
 * 把带 data-i18n / -title / -ph 的静态节点填上文案。
 * 和 lib/i18n.js 的 applyI18n 同一套语义（那个是给普通脚本用的，popup 是 ESM，不能直接 import）。
 */
function applyPopupI18n(root) {
  const scope = root || document;
  for (const el of scope.querySelectorAll('[data-i18n]')) {
    el.textContent = uiText(el.dataset.i18n);
  }
  for (const el of scope.querySelectorAll('[data-i18n-title]')) {
    el.title = uiText(el.dataset.i18nTitle);
    if (el.hasAttribute('aria-label')) el.setAttribute('aria-label', el.title);
  }
  for (const el of scope.querySelectorAll('[data-i18n-ph]')) {
    el.placeholder = uiText(el.dataset.i18nPh);
  }
}

function langNameOf(code) {
  const names = (state && state.settings && state.settings.targetNames) || {};
  return names[code] || langDisplayName(code, uiText);
}
const txt = $('#txt');
const out = $('#out');
const outText = $('#out-text');
const statusEl = $('#status');
const goBtn = $('#btn-go');
const goLabel = $('#go-label');
const clearBtn = $('#btn-clear');
const copyBtn = $('#btn-copy');
const resultPanels = ['loading', 'translation', 'failure', 'empty-input'];

function showResult(panel) {
  for (const key of resultPanels) $(`#${key}`).hidden = key !== panel;
}

function showFailure(message, details = '') {
  $('#error-message').textContent = message;
  const diagnostic = $('#diagnostic');
  diagnostic.hidden = !details || details === message;
  diagnostic.open = false;
  $('#diagnostic-text').textContent = details;
  showResult('failure');
}

function showRequestDetails(result, vars) {
  const details = $('#success-diagnostic');
  const fields = [
    [uiText('popup_http_status'), result.status],
    [uiText('popup_request_time'), Number.isFinite(result.ms) ? (result.ms / 1000).toFixed(1) + ' s' : ''],
    [uiText('popup_response_path'), result.usedPath],
    [uiText('popup_reasoning'), result.reasoningChars],
    ...((result.warnings || []).map(warning => [uiText('popup_request_warning'), warning?.code
      ? uiText(warning.code, warning.params, warning.text || '') + (warning.shape || '') : warning?.text || warning]))
  ].flatMap(([label, value]) => {
    if (!value) return [];
    const term = document.createElement('dt');
    const data = document.createElement('dd');
    term.textContent = label;
    data.textContent = maskRequest({body: String(value)}, vars).body;
    return [term, data];
  });
  $('#request-details').replaceChildren(...fields);
  details.open = false;
  details.hidden = !fields.length;
}

function setBusy(busy) {
  goBtn.disabled = busy;
  goLabel.textContent = uiText(busy ? 'popup_translating' : 'popup_translate');
}


let state = null;
let controller = null;
let statusTimer = 0;
/** run 序号：连点两次时，旧那轮恢复后不许再写界面 */
let runSeq = 0;

function setStatus(text, isErr = false) {
  clearTimeout(statusTimer);
  statusEl.textContent = text || '';
  statusEl.classList.toggle('error-text', isErr);
}

function updateClearButton() {
  clearBtn.disabled = !txt.value && !out.textContent && !controller;
}

function setOut(text) {
  outText.textContent = text;
  updateClearButton();
}

/* ---- 流式渲染节流（同 content.js） ---- */

const RENDER_INTERVAL = 50;

let pendingOut = null;
let outTimer = 0;
let outLastFlush = 0;

function cancelStreamRender() {
  if (outTimer) {
    clearTimeout(outTimer);
    outTimer = 0;
  }
  pendingOut = null;
}

function applyOut() {
  outTimer = 0;
  outLastFlush = performance.now();

  const text = pendingOut === null ? '' : pendingOut;
  pendingOut = null;

  if (text) {
    showResult('translation');
    copyBtn.disabled = false;
  }
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  setOut(text);
  if (atBottom) out.scrollTop = out.scrollHeight;
}

function queueOut(text) {
  pendingOut = text || '';
  if (outTimer) return;
  const gap = performance.now() - outLastFlush;
  if (gap >= RENDER_INTERVAL) applyOut();
  else outTimer = setTimeout(applyOut, RENDER_INTERVAL - gap);
}

/** popup 也跟随设置里的主题 */
function applyTheme() {
  const t = (state && state.settings && state.settings.theme) || 'auto';
  let dark = true;
  if (t === 'light') dark = false;
  else if (t === 'auto') {
    const q = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
    dark = q ? !q.matches : true;
  }
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  window.RTM3Theme.apply(document.documentElement, state?.settings?.themeColor, dark ? 'dark' : 'light');
}

async function init() {
  /* **语言包要先载入再铺界面**（第十一版 §1：popup 整页没进 i18n）。
     顺序反了用户会先看见中文再闪成英文。 */
  await loadPopupPack();
  applyPopupI18n();

  state = await loadState();
  applyTheme();
  renderSelectors();

  // 带上页面里选中的文字
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => String(window.getSelection() || '').trim()
      });
      const selected = res && res[0] && res[0].result;
      if (selected && !txt.value) {
        const limit = Math.max(1, Number(state.settings.maxChars) || 8000);
        txt.value = selected.slice(0, limit);
      }
    }
  } catch {
    /* Certain pages do not allow the selection script. */
  }

  updateClearButton();
  if (txt.value.trim()) txt.focus();
}

function renderSelectors() {
  sel.replaceChildren(...sel.querySelectorAll(':scope > button'));
  for (const c of state.configs) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    sel.appendChild(o);
  }
  sel.value = state.activeConfigId;

  /* 目标语言：和设置页 / 面板顶栏同一个值（settings.targetLang，存的是代码）。
     显示名优先取用户在「语言代码表」里改过的那个。 */
  if (langSel) {
    /* **顺序要和设置页 / 面板同源**：都走 orderedLangCodes（langOrder 打头
       → 未提到的按内置序 → 去重）。以前这里用 TARGET_PRESETS.slice()，
       用户在语言表里排的顺序在 popup 里完全看不到（第八版 §1 指出）。 */
    const codes = orderedLangCodes(state.settings && state.settings.langOrder);
    const curLang = String(state.settings.targetLang || '');
    if (curLang && !codes.includes(curLang)) codes.unshift(curLang);
    langSel.replaceChildren(...langSel.querySelectorAll(':scope > button'));
    for (const code of codes) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = langNameOf(code);
      langSel.appendChild(o);
    }
    langSel.value = curLang || codes[0];
  }
}

let preferenceWrites = Promise.resolve();
function updatePreference(apply) {
  preferenceWrites = preferenceWrites.then(async () => {
    const latest = await loadState();
    apply(latest);
    await saveState(latest);
    state = latest;
  }).catch(error => showFailure(uiText('popup_check_config'), String(error.message || error)));
}

sel.addEventListener('change', () => {
  const value = sel.value;
  updatePreference(latest => { latest.activeConfigId = value; });
});
langSel.addEventListener('change', () => {
  const value = langSel.value;
  updatePreference(latest => { latest.settings.targetLang = value; });
});
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.state || !state) return;
  await preferenceWrites;
  state = await loadState();
  renderSelectors();
  applyTheme();
});
matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme);

goBtn.addEventListener('click', run);

txt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    run();
  }
});

copyBtn.addEventListener('click', async () => {
  if (!out.textContent) return;
  try {
    await navigator.clipboard.writeText(out.textContent);
    setStatus(uiText('popup_copied'));
    statusTimer = setTimeout(() => setStatus(''), 1500);
  } catch {
    setStatus(uiText('popup_copy_failed'), true);
  }
});

txt.addEventListener('input', () => {
  updateClearButton();
  if (!$('#empty-input').hidden) showResult();
});

clearBtn.addEventListener('click', () => {
  ++runSeq;
  controller?.abort();
  controller = null;
  cancelStreamRender();
  txt.value = '';
  setBusy(false);
  setOut('');
  setStatus('');
  showResult();
  txt.focus();
});

$('#btn-retry').addEventListener('click', run);
$('#link-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

async function run() {
  const text = txt.value.trim();
  if (!text) {
    showResult('empty-input');
    txt.focus();
    return;
  }
  const cfg = state && getConfig(state, sel.value);
  if (!cfg) {
    showFailure(uiText('popup_no_config'));
    return;
  }

  const myRun = ++runSeq;
  controller?.abort();
  controller = new AbortController();
  cancelStreamRender();
  setBusy(true);
  setStatus('');
  setOut('');
  copyBtn.disabled = true;
  $('#success-diagnostic').hidden = true;
  $('#success-diagnostic').open = false;
  $('#request-details').replaceChildren();
  showResult('loading');
  const vars = buildVars({...state, settings: {...state.settings, targetLang: langSel.value}}, text, { url: 'popup', title: document.title });
  const key = requestFields(cfg.request)?.fields.find(field => field.secret)?.value;
  const diagnosticVars = key ? {...vars, requestApiKey: key} : vars;

  try {
    const result = await runRequest({
      requestText: cfg.request,
      adapter: cfg.adapter,
      vars,
      path: cfg.path,
      responseMode: cfg.responseMode,
      signal: controller.signal,
      onDelta: (translation, _piece, status) => {
        if (myRun === runSeq && !(status >= 400)) queueOut(translation);
      }
    });
    if (myRun !== runSeq) return;
    cancelStreamRender();
    if (!result.text || result.status >= 400) {
      const diagnostic = result.errorCode ? uiText(result.errorCode, result.errorParams, result.error)
        : result.error || [result.status && 'HTTP ' + result.status, result.statusText].filter(Boolean).join(' · ');
      const details = maskRequest({body: diagnostic || ''}, diagnosticVars).body.slice(0, 1200);
      const reason = result.status === 401 || result.status === 403
        ? uiText('popup_auth_failed')
        : result.status >= 400 ? 'HTTP ' + result.status + (result.statusText ? ' · ' + result.statusText : '')
          : uiText('popup_check_config');
      showFailure(maskRequest({body: reason}, diagnosticVars).body, details);
      return;
    }

    setOut(result.text);
    copyBtn.disabled = false;
    showRequestDetails(result, diagnosticVars);
    showResult('translation');
  } catch (error) {
    if (myRun !== runSeq) return;
    cancelStreamRender();
    showFailure(uiText('popup_check_config'), maskRequest({body: String(error.message || error)}, diagnosticVars).body);
  } finally {
    if (myRun === runSeq) {
      controller = null;
      setBusy(false);
      updateClearButton();
    }
  }
}

init().catch((error) => showFailure(uiText('popup_init_failed'), String(error.message || error)));
