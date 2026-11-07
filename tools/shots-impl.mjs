import { createRequire } from "module";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { mkdtempSync, mkdirSync } from "fs";
import { createServer } from "http";

const require = createRequire(import.meta.url);
const ROOT = "C:/Users/Administrator/WorkBuddy/翻译插件";
const OUT = ROOT + "/docs/shots";
mkdirSync(OUT, { recursive: true });

const { chromium } = require(join(homedir(), ".workbuddy/binaries/node/workspace/node_modules/playwright-core"));

// 假接口：返回一段固定的中文译文。不联网、不烧额度、内容可控。
const TRANSLATED = "选中网页上的任意文字，就会出现一个小圆点。点一下，扩展就把你自己配置的那段请求发出去 —— 不需要经过任何第三方中转。";

// 假文章页：避免把真实网站的版权内容拍进仓库
const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin:0; font: 17px/1.85 -apple-system, "Segoe UI", system-ui, sans-serif;
         color:#1a1a1a; background:#fff; }
  .wrap { max-width: 720px; margin: 0 auto; padding: 56px 24px 80px; }
  .kicker { font-size:13px; letter-spacing:.12em; text-transform:uppercase; color:#8b5cf6; font-weight:600; }
  h1 { font-size: 38px; line-height:1.25; margin:14px 0 10px; letter-spacing:-.02em; }
  .meta { color:#888; font-size:14px; margin-bottom:32px; }
  p { margin: 0 0 22px; }
  .lead { font-size:19px; color:#333; }
  hr { border:0; border-top:1px solid #eee; margin:34px 0; }
  .tip { background:#f7f5ff; border-left:3px solid #8b5cf6; padding:14px 18px; font-size:15px; color:#444; }
</style></head><body><div class="wrap">
<div class="kicker">Browser Extensions</div>
<h1>What if your translator was just an HTTP request you wrote yourself?</h1>
<div class="meta">By A. Writer · 6 min read</div>
<p class="lead" id="lead">Every translation extension ships with its own opinion about which API you should use, how your prompt should look, and what happens to the text you select. Most of them are closed boxes: you pick a provider from a dropdown and hope for the best.</p>
<p>This one takes the opposite approach. Instead of hiding the request behind a settings form, it hands you the raw text box — you paste a curl command or a raw HTTP message, write <code>{{text}}</code> where the selection should go, and that is your configuration.</p>
<hr>
<div class="tip">Nothing is rewritten except the placeholders. Header order, spacing, JSON layout — whatever you typed is what gets sent.</div>
<p>That sounds like a small thing, but it changes what the extension can talk to. Any OpenAI-compatible endpoint, any self-hosted gateway, any service with an oddball response shape — if you can describe the request, you can use it.</p>
</div></body></html>`;

const REQUEST = [
  "POST https://api.your-gateway.com/v1/chat/completions",
  "Authorization: Bearer {{apiKey}}",
  "Content-Type: application/json",
  "",
  '{"model": "{{model}}", "stream": true,',
  ' "messages": [{"role": "user",',
  '   "content": "把下面这段翻译成简体中文，',
  '    只输出译文：\\n\\n{{text}}"}]}',
].join("\n");

// 把展示用的域名导到本地假接口，这样截图里显示的是正常域名、
// 请求却真的打到了本地服务。截图专用，不影响被测扩展的任何逻辑。
const DEMO_HOST = "api.demo-gateway.example";

function serve(body, type) {
  const s = createServer((req, res) => {
    // 假接口必须带 CORS 头：扩展的 fetch 是从 service worker 发出的，
    // 没有 Access-Control-Allow-Origin 会被浏览器拦成 "Failed to fetch"。
    // （实测踩过：不带这个头，面板上显示的就是「请求发送失败：Failed to fetch」）
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    };
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    res.writeHead(200, Object.assign({ "Content-Type": type }, cors));
    res.end(body);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

console.log("启动假接口与测试页 …");
const apiSrv = await serve(
  JSON.stringify({ choices: [{ message: { content: TRANSLATED } }] }),
  "application/json; charset=utf-8"
);
const pageSrv = await serve(PAGE, "text/html; charset=utf-8");
const API_PORT = apiSrv.address().port;
const PAGE_PORT = pageSrv.address().port;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), "rt-shots-")), {
  executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  headless: true,
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
  args: [
    "--disable-extensions-except=" + ROOT,
    "--load-extension=" + ROOT,
    "--window-position=-933,-287",
    "--window-size=900,1200",
  ],
});

// 拦截发往 DEMO_HOST 的请求，返回假译文。用 service worker 层拦截，
// 因为请求是扩展的后台 fetch 出去的，page.route 拦不到。
const API_PATH = /.*/;
await ctx.route("**/*", async (route) => {
  const reqUrl = route.request().url();
  if (reqUrl.includes(DEMO_HOST)) {
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ choices: [{ message: { content: TRANSLATED } }] }),
    });
    return;
  }
  await route.fallback();
});

for (let i = 0; i < 90 && ctx.serviceWorkers().length === 0; i += 1) {
  await new Promise((r) => setTimeout(r, 250));
}
let extId = null;
const sw = ctx.serviceWorkers()[0];
if (sw) {
  const m = /^chrome-extension:\/\/([a-z]+)\//.exec(sw.url());
  if (m) extId = m[1];
}
if (!extId) {
  console.log("没有 service worker，扩展没加载起来");
  await ctx.close();
  process.exit(1);
}

// 写一份配置进存档
const boot = await ctx.newPage();
await boot.goto("chrome-extension://" + extId + "/options.html", { waitUntil: "domcontentloaded" });
await boot.waitForTimeout(1200);
const realReq = REQUEST
  // 请求地址**保持好看的域名**（展示图里不该出现 127.0.0.1:端口），
  // 由下面的 route 拦截把这个域名的请求导到本地假接口。
  .replace("https://api.your-gateway.com", "https://api.demo-gateway.example")
  // 假接口返回的是一段完整 JSON，不是 SSE —— 所以 stream 必须关掉，
  // 否则引擎按 SSE 逐块解析，拿不到 choices[0].message.content。
  .replace("\"stream\": true,", "\"stream\": false,");
await boot.evaluate(async ({ r, r2 }) => {
  const g = await chrome.storage.local.get("state");
  const st = g.state;
  st.configs = [
    // 注意：c1 是 activeConfigId，**它也必须用打到假接口的那份 realReq**。
    // 早先这里给 c1 传了没替换过地址的原始 REQUEST（指向一个不存在的域名），
    // 结果面板上一直显示「Failed to fetch」，查了三轮才定位到。
    { id: "c1", name: "我的模型网关", request: r2, fallbacks: [] },
    { id: "c2", name: "备用接口", request: r2, fallbacks: [] },
    { id: "c3", name: "Bing 翻译（免费）", request: "GET https://edge.microsoft.com/translate/auth", fallbacks: [] },
  ];
  st.activeConfigId = "c1";
  st.settings = Object.assign({}, st.settings, {
    panelSlots: 1,
    theme: "dark",
    panelCss: "",
    panelWidth: 460,
    slotConfigs: ["c1"],
    fontSize: 18,
    triggerStyle: "badge",
    targetLang: "简体中文",
    showOriginal: true,
  });
  // 变量要给值。注意 vars 是**数组** [{ name, value }] 不是对象 ——
  // 写成 st.vars.apiKey = ... 根本不生效，症状是面板上「缺失变量=model」
  // 加上「Failed to fetch」（{‌{model}} 没替换，JSON 变形）。
  const setVar = (arr, name, value) => {
    const hit = arr.find((v) => v && v.name === name);
    if (hit) hit.value = value;
    else arr.push({ name, value });
  };
  st.vars = Array.isArray(st.vars) ? st.vars : [];
  setVar(st.vars, "apiKey", "sk-demo-not-a-real-key");
  setVar(st.vars, "model", "any-model");
  await chrome.storage.local.set({ state: st });
}, { r: REQUEST, r2: realReq });
await boot.close();

// ---- 01 / 02：划词与面板 ----
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:" + PAGE_PORT + "/", { waitUntil: "load" });
await page.waitForTimeout(2500);
await page.evaluate(() => {
  const p = document.getElementById("lead");
  const t = p.firstChild;
  const r = document.createRange();
  r.setStart(t, 10);
  r.setEnd(t, 150);
  const s = window.getSelection();
  s.removeAllRanges();
  s.addRange(r);
  const segs = Array.from(r.getClientRects()).filter((x) => x.width > 0);
  const tail = segs[segs.length - 1];
  document.dispatchEvent(new MouseEvent("mouseup", {
    bubbles: true, composed: true,
    clientX: tail.right - 2, clientY: tail.top + tail.height / 2,
  }));
});
await page.waitForTimeout(1200);
const probe = await ctx.serviceWorkers()[0].evaluate(async (url) => {
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    return { ok: r.ok, status: r.status, text: (await r.text()).slice(0, 60) };
  } catch (e) {
    return { err: String(e).slice(0, 120) };
  }
}, "http://127.0.0.1:" + API_PORT + "/").catch((e) => ({ evalErr: String(e).slice(0, 90) }));
console.log("  service worker 直连假接口: " + JSON.stringify(probe));
const cfg = await ctx.serviceWorkers()[0].evaluate(async () => {
  const g = await chrome.storage.local.get("state");
  const st = g.state;
  const c = st.configs.find((x) => x.id === st.activeConfigId);
  const m = /^\s*(?:curl\s+)?(?:POST|GET|PUT|PATCH)?\s*(\S+)/m.exec(c.request || "");
  const first = (c.request || "").split("\n").find((l) => /https?:/.test(l)) || "";
  return { id: c.id, name: c.name, hasUrl: /https?:/.test(first), firstLine: (c.request || "").split("\n")[0],
           urlLine: first.trim(), vars: Array.isArray(st.vars) ? st.vars.map((v) => v.name + "=" + v.value) : "not-array" };
});
console.log("  配置: " + JSON.stringify(cfg));
const trig = await page.evaluate(() => {
  const sh = document.getElementById("request-translate-host").shadowRoot;
  const t = sh.querySelector(".rt-trigger");
  const r = t ? t.getBoundingClientRect() : null;
  return { show: !!(t && t.classList.contains("show")), w: r ? Math.round(r.width) : 0 };
});
console.log("  小圆点 " + JSON.stringify(trig));
await page.screenshot({ path: OUT + "/01-selection.png" });
console.log("  01-selection.png");

await page.evaluate(() => {
  const sh = document.getElementById("request-translate-host").shadowRoot;
  sh.querySelector(".rt-trigger").click();
});
// 等到真的出译文再截 —— 固定 sleep 会拍到「请求中…」的空面板
await page.waitForFunction(() => {
  const sh = document.getElementById("request-translate-host").shadowRoot;
  const st = sh.querySelector(".rt-slot-st");
  return st && /完成|失败/.test(st.textContent);
}, { timeout: 15000 }).catch(() => console.log("  (等超时了，仍然截)"));
await page.waitForTimeout(400);
const panel = await page.evaluate(() => {
  const sh = document.getElementById("request-translate-host").shadowRoot;
  const p = sh.querySelector("#rt-panel");
  const r = p ? p.getBoundingClientRect() : null;
  const out = sh.querySelector(".rt-slot-b");
  return {
    show: !!(p && p.classList.contains("show")),
    h: r ? Math.round(r.height) : 0,
    text: out ? out.textContent.slice(0, 30) : "",
  };
});
console.log("  面板 " + JSON.stringify(panel));
await page.waitForTimeout(500);
await page.screenshot({ path: OUT + "/02-panel.png" });
const diag = await page.evaluate(() => {
  const sh = document.getElementById("request-translate-host").shadowRoot;
  const rows = [...sh.querySelectorAll(".rt-diag .d-row")].map((r) =>
    r.querySelector(".d-k").textContent + "=" + r.querySelector(".d-v").textContent);
  const st = sh.querySelector(".rt-slot-st");
  const msg = sh.querySelector(".rt-msg");
  return { status: st ? st.textContent : "", msg: msg ? msg.textContent : "", rows };
});
console.log("  诊断 " + JSON.stringify(diag));
console.log("  02-panel.png");
await page.close();

// ---- 03 / 04：设置页 ----
const opt = await ctx.newPage();
await opt.goto("chrome-extension://" + extId + "/options.html", { waitUntil: "domcontentloaded" });
await opt.waitForTimeout(1400);
await opt.reload({ waitUntil: "domcontentloaded" });
await opt.waitForTimeout(1800);
await opt.evaluate(() => {
  const pv = document.getElementById("panel-preview");
  if (pv) pv.hidden = true;
  const dets = [...document.querySelectorAll("details")];
  for (const d of dets) {
    const s = d.querySelector("summary");
    if (s && s.textContent.includes("这次会发出去的请求")) {
      d.open = true;
      const ta = d.querySelector("textarea, pre, code");
      if (ta) { ta.style.minHeight = "260px"; ta.style.maxHeight = "none"; }
    }
  }
});
await opt.waitForTimeout(700);
await opt.screenshot({ path: OUT + "/03-config.png" });
console.log("  03-config.png");

// 变量页签（是我自己加进去的，这份是变量表，讲「变量可以拖动归类」）
await opt.evaluate(() => {
  const t = document.querySelector('.tab[data-tab="vars"]');
  if (t) t.click();
});
await opt.waitForTimeout(900);
await opt.screenshot({ path: OUT + "/04-vars.png" });
console.log("  04-vars.png");

await ctx.close();
apiSrv.close();
pageSrv.close();
console.log("完成");
