/**
 * 真实浏览器 UI 回归
 * ------------------------------------------------------------------
 * 拿系统里的 Edge 加载这个扩展，真跑一遍：
 *   划词 → 小圆点贴哪儿 → 点开面板 → 顶栏/底栏多高 → 网页缩放后尺寸变不变
 *
 * 纯静态检查（check-globals / check-dom）只能证明「代码能跑、选择器对得上」，
 * 面板到底长什么样、位置对不对，只有真机加载才看得见。
 *
 * 用法：node tools/e2e-ui.mjs
 * 依赖：playwright-core（不下载浏览器，直接用系统 Edge）
 * 没装 Edge 会直接跳过，不算失败。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

/* ------------------------------------------------------------------ */
/* 找 Edge + playwright-core                                           */
/* ------------------------------------------------------------------ */

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable'
];

const PW_CANDIDATES = [
  'playwright-core',
  path.join(
    process.env.USERPROFILE || process.env.HOME || '',
    '.workbuddy/binaries/node/workspace/node_modules/playwright-core'
  )
];

function findEdge() {
  return EDGE_CANDIDATES.find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
}

function loadChromium() {
  for (const p of PW_CANDIDATES) {
    try {
      return require(p).chromium;
    } catch {
      /* 换下一个 */
    }
  }
  return null;
}

const edge = findEdge();
const chromium = edge ? loadChromium() : null;

if (!edge) {
  console.log('没找到 Edge，跳过 UI 测试。');
  process.exit(0);
}
if (!chromium) {
  console.log('没找到 playwright-core，跳过 UI 测试。');
  console.log('装一下：cd ~/.workbuddy/binaries/node/workspace && npm i playwright-core');
  process.exit(0);
}

/* ------------------------------------------------------------------ */
/* 断言                                                                */
/* ------------------------------------------------------------------ */

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`);
  }
}

function near(name, actual, expected, tol, unit) {
  const ok = typeof actual === 'number' && Math.abs(actual - expected) <= tol;
  check(name, ok, `实测 ${fmt(actual)}${unit || ''}，期望 ${expected}±${tol}`);
}

function between(name, actual, lo, hi, unit) {
  const ok = typeof actual === 'number' && actual >= lo && actual <= hi;
  check(name, ok, `实测 ${fmt(actual)}${unit || ''}，期望 ${lo}~${hi}`);
}

const fmt = (v) => (typeof v === 'number' ? v.toFixed(1) : String(v));

/* ------------------------------------------------------------------ */
/* 测试页面                                                            */
/* ------------------------------------------------------------------ */

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>rt-e2e</title>
<style>
  body { margin: 0; padding: 40px; font: 16px/28px "Microsoft YaHei", sans-serif; background: #fff; color: #000; }
  #t { width: 600px; }
</style></head>
<body>
<p id="t">第一行文字稍微长一点，长到能把整段选区的右边界推到很远的地方<br>第二行是中等长度的文字，用来撑出多行选区<br>短短一行</p>
</body></html>`;

/** 慢接口：让请求在飞行中停一会儿，好让我们采样代理状态 */
const SLOW_MS = 1200;

/** 假 OCR 认出来的文字。面板原文区应该出现这一整段 */
/* 假 OCR 接口「认出来」的文字。
   刻意写成真实英文截图的样子：**撇号 + 双引号 + 换行**。
   撇号是这里的主角 —— 模板通常是 `-d '{...JSON...}'`（外层 shell 单引号、
   内层 JSON 字符串），只做 JSON 转义的话撇号会把外层单引号提前闭合，
   请求体从那儿被截断，服务端报 `Unexpected end-of-input in VALUE_STRING`。 */
const OCR_TEXT = 'Pixeldrain\'s free tier: "6.00 GB per day"\nours is already 9.96 GB.';

/** 假「图片直传测试」接口回的译文。和 OCR_TEXT 刻意不一样 ——
    两个接口都会被同一节打到，用同一句话就分不出这条断言是在查哪一边。 */
const IMG_TEST_TEXT = '图片直传测试的假译文';

/** 假 OCR 接口收到的最后一个请求体，用来断言图片真的以 data URL 发过去了 */
let lastOcrRequest = '';
/** 假 OCR 接口被打了几次。用来反证「剪切板里没图时压根不会发请求」 */
let ocrHits = 0;
/** 假翻译接口收到的最后一个请求体。直传模式下 {{image}} 有没有塞进请求，只看这里 */
let lastTextRequest = '';
/** 假翻译接口被打了几次 */
let textHits = 0;
/** 翻译接口**按顺序**记下来的每一条请求（`{ path, body }`）。
    「主请求挂了自动切后备」那节只看这里 —— 只看 lastTextRequest 分不出
    「先发了主请求、挂了之后才发后备」，也看不出「没勾的那条到底发没发」。 */
let textSeq = [];
/** 假「图片直传测试」接口收到的最后一个请求体。设置页那块「测试图片配置」只看这里 */
let lastImgTestRequest = '';
/** 假「图片直传测试」接口被打了几次 */
let imgTestHits = 0;
/** 假接口收到的最后一个请求路径 —— 断言挂了的时候用来判断「请求到底打到哪条路由」 */
let lastPath = '';
/** 「换 model 重试」那一节：/modelfail 收到的 model 名，按顺序记 */
let modelTries = [];
/** 同上，记真发出去的地址 —— 用来验「打码只影响展示：真请求里 key 还是真的」 */
let modelFailUrls = [];

/** 从一段请求体里把 PNG 的宽高抠出来。
    纯 PNG 前 24 字节是定长头：8 字节签名 + 4 字节长度 + 4 字节 "IHDR" + 宽 4 + 高 4。
    框选截图那节靠它量「裁出来的图到底多宽」—— 图是 data URL 塞在请求体里的，
    这是唯一能看见裁剪结果的窗口（content script 跑在隔离世界里，页面钩不到
    它的 canvas.toDataURL）。 */
function pngSizeOf(text) {
  const m = /data:image\/png;base64,([A-Za-z0-9+/=]+)/.exec(text || '');
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 24) return null;
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

/** 慢速**流式**接口：先建连、再一段一段吐，用来量「请求在飞的时候用户切走了」。
    分段数和间隔要够大，大到用户切完之后它还在吐 —— 不然那种「半路的流糊到
    别人脸上」的问题根本采不到。 */
const STREAM_CHUNKS = 3;
const STREAM_GAP_MS = 400;

/** 长流式接口：分段多得足够把面板撑出滚动条，专供「输出不许甩着滚动条跑」那一节。
    **每一片都要不一样**：引擎的累加器有一条「重复帧忽略」规则（防的是把「整段累计
    文本」当增量发的那种接口），发同一句 24 遍的话从第 2 片起会被整批丢掉（真踩过）。 */
const LONG_CHUNKS = 24;
const LONG_GAP_MS = 60;
const LONG_CHUNK_TEXT = '这一段用来把面板撑出滚动条的假译文故意写得很长，重复很多遍也不会变短。';

const server = http.createServer(async (req, res) => {
  lastPath = req.url || '';
  if (req.url && req.url.startsWith('/slow')) {
    await new Promise((r) => setTimeout(r, SLOW_MS));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('慢速响应');
    return;
  }
  // 长流式接口：分段多、间隔短，专门把面板撑出滚动条。
  // **必须排在 /stream 前面** —— 它自己就以 /stream 开头，不然会被下面那条吃掉。
  if (req.url && req.url.startsWith('/streamlong')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastTextRequest = body;
      textHits += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      let i = 0;
      const timer = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(timer);
          return;
        }
        i += 1;
        res.write(
          'data: ' +
            JSON.stringify({ choices: [{ delta: { content: `第${i}段：${LONG_CHUNK_TEXT}` } }] }) +
            '\n\n'
        );
        if (i >= LONG_CHUNKS) {
          clearInterval(timer);
          res.end('data: [DONE]\n\n');
        }
      }, LONG_GAP_MS);
      res.on('close', () => clearInterval(timer));
    });
    return;
  }
  // SSE 假接口：引擎是看 Content-Type 里的 event-stream 认流式的，
  // 片段按 choices[0].delta.content 走（AUTO_PATHS 里那条）。
  if (req.url && req.url.startsWith('/stream')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastTextRequest = body;
      textHits += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      let i = 0;
      const timer = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(timer);
          return;
        }
        i += 1;
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: '分段' + i } }] }) + '\n\n');
        if (i >= STREAM_CHUNKS) {
          clearInterval(timer);
          res.end('data: [DONE]\n\n');
        }
      }, STREAM_GAP_MS);
      // 注意挂的是 res 不是 req：Node 16 起 IncomingMessage 的 'close' 在
      // **请求体收完**时就触发（不是连接断开），挂 req 上等于一起手就掐掉定时器，
      // 结果一个分片都吐不出去、响应永远不结束（踩过）。
      res.on('close', () => clearInterval(timer));
    });
    return;
  }
  // 「这就是硅基流动那种 400」：原样复刻真实撞过的报错体。
  // DeepSeek-OCR 的 max_seq_len 只有 8192，而提示词 + max_tokens 是加在一起算的。
  // 放在 /ocr 前面判，不然会被上面那条 startsWith('/ocr') 吃掉。
  if (req.url && req.url.startsWith('/ocr-reject')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastOcrRequest = body;
      ocrHits += 1;
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        code: 20015,
        message: 'max_tokens (8192) have exceeded max_seq_len (8192) limit.',
        data: null
      }));
    });
    return;
  }
  // 假「图片直传测试」接口：设置页在勾了「禁用外置 OCR」之后那块「测试」打的就是它。
  // **故意回 SSE**（`stream: true` 的真接口就长这样，Ling 那种）—— 实机上踩过：
  // 设置页原来自个儿 JSON.parse(res.text())，于是当场报「返回的不是 JSON」，
  // 而面板走引擎翻得好好的。这里把请求体记下来 —— 图片有没有以 data URL 进去、
  // 目标语言有没有填上，只看这里。
  // 放在 /ocr 前面判：不然会被上面那条 startsWith('/ocr') 吃掉。
  if (req.url && req.url.startsWith('/imgtest')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastImgTestRequest = body;
      imgTestHits += 1;
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
      // 分三帧喂，中间那帧还把事件切成两半 —— 跨分片拼接也一起测了
      const frames = [
        'data: {"choices":[{"delta":{"content":"' + IMG_TEST_TEXT.slice(0, 4) + '"}}]}\n\n',
        'data: {"choices":[{"delta":{"cont',
        'ent":"' + IMG_TEST_TEXT.slice(4) + '"}}]}\n\ndata: [DONE]\n\n'
      ];
      for (const f of frames) res.write(f);
      res.end();
    });
    return;
  }
  // 假 OCR 接口：回一个标准 chat.completions 结构（硅基流动就是照这个格式回的），
  // 顺便把请求体记下来 —— 「图片到底有没有以 data URL 发出去」只有这里看得到。
  if (req.url && req.url.startsWith('/ocr')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastOcrRequest = body;
      ocrHits += 1;
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: OCR_TEXT }, finish_reason: 'stop' }]
      }));
    });
    return;
  }
  // 纯文本假译文：面板真要发请求时用它，别去够真实网络（会挂 20 秒，
  // 还会顺手把代理租约一直攥着，污染后面量代理的那一节）。
  // 顺手把请求体记下来 —— 直传模式下 {{image}} 有没有塞进去，只有这里看得到。
  if (req.url && req.url.startsWith('/text')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastTextRequest = body;
      textHits += 1;
      textSeq.push({ path: req.url, body });
      // 默认回「本地假译文」；带 ?tag=xxx 时缀一个标记 ——
      // 「换配置不重发」那一节靠它认「切回来看到的是这个配置自己的译文」，
      // 而不是上一个配置留在界面上的东西。
      const tag = new URL(req.url, 'http://x').searchParams.get('tag');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('本地假译文' + (tag ? '【' + tag + '】' : ''));
    });
    return;
  }
  /* 「换 model 重试」专用：请求体里 model 是 `bad-model` 就回 500（第一次必挂），
     是别的就正常回译文。这样「第一个失败→自动试第二个→成功」整条链都能真跑一遍。
     收到的 model 按顺序记下来，断言「确实先发了 bad 再发 good」。 */
  if (req.url && req.url.startsWith('/modelfail')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let model = '';
      try { model = JSON.parse(body).model || ''; } catch { /* 不是 JSON 就算了 */ }
      modelTries.push(model);
      modelFailUrls.push(req.url);
      if (model === 'bad-model') {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: { message: 'model not available' } }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ choices: [{ message: { content: '重试后的译文【' + model + '】' } }] }));
    });
    return;
  }
  /* 「后备请求轮换」专用：主请求的那条打过来必然 500 且抠不出 text，
     于是后台会自动去试勾上的后备。照旧记请求体 + 顺序。
     和 /directfail 分开是因为那一条有自己的断言（「重发的是哪张图」），
     混在一起两边数不清。 */
  if (req.url && req.url.startsWith('/chainfail')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastTextRequest = body;
      textHits += 1;
      textSeq.push({ path: req.url, body });
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'main request down' } }));
    });
    return;
  }
  /* 「直传失败后点 ↻」专用：怎么发都回 500，好把面板停在失败态，
     同时照旧把请求体记下来 —— 「重试重发的是哪张图」只看这里。 */
  if (req.url && req.url.startsWith('/directfail')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      lastTextRequest = body;
      textHits += 1;
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: 'image endpoint down' } }));
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

/**
 * 往**系统剪切板**里塞一张图 / 一段文字，模拟用户按 Win + Shift + S 截图。
 *
 * 为什么不从页面里 navigator.clipboard.write —— 那要求页面是安全上下文、
 * 还要有 clipboard-write 权限，多一层不确定性；而且我们要验的恰恰是
 * 「扩展能不能读到系统剪切板」，从系统这边放进去最接近真实情况。
 *
 * 塞不进去（非 Windows / 没有 PowerShell）返回 false，调用方跳过这一段。
 */
function setClipboard(kind, value) {
  if (process.platform !== 'win32') return false;
  const esc = String(value).replace(/'/g, "''");
  const script = kind === 'image'
    ? "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; " +
      "$i=[System.Drawing.Image]::FromFile('" + esc + "'); " +
      '[System.Windows.Forms.Clipboard]::SetImage($i); $i.Dispose()'
    : 'Add-Type -AssemblyName System.Windows.Forms; ' +
      "[System.Windows.Forms.Clipboard]::SetText('" + esc + "')";
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
      stdio: 'ignore'
    });
    return true;
  } catch {
    return false;
  }
}

const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

/* ------------------------------------------------------------------ */
/* 启动 Edge，加载扩展                                                 */
/* ------------------------------------------------------------------ */

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-e2e-'));
console.log(`Edge: ${edge}`);
console.log(`扩展: ${ROOT}\n`);

let ctx;
try {
  ctx = await chromium.launchPersistentContext(profile, {
    executablePath: edge,
    headless: true,
    viewport: null, // 用真实窗口尺寸，别开设备模拟 —— 那会干扰网页缩放
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--window-size=1200,900',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  /* ---- 等 service worker 起来 ---- */
  let sw = ctx.serviceWorkers()[0];
  if (!sw) {
    try {
      sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    } catch {
      sw = null;
    }
  }
  check('扩展已加载（service worker 起来了）', !!sw);
  if (!sw) throw new Error('扩展没加载，后面没法测');

  /* ---- 打开测试页 ---- */
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForTimeout(600); // 等内容脚本注入 + 取设置

  const injected = await page.evaluate(() => !!document.getElementById('request-translate-host'));
  check('内容脚本已注入', injected);
  if (!injected) throw new Error('内容脚本没进来');

  /* ------------------------------------------------------------------ */
  /* 工具：读取面板几何                                                  */
  /* ------------------------------------------------------------------ */

  const measure = () =>
    page.evaluate(() => {
      const host = document.getElementById('request-translate-host');
      const root = host && host.shadowRoot;
      const q = (s) => (root ? root.querySelector(s) : null);

      const box = (el) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          x: r.x,
          y: r.y,
          w: r.width,
          h: r.height,
          right: r.right,
          bottom: r.bottom,
          display: cs.display,
          fontSize: cs.fontSize,
          bg: cs.backgroundColor,
          radius: cs.borderRadius
        };
      };

      const sel = window.getSelection();
      let selRect = null;
      let tailRect = null;
      if (sel && sel.rangeCount) {
        const range = sel.getRangeAt(0);
        const b = range.getBoundingClientRect();
        selRect = { left: b.left, right: b.right, top: b.top, bottom: b.bottom, w: b.width };
        const segs = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
        if (segs.length) {
          const t = segs[segs.length - 1];
          tailRect = { left: t.left, right: t.right, top: t.top, bottom: t.bottom, w: t.width };
        }
      }

      const panel = q('.rt-panel');
      const trig = q('.rt-trigger');
      const iconPath = q('.rt-trigger .rt-ico svg path');
      return {
        trigger: box(trig),
        triggerCls: trig ? trig.className : '',
        triggerHasSvg: !!q('.rt-trigger svg'),
        triggerPathD: iconPath ? iconPath.getAttribute('d') : '',
        head: box(q('.rt-head')),
        foot: box(q('.rt-foot')),
        src: box(q('.rt-src')),
        out: box(q('.rt-out')),
        panel: box(panel),
        panelZs: panel ? panel.style.getPropertyValue('--rt-zs') : '',
        panelStyleW: panel ? panel.style.width : '',
        panelShown: panel ? panel.classList.contains('show') : false,
        light: panel ? panel.classList.contains('light') : false,
        selRect,
        tailRect,
        innerW: window.innerWidth,
        innerH: window.innerHeight,
        dpr: window.devicePixelRatio
      };
    });

  /* ------------------------------------------------------------------ */
  /* 1. 划词 → 小圆点贴哪儿                                              */
  /* ------------------------------------------------------------------ */

  console.log('1. 划词，看小圆点落在哪');

  // 从第一行第 3 个字选到「短短一行」的末尾，并在末尾位置松手（模拟正向拖选）
  // 松手点就是按钮该贴的地方（贴鼠标那一版），所以连它一起返回
  const selectText = () =>
    page.evaluate(() => {
      const p = document.getElementById('t');
      const [t0, , , , t2] = p.childNodes;
      const range = document.createRange();
      range.setStart(t0, 2);
      range.setEnd(t2, t2.textContent.length);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);

      const segs = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
      const tail = segs[segs.length - 1];
      const whole = range.getBoundingClientRect();

      // 在选区末尾松手
      const mouseX = tail.right - 2;
      const mouseY = tail.top + tail.height / 2;
      document.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          composed: true,
          clientX: mouseX,
          clientY: mouseY
        })
      );
      return {
        segCount: segs.length,
        tailRight: tail.right,
        tailBottom: tail.bottom,
        wholeRight: whole.right,
        mouseX,
        mouseY
      };
    });

  /** 请求跑完，面板进入稳定状态（底部状态栏不再是「…」） */
  const settle = () =>
    page
      .waitForFunction(
        () => {
          const root = document.getElementById('request-translate-host')?.shadowRoot;
          const msg = root && root.querySelector('.rt-msg');
          const t = msg ? msg.textContent.trim() : '';
          return t && t !== '…' && t !== '请求中…';
        },
        null,
        { timeout: 20000 }
      )
      .catch(() => {});

  const sel = await selectText();

  await page.waitForTimeout(300);
  const m1 = await measure();

  check('小圆点出现了', !!(m1.trigger && m1.trigger.display !== 'none'), `display=${m1.trigger && m1.trigger.display}`);
  near('小圆点尺寸固定 45px', m1.trigger && m1.trigger.w, 45, 1, 'px');

  if (m1.trigger) {
    // 贴鼠标这一版：按钮就落在松手点右下方 14px 处（MOUSE_GAP，见 content.js）
    near('小圆点贴的正是鼠标松手的位置（右下 14px）', m1.trigger.x - sel.mouseX, 14, 2, 'px');
    near('纵向也一样', m1.trigger.y - sel.mouseY, 14, 2, 'px');
    const farFromWhole = sel.wholeRight - sel.tailRight;
    check(
      '没被整段选区的右边界带跑',
      farFromWhole > 100 && m1.trigger.x < sel.wholeRight - 100,
      `整段右边界 ${fmt(sel.wholeRight)}，末尾 ${fmt(sel.tailRight)}，圆点 x=${fmt(m1.trigger.x)}`
    );
  }

  /* ------------------------------------------------------------------ */
  /* 1.5 Shadow DOM 里划词（B 站评论区那种 Web Component）                */
  /* ------------------------------------------------------------------ */

  // B 站评论区是 <bili-comments> + shadowRoot。选区落在 Shadow DOM 里会被重定目标
  // 到 document 层：isCollapsed 变 true、range 的几何量全丢（rect 全 0、clientRects
  // 为空），只有 toString() 还拿得到文字。以前这两条都把结果直接挡掉，表现就是
  // 「划视频标题弹按钮、划评论区评论不弹」。这里钉住：照样弹，而且贴鼠标松开的位置。
  console.log('\n1.5 Shadow DOM 里划词');

  // 这一段必须用真鼠标拖，不能像第 1 节那样手工 createRange：脚本构造的选区
  // 自己持有 Shadow 内部节点，浏览器不做重定目标，几何量是好的；只有真实拖拽
  // 出来的选区才是「rect 全 0」那个形态。
  const shBox = await page.evaluate(() => {
    const hostEl = document.createElement('div');
    hostEl.id = 'rt-shadow-host';
    hostEl.style.cssText =
      'position:fixed;left:60px;bottom:60px;width:300px;padding:8px;background:#fff;border:1px solid #ccc;z-index:5';
    document.body.appendChild(hostEl);
    const sr = hostEl.attachShadow({ mode: 'open' });
    sr.innerHTML = '<div style="font:16px/26px sans-serif">影子里的评论文字，用来验划词</div>';
    const r = sr.querySelector('div').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });

  const shFrom = { x: shBox.x + 4, y: shBox.y + shBox.h / 2 };
  const shTo = { x: shBox.x + shBox.w - 4, y: shFrom.y };
  await page.mouse.move(shFrom.x, shFrom.y);
  await page.mouse.down();
  await page.mouse.move(shTo.x, shTo.y, { steps: 14 });
  await page.mouse.up();

  const shadowProbe = {
    ...(await page.evaluate(() => {
      const s = window.getSelection();
      const out = { text: s.toString().trim(), geoW: 0, geoH: 0, rectCount: 0, collapsed: s.isCollapsed };
      if (s.rangeCount) {
        const rg = s.getRangeAt(0);
        const b = rg.getBoundingClientRect();
        out.geoW = b.width;
        out.geoH = b.height;
        out.rectCount = rg.getClientRects().length;
      }
      return out;
    })),
    mx: shTo.x
  };

  check(
    '前置条件：Shadow DOM 的选区确实拿不到几何量',
    shadowProbe.geoW === 0 && shadowProbe.geoH === 0 && shadowProbe.rectCount === 0,
    `文字「${shadowProbe.text}」，rect ${fmt(shadowProbe.geoW)}x${fmt(shadowProbe.geoH)}，` +
      `clientRects ${shadowProbe.rectCount}，isCollapsed=${shadowProbe.collapsed}`
  );
  check('前置条件：这种情况下文字仍然拿得到', shadowProbe.text.length > 0, `文字「${shadowProbe.text}」`);

  await page.waitForTimeout(300);
  const mSh = await measure();

  check(
    'Shadow DOM 里划词也弹按钮',
    !!(mSh.trigger && mSh.trigger.display !== 'none'),
    `display=${mSh.trigger && mSh.trigger.display}`
  );
  if (mSh.trigger && mSh.trigger.display !== 'none') {
    between('没几何量时贴鼠标松开的位置', mSh.trigger.x - shadowProbe.mx, 2, 20, 'px');
  }

  // 去掉 isCollapsed 判断之后，「单击、没选中文字」不能跟着乱弹
  await page.mouse.click(200, 200);
  await page.waitForTimeout(300);
  const mEmpty = await measure();
  check(
    '单击（没选中文字）还是不弹',
    !mEmpty.trigger || mEmpty.trigger.display === 'none',
    `display=${mEmpty.trigger && mEmpty.trigger.display}`
  );

  // 收拾干净：影子宿主和残留选区都不能留给后面的小节
  await page.evaluate(() => {
    const h = document.getElementById('rt-shadow-host');
    if (h) h.remove();
  });
  await selectText();
  await page.waitForTimeout(200);

  /* ------------------------------------------------------------------ */
  /* 2. 点开面板，量顶栏底栏                                             */
  /* ------------------------------------------------------------------ */

  console.log('\n2. 点开面板，量尺寸');

  await page.click('.rt-trigger', { force: true });
  await page.waitForTimeout(700); // 面板立刻显示，请求还在飞，不影响量尺寸

  const m2 = await measure();
  check('面板显示了', m2.panelShown);

  if (m2.panelShown) {
    near('面板宽度 = 设置值 460', m2.panel.w, 460, 2, 'px');
    between('顶栏高度（原 ~65px）', m2.head && m2.head.h, 28, 50, 'px');
    between('底栏高度（原 ~45px）', m2.foot && m2.foot.h, 20, 38, 'px');
    check(
      '顶栏比底栏高（控件在顶上）',
      m2.head && m2.foot && m2.head.h > m2.foot.h,
      `顶 ${fmt(m2.head && m2.head.h)} / 底 ${fmt(m2.foot && m2.foot.h)}`
    );

    const chromeH = (m2.head ? m2.head.h : 0) + (m2.foot ? m2.foot.h : 0);
    check('上下两条杠合计不超 80px', chromeH < 80, `合计 ${fmt(chromeH)}px`);

    console.log(
      `     面板 ${fmt(m2.panel.w)}×${fmt(m2.panel.h)}｜顶栏 ${fmt(m2.head.h)}｜原文区 ${fmt(
        m2.src.h
      )}｜正文区 ${fmt(m2.out.h)}｜底栏 ${fmt(m2.foot.h)}`
    );
  }

  /* ------------------------------------------------------------------ */
  /* 3. 网页缩放：面板尺寸必须纹丝不动                                    */
  /* ------------------------------------------------------------------ */

  console.log('\n3. 把网页缩放到 150%，看面板有没有跟着变大');

  // 先在 100% 下等请求跑完，这样两次量的才是同一个状态
  await settle();
  await page.waitForTimeout(200);
  const m2b = await measure();

  const tabId = await sw.evaluate(async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs[0].id;
  });

  await sw.evaluate((id) => chrome.tabs.setZoom(id, 1.5), tabId);
  await page.waitForTimeout(600);

  const m3 = await measure();
  check('页面缩放已生效（window.innerWidth 变化）', m3.innerW !== m1.innerW, `${fmt(m1.innerW)} → ${fmt(m3.innerW)}`);

  const zs = parseFloat(m3.panelZs);
  near('面板拿到了补偿系数 1/1.5', zs, 1 / 1.5, 0.01);

  // 物理尺寸 = 页面 CSS 像素 × 页面缩放。补偿对了，这个值就不该变。
  const phys = (v, z) => v * z;
  near('面板物理宽度不变', phys(m3.panel.w, 1.5), m2b.panel.w, 3, 'px');
  near('顶栏物理高度不变', phys(m3.head.h, 1.5), m2b.head.h, 2, 'px');
  near('底栏物理高度不变', phys(m3.foot.h, 1.5), m2b.foot.h, 2, 'px');
  near('正文区物理高度不变', phys(m3.out.h, 1.5), m2b.out.h, 3, 'px');

  // 缩放后面板要重新贴到选区末尾（这条能抓到「坐标按旧缩放算」的错误）
  if (m3.tailRect) {
    const gapPhys = (m3.panel.x - m3.tailRect.right) * 1.5;
    near('缩放后面板重新贴到选区末尾（间距 14 物理 px）', gapPhys, 14, 5, 'px');
    check(
      '缩放后面板没跑出视口',
      m3.panel.x >= 0 && m3.panel.x + m3.panel.w <= m3.innerW + 1,
      `x=${fmt(m3.panel.x)} 宽=${fmt(m3.panel.w)} 视口=${fmt(m3.innerW)}`
    );
  }

  console.log(
    `     面板 100%：${fmt(m2b.panel.w)} 物理 px｜150%：${fmt(m3.panel.w)} CSS px = ${fmt(
      phys(m3.panel.w, 1.5)
    )} 物理 px`
  );

  // 缩放后重新划词，小圆点也要保持尺寸和「贴着字」
  await page.keyboard.press('Escape'); // 关掉面板，免得挡住
  await page.waitForTimeout(150);
  const sel3 = await selectText();
  await page.waitForTimeout(300);
  const m3b = await measure();

  check('缩放后小圆点能正常出现', !!(m3b.trigger && m3b.trigger.display !== 'none'));
  if (m3b.trigger && m3b.trigger.display !== 'none') {
    near('缩放后小圆点物理尺寸仍是 45', phys(m3b.trigger.w, 1.5), 45, 1.5, 'px');
    // 物理上还是离指针 14px（CSS 里那 14px 也跟着 1/zoom 缩了）
    const dxPhys = (m3b.trigger.x - sel3.mouseX) * 1.5;
    near('缩放后仍然贴鼠标（物理 14px）', dxPhys, 14, 3, 'px');
  }

  // 小圆点还开着的时候缩回 100%：缩放事件应该把它重算到新位置
  await sw.evaluate((id) => chrome.tabs.setZoom(id, 1), tabId);
  await page.waitForTimeout(500);
  // 鼠标刚才点过按钮，缩放回 100% 后按钮又正好挪回鼠标底下 —— 会命中 :hover（×1.08）
  await page.mouse.move(2, 2);
  await page.waitForTimeout(250);
  const mLive = await measure();
  check(
    '缩回 100% 时小圆点没被缩放事件弄丢',
    !!(mLive.trigger && mLive.trigger.display !== 'none')
  );
  near('缩回后小圆点物理尺寸仍是 45', mLive.trigger ? mLive.trigger.w : NaN, 45, 1.5, 'px');

  const sel4 = await selectText();
  await page.waitForTimeout(300);
  const m4 = await measure();
  near('缩回 100% 后仍然贴鼠标', m4.trigger.x - sel4.mouseX, 14, 2, 'px');

  /* ------------------------------------------------------------------ */
  /* 4. 改字号，顶栏底栏应该等比跟着走（说明尺寸是按字号走的，不是写死的）  */
  /* ------------------------------------------------------------------ */

  console.log('\n4. 把面板字号调到 14 / 32，看两条杠跟不跟');

  const setFontSize = (v) =>
    sw.evaluate(async (fs) => {
      const { state } = await chrome.storage.local.get('state');
      state.settings = { ...(state.settings || {}), fontSize: fs };
      await chrome.storage.local.set({ state });
      return true;
    }, v);

  // 面板此时是关的（上一段按了 Escape），重新划词把它叫出来
  await selectText();
  await page.waitForTimeout(200);
  await page.click('.rt-trigger', { force: true });
  await settle();

  await setFontSize(14);
  await page.waitForTimeout(500);
  const mSmall = await measure();

  await setFontSize(32);
  await page.waitForTimeout(500);
  const mBig = await measure();

  // 判据是「跟不跟字号走」，不是某个绝对值：14/20 ≈ 0.7，32/20 = 1.6
  check(
    '字号 14 时顶栏跟着缩（≤ 默认的 80%）',
    mSmall.head.h < m2b.head.h * 0.8,
    `14→${fmt(mSmall.head.h)}px，20→${fmt(m2b.head.h)}px`
  );
  check(
    '字号 14 时底栏跟着缩',
    mSmall.foot.h < m2b.foot.h * 0.8,
    `14→${fmt(mSmall.foot.h)}px，20→${fmt(m2b.foot.h)}px`
  );
  check(
    '字号 32 时顶栏跟着涨（≥ 默认的 145%）',
    mBig.head.h > m2b.head.h * 1.45,
    `32→${fmt(mBig.head.h)}px`
  );
  check(
    '字号 32 时底栏跟着涨',
    mBig.foot.h > m2b.foot.h * 1.45,
    `32→${fmt(mBig.foot.h)}px`
  );

  console.log(
    `     顶栏 / 底栏：字号 14 → ${fmt(mSmall.head.h)} / ${fmt(mSmall.foot.h)}px｜字号 20 → ${fmt(
      m2b.head.h
    )} / ${fmt(m2b.foot.h)}px｜字号 32 → ${fmt(mBig.head.h)} / ${fmt(mBig.foot.h)}px`
  );

  await setFontSize(20);
  await page.waitForTimeout(400);

  /* ------------------------------------------------------------------ */
  /* 5. 设置页：打得开、语言下拉是真的                                   */
  /* ------------------------------------------------------------------ */
  /* 静态检查只能证明 id 对得上，东西到底渲没渲染出来、能不能存下去，
     还是得真开一次设置页。 */

  const extId = new URL(sw.url()).host;
  const errors = [];
  const opt = await ctx.newPage();
  opt.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  opt.on('pageerror', (e) => errors.push(String((e && e.message) || e)));

  await opt.goto(`chrome-extension://${extId}/options.html`, { waitUntil: 'load' });
  await opt.waitForSelector('#cfg-list .cfg-item', { timeout: 8000 });
  await opt.waitForTimeout(200);

  check('设置页打得开、没报错', errors.length === 0, errors.join(' | '));

  /* ---- 说明文字的「不再显示」（kniph 2026-10-14：「这种注释太多了」）----
     每条静态说明都该有个按钮；点过之后**永久收起**（存 settings.hiddenHints，reload 也在）。
     测完把它清掉，别把这条状态留给后面的小节。 */
  const hintButtons = await opt.evaluate(() => {
    const list = [...document.querySelectorAll('[data-hint]')];
    return {
      count: list.length,
      missing: list.filter((el) => !el.querySelector('.hint-hide')).map((el) => el.dataset.hint),
      ids: list.map((el) => el.dataset.hint)
    };
  });
  check('每条说明都补上了「不再显示」按钮',
    hintButtons.count >= 15 && hintButtons.missing.length === 0,
    `${hintButtons.count} 条｜缺按钮：${hintButtons.missing.join(',') || '（无）'}`);
  check('id 不重复（它进存档，重了会连坐）',
    new Set(hintButtons.ids).size === hintButtons.ids.length, hintButtons.ids.join(','));

  const HIDE_ID = 'set-maxh';
  await opt.evaluate(() => document.querySelector('.tab[data-tab="settings"]')?.click());
  await opt.waitForTimeout(200);
  const hintBefore = await opt.evaluate((id) => {
    const el = document.querySelector(`[data-hint="${id}"]`);
    return { display: getComputedStyle(el).display, hasBtn: !!el.querySelector('.hint-hide') };
  }, HIDE_ID);
  check('（脚手架）这条说明本来是露着的、按钮在', hintBefore.display !== 'none' && hintBefore.hasBtn,
    JSON.stringify(hintBefore));

  await opt.evaluate((id) => document.querySelector(`[data-hint="${id}"] .hint-hide`).click(), HIDE_ID);
  await opt.waitForTimeout(900);
  const afterHide = await opt.evaluate(async (id) => {
    const el = document.querySelector(`[data-hint="${id}"]`);
    const { state } = await chrome.storage.local.get('state');
    return {
      display: getComputedStyle(el).display,
      saved: state.settings.hiddenHints || [],
      oldKey: 'ocrHintHidden' in state.settings,
      othersVisible: [...document.querySelectorAll('[data-hint]')].filter(
        (x) => x.dataset.hint !== id && getComputedStyle(x).display !== 'none'
      ).length
    };
  }, HIDE_ID);
  check('点「不再显示」当场收起', afterHide.display === 'none', JSON.stringify(afterHide));
  check('记进了 settings.hiddenHints 并落盘', afterHide.saved.includes(HIDE_ID), JSON.stringify(afterHide.saved));
  check('只收起那一条，别的说明不受影响', afterHide.othersVisible > 0, String(afterHide.othersVisible));
  check('老的那个 boolean 键（ocrHintHidden）不再写进存档', afterHide.oldKey === false);

  await opt.reload();
  await opt.waitForTimeout(900);
  await opt.evaluate(() => document.querySelector('.tab[data-tab="settings"]')?.click());
  await opt.waitForTimeout(200);
  check('重新打开设置页它仍然是收着的（永久生效，不是本次会话）',
    await opt.evaluate((id) => getComputedStyle(document.querySelector(`[data-hint="${id}"]`)).display === 'none', HIDE_ID));

  /* 「不再显示」之后没有回头路 —— 那个按钮得在设置页给一个。收着的时候它自己藏掉（没藏过说明
     时零噪音），藏过才出现；点一下把 `hiddenHints` 整个清空，那条说明当场回来。 */
  const restoreBtn = await opt.evaluate(() => {
    const b = document.querySelector('#btn-restore-hints');
    return { exists: !!b, shown: b ? !b.hidden : false };
  });
  check('藏过说明之后「把说明放回来」那个按钮出现着（在设置页页脚）',
    restoreBtn.exists && restoreBtn.shown, JSON.stringify(restoreBtn));

  await opt.evaluate(() => document.querySelector('#btn-restore-hints').click());
  await opt.waitForTimeout(400);
  const afterRestore = await opt.evaluate(async (id) => {
    const { state } = await chrome.storage.local.get('state');
    return {
      display: getComputedStyle(document.querySelector(`[data-hint="${id}"]`)).display,
      hiddenHints: state.settings.hiddenHints || [],
      btnHidden: document.querySelector('#btn-restore-hints').hidden
    };
  }, HIDE_ID);
  check('点它那条说明当场回来', afterRestore.display !== 'none', JSON.stringify(afterRestore));
  check('存档里的 hiddenHints 整个清空了（只影响这一项，不连带别的设置）',
    afterRestore.hiddenHints.length === 0, JSON.stringify(afterRestore.hiddenHints));
  check('一条都没藏了 → 那个按钮自己藏回去',
    afterRestore.btnHidden === true, String(afterRestore.btnHidden));

  // 收拾干净
  await opt.evaluate(async (id) => {
    const { state } = await chrome.storage.local.get('state');
    state.settings.hiddenHints = (state.settings.hiddenHints || []).filter((x) => x !== id);
    await chrome.storage.local.set({ state });
  }, HIDE_ID);
  await opt.reload();
  await opt.waitForTimeout(800);
  check('清掉存档之后它又回来了（机制可逆）',
    await opt.evaluate((id) => !document.querySelector(`[data-hint="${id}"]`).classList.contains('hint-off'), HIDE_ID));
  await opt.evaluate(() => document.querySelector('.tab[data-tab="configs"]')?.click());
  await opt.waitForTimeout(200);

  /* ---- 三处左栏同一套行（kniph 2026-10-14：「统一成同样的操作逻辑，尽量复用代码」）----
     行 = 手柄 + 可点的主体 + ↑↓；不可排序的那栏（OCR 供应商）放**同宽空位**。
     所以「行宽 − 条目宽」三处必须一样 —— 分量三次（三个列表不在同一个模式下同时可见）。 */
  const cfgRowChrome = await opt.evaluate(() =>
    [...document.querySelectorAll('#cfg-list .cfg-row')].map((r) => ({
      rowH: Math.round(r.getBoundingClientRect().height),
      chrome: Math.round(r.getBoundingClientRect().width - r.querySelector('.cfg-item').getBoundingClientRect().width),
      grips: r.querySelectorAll('.cfg-grip').length,
      mv: r.querySelectorAll('.cfg-mv-btn').length
    }))
  );
  check('（脚手架）配置列表有行可量', cfgRowChrome.length >= 2, String(cfgRowChrome.length));
  check('配置列表的行 = 手柄 + 条目 + 两枚 ↑↓',
    cfgRowChrome.every((r) => r.grips === 1 && r.mv === 2), JSON.stringify(cfgRowChrome[0]));
  let imgCfgRowChrome = [];

  /* ---- 密钥变量的值默认打码（别让设置页截图带走 Key） ----------------------
     配置栏和 OCR 的请求预览早就把 Key 打码了（lib/engine.js 的 maskRequest），
     变量这一栏作为「源头」不能反着来。判据是**变量名里含 key**（不区分大小写）：
     这里新加一条变量试：默认藏、点眼睛能看、再点藏回去，改名之后状态跟着重算。
     测完把这条删掉，别留给后面的小节。 */
  // 先切到「变量」页签（默认激活的不是它，不切的话按钮量不到尺寸）
  await opt.evaluate(() => {
    document.querySelector('.tab[data-tab="vars"]')?.click();
  });
  await opt.waitForTimeout(150);

  /* 切过来的时候，**编辑态**的空值输入框也得是正常高度 —— 不能扁成一条缝。
     踩过：变量栏的值是 textarea、按内容撑高，但初始化时这一栏还是 display:none，
     scrollHeight 量出来是 0，硬写就把高度写成 0px；切过来之后一直缩着，得手点一下才恢复
     （kniph 报的「不动这个框就扁成一条缝」）。这条量的是**真人看到的样子**。
     （默认没有哪条在编辑态 —— 点开一条再来量。） */
  await opt.evaluate(() => {
    document.querySelector('#vars-body .var-row')?.click();
  });
  await opt.waitForTimeout(150);
  const varBoxHeights = await opt.evaluate(() =>
    Array.from(document.querySelectorAll('#vars-body .var-row.editing textarea[data-kind="value"]')).map(
      (el) => el.getBoundingClientRect().height
    )
  );
  check(
    '点开一条，空值框也是正常一行高（没被量成一条缝）',
    varBoxHeights.length > 0 && varBoxHeights.every((h) => h >= 24),
    JSON.stringify(varBoxHeights)
  );

  /* ---- 变量栏：卡片网格 + 点击编辑（kniph 2026-10-14：「像卡片一样排列，
     一目了然，方便查找」）----
     一轮教训：一张表（名字列被压瘦）→ 上下两行（13 条摊成 26 行）→ 一行一条（仍要滚 13 下）。
     **关键是二维**：一行一条怎么压高度，查找都得靠滚动。
     默认存档只有一条变量，量不出「几列」—— 先塞够变量再量，量完**还原成默认那条**
     （后面所有小节都跑在这份存档上）。上面那步把唯一那条点开了，
     下面的 reload 顺带把编辑态重置掉。 */
  await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    const names = ['apiKey', 'SILICONFLOW_CN_API_KEY', 'model', 'target', 'DEEPSEEK_BASE_URL', '翻'];
    state.vars = names.map((n, i) => ({ name: n, value: i === 5 ? '' : 'sk-' + 'x'.repeat(20 + i * 7) }));
    await chrome.storage.local.set({ state });
  });
  await opt.reload();
  await opt.waitForTimeout(600);
  await opt.evaluate(() => document.querySelector('.tab[data-tab="vars"]')?.click());
  await opt.waitForTimeout(200);

  const varGrid = await opt.evaluate(() => {
    const list = document.querySelector('#vars-body');
    const cards = [...list.querySelectorAll('.var-row')];
    const tops = cards.map((c) => Math.round(c.getBoundingClientRect().top));
    // 同一行的卡片 = top 相同；列数 = 不同 top 的个数（卡片高度一致时才准）
    const heights = [...new Set(cards.map((c) => Math.round(c.getBoundingClientRect().height)))];
    const cols = new Set(tops).size;
    const first = cards[0];
    return {
      total: cards.length,
      cols,
      heights,
      display: getComputedStyle(list).display,
      // 值两行：摘要高度该容得下两行 11.5px 文字
      subH: Math.round(first.querySelector('.var-sub').getBoundingClientRect().height),
      cardW: Math.round(first.getBoundingClientRect().width),
      /* 网格列是并排的，所以「第一张卡离容器右边界多远」和溢不溢出无关 ——
         真要判溢出看**最宽的那张卡有没有顶出容器右边界**（grid 子项 min-width:auto
         遇上长 token 就该顶出去，这是加 `.var-main { min-width: 0 }` 的原因）。 */
      rightMost: Math.max(...cards.map((c) => Math.round(c.getBoundingClientRect().right))),
      listRight: Math.round(list.getBoundingClientRect().right),
      // 值的摘要该容得下两行 11.5px / line-height 1.35 ≈ 31px；一行只有 16px
      subH: Math.round(first.querySelector('.var-sub').getBoundingClientRect().height),
      nameMono: /mono|Consolas|Cascadia/i.test(getComputedStyle(first.querySelector('.var-name')).fontFamily),
      cursor: getComputedStyle(first).cursor,
      hasMain: !!first.querySelector('.var-main'),
      grips: cards.filter((c) => c.querySelector('.var-grip')).length,
      /* 手柄和文字必须物理分开 —— 第一版手柄绝对定位贴在 left:1px，和名字叠在一起
         （kniph 2026-10-14：「把手太窄了，而且和文字重叠了」）。
         判据：手柄右边界 ≤ 正文左边界。宽度也要够 —— 太窄了难点中。 */
      gripR: Math.round(first.querySelector('.var-grip').getBoundingClientRect().right),
      mainL: Math.round(first.querySelector('.var-main').getBoundingClientRect().left),
      gripW: Math.round(first.querySelector('.var-grip').getBoundingClientRect().width)
    };
  });
  check('（脚手架）塞了 6 条变量', varGrid.total === 6, String(varGrid.total));
  check('变量栏是 CSS 网格（不是一行一条的列表）',
    varGrid.display === 'grid', varGrid.display);
  check('6 条摊成多列（一眼看全，不用一条一条滚）',
    varGrid.cols >= 2, `${varGrid.cols} 列`);
  check('同一行里卡片等高（网格才排得齐）',
    varGrid.heights.length === 1, JSON.stringify(varGrid.heights));
  check('值摘要是两行的高度（只给一行认不出是哪条）',
    varGrid.subH >= 26, `${varGrid.subH}px`);
  check('最右那张卡也没顶出容器（grid 子项 min-width:auto 容易撑破）',
    varGrid.rightMost <= varGrid.listRight + 1,
    `最右 ${varGrid.rightMost} / 容器 ${varGrid.listRight}`);
  check('名字和值竖排在一块（.var-main），操作按钮在右边另起',
    varGrid.hasMain, String(varGrid.hasMain));
  check('每张卡片都有拖动手柄',
    varGrid.grips === 6, `${varGrid.grips} / 6`);
  check('手柄在文字左边、不重叠（grip 右边界 ≤ 正文左边界）',
    varGrid.gripR <= varGrid.mainL,
    `grip 右 ${varGrid.gripR} / 正文左 ${varGrid.mainL}`);
  check('手柄够宽（太窄了难点中）',
    varGrid.gripW >= 14, `${varGrid.gripW}px`);
  check('名字是等宽字体（和「内置变量」那列一个观感）', varGrid.nameMono);
  check('卡片可点（cursor: pointer 提示能点开）', varGrid.cursor === 'pointer');

  /* 点卡片 → 展开；点「收起」→ 回去。这是新交互的主干。
     ⚠️ 每次点击都整块重画，旧引用立刻脱离文档 —— 每个动作后重新 query。 */
  const varFold = await opt.evaluate(async () => {
    const q = () => document.querySelector('#vars-body .var-row');
    q().click();
    await new Promise((r) => setTimeout(r, 150));
    const editingEl = q();
    const editing = {
      is: editingEl.classList.contains('editing'),
      hasInputs: !!(editingEl.querySelector('[data-kind="name"]') && editingEl.querySelector('[data-kind="value"]'))
    };
    editingEl.querySelector('.row-fold').click();
    await new Promise((r) => setTimeout(r, 150));
    const foldedEl = q();
    const folded = {
      is: !foldedEl.classList.contains('editing'),
      hasInputs: !foldedEl.querySelector('[data-kind="value"]'),
      sub: (foldedEl.querySelector('.var-sub') || {}).textContent
    };
    return { editing, folded };
  });
  check('点「收起」回到卡片（值框收掉、摘要还在）',
    varFold.folded.is && varFold.folded.hasInputs, JSON.stringify(varFold.folded));
  check('点卡片摊开编辑（名字框 + 值框都在）',
    varFold.editing.is && varFold.editing.hasInputs, JSON.stringify(varFold.editing));

  /* ---- 卡片拖动排序（kniph 2026-10-14：「配置多起来之后只能按创建顺序排，
     视觉上不美观」）。和三处左栏**同一个 `bindSortDrag`**，只多了 `grid: true`。
     网格里落点是「离指针最近的卡 + 它左半还是右半」，指示线是**竖**的 ——
     横线在一行好几张的网格里根本分不清落在哪一列。 */
  const varNamesBefore = await opt.evaluate(() =>
    [...document.querySelectorAll('#vars-body .var-row .var-name')].map((n) => n.textContent)
  );
  /** 一次完整的拖动手势：抓住第 from 张卡的手柄，松到第 to 张卡的左半（`side: 'left'`，默认）
      或右半（`'right'`，= 放到它后面）。网格里落点靠 X 决定，别按 Y 想当然。
      落点取「卡宽 20% / 80%」而不是 25%/75% —— 卡片右上角是 ✕，
      压在上面就变成「拖一下顺便删了一条」。 */
  const dragVarTo = async (from, to, side = 'left') => {
    const pts = await opt.evaluate(([f, t, sd]) => {
      const cards = [...document.querySelectorAll('#vars-body .var-row')];
      if (!cards[f] || !cards[t]) throw new Error(`没有第 ${f} / ${t} 张卡（现在一共 ${cards.length} 张）`);
      const a = cards[f].querySelector('.var-grip').getBoundingClientRect();
      const b = cards[t].getBoundingClientRect();
      return {
        gx: a.left + a.width / 2, gy: a.top + a.height / 2,
        tx: b.left + b.width * (sd === 'right' ? 0.8 : 0.2),
        ty: b.top + b.height / 2
      };
    }, [from, to, side]);
    await opt.mouse.move(pts.gx, pts.gy);
    await opt.mouse.down();
    await opt.mouse.move(pts.gx + 6, pts.gy, { steps: 3 }); // 过「手抖」阈值
    await opt.mouse.move(pts.tx, pts.ty, { steps: 8 });
    await opt.waitForTimeout(120);
  };
  /* 往第 3 张（下一行）的左边拖：跨行才有真实位移。**别拿第 2 张试** ——
     网格里 `dropIndex` 给的是「插到第几个」，插到第 1 位恰好等于原地挪动（from=0, to=0），
     什么都不会变，一条白测。三处左栏的 e2e 用「拖到最后一行」也是这个道理。 */
  await dragVarTo(0, 2);
  const varMark = await opt.evaluate(() => {
    const t = document.querySelector('#vars-body .var-row.drop-before');
    const h = document.querySelector('#vars-body .var-row.dragging');
    // 网格指示线必须**窄而高**（竖线）；横线（宽、高各 2px）在网格里对不了列
    const indicatorW = t
      ? (() => {
          const cs = getComputedStyle(t, '::before');
          return { w: cs.width, h: cs.height };
        })()
      : null;
    /* 指示线的**实际落点**也要量 —— 它是 absolute，靠 `.var-row { position: relative }`
       当基准；基准一丢（上一版改 flex 时手滑删过），CSS 照样有效但线画到别的层去了，
       computed style 全是对的、屏幕上就是没有。量 getBoundingClientRect 才抓得住。 */
    const indicatorRect = t
      ? (() => {
          const b = t.getBoundingClientRect();
          const cs = getComputedStyle(t, '::before');
          // ::before 没有独立盒模型可查，按 left: -3px / top:3 / bottom:3 反推它该在哪
          return {
            lineX: b.left + parseFloat(cs.left),
            insideX: b.left + parseFloat(cs.left) >= 0 &&
                     b.left + parseFloat(cs.left) <= b.right
          };
        })()
      : null;
    return {
      before: t ? t.dataset.id : '',
      dragging: h ? h.dataset.id : '',
      indicatorW,
      indicatorRect
    };
  });
  check('拖动指示线画在卡片边上（不是飘到别的层 —— position:relative 基准还在）',
    varMark.indicatorRect && varMark.indicatorRect.insideX,
    JSON.stringify(varMark.indicatorRect));
  check('拖动时目标卡片标出了「会插到它左边」',
    varMark.before === '2', `drop-before 落在 ${varMark.before || '(没有)'}`);
  check('被拖的那张有反馈', varMark.dragging === '0', varMark.dragging || '(没有)');
  check('网格里指示线是竖的（横线分不清哪一列）',
    varMark.indicatorW && parseFloat(varMark.indicatorW.w) <= 3 &&
      parseFloat(varMark.indicatorW.h) > parseFloat(varMark.indicatorW.w),
    JSON.stringify(varMark.indicatorW));

  await opt.mouse.up();
  await opt.waitForTimeout(600);
  const varAfterDrag = await opt.evaluate(() => ({
    dom: [...document.querySelectorAll('#vars-body .var-row .var-name')].map((n) => n.textContent)
  }));
  /* 「插到第 3 张的左边」→ 实际落在下标 1（第 3 位）：被拖的那张本来在下标 0，
     往它前面插时 `dropIndex` 的 `to > from` 要减一（和三处左栏同一条 off-by-one）。
     所以**别按「第几张」想下标** —— 断言直接钉「被拖的那张在新顺序里的位置」。 */
  check('松手后被拖的那张真的换位了（插到第 3 张左边 = 落到第 2 位）',
    varAfterDrag.dom[1] === varNamesBefore[0] && varAfterDrag.dom[0] === varNamesBefore[1],
    `拖前 ${varNamesBefore.slice(0, 3).join(',')} → 拖后 ${varAfterDrag.dom.slice(0, 3).join(',')}`);
  check('一条变量都没丢（还是 6 条，就是换了个位置）',
    varAfterDrag.dom.length === 6 && varNamesBefore.every((n) => varAfterDrag.dom.includes(n)),
    `${varAfterDrag.dom.length} 条：${varAfterDrag.dom.join(',')}`);
  const varSavedOrder = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    return state.vars.map((v) => v.name);
  });
  check('拖完的顺序落盘了（reload 后还是这个顺序）',
    JSON.stringify(varSavedOrder) === JSON.stringify(varAfterDrag.dom),
    `存档 ${varSavedOrder.slice(0, 3).join(',')}｜页面 ${varAfterDrag.dom.slice(0, 3).join(',')}`);
  const varLeftover = await opt.evaluate(
    () => document.querySelectorAll('#vars-body .drop-before, #vars-body .drop-after, #vars-body .dragging').length
  );
  check('松手后指示线 / 拖动态清干净了', varLeftover === 0, `${varLeftover} 个残留`);

  /* 反向拖一次：off-by-one 恰好藏在这个方向。目标选最后一张的**右半边**（= 放到末尾），
     这样 `over + 1` 才真的走到 over 后面（往末尾拖是从后往前插，不该减一）。 */
  await dragVarTo(1, 5, 'right');
  await opt.mouse.up();
  await opt.waitForTimeout(600);
  const varAfterBack = await opt.evaluate(() =>
    [...document.querySelectorAll('#vars-body .var-row .var-name')].map((n) => n.textContent)
  );
  check('往末尾拖也只挪一格（没有 off-by-one）',
    varAfterBack[varAfterBack.length - 1] === varAfterDrag.dom[1] &&
      varAfterBack.length === 6,
    `拖后第 2 张「${varAfterDrag.dom[1]}」→ 现在末位「${varAfterBack[varAfterBack.length - 1]}」｜${varAfterBack.join(',')}`);

  // 下面几节都操作「最后一行」（新建的那条），前面塞的 6 条脚手架不影响
  const varRowsBefore = await opt.evaluate(() => document.querySelectorAll('#vars-body .var-row').length);

  await opt.click('#btn-add-var');
  await opt.waitForTimeout(120);
  /* 新建那条直接进编辑态（名字还空着，摘要行没东西可显示） */
  const newRow = await opt.evaluate(() => {
    const rows = document.querySelectorAll('#vars-body .var-row');
    const row = rows[rows.length - 1];
    return {
      editing: row.classList.contains('editing'),
      focused: (document.activeElement && document.activeElement.dataset.kind) || ''
    };
  });
  check('新建的那条直接进编辑态（焦点在名字框）',
    newRow.editing && newRow.focused === 'name', JSON.stringify(newRow));

  await opt.evaluate(() => {
    const rows = document.querySelectorAll('#vars-body .var-row');
    const row = rows[rows.length - 1];
    const name = row.querySelector('[data-kind="name"]');
    const val = row.querySelector('[data-kind="value"]');
    name.value = 'rtTestKey';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    val.value = 'sk-abcdef1234567890';
    val.dispatchEvent(new Event('input', { bubbles: true }));
  });

  const varMask = await opt.evaluate(() => {
    const rows = document.querySelectorAll('#vars-body .var-row');
    const row = rows[rows.length - 1];
    const val = row.querySelector('[data-kind="value"]');
    const eye = row.querySelector('.row-eye');
    const read = () => {
      const cs = getComputedStyle(val);
      return {
        masked: val.classList.contains('masked'),
        css: cs.webkitTextSecurity || cs.getPropertyValue('-webkit-text-security')
      };
    };
    const before = read();
    eye.click();
    const shown = read();
    eye.click();
    const back = read();
    return { before, shown, back, value: val.value, tag: val.tagName };
  });

  check(
    '新加的变量值默认打码（不是明文摆着）',
    varMask.before.masked && varMask.before.css === 'disc',
    JSON.stringify(varMask.before)
  );
  check(
    '点眼睛能看到真值（打码只是显示层，值没被改）',
    !varMask.shown.masked && varMask.value === 'sk-abcdef1234567890',
    `${JSON.stringify(varMask.shown)}｜值 ${varMask.value}｜tag=${varMask.tag}`
  );
  check('再点一下又藏回去', varMask.back.masked, JSON.stringify(varMask.back));

  /* 打码的判据是**变量名里含 key**（不区分大小写），不是「所有变量一律藏」——
     model 这类藏起来只会让人看不见自己在填什么。改名之后状态要跟着重算。 */
  const varNameMask = await opt.evaluate(() => {
    const rows = document.querySelectorAll('#vars-body .var-row');
    const row = rows[rows.length - 1];
    const name = row.querySelector('[data-kind="name"]');
    const val = row.querySelector('[data-kind="value"]');
    const eye = row.querySelector('.row-eye');
    const ren = (n) => {
      name.value = n;
      name.dispatchEvent(new Event('input', { bubbles: true }));
    };
    ren('model');
    const plain = { masked: val.classList.contains('masked'), title: eye.title };
    ren('myModel');
    const still = { masked: val.classList.contains('masked') };
    ren('modelKey');
    const back = { masked: val.classList.contains('masked'), title: eye.title };
    ren('rtTestKey');
    return { plain, still, back };
  });
  check('不含 key 的变量名不藏值（model 看得见自己填了什么）',
    !varNameMask.plain.masked && varNameMask.plain.title === '隐藏',
    JSON.stringify(varNameMask.plain));
  check('myModel 里有 model 也不算（判的是 key，不是 model）', !varNameMask.still.masked,
    JSON.stringify(varNameMask.still));
  check('改名成 modelKey 之后自动藏起来（打码跟着名字走）',
    varNameMask.back.masked && varNameMask.back.title === '显示',
    JSON.stringify(varNameMask.back));

  /* 多行值要把框撑高（「换 model 重试」就是这么填的：一行一个）。 */
  const varGrow = await opt.evaluate(() => {
    const rows = document.querySelectorAll('#vars-body .var-row');
    const val = rows[rows.length - 1].querySelector('[data-kind="value"]');
    const before = val.getBoundingClientRect().height;
    val.value = 'model-a\nmodel-b\nmodel-c';
    val.dispatchEvent(new Event('input', { bubbles: true }));
    const after = val.getBoundingClientRect().height;
    return { before, after };
  });
  check('值填三行，输入框跟着撑高（不再是挤在一行）',
    varGrow.after > varGrow.before + 12,
    `${varGrow.before.toFixed(1)}px → ${varGrow.after.toFixed(1)}px`);

  /* 收起那条临时变量再删（紧凑行上 ✕ 直接删；编辑态收尾一并验） */
  const varSum = await opt.evaluate(() => {
    const rows = document.querySelectorAll('#vars-body .var-row');
    const row = rows[rows.length - 1];
    row.querySelector('.row-fold')?.click();
    return { folded: !row.classList.contains('editing') };
  });
  await opt.waitForTimeout(120);
  const varKeySum = await opt.evaluate(() => {
    const rows = document.querySelectorAll('#vars-body .var-row');
    const row = rows[rows.length - 1];
    return {
      name: (row.querySelector('.var-name') || {}).textContent,
      sub: (row.querySelector('.var-sub') || {}).textContent,
      isKey: !!(row.querySelector('.var-name') || {}).classList.contains('is-key')
    };
  });
  check('含 key 的那条，紧凑行摘要只给圆点（值不出现）',
    varKeySum.isKey && /^\*{6}|^•{6}$/.test(varKeySum.sub),
    `名字「${varKeySum.name}」｜摘要「${varKeySum.sub}」`);

  // 收拾干净
  await opt.evaluate(() => {
    const rows = document.querySelectorAll('#vars-body .var-row');
    const row = rows[rows.length - 1];
    if (row) row.querySelector('.row-del').click();
  });
  await opt.waitForTimeout(120);
  const varLeft = await opt.evaluate(() => document.querySelectorAll('#vars-body .var-row').length);
  check(
    '（脚手架）测完把那条临时变量删掉了',
    varLeft === varRowsBefore,
    `还剩 ${varLeft} 行（原本 ${varRowsBefore}）`
  );

  /* 前面为了量「几列」塞了 6 条 —— **必须还原成默认那条**，后面所有小节都跑在这份存档上，
     留一堆变量会污染它们（比如「面板下拉列出的变量」「变量数」之类的断言）。 */
  await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    state.vars = [{ name: 'apiKey', value: '' }];
    await chrome.storage.local.set({ state });
  });
  await opt.reload();
  await opt.waitForTimeout(600);
  const varRestored = await opt.evaluate(() => document.querySelectorAll('#vars-body .var-row').length);
  check('（脚手架）变量表还原成默认那条，后面的小节跑在干净存档上',
    varRestored === 1, `还剩 ${varRestored} 条`);

  // 「设置」是第二个 tab，不点开的话里面的元素量不到尺寸
  await opt.evaluate(() => {
    document.querySelector('.tab[data-tab="settings"]')?.click();
  });
  await opt.waitForTimeout(150);

  /* ---- 目标语言：真的是个下拉框，候选不是空的 ----------------------
     早先是 <input list> + datalist，输入框里有值时点开只剩匹配的几项，
     看着像「下拉里就两个选项」。这里量一下真实渲染出来的选项。 */
  const langBox = await opt.evaluate(() => {
    const sel = document.getElementById('s-lang');
    const other = document.getElementById('s-lang-other');
    const opts = sel ? Array.from(sel.options) : [];
    return {
      tag: sel ? sel.tagName : '',
      count: opts.length,
      lastValue: opts.length ? opts[opts.length - 1].value : '',
      lastText: opts.length ? (opts[opts.length - 1].textContent || '').trim() : '',
      hasJa: opts.some((o) => o.value === '日语'),
      otherTag: other ? other.tagName : '',
      otherHidden: other ? other.hidden : null
    };
  });
  check('目标语言是个 <select>，不是输入框', langBox.tag === 'SELECT', langBox.tag);
  check('下拉里真的有几十个候选（不是空的、也不是只剩两项）',
    langBox.count >= 25, `options = ${langBox.count}`);
  check('常用语言在里面（日语）', langBox.hasJa);
  check('末尾是「其他（自己填）」', langBox.lastValue === '__other__', langBox.lastText);
  check('「自己填」那个框默认藏着',
    langBox.otherTag === 'INPUT' && langBox.otherHidden === true, `hidden = ${langBox.otherHidden}`);

  await opt.selectOption('#s-lang', '日语');
  await opt.waitForTimeout(1300);
  const langSaved = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    return state.settings.targetLang;
  });
  check('挑「日语」之后落盘了', langSaved === '日语', String(langSaved));

  await opt.selectOption('#s-lang', '__other__');
  await opt.waitForTimeout(150);
  const langOther = await opt.evaluate(() => {
    const el = document.getElementById('s-lang-other');
    const box = el ? el.getBoundingClientRect() : null;
    return { hidden: el ? el.hidden : null, h: box ? box.height : 0 };
  });
  check('选「其他」时那个输入框才露出来', langOther.hidden === false && langOther.h > 0,
    JSON.stringify(langOther));

  // 收拾干净：后面几节要看到「简体中文」，别把语言留成日语
  await opt.selectOption('#s-lang', '简体中文');
  await opt.waitForTimeout(1300);
  const langBack = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    return state.settings.targetLang;
  });
  check('改回「简体中文」，不留脏数据给后面几节', langBack === '简体中文', String(langBack));

  check('操作完仍然没有报错', errors.length === 0, errors.join(' | '));

  /* ------------------------------------------------------------------ */
  /* 6. 翻译按钮：预设 / 大小 / 自定义 SVG                              */
  /* ------------------------------------------------------------------ */

  console.log('\n6. 翻译按钮：换预设、改大小、填一段自己的 SVG');

  await opt.evaluate(() => document.querySelector('.tab[data-tab="settings"]')?.click());
  await opt.waitForTimeout(200);

  // 卡片上画的是「你实际会用的图标」，所以得从「没填图标」的状态开始量
  await opt.evaluate(() => {
    const el = document.getElementById('s-trigsvg');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await opt.waitForTimeout(200);

  const cards = await opt.evaluate(() =>
    [...document.querySelectorAll('#trig-styles .trig-card')].map((b) => ({
      id: b.dataset.style,
      // 名字是卡片里那个（唯一的）无 class 的 span —— 图标 span 是 .trig-prev
      name: (b.querySelector('span:not([class])') || {}).textContent || '',
      on: b.classList.contains('on'),
      hasSvg: !!b.querySelector('svg'),
      bare: !!b.querySelector('.trig-prev.bare')
    }))
  );
  check('三个样式卡都渲染出来了', cards.length === 3, cards.map((c) => c.id).join(','));
  check(
    '卡片是 方块 / 地球 / 自定义（笔尖已经换掉了）',
    cards.map((c) => c.id).join() === 'badge,globe,custom',
    cards.map((c) => c.id).join()
  );
  check('没有「笔尖」那张卡了', !cards.some((c) => c.id === 'nib'));
  check('默认选中「译字方块」', !!(cards[0] && cards[0].on && cards[0].id === 'badge'));
  const cardById = Object.fromEntries(cards.map((c) => [c.id, c]));
  check('地球那张卡画着自己的图标', !!(cardById.globe && cardById.globe.hasSvg));
  check('「自定义」那张卡没填图标时是空的（不拿示例图标冒充）',
    !!(cardById.custom && !cardById.custom.hasSvg));
  check('只有「自定义」那张卡不带底座（虚线框示意）',
    cards.filter((c) => c.bare).map((c) => c.id).join() === 'custom');

  await opt.evaluate(() => {
    document.querySelector('#trig-styles .trig-card[data-style="globe"]')?.click();
  });
  await opt.waitForTimeout(1300);

  const afterGlobe = await opt.evaluate(async () => {
    const root = document.getElementById('trig-preview').shadowRoot;
    const el = root && root.querySelector('.rt-trigger');
    const { state } = await chrome.storage.local.get('state');
    return {
      style: state.settings.triggerStyle,
      on: [...document.querySelectorAll('#trig-styles .trig-card.on')].map((b) => b.dataset.style),
      cls: el ? el.className : '',
      svg: !!(el && el.querySelector('svg'))
    };
  });
  check('切到地球后写进了存储', afterGlobe.style === 'globe', `triggerStyle = ${afterGlobe.style}`);
  check('卡片上的选中态跟着换了', afterGlobe.on.join() === 'globe', afterGlobe.on.join());
  check('预览换成了带 SVG 的地球', /s-globe/.test(afterGlobe.cls) && afterGlobe.svg, afterGlobe.cls);

  await opt.evaluate(() => {
    const el = document.getElementById('s-trigsize');
    el.value = '60';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await opt.waitForTimeout(1300);
  const savedSize = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    return state.settings.triggerSize;
  });
  check('按钮大小写进了存储', savedSize === 60, `triggerSize = ${savedSize}`);

  // 自定义图标：直接粘一段自己画的 SVG
  const CUSTOM_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">' +
    '<path d="M4 12h16"/></svg>';

  const setTriggerSvg = async (value) => {
    await opt.evaluate((v) => {
      const el = document.getElementById('s-trigsvg');
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
    await opt.waitForTimeout(1300);
  };

  await setTriggerSvg(CUSTOM_SVG);

  const afterSvg = await opt.evaluate(async () => {
    const root = document.getElementById('trig-preview').shadowRoot;
    const p = root.querySelector('.rt-trigger .rt-ico svg path');
    const msg = document.getElementById('s-trigsvg-msg');
    const { state } = await chrome.storage.local.get('state');
    return {
      saved: state.settings.triggerSvg,
      pathD: p ? p.getAttribute('d') : '',
      msgHidden: msg.hidden,
      msgCls: msg.className,
      msgText: msg.textContent.trim()
    };
  });
  check('自定义 SVG 写进了存储', afterSvg.saved === CUSTOM_SVG, JSON.stringify(afterSvg.saved));
  check('预览里换成了自己填的图标', afterSvg.pathD === 'M4 12h16', afterSvg.pathD);
  check(
    '合法时给个「用上了」的绿色确认',
    afterSvg.msgHidden === false && /ok/.test(afterSvg.msgCls) && afterSvg.msgText.includes('用上了'),
    `${afterSvg.msgCls}｜${afterSvg.msgText}`
  );

  // 左边那张「自定义」卡画的应该就是你填的这个图标（跟预览同源）
  const cardFilled = await opt.evaluate(() => {
    const c = document.querySelector('#trig-styles .trig-card[data-style="custom"]');
    const p = c && c.querySelector('.trig-prev svg path');
    return { hasSvg: !!(c && c.querySelector('svg')), pathD: p ? p.getAttribute('d') : '' };
  });
  check('卡片跟着显示自己填的图标（和预览一致）',
    cardFilled.pathD === 'M4 12h16', cardFilled.pathD);

  // 换一段会被拦下来的（带 onload）：不能生效，而且要说明为什么
  await setTriggerSvg('<svg onload="alert(1)"></svg>');
  const badSvg = await opt.evaluate(() => {
    const root = document.getElementById('trig-preview').shadowRoot;
    const msg = document.getElementById('s-trigsvg-msg');
    return {
      hidden: msg.hidden,
      text: msg.textContent.trim(),
      hasCircle: !!root.querySelector('.rt-trigger .rt-ico svg circle')
    };
  });
  check('不合法时会给出提示', !badSvg.hidden && badSvg.text.includes('没用上'), badSvg.text);
  check('不合法时回落到预设（地球有 circle，箭头没有）', badSvg.hasCircle === true);

  await setTriggerSvg(CUSTOM_SVG);

  // 页面上那个真实按钮呢？
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.waitForTimeout(200);
  await selectText();
  await page.waitForTimeout(400);
  const mBtn = await measure();

  check('页面上的按钮也换成了地球', /s-globe/.test(mBtn.triggerCls) && mBtn.triggerHasSvg, mBtn.triggerCls);
  near('页面上的按钮变成了 60px', mBtn.trigger.w, 60, 1.5, 'px');
  check('页面上用的是自己填的图标', mBtn.triggerPathD === 'M4 12h16', mBtn.triggerPathD);
  console.log(
    `     ${mBtn.triggerCls}｜${fmt(mBtn.trigger.w)}px｜图标 path=${mBtn.triggerPathD}`
  );

  /* 「自定义」预设：不给底座，整块就是自己那段 SVG。
     两个分支都要走 —— 填了图标 / 没填图标（没填时用示例图标顶着，不能是个空按钮）。 */
  await opt.evaluate(() => {
    document.querySelector('#trig-styles .trig-card[data-style="custom"]')?.click();
  });
  await opt.waitForTimeout(1300);

  const customOn = await opt.evaluate(async () => {
    const root = document.getElementById('trig-preview').shadowRoot;
    const el = root && root.querySelector('.rt-trigger');
    const p = root.querySelector('.rt-trigger .rt-ico svg path');
    const cs = el ? getComputedStyle(el) : null;
    const msg = document.getElementById('s-trigsvg-msg');
    const { state } = await chrome.storage.local.get('state');
    return {
      style: state.settings.triggerStyle,
      cls: el ? el.className : '',
      bg: cs ? cs.backgroundColor : '',
      border: cs ? cs.borderTopWidth : '',
      shadow: cs ? cs.boxShadow : '',
      pathD: p ? p.getAttribute('d') : '',
      note: (msg.textContent || '').trim()
    };
  });
  check('切到「自定义」后写进了存储', customOn.style === 'custom', customOn.style);
  check(
    '预览上真的没有底座（底色透明 / 无描边 / 无阴影）',
    customOn.bg === 'rgba(0, 0, 0, 0)' && customOn.border === '0px' && customOn.shadow === 'none',
    `${customOn.bg}｜${customOn.border}｜${customOn.shadow}`
  );
  check('图标还是自己填的那个', customOn.pathD === 'M4 12h16', customOn.pathD);
  check('填了图标就没有「还没填」的提醒', !customOn.note.includes('还没填图标'), customOn.note);

  await setTriggerSvg('');
  const customEmpty = await opt.evaluate(() => {
    const root = document.getElementById('trig-preview').shadowRoot;
    const el = root && root.querySelector('.rt-trigger');
    const p = root.querySelector('.rt-trigger .rt-ico svg path');
    const msg = document.getElementById('s-trigsvg-msg');
    return {
      cls: el ? el.className : '',
      pathD: p ? p.getAttribute('d') : '',
      noteHidden: msg.hidden,
      noteCls: msg.className,
      note: msg.textContent.trim()
    };
  });
  check(
    '清空图标后按钮不会变空 —— 用示例图标顶着',
    customEmpty.pathD === 'M3.5 7.5h11M3.5 12h7.5M3.5 16.5h9',
    customEmpty.pathD
  );
  check(
    '而且会直说「还没填图标」（不做静默回退）',
    customEmpty.noteHidden === false && /warn/.test(customEmpty.noteCls) &&
      customEmpty.note.includes('还没填图标'),
    `${customEmpty.noteCls}｜${customEmpty.note}`
  );
  check('样式没变，只是图标换成了占位的', /s-custom/.test(customEmpty.cls), customEmpty.cls);

  const cardCleared = await opt.evaluate(() => {
    const c = document.querySelector('#trig-styles .trig-card[data-style="custom"]');
    return { hasSvg: !!(c && c.querySelector('svg')) };
  });
  check('清空图标后卡片也空了（不留示例图标在那儿）', cardCleared.hasSvg === false);

  await setTriggerSvg(CUSTOM_SVG);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.waitForTimeout(200);
  await selectText();
  await page.waitForTimeout(400);
  const mCustom = await measure();
  check('页面上的按钮也换成了自定义', /s-custom/.test(mCustom.triggerCls), mCustom.triggerCls);
  check(
    '页面上同样没有底色（不是只有预览干净）',
    !!mCustom.trigger && mCustom.trigger.bg === 'rgba(0, 0, 0, 0)',
    mCustom.trigger && mCustom.trigger.bg
  );
  check('页面上用的是自己填的图标', mCustom.triggerPathD === 'M4 12h16', mCustom.triggerPathD);

  /* ------------------------------------------------------------------ */
  /* 7. 配置列表：上下移 / 拖动排序                                       */
  /* ------------------------------------------------------------------ */
  /* 顺序本身是有意义的 —— 弹出菜单、面板里的配置下拉、右键菜单都按
     state.configs 的顺序走。这一节两条路径都真走一遍：点 ↑ ↓，和按住手柄拖。 */

  console.log('\n7. 配置列表：把顺序调过来');

  await opt.evaluate(() => document.querySelector('.tab[data-tab="configs"]')?.click());
  await opt.waitForTimeout(200);

  /** 屏幕上和存储里的顺序各是什么 */
  const orderOf = () =>
    opt.evaluate(async () => {
      const dom = [...document.querySelectorAll('#cfg-list .cfg-row')].map((r) => r.dataset.id);
      const { state } = await chrome.storage.local.get('state');
      return { dom, saved: state.configs.map((c) => c.id) };
    });

  /** 当前选中的是哪一条（改顺序不该把它改掉） */
  const activeOf = () =>
    opt.evaluate(() => {
      const item = document.querySelector('#cfg-list .cfg-row .cfg-item.is-active');
      return item ? item.closest('.cfg-row').dataset.id : '';
    });

  const shape = await opt.evaluate(() => {
    const rows = [...document.querySelectorAll('#cfg-list .cfg-row')];
    const first = rows[0];
    const last = rows[rows.length - 1];
    return {
      rows: rows.length,
      grips: document.querySelectorAll('#cfg-list .cfg-row .cfg-grip').length,
      items: document.querySelectorAll('#cfg-list .cfg-row .cfg-item').length,
      firstUp: first.querySelector('.cfg-mv-btn[data-mv="-1"]').disabled,
      firstDown: first.querySelector('.cfg-mv-btn[data-mv="1"]').disabled,
      lastDown: last.querySelector('.cfg-mv-btn[data-mv="1"]').disabled
    };
  });
  check(
    '每条配置一行，手柄和上下移都在',
    shape.rows > 1 && shape.grips === shape.rows && shape.items === shape.rows,
    `${shape.rows} 行 / ${shape.grips} 个手柄`
  );
  check(
    '第一条的 ↑ 和最后一条的 ↓ 是禁用的（点了也不会有反应，索性禁掉）',
    shape.firstUp === true && shape.lastDown === true && shape.firstDown === false
  );

  const before = await orderOf();
  const activeBefore = await activeOf();

  // —— 点第一行的 ↓：它应该和第二行换位
  await opt.evaluate(() => {
    document.querySelector('#cfg-list .cfg-row .cfg-mv-btn[data-mv="1"]')?.click();
  });
  await opt.waitForTimeout(1300);
  const afterDown = await orderOf();
  check(
    '点 ↓ 之后前两条换了位',
    afterDown.dom[0] === before.dom[1] && afterDown.dom[1] === before.dom[0],
    `${before.dom.slice(0, 3).join(',')} → ${afterDown.dom.slice(0, 3).join(',')}`
  );
  check('新顺序落盘了（DOM 和存储一致）', JSON.stringify(afterDown.saved) === JSON.stringify(afterDown.dom));
  check('改顺序不会顺手改掉「当前选中」', (await activeOf()) === activeBefore, activeBefore);

  // 重渲染会把按钮换掉，所以焦点得手动还回去，否则连按第二下就落空了
  const focusKept = await opt.evaluate(() => {
    const el = document.activeElement;
    return el && el.classList.contains('cfg-mv-btn') ? el.dataset.mv : '';
  });
  check('重渲染后焦点还在同一个 ↓ 上', focusKept === '1', `activeElement.dataset.mv = ${focusKept || '(丢了)'}`);

  // —— 键盘也能用：焦点还在这儿，Shift+Tab 到旁边的 ↑，回车就该换回去
  await opt.keyboard.press('Shift+Tab');
  await opt.keyboard.press('Enter');
  await opt.waitForTimeout(1300);
  const afterUp = await orderOf();
  check(
    '用键盘走到 ↑ 上按回车，能换回来',
    JSON.stringify(afterUp.dom) === JSON.stringify(before.dom),
    afterUp.dom.slice(0, 3).join(',')
  );

  // —— 拖动：按住最后一行的手柄，拖到第一行上半区
  const gripBoxes = () =>
    opt.evaluate(() =>
      [...document.querySelectorAll('#cfg-list .cfg-row')].map((r) => {
        const b = r.getBoundingClientRect();
        const g = r.querySelector('.cfg-grip').getBoundingClientRect();
        return {
          id: r.dataset.id,
          top: b.top,
          bottom: b.bottom,
          gripX: g.left + g.width / 2,
          gripY: g.top + g.height / 2
        };
      })
    );

  /** 一次完整的拖动手势：抓住 srcRow 的手柄，松在 y 处 */
  const dragTo = async (box, y) => {
    await opt.mouse.move(box.gripX, box.gripY);
    await opt.mouse.down();
    await opt.mouse.move(box.gripX, box.gripY + (y > box.gripY ? 8 : -8)); // 先过「手抖」阈值
    await opt.mouse.move(box.gripX, y, { steps: 6 });
    await opt.waitForTimeout(120);
  };

  const boxes = await gripBoxes();
  const srcRow = boxes[boxes.length - 1];
  const dstRow = boxes[0];

  await dragTo(srcRow, dstRow.top + 2); // 压到第一行的上半区

  const mark = await opt.evaluate(() => {
    const target = document.querySelector('#cfg-list .cfg-row.drop-before');
    const held = document.querySelector('#cfg-list .cfg-row.dragging');
    return { before: target ? target.dataset.id : '', dragging: held ? held.dataset.id : '' };
  });
  check('拖动时画出了「会插到这儿」的指示线', mark.before === dstRow.id, mark.before || '(没有)');
  check('被拖的那一行有反馈', mark.dragging === srcRow.id, mark.dragging || '(没有)');

  await opt.mouse.up();
  await opt.waitForTimeout(1300);
  const afterDrag = await orderOf();
  check('拖到最前面之后顺序真的变了', afterDrag.dom[0] === srcRow.id, afterDrag.dom.slice(0, 3).join(','));
  check('拖动后的顺序也落盘了', JSON.stringify(afterDrag.saved) === JSON.stringify(afterDrag.dom));

  const leftover = await opt.evaluate(
    () => document.querySelectorAll('#cfg-list .drop-before, #cfg-list .drop-after, #cfg-list .dragging').length
  );
  check('松手后指示线 / 拖动态清干净了', leftover === 0, `${leftover} 个残留`);

  // —— 反向再拖一次：往下拖。off-by-one 恰好藏在这个方向 ——
  // 「移除之后」的坐标比「移除之前」少一位，少减这一位就会多挪一格。
  const boxes2 = await gripBoxes();
  const src2 = boxes2[0];
  const dst2 = boxes2[boxes2.length - 1];

  await dragTo(src2, dst2.bottom - 2); // 压到最后一行下半区 = 放到末尾

  const mark2 = await opt.evaluate(() => {
    const t = document.querySelector('#cfg-list .cfg-row.drop-after');
    return t ? t.dataset.id : '';
  });
  check('往下拖时指示线画在目标的下方', mark2 === dst2.id, mark2 || '(没有)');

  await opt.mouse.up();
  await opt.waitForTimeout(1300);
  const afterDrag2 = await orderOf();
  check(
    '往下拖到末尾：它正好排在最后，没多挪一位',
    afterDrag2.dom[afterDrag2.dom.length - 1] === src2.id && afterDrag2.dom.length === boxes2.length,
    afterDrag2.dom.join(',')
  );
  check('往下拖之后也落盘了', JSON.stringify(afterDrag2.saved) === JSON.stringify(afterDrag2.dom));

  // —— 只是点一下手柄（手抖 2px 以内）不该误排序
  const steady = await orderOf();
  const g0 = await opt.evaluate(() => {
    const g = document.querySelector('#cfg-list .cfg-row .cfg-grip').getBoundingClientRect();
    return { x: g.left + g.width / 2, y: g.top + g.height / 2 };
  });
  await opt.mouse.move(g0.x, g0.y);
  await opt.mouse.down();
  await opt.mouse.move(g0.x, g0.y + 2); // 抖一下，但没过阈值
  await opt.mouse.up();
  await opt.waitForTimeout(600);
  const afterClick = await orderOf();
  check(
    '只是点一下手柄（手抖 2px）不会误排序',
    JSON.stringify(afterClick.dom) === JSON.stringify(steady.dom),
    afterClick.dom.slice(0, 3).join(',')
  );

  /* —— 一条配置两段模板：文本一段、图片一段（新加的第二个输入框） —— */
  const beforeSel = await opt.evaluate(
    async () => (await chrome.storage.local.get('state')).state.activeConfigId
  );

  /* 请求块现在**默认全收起**（kniph 2026-10-13 定的，主请求也一样）—— 收起时块体是 display:none，
     要跟块里的字段打交道（focus / 量 offsetParent）就得先把块摊开。这里只贴一个 `open` 类，
     不走 ▾ 的真实点击（那件事下面单独用真鼠标测）。*/
  const openAllBlocks = () =>
    opt.evaluate(() => {
      document.querySelectorAll('#req-blocks .req-block').forEach((b) => b.classList.add('open'));
    });

  /* 内置适配器那条（Bing）不再有「类型 / 内置适配器」两个下拉：适配器只有 Bing 一个、
     而且只有内置预设会用上它，用户加的配置全是自定义请求 —— 「这块是什么」改成从数据上看
     （块上 `data-adapter` 有值就是内置通道），界面上只摊一行只读说明。 */
  const bingBlock = await opt.evaluate(async () => {
    const row = [...document.querySelectorAll('#cfg-list .cfg-row')].find((r) => r.dataset.id === 'builtin-bing');
    const item = row && row.querySelector('.cfg-item');
    if (item) item.click();
    await new Promise((r) => setTimeout(r, 500));
    const b = document.querySelector('#req-blocks .req-block:first-child');
    return {
      active: (await chrome.storage.local.get('state')).state.activeConfigId,
      kindSelects: document.querySelectorAll('#req-blocks .rb-kind').length,
      adapterSelects: document.querySelectorAll('#req-blocks select.rb-adapter').length,
      note: (b.querySelector('.rb-adapter-note') || {}).textContent || '',
      reqVisible: !!(b.querySelector('.rb-request') || {}).offsetParent
    };
  });
  check('（脚手架）当前这条就是内置适配器那条', bingBlock.active === 'builtin-bing', bingBlock.active);
  check('块里没有「类型」下拉，也没有能选的适配器下拉（都删掉了）',
    bingBlock.kindSelects === 0 && bingBlock.adapterSelects === 0, JSON.stringify(bingBlock));
  check('内置通道那条只摊一行只读说明（Bing），请求模板不显示',
    /Bing/.test(bingBlock.note) && !bingBlock.reqVisible, JSON.stringify(bingBlock));

  // 切到一条「自定义请求」型的配置。Bing 那条（适配器型）的编辑器里压根没有请求模板可编辑。
  const tplSwitched = await opt.evaluate(async () => {
    const row = [...document.querySelectorAll('#cfg-list .cfg-row')]
      .find((r) => r.dataset.id === 'builtin-ollama');
    const item = row && row.querySelector('.cfg-item');
    if (item) item.click();
    await new Promise((r) => setTimeout(r, 500));
    // 记一下**默认**状态（还没手动摊开之前）：块应当全是收起的，主请求也一样
    const b0 = document.querySelector('#req-blocks .req-block:first-child');
    const defaultOpen = {
      open: b0.classList.contains('open'),
      bodyVisible: !!b0.querySelector('.rb-request').offsetParent
    };
    // 块默认收起：先摊开，不然「请求模板那一块看得见」这条量的是 display:none
    document.querySelectorAll('#req-blocks .req-block').forEach((x) => x.classList.add('open'));
    const { state } = await chrome.storage.local.get('state');
    return {
      defaultOpen,
      active: state.activeConfigId,
      hasBox: !!document.querySelector('#req-blocks .req-block:first-child .rb-image-request'),
      imgVal: (document.querySelector('#req-blocks .req-block:first-child .rb-image-request') || {}).value,
      // 「自定义请求」型：请求模板那一块要看得见（适配器型才藏起来）
      requestVisible: !!(document.querySelector('#req-blocks .req-block:first-child .rb-request') || {}).offsetParent,
      // 「图片请求模板」默认是收起的 <details>：不填的人不用天天看着那一大块
      imgTplOpen: document.querySelector('#req-blocks .req-block:first-child .img-tpl').open
    };
  });
  check('请求块默认全是收起的（主请求也一样，kniph 2026-10-13 定的）',
    !tplSwitched.defaultOpen.open && !tplSwitched.defaultOpen.bodyVisible,
    JSON.stringify(tplSwitched.defaultOpen));
  check('切到自定义请求型配置后，图片模板的输入框在', tplSwitched.hasBox && tplSwitched.requestVisible,
    JSON.stringify(tplSwitched));
  check('图片请求模板默认收起（可选的东西不占版面）', tplSwitched.imgTplOpen === false,
    String(tplSwitched.imgTplOpen));
  check('图片模板默认是空的（老配置读出来就是空串）', tplSwitched.imgVal === '',
    JSON.stringify(tplSwitched.imgVal));

  /* ---- 两段模板共用一套骨架（kniph 2026-10-14：「完全是两套布局结构，也有小差别」）----
     结构、字号、行高、内边距、圆角、最小高度、标题栏 —— 一项一项量，别靠「看着差不多」。 */
  const tplUnified = await opt.evaluate(() => {
    const b = document.querySelector('#req-blocks .req-block:first-child');
    const plain = b.querySelector('.rb-request');
    const image = b.querySelector('.rb-image-request');
    const box = (el) => {
      const cs = getComputedStyle(el);
      return ['fontFamily', 'fontSize', 'lineHeight', 'padding', 'borderRadius', 'minHeight', 'whiteSpace']
        .map((k) => cs[k]).join(' | ');
    };
    const sum = (el) => {
      const cs = getComputedStyle(el.closest('details').querySelector('summary'));
      return ['fontSize', 'padding', 'margin', 'color'].map((k) => cs[k]).join(' | ');
    };
    return {
      boxesSame: box(plain) === box(image),
      boxes: box(plain),
      headsSame: sum(plain) === sum(image),
      // 结构：都是 details.preview.tpl-fold > summary + .fold-body > (标签排 + textarea + .hint)
      // （标签排 2026-10-14 挪进块里了，两栏一个位置）
      shape: [plain, image].map((el) => {
        const d = el.closest('details');
        const body = d.querySelector(':scope > .fold-body');
        return {
          tag: d.tagName,
          cls: d.className,
          kids: body ? [...body.children].map((c) => c.tagName + '.' + c.className) : null
        };
      }),
      sameShape: [plain, image].every((el) => {
        const d = el.closest('details');
        const body = d.querySelector(':scope > .fold-body');
        return d.tagName === 'DETAILS' && d.classList.contains('preview') &&
          d.classList.contains('tpl-fold') && !!body && body.children.length === 3 &&
          body.children[0].classList.contains('chips') &&
          body.children[1].tagName === 'TEXTAREA' && body.children[2].classList.contains('hint');
      }),
      plainOpen: plain.closest('details').open,
      imageOpen: image.closest('details').open
    };
  });
  check('两段模板共用一个骨架（details.preview.tpl-fold > summary + fold-body > 标签排 + 文本框 + 说明）',
    tplUnified.sameShape, JSON.stringify(tplUnified.shape));
  check('两段模板的文本框排版一模一样（字号 / 行高 / 内边距 / 圆角 / 最小高度 / 换行）',
    tplUnified.boxesSame, tplUnified.boxes);
  check('两段模板的标题栏也一模一样', tplUnified.headsSame);
  check('文字那条默认摊开（天天要改），图片那条默认收起',
    tplUnified.plainOpen && !tplUnified.imageOpen,
    JSON.stringify({ plain: tplUnified.plainOpen, image: tplUnified.imageOpen }));

  /* 字段顺序：两段模板挨着、两个「响应」字段挨着收尾。
     原来「响应格式」夹在两段模板中间 —— 读起来像「只管上面那一段」（kniph 2026-10-14 报的）。 */
  const fieldOrder = await opt.evaluate(() => {
    const b = document.querySelector('#req-blocks .req-block:first-child');
    return [...b.querySelectorAll('.rb-body > *')].map((el) => {
      if (el.matches('.tpl-fold')) return el.querySelector('summary').textContent.trim().split('（')[0];
      if (el.matches('.mode-field')) return '响应格式';
      if (el.querySelector('.rb-path')) return '响应提取路径';
      return el.className;
    });
  });
  check('块里字段顺序：请求模板 → 图片模板 → 响应格式 → 提取路径（响应那两项挨着）',
    JSON.stringify(fieldOrder) === JSON.stringify(['请求模板', '图片请求模板', '响应格式', '响应提取路径']),
    JSON.stringify(fieldOrder));

  /* ---- 折叠手势统一：**点块头**（整条标题栏）收起 / 展开，角落那个 ▾ 只是指示器 ---- */
  const foldGesture = await opt.evaluate(() => {
    const b = document.querySelector('#req-blocks .req-block:first-child');
    b.classList.remove('open');
    const t = b.querySelector('.rb-tag').getBoundingClientRect();
    return { x: Math.round(t.x + t.width / 2), y: Math.round(t.y + t.height / 2) };
  });
  await opt.mouse.click(foldGesture.x, foldGesture.y);
  await opt.waitForTimeout(150);
  const afterHead = await opt.evaluate(() =>
    document.querySelector('#req-blocks .req-block:first-child').classList.contains('open'));
  check('点块头（点的是「主请求」那几个字，不是角落的按钮）就摊开', afterHead === true, String(afterHead));

  await opt.locator('#req-blocks .req-block:first-child .rb-fold').click();
  await opt.waitForTimeout(150);
  const afterFoldBtn = await opt.evaluate(() =>
    document.querySelector('#req-blocks .req-block:first-child').classList.contains('open'));
  check('再点那枚 ▾ 就收起 —— 只折一次，不会来回折（它和块头走同一条路）',
    afterFoldBtn === false, String(afterFoldBtn));

  // 块头里的控件（勾选框）不该连带折叠
  await opt.mouse.click(foldGesture.x, foldGesture.y);
  await opt.waitForTimeout(150);
  await opt.locator('#req-blocks .req-block:first-child .rb-enable').click();
  await opt.waitForTimeout(300);
  const afterCheck = await opt.evaluate(() => {
    const b = document.querySelector('#req-blocks .req-block:first-child');
    return { open: b.classList.contains('open'), checked: b.querySelector('.rb-enable').checked };
  });
  check('点勾选框只改「参与轮换」，不会顺手把块折了',
    afterCheck.open === true && afterCheck.checked === false, JSON.stringify(afterCheck));
  // 收尾：勾回来 + 摊开（后面几节还要用这条配置）
  await opt.evaluate(async () => {
    const box = document.querySelector('#req-blocks .req-block:first-child .rb-enable');
    box.checked = true;
    box.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelectorAll('#req-blocks .req-block').forEach((x) => x.classList.add('open'));
    await new Promise((r) => setTimeout(r, 1200));
  });

  // 写一段进去：它和普通模板要各存各的
  const wroteImg = await opt.evaluate(async () => {
    // 先摊开请求块、再展开那个折叠的 <details> —— display:none 里 focus() 是空操作
    document.querySelectorAll('#req-blocks .req-block').forEach((x) => x.classList.add('open'));
    document.querySelector('#req-blocks .req-block:first-child .img-tpl').open = true;
    const box = document.querySelector('#req-blocks .req-block:first-child .rb-image-request');
    box.focus();
    box.value = '{"mode":"e2e-image","text":"{{image}}"}';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1300));
    const { state } = await chrome.storage.local.get('state');
    const cfg = state.configs.find((c) => c.id === 'builtin-ollama');
    return { img: cfg.imageRequest, text: cfg.request };
  });
  check('图片模板单独落盘了', String(wroteImg.img).includes('e2e-image'), String(wroteImg.img).slice(0, 40));
  check('普通模板没被串改（两段各存各的）',
    !String(wroteImg.text).includes('e2e-image'), String(wroteImg.text).slice(0, 30));

  // 块里那排标签应该插进「当前光标所在的框」—— 这里光标在图片模板里（标签在**同一个块**的
  // 文字模板上，这正是 2026-10-14 统一之后的行为：标签长在块里面，插哪段看光标在谁身上）。
  // 挑 {{date}}：Ollama 那条内置模板里没有它，才不会把「本来就有」看成「刚插进去」。
  const chipInto = await opt.evaluate(async () => {
    document.querySelectorAll('#req-blocks .req-block').forEach((x) => x.classList.add('open'));
    document.querySelector('#req-blocks .req-block:first-child .img-tpl').open = true;
    const box = document.querySelector('#req-blocks .req-block:first-child .rb-image-request');
    box.focus();
    box.selectionStart = box.selectionEnd = box.value.length;
    const before = box.value;
    const chip = [...document.querySelectorAll('#req-blocks .req-block:first-child .chips .chip')]
      .find((c) => c.dataset.ins === '{{date}}');
    if (chip) chip.click();
    await new Promise((r) => setTimeout(r, 1000));
    const { state } = await chrome.storage.local.get('state');
    const cfg = state.configs.find((c) => c.id === 'builtin-ollama');
    return { grew: box.value.length - before.length, img: cfg.imageRequest, text: cfg.request };
  });
  check('那排标签会插进「当前光标所在的框」（这里是图片模板）',
    chipInto.grew > 0 && String(chipInto.img).includes('{{date}}'), JSON.stringify(chipInto));
  check('标签没跑进普通模板里', !String(chipInto.text).includes('{{date}}'), String(chipInto.text).slice(0, 40));

  /* 主请求也是「默认收起、点 ▾ 才摊开」—— 真鼠标点一次，两向都验（kniph 2026-10-13 的要求）。 */
  const mainFoldStart = await opt.evaluate(() => {
    const b = document.querySelector('#req-blocks .req-block:first-child');
    b.querySelector('.rb-fold').scrollIntoView({ block: 'center' });
    const q = b.querySelector('.rb-fold').getBoundingClientRect();
    return { open: b.classList.contains('open'), x: q.x + q.width / 2, y: q.y + q.height / 2 };
  });
  await opt.mouse.click(mainFoldStart.x, mainFoldStart.y);
  await opt.waitForTimeout(320);
  const mainFolded = await opt.evaluate(() => {
    const b = document.querySelector('#req-blocks .req-block:first-child');
    return { open: b.classList.contains('open'), body: getComputedStyle(b.querySelector('.rb-body')).display };
  });
  check('真鼠标点 ▾ 能把主请求收起',
    mainFoldStart.open && !mainFolded.open && mainFolded.body === 'none', JSON.stringify(mainFolded));

  const mainFoldBack = await opt.evaluate(() => {
    const b = document.querySelector('#req-blocks .req-block:first-child');
    const q = b.querySelector('.rb-fold').getBoundingClientRect();
    return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  });
  await opt.mouse.click(mainFoldBack.x, mainFoldBack.y);
  await opt.waitForTimeout(320);
  const mainOpened = await opt.evaluate(() => {
    const b = document.querySelector('#req-blocks .req-block:first-child');
    return { open: b.classList.contains('open'), body: getComputedStyle(b.querySelector('.rb-body')).display };
  });
  check('再点 ▾ 能摊开主请求',
    mainOpened.open && mainOpened.body !== 'none', JSON.stringify(mainOpened));

  /* 后备块的块头：**只读标签 + 真鼠标点得到 ▾ / ×**（kniph 实测「收不起、删不掉」的回归）。
     根因是块头里那条改名用的 `<input class="rb-name">` 被全局 `input[type="text"] { width:100% }`
     撑满整行（权重 0,1,1 压过单类 0,1,0），把 ↑↓×▾ 顶出块外、被 `.req-block` 的 overflow:hidden
     裁掉；处理器本身没坏（DOM `.click()` 能折叠）—— 所以这里必须**量几何 + 用真鼠标**。 */
  const fbProbe = await opt.evaluate(async () => {
    document.getElementById('btn-add-fallback').click();
    await new Promise((r) => setTimeout(r, 450));
    const b = [...document.querySelectorAll('#req-blocks .req-block')].pop();
    b.scrollIntoView({ block: 'nearest' });
    const head = b.querySelector('.rb-head');
    const box = (el) => {
      const q = el.getBoundingClientRect();
      return { x: q.x, y: q.y, w: q.width, h: q.height };
    };
    const fold = box(b.querySelector('.rb-fold'));
    const del = b.querySelector('.rb-del') ? box(b.querySelector('.rb-del')) : null;
    const hit = (q) => {
      const el = document.elementFromPoint(q.x + q.w / 2, q.y + q.h / 2);
      return el ? el.className || el.tagName : '';
    };
    return {
      count: document.querySelectorAll('#req-blocks .req-block').length,
      tag: (b.querySelector('.rb-tag') || {}).textContent,
      hasNameInput: !!b.querySelector('.rb-name'),
      inputsInHead: [...head.querySelectorAll('input')].map((i) => i.className || i.type),
      headOverflow: head.scrollWidth - head.offsetWidth,
      boxOverflow: document.querySelector('#req-blocks').scrollWidth - document.querySelector('#req-blocks').offsetWidth,
      fold, del, foldHit: hit(fold), delHit: del ? hit(del) : ''
    };
  });
  check('（脚手架）＋ 加一条后备请求真的多出一块', fbProbe.count === 2, String(fbProbe.count));
  check('后备块头是只读标签「后备 1」，且除勾选框外没有别的输入框',
    fbProbe.tag === '后备 1' && !fbProbe.hasNameInput &&
    fbProbe.inputsInHead.length === 1 && fbProbe.inputsInHead[0] === 'rb-enable',
    JSON.stringify({ tag: fbProbe.tag, has: fbProbe.hasNameInput, inputs: fbProbe.inputsInHead }));
  check('块头不再横向溢出（▾ / × 不会被 overflow:hidden 裁掉）',
    fbProbe.headOverflow <= 0 && fbProbe.boxOverflow <= 0,
    `head=${fbProbe.headOverflow} box=${fbProbe.boxOverflow}`);
  check('▾ / × 在鼠标下打得中（不是被顶出块外）',
    String(fbProbe.foldHit).includes('rb-fold') && String(fbProbe.delHit).includes('rb-del'),
    `${fbProbe.foldHit} / ${fbProbe.delHit}`);

  // 真鼠标点 ▾ → 收起；再点一次 → 展开
  const clickBox = async (q) => {
    await opt.mouse.click(q.x + q.w / 2, q.y + q.h / 2);
    await opt.waitForTimeout(350);
  };
  await clickBox(fbProbe.fold);
  const foldedNow = await opt.evaluate(() => {
    const b = [...document.querySelectorAll('#req-blocks .req-block')].pop();
    return { open: b.classList.contains('open'), body: getComputedStyle(b.querySelector('.rb-body')).display };
  });
  check('真鼠标点 ▾ 能把后备收起来', !foldedNow.open && foldedNow.body === 'none', JSON.stringify(foldedNow));

  const fold2 = await opt.evaluate(() => {
    const q = [...document.querySelectorAll('#req-blocks .req-block')].pop().querySelector('.rb-fold').getBoundingClientRect();
    return { x: q.x, y: q.y, w: q.width, h: q.height };
  });
  await clickBox(fold2);
  const unfoldedNow = await opt.evaluate(() => {
    const b = [...document.querySelectorAll('#req-blocks .req-block')].pop();
    return { open: b.classList.contains('open'), body: getComputedStyle(b.querySelector('.rb-body')).display };
  });
  check('再点 ▾ 能展开', unfoldedNow.open && unfoldedNow.body !== 'none', JSON.stringify(unfoldedNow));

  // 真鼠标点 × → 删掉。那句 confirm 里报的名字是**现算的位置名**（不许再是 undefined）
  const seenDialogs = [];
  const onDlg = (d) => {
    seenDialogs.push(d.message());
    d.accept();
  };
  opt.on('dialog', onDlg);
  const del2 = await opt.evaluate(() => {
    const q = [...document.querySelectorAll('#req-blocks .req-block')].pop().querySelector('.rb-del').getBoundingClientRect();
    return { x: q.x, y: q.y, w: q.width, h: q.height };
  });
  await clickBox(del2);
  opt.off('dialog', onDlg);
  const fbAfterDel = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    const cfg = state.configs.find((c) => c.id === 'builtin-ollama');
    return { blocks: document.querySelectorAll('#req-blocks .req-block').length, saved: (cfg.fallbacks || []).length };
  });
  check('真鼠标点 × 能把后备删掉（界面与存档同步）',
    fbAfterDel.blocks === 1 && fbAfterDel.saved === 0, JSON.stringify(fbAfterDel));
  check('删除确认框报的是「后备 1」而不是 undefined',
    seenDialogs.some((m) => m.includes('后备 1')), seenDialogs.join(' ｜ '));

  // 把选中状态还回去，别影响后面几节（它们默认当前配置是原来那条）
  const restored = await opt.evaluate(async (prev) => {
    const row = [...document.querySelectorAll('#cfg-list .cfg-row')].find((r) => r.dataset.id === prev);
    const item = row && row.querySelector('.cfg-item');
    if (item) item.click();
    await new Promise((r) => setTimeout(r, 500));
    return (await chrome.storage.local.get('state')).state.activeConfigId;
  }, beforeSel);
  check('测完把「当前配置」还原了', restored === beforeSel, `${beforeSel} → ${restored}`);

  check('折腾完设置页仍然没报错', errors.length === 0, errors.join(' | '));

  /* ------------------------------------------------------------------ */
  /* 8. 面板不许跑出视口                                                  */
  /* ------------------------------------------------------------------ */
  /* 以前只有左上角限位，往右下拖能拖到只剩一点露在外面。
     这里量三件事：贴着视口右下角的选区、拖到右下极限、拖到左上极限。 */

  console.log('\n8. 面板边界：靠边的选区 + 拖到极限');

  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);

  await page.evaluate(() => {
    document.getElementById('corner')?.remove();
    const d = document.createElement('div');
    d.id = 'corner';
    d.style.cssText =
      'position:fixed;right:6px;bottom:6px;width:170px;font:14px/20px sans-serif;background:#eee';
    d.textContent = '右下角的文字';
    document.body.appendChild(d);

    const node = d.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.textContent.length);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);

    const tail = range.getClientRects()[0];
    document.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        composed: true,
        clientX: tail.right - 2,
        clientY: tail.top + tail.height / 2
      })
    );
  });

  await page.waitForTimeout(300);
  await page.click('.rt-trigger', { force: true });
  await settle();
  await page.waitForTimeout(200);

  const mCorner = await measure();
  check(
    '贴着视口右下角的选区：面板右边没出界',
    mCorner.panel.right <= mCorner.innerW + 1,
    `面板右边 ${fmt(mCorner.panel.right)} / 视口宽 ${mCorner.innerW}`
  );
  check(
    '贴着视口右下角的选区：面板下边没出界',
    mCorner.panel.bottom <= mCorner.innerH + 1,
    `面板下边 ${fmt(mCorner.panel.bottom)} / 视口高 ${mCorner.innerH}`
  );
  check(
    '面板左上也没出界',
    mCorner.panel.x >= -0.5 && mCorner.panel.y >= -0.5,
    `${fmt(mCorner.panel.x)}, ${fmt(mCorner.panel.y)}`
  );

  /** 按住顶栏那个小圆点，把面板拖 dx/dy 像素 */
  const dragBy = async (dx, dy) => {
    const from = await page.evaluate(() => {
      const root = document.getElementById('request-translate-host').shadowRoot;
      const r = root.querySelector('.rt-dot').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(150);
    return measure();
  };

  const mBR = await dragBy(4000, 4000);
  check(
    '拖到右下极限：右边没出界',
    mBR.panel.right <= mBR.innerW + 1,
    `面板右边 ${fmt(mBR.panel.right)} / 视口宽 ${mBR.innerW}`
  );
  check(
    '拖到右下极限：下边没出界',
    mBR.panel.bottom <= mBR.innerH + 1,
    `面板下边 ${fmt(mBR.panel.bottom)} / 视口高 ${mBR.innerH}`
  );
  check('拖到右下极限：面板还是完整的', mBR.panel.w > 100 && mBR.panel.h > 40,
    `${fmt(mBR.panel.w)}×${fmt(mBR.panel.h)}`);

  const mTL = await dragBy(-4000, -4000);
  check(
    '拖到左上极限：贴着左上角停住',
    mTL.panel.x >= -0.5 && mTL.panel.y >= -0.5,
    `${fmt(mTL.panel.x)}, ${fmt(mTL.panel.y)}`
  );

  // 面板内容变高（顶栏那个「原文」开关一收一放）也不该把自己顶出视口
  await dragBy(4000, 4000);
  const toggleSrc = () =>
    page.evaluate(() => {
      const root = document.getElementById('request-translate-host').shadowRoot;
      root.querySelector('[data-act="src"]').click();
    });
  await toggleSrc();
  await page.waitForTimeout(150);
  await toggleSrc();
  await page.waitForTimeout(250);

  const mGrow = await measure();
  check(
    '内容变高后仍然整个在视口里',
    mGrow.panel.bottom <= mGrow.innerH + 1,
    `面板下边 ${fmt(mGrow.panel.bottom)} / 视口高 ${mGrow.innerH}`
  );

  await page.evaluate(() => {
    document.getElementById('corner')?.remove();
    window.getSelection()?.removeAllRanges();
  });

  /* ------------------------------------------------------------------ */
  /* 9. 刷新页面后：第一次划词 / 第一次开面板                             */
  /* ------------------------------------------------------------------ */
  /* 设置是**异步**读进来的，而初始化时 applyAppearance() 先按默认值跑过一次。
     这一段专门盯「冷启动」这两条路径：刷新后第一次划词就得是存下来的样式，
     第一次开面板（再贴上最容易出视口的右下角）就得整个在视口里。
     单独放一节、前面不留状态，免得跟别的用例互相干扰。 */

  console.log('\n9. 刷新页面后：第一次划词、第一次开面板');

  // 先把当前配置指到本地假接口：这一段要的是「面板真的开出来」，
  // 不能让它去够真实网络（挂在那儿 20 秒，测量也就没意义了）
  await opt.evaluate(async (url) => {
    const { state } = await chrome.storage.local.get('state');
    const id = 'e2e-local';
    const cfg = {
      id,
      name: '本地假接口',
      note: '',
      adapter: '',
      request: 'curl ' + url,
      path: '',
      responseMode: 'text'
    };
    const i = state.configs.findIndex((c) => c.id === id);
    if (i >= 0) state.configs[i] = cfg;
    else state.configs.push(cfg);
    state.activeConfigId = id;
    // 把「显示原文」打开：原文区是开面板之后才填进去的，会让面板临时长高，
    // 正好是夹取最容易漏掉的那种情况（这也是唯一能让面板切底的路径）
    state.settings = { ...state.settings, showOriginal: true };
    await chrome.storage.local.set({ state });
  }, `http://127.0.0.1:${port}/text`);

  await page.reload();
  // 别用固定毫秒数赌 content script 注入了 —— 等宿主节点真的挂上来。
  // 之后那点等待是留给「异步读进来的设置落到按钮上」的，不能等太久：
  // 等过头就等于替被测代码把活干了，这一节也就没意义了。
  await page
    .waitForFunction(() => !!document.getElementById('request-translate-host'), null, { timeout: 10000 })
    .catch(() => {});
  await page.waitForTimeout(500);

  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await selectText();
  await page.waitForTimeout(400);
  const mFresh = await measure();
  // 断言「按钮用的是存档里那个样式」而不是写死某个预设名 —— 上面的用例换过预设，
  // 写死就得跟着改，而且那样测的也不是这条要管的事了。
  // 注意得从**设置页**读 storage：网页那边是主世界，根本没有 chrome.storage。
  const storedStyle = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    return state.settings.triggerStyle;
  });
  check(
    '刷新后第一次划词就是存下来的样式',
    new RegExp('(^|\\s)s-' + storedStyle + '(\\s|$)').test(mFresh.triggerCls),
    `${storedStyle}｜${mFresh.triggerCls}`
  );
  near('刷新后大小也是存下来的 60px', mFresh.trigger.w, 60, 1.5, 'px');
  check('刷新后自定义图标也在', mFresh.triggerPathD === 'M4 12h16', mFresh.triggerPathD);

  // 冷启动下贴右下角开面板
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.id = 'corner-cold';
    d.style.cssText =
      'position:fixed;right:6px;bottom:6px;width:170px;font:14px/20px sans-serif;background:#eee';
    d.textContent = '右下角的文字';
    document.body.appendChild(d);

    const node = d.firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, node.textContent.length);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(range);

    const tail = range.getClientRects()[0];
    document.dispatchEvent(
      new MouseEvent('mouseup', {
        bubbles: true,
        composed: true,
        clientX: tail.right - 2,
        clientY: tail.top + tail.height / 2
      })
    );
  });
  await page.waitForTimeout(300);
  await page.click('.rt-trigger', { force: true });
  await settle();
  await page.waitForTimeout(300);

  const mCold = await measure();
  check(
    '冷启动第一次开面板：下边也没出界',
    mCold.panel.bottom <= mCold.innerH + 1,
    `面板下边 ${fmt(mCold.panel.bottom)} / 视口高 ${mCold.innerH}`
  );
  check(
    '冷启动第一次开面板：右边也没出界',
    mCold.panel.right <= mCold.innerW + 1,
    `面板右边 ${fmt(mCold.panel.right)} / 视口宽 ${mCold.innerW}`
  );

  const coldOut = await page.evaluate(() => {
    const root = document.getElementById('request-translate-host').shadowRoot;
    return {
      out: root.querySelector('.rt-out').textContent,
      msg: root.querySelector('.rt-msg').textContent,
      src: root.querySelector('.rt-src').textContent,
      srcHidden: root.querySelector('.rt-src').classList.contains('hidden')
    };
  });
  check(
    '冷启动这次请求真打在本地假接口上',
    coldOut.out.includes('本地假译文'),
    `${coldOut.msg}｜${coldOut.out}`
  );
  check('原文区在（这段就是被切底的元凶）', !coldOut.srcHidden && coldOut.src.includes('右下角'), coldOut.src);

  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    document.getElementById('corner-cold')?.remove();
    window.getSelection()?.removeAllRanges();
  });

  /* ------------------------------------------------------------------ */
  /* 10. 翻译截图（OCR）：真剪切板 → 假 OCR 接口 → 面板                  */
  /* ------------------------------------------------------------------ */
  /* 全链路真跑一遍：把一张**真 PNG**塞进系统剪切板（就是 Win + Shift + S
     留下的那种），再触发右键菜单里那条消息。剩下的扩展自己走：
       offscreen 文档读剪切板 → 转 data URL → POST 到 OCR 接口 →
       把认出来的文字丢进正常的翻译链路（配置已经指向本地假译文接口）。
     OCR 接口是假的，「读剪切板」这一步是真的 —— 浏览器给的限制全在这一步上
     （offscreen 文档拿不到焦点、剪贴板项的类型可能是空串）。 */

  console.log('\n10. 翻译截图（OCR）：真剪切板图片走一遍全链路');

  /* 模板化之后 OCR 编辑器就是一个大文本框（和配置栏同款）——
     e2e 用这一段当「用户手写」的模板，指到本地假接口。 */
  const ocrTpl = (url) => [
    'curl ' + url + ' \\',
    '  -H "Content-Type: application/json" \\',
    '  -H "Authorization: Bearer sk-e2e" \\',
    "  -d '{",
    '  "model": "e2e-ocr-model",',
    '  "messages": [',
    '    {"role": "user", "content": [',
    '      {"type": "image_url", "image_url": {"url": "{{image}}"}},',
    '      {"type": "text", "text": "<image>\\nFree OCR."}',
    '    ]}',
    '  ],',
    '  "temperature": 0.01',
    "}'"
  ].join('\n');

  /* ---- 设置页的 OCR 那一栏 ---- */
  await opt.evaluate(() => document.querySelector('.tab[data-tab="ocr"]')?.click());
  await opt.waitForTimeout(250);

  const ocrShape = await opt.evaluate(() => ({
    rows: [...document.querySelectorAll('#ocr-list .cfg-row')].map((b) => b.dataset.id),
    active: ((document.querySelector('#ocr-list .cfg-row:has(> .cfg-item.is-active)') || { dataset: {} }).dataset.id || ''),
    chipCount: document.querySelectorAll('#ocr-blocks .chips .chip').length,
    request: document.querySelector('#ocr-blocks .req-block .rb-request').value,
    preview: (document.querySelector('#o-preview') || {}).textContent || ''
  }));
  check('列表里内置的三条都在', ocrShape.rows.length >= 3, ocrShape.rows.join(','));
  check('默认选中硅基流动那条', ocrShape.active === 'builtin-siliconflow', ocrShape.active);
  check(
    '编辑器里就是选中那条的请求模板（地址 / 模型 / 图片占位符 / 提示词都在文本里）',
    ocrShape.request.includes('https://api.siliconflow.cn/v1/chat/completions') &&
      ocrShape.request.includes('deepseek-ai/DeepSeek-OCR') &&
      ocrShape.request.includes('{{image}}') &&
      ocrShape.request.includes('<image>\\nFree OCR.'),
    ocrShape.request.slice(0, 120)
  );
  check('占位符标签四个（image / imageBase64 / imageUrlEncoded / apiKey）',
    ocrShape.chipCount === 4, String(ocrShape.chipCount));

  /* ---- OCR 栏的请求模板要和配置栏**同一副骨架 / 同一套排版**（kniph 2026-10-14：
         把配置栏那几轮推进覆盖到 OCR 栏）---- */
  const ocrTplShape = await opt.evaluate(() => {
    const box = document.querySelector('#ocr-blocks .req-block .rb-request');
    const d = box && box.closest('details.tpl-fold');
    const body = d && d.querySelector(':scope > .fold-body');
    // 拿配置栏那段的样式当基准：两栏的 textarea 必须逐项相同
    const pick = (el) => {
      const cs = getComputedStyle(el);
      return ['fontFamily', 'fontSize', 'lineHeight', 'padding', 'borderRadius', 'minHeight', 'whiteSpace']
        .map((k) => cs[k]).join(' | ');
    };
    const sum = getComputedStyle(d.querySelector('summary'));
    return {
      // 诊断用：哪儿不像就报哪儿
      parts: {
        isDetails: d.tagName === 'DETAILS',
        preview: d.classList.contains('preview'),
        tplFold: d.classList.contains('tpl-fold'),
        kids: body ? [...body.children].map((c) => c.tagName + '.' + c.className) : null,
        open: d.open
      },
      sameSkeleton: d.tagName === 'DETAILS' && d.classList.contains('preview') &&
        d.classList.contains('tpl-fold') && !!body && body.children.length === 3 &&
        body.children[0].classList.contains('chips') &&
        body.children[1].tagName === 'TEXTAREA' && body.children[2].classList.contains('hint'),
      ownStyle: pick(box),
      open: d.open,
      summaryStyle: ['fontSize', 'padding', 'margin'].map((k) => sum[k]).join(' | ')
    };
  });
  // 同一套样式的证据：和配置栏那段用的是同一条 CSS 规则（选择器里 #o-request 和 .rb-request 并列）
  const cfgTplStyle = await opt.evaluate(async () => {
    document.querySelector('.tab[data-tab="configs"]')?.click();
    await new Promise((r) => setTimeout(r, 200));
    document.querySelectorAll('#req-blocks .req-block').forEach((b) => b.classList.add('open'));
    const el = document.querySelector('#req-blocks .req-block .rb-request');
    const cs = getComputedStyle(el);
    const out = ['fontFamily', 'fontSize', 'lineHeight', 'padding', 'borderRadius', 'minHeight', 'whiteSpace']
      .map((k) => cs[k]).join(' | ');
    document.querySelector('.tab[data-tab="ocr"]')?.click();
    await new Promise((r) => setTimeout(r, 200));
    return out;
  });
  check('OCR 的请求模板也是配置栏那副骨架（details.preview.tpl-fold > summary + fold-body > 标签排 + 文本框 + 说明）',
    ocrTplShape.sameSkeleton, JSON.stringify(ocrTplShape.parts));
  check('两个栏的请求模板文本框排版逐项相同（同一条 CSS 规则在管）',
    ocrTplShape.ownStyle === cfgTplStyle, `${ocrTplShape.ownStyle}\n   VS ${cfgTplStyle}`);
  check('OCR 的请求模板默认摊开（那是这栏天天要改的东西）', ocrTplShape.open === true, String(ocrTplShape.open));

  /* 折叠手势也一样：**先点块头 ▾ 把整块摊开**（两栏同一个手势），再点模板的标题栏折 / 展。
     ⚠️ 判据用**几何**（框高缩到只剩标题栏那行），别用 `offsetParent` —— 这个 Edge 上
     收起的 <details> 里 `offsetParent` 仍然不是 null（content-visibility 那套），量不出来。
     ⚠️ 块默认收起（`.req-block:not(.open) .rb-body { display:none }`），不先摊开的话
     里面那个 <summary> 是**点不到的**（playwright 会报 element is not visible）。 */
  const ocrGripBox = await opt.evaluate(() => {
    const b = document.querySelector('#ocr-blocks .req-block:first-child');
    b.scrollIntoView({ block: 'nearest' });
    const q = b.querySelector('.rb-fold').getBoundingClientRect();
    return { x: q.x + q.width / 2, y: q.y + q.height / 2 };
  });
  await opt.mouse.click(ocrGripBox.x, ocrGripBox.y);
  await opt.waitForTimeout(320);
  const ocrBlockOpen = await opt.evaluate(() => {
    const b = document.querySelector('#ocr-blocks .req-block:first-child');
    return {
      open: b.classList.contains('open'),
      body: getComputedStyle(b.querySelector('.rb-body')).display
    };
  });
  check('OCR 那块也是点 ▾ 摊开（和配置栏同一个手势）',
    ocrBlockOpen.open && ocrBlockOpen.body !== 'none', JSON.stringify(ocrBlockOpen));

  const ocrFoldBefore = await opt.evaluate(() => {
    const d = document.querySelector('#ocr-blocks .req-block:first-child details.tpl-fold');
    return {
      h: Math.round(d.getBoundingClientRect().height),
      sum: Math.round(d.querySelector('summary').getBoundingClientRect().height)
    };
  });
  await opt.locator('#ocr-blocks .req-block:first-child details.tpl-fold > summary').click();
  await opt.waitForTimeout(150);
  const ocrFoldOff = await opt.evaluate(() => {
    const d = document.querySelector('#ocr-blocks .req-block:first-child details.tpl-fold');
    return { open: d.open, h: Math.round(d.getBoundingClientRect().height) };
  });
  check('点 OCR 请求模板的标题栏就收起来（和配置栏一个手势）',
    ocrFoldOff.open === false && ocrFoldOff.h < ocrFoldBefore.h / 3 &&
      ocrFoldOff.h <= ocrFoldBefore.sum + 2,
    `${ocrFoldBefore.h}px → ${ocrFoldOff.h}px（标题栏 ${ocrFoldBefore.sum}px）`);
  await opt.locator('#ocr-blocks .req-block:first-child details.tpl-fold > summary').click();
  await opt.waitForTimeout(150);
  const ocrFoldBack = await opt.evaluate(() => {
    const d = document.querySelector('#ocr-blocks .req-block:first-child details.tpl-fold');
    return { open: d.open, h: Math.round(d.getBoundingClientRect().height) };
  });
  check('再点一下摊开（高度长回去）',
    ocrFoldBack.open === true && ocrFoldBack.h > ocrFoldBefore.h - 2, JSON.stringify(ocrFoldBack));

  /* OCR 栏也要贯彻那条理念：**整条请求摊开给用户看**，别让他猜扩展发了什么。 */
  check(
    'OCR 栏把整条请求摊开（方法 / 地址 / 请求头 / 请求体）',
    /方法：POST/.test(ocrShape.preview) &&
      ocrShape.preview.includes('https://api.siliconflow.cn/v1/chat/completions') &&
      /请求头：[\s\S]*Authorization:/.test(ocrShape.preview) &&
      /实际会发出的请求体/.test(ocrShape.preview) &&
      /"image_url"/.test(ocrShape.preview) &&
      /"text"/.test(ocrShape.preview),
    ocrShape.preview.slice(0, 100)
  );
  check(
    '预览里的图是一张示例图（真截图是几十万字符的 data URL，摊出来没法看）',
    ocrShape.preview.includes('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='),
    ocrShape.preview.slice(0, 120)
  );
  check(
    '还没填 Key 时预览直说「还没填」（不用等他点了测试才知道）',
    ocrShape.preview.includes('Bearer （还没填）'),
    ocrShape.preview.split('\n').slice(-4).join(' ｜ ')
  );
  /* 编辑器是一列 flex：预览块曾经被当成**可压缩项**，被压成几十像素高、
     再被 .preview 的 overflow:hidden 剪掉大半 —— 屏幕上只剩「方法 / 地址」两行，
     看着像没渲染出来。量一下框高必须装得下 summary + pre。
     （预览现在默认收起，量之前先展开。） */
  const pvBox = await opt.evaluate(() => {
    const pre = document.querySelector('#o-preview');
    const d = pre.closest('details');
    d.open = true;
    const sum = d.querySelector('summary');
    return {
      box: Math.round(d.getBoundingClientRect().height),
      need: Math.round(pre.getBoundingClientRect().height + sum.getBoundingClientRect().height)
    };
  });
  check(
    '预览块没被 flex 压扁（框比内容矮 = 被剪掉了）',
    pvBox.box >= pvBox.need - 2,
    `框 ${pvBox.box} / 需要 ${pvBox.need}`
  );

  // 点另一条 → 切过去 + 落盘
  await opt.evaluate(() => {
    const b = [...document.querySelectorAll('#ocr-list .cfg-row')]
      .find((x) => x.dataset.id === 'builtin-openai-vl');
    if (b) b.querySelector('.cfg-item').click();
  });
  await opt.waitForTimeout(1300);
  const switched = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    return {
      saved: state.ocr.activeId,
      dom: ((document.querySelector('#ocr-list .cfg-row:has(> .cfg-item.is-active)') || { dataset: {} }).dataset.id || '')
    };
  });
  check(
    '点一条就切过去，而且立刻落盘',
    switched.saved === 'builtin-openai-vl' && switched.dom === 'builtin-openai-vl',
    JSON.stringify(switched)
  );

  // 把选中那条的请求模板指到本地假 OCR 接口
  await opt.evaluate(async (tpl) => {
    const el = document.querySelector('#ocr-blocks .req-block .rb-request');
    el.value = tpl;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1000));
  }, ocrTpl(`http://127.0.0.1:${port}/ocr`));
  await opt.waitForTimeout(1300);

  const ocrSaved = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    const p = state.ocr.providers.find((x) => x.id === state.ocr.activeId);
    return { request: p.request, responsePath: p.responsePath };
  });
  check(
    '改过的 OCR 模板落盘了（原样一字不改）',
    ocrSaved.request.includes(`127.0.0.1:${port}/ocr`) && ocrSaved.request.includes('e2e-ocr-model') &&
      ocrSaved.request.includes('sk-e2e') && ocrSaved.request.includes('Free OCR.'),
    ocrSaved.request.slice(0, 120)
  );

  /* 预览是跟着输入框实时刷的 —— 改了模板就该当场看到新的那条请求 */
  const ocrPreview2 = await opt.evaluate(() => document.querySelector('#o-preview').textContent);
  check(
    '改了模板预览跟着变（模型名和接口地址都是刚写的那份）',
    ocrPreview2.includes('e2e-ocr-model') && ocrPreview2.includes(`127.0.0.1:${port}/ocr`),
    ocrPreview2.slice(0, 100)
  );
  check(
    '预览里头的 key 是打码的（短的 → Bearer ***，别把整把 key 印在屏幕上）',
    !ocrPreview2.includes('Bearer sk-e2e') && /Authorization: Bearer \*+/.test(ocrPreview2),
    (ocrPreview2.match(/Authorization: .*/) || [''])[0]
  );

  // 新建 / 删除
  const beforeNew = await opt.evaluate(() => document.querySelectorAll('#ocr-list .cfg-item').length);
  await opt.click('#btn-ocr-new');
  await opt.waitForTimeout(1300);
  const afterNew = await opt.evaluate(() => ({
    n: document.querySelectorAll('#ocr-list .cfg-item').length,
    active: ((document.querySelector('#ocr-list .cfg-row:has(> .cfg-item.is-active)') || { dataset: {} }).dataset.id || ''),
    hasEditor: !document.querySelector('#ocr-editor').hidden
  }));
  check(
    '新建一条：列表变长、自动切过去、编辑器还在',
    afterNew.n === beforeNew + 1 && !!afterNew.active && afterNew.hasEditor,
    JSON.stringify(afterNew)
  );

  await opt.evaluate(() => { window.confirm = () => true; });
  await opt.click('#btn-ocr-delete');
  await opt.waitForTimeout(1400);
  const afterDel = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    return {
      n: document.querySelectorAll('#ocr-list .cfg-item').length,
      providers: state.ocr.providers.length,
      active: state.ocr.activeId
    };
  });
  check(
    '删掉之后真的少了一条，而且选中回到还在的那条',
    afterDel.n === beforeNew && afterDel.providers === beforeNew && afterDel.active === 'builtin-openai-vl',
    JSON.stringify(afterDel)
  );

  /* ---- 设置页那个「测试」按钮：真发一次 OCR，结果摊在页面上 ---- */
  const probeShot = path.join(os.tmpdir(), 'rt-e2e-ocr-probe.png');
  await page.screenshot({ path: probeShot });
  const probeBuf = fs.readFileSync(probeShot);

  const hitsBeforeOcrTest = ocrHits;
  await opt.setInputFiles('#ocr-test-img', { name: 'probe.png', mimeType: 'image/png', buffer: probeBuf });
  await opt.click('#btn-ocr-test');
  await opt
    .waitForFunction(
      () => {
        const el = document.querySelector('#ocr-test-result');
        return !!el && !el.hidden && /HTTP \d/.test(el.textContent);
      },
      null,
      { timeout: 30000 }
    )
    .catch(() => {});

  const ocrTestOut = await opt.evaluate(() => {
    const el = document.querySelector('#ocr-test-result');
    return { text: el.textContent, html: el.innerHTML, folded: !!el.querySelector('details.test-fold') };
  });
  check('设置页点「测试」真的发了一次 OCR 请求', ocrHits === hitsBeforeOcrTest + 1,
    `假接口被打 ${ocrHits - hitsBeforeOcrTest} 次`);
  check('结果显示假接口返回的识别文字', ocrTestOut.text.includes(OCR_TEXT), ocrTestOut.text.slice(0, 140));
  check('认出来了就不折（要看的识别结果直接可见，和配置栏同一套 resultBlockHtml）',
    !ocrTestOut.folded, String(ocrTestOut.folded));
  check('标了 HTTP 200，也带上了这张图的来源和大小',
    /HTTP 200/.test(ocrTestOut.text) && /本地图片 probe\.png · \d/.test(ocrTestOut.text),
    ocrTestOut.text.slice(0, 140));
  check('把实际请求和原始响应都摊出来了',
    ocrTestOut.html.includes('实际请求') && ocrTestOut.html.includes('原始响应'),
    ocrTestOut.html.slice(0, 140));
  check('摊出来的请求头里 key 是打码的（别让设置页截图带走 key）',
    ocrTestOut.html.includes('Bearer ***') && !ocrTestOut.html.includes('sk-e2e'),
    ocrTestOut.text.slice(0, 140));


  /* ---- 配置栏的「测试」也得给 key 打码（2026-10-10 修的 bug）----
     这块以前**只测了 OCR 栏**，配置栏那条路没人看 —— 于是它的「实际请求」一直印着明文 key。
     修法：打码统一在「产生 result」那一层做（engine 的 runRequest / lib/ocr.js 那两个），
     两边的「实际请求」共用同一个 requestBlockHtml 排版。 */
  const prevActiveCfg = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    return state.activeConfigId || '';
  });
  await opt.evaluate(async (u) => {
    const { state } = await chrome.storage.local.get('state');
    const cfg = {
      id: 'e2e-keycfg',
      name: '带 key 的测试配置',
      note: '',
      adapter: '',
      /* 同一把 key 同时出现在**地址查询串**和 Authorization 头里 —— kniph 报的就是
         地址那处一直没打码（老实现只认 Authorization）。地址里的那个走 {{apiKey}} 变量，
         打码跟着变量走才藏得掉；头里那个是写死的明文，兜底那条规则管它。 */
      request:
        "curl -X POST -H 'Content-Type: application/json' " +
        "-H 'Authorization: Bearer sk-cfg-1234567890' " +
        "-d '{\"text\":\"{{text}}\"}' " + u + '?key={{apiKey}}',
      imageRequest: '',
      path: '',
      responseMode: 'text'
    };
    const j = state.configs.findIndex((c) => c.id === 'e2e-keycfg');
    if (j >= 0) state.configs[j] = cfg;
    else state.configs.push(cfg);
    if (!state.vars.some((v) => v.name === 'apiKey')) state.vars.push({ name: 'apiKey', value: '' });
    state.vars = state.vars.map((v) => (v.name === 'apiKey' ? { ...v, value: 'sk-cfg-1234567890' } : v));
    await chrome.storage.local.set({ state });
  }, `http://127.0.0.1:${port}/text`);

  await opt.reload();
  await opt.waitForTimeout(900);
  await opt.evaluate(() => document.querySelector('.tab[data-tab="configs"]')?.click());
  await opt.waitForTimeout(250);
  await opt.click('#cfg-list .cfg-row[data-id="e2e-keycfg"] .cfg-item');
  await opt.waitForTimeout(250);
  /* 顺手挂一条后备（它抄的就是主请求那段，也指 /text）—— 这样链上是 2 条，
     专门验「只发了第 1 条，明说后面 1 条没跑」那句（kniph 报过「按顺序试 2 条」的歧义）。 */
  await opt.click('#btn-add-fallback');
  await opt.waitForTimeout(400);
  await opt.click('#btn-test');
  await opt
    .waitForFunction(
      () => {
        const el = document.querySelector('#test-result');
        return !!el && !el.hidden && /HTTP \d/.test(el.textContent);
      },
      null,
      { timeout: 30000 }
    )
    .catch(() => {});

  const cfgTestOut = await opt.evaluate(() => {
    const el = document.querySelector('#test-result');
    return { text: el.textContent, html: el.innerHTML };
  });
  check('配置栏「测试」把实际请求和原始响应都摊出来了',
    cfgTestOut.html.includes('实际请求') && cfgTestOut.html.includes('原始响应'),
    cfgTestOut.html.slice(0, 120));
  check('结果头说「链上共 2 条请求」，不再写会让人以为「要发 2 条」的「按顺序试 2 条」',
    cfgTestOut.text.includes('链上共 2 条请求') && !cfgTestOut.text.includes('按顺序试'),
    cfgTestOut.text.slice(0, 60));
  check('只发了第 1 条就明说「第 1 条拿到译文，后面 1 条没跑」',
    cfgTestOut.text.includes('第 1 条拿到译文') && cfgTestOut.text.includes('后面 1 条没跑'),
    cfgTestOut.text.slice(0, 90));
  check('配置栏「实际请求」里的 key 也是打码的（曾经是明文摆着）',
    /Authorization: Bearer sk-cfg…（已隐藏）/.test(cfgTestOut.text) &&
      !cfgTestOut.text.includes('sk-cfg-1234567890'),
    (cfgTestOut.text.match(/Authorization: Bearer [^\n]*/) || [''])[0].slice(0, 60));
  /* 地址里的 key：老实现只认 Authorization 头，`?key=…` 一直明文摆着（kniph 报的） */
  check('地址查询串里的 key 也打码了（打码跟着变量走）',
    /\?key=sk-cfg…（已隐藏）/.test(cfgTestOut.text),
    (cfgTestOut.text.match(/HTTP[^\n]*|\/text[^\n]*/) || [''])[0].slice(0, 80));
  check('打码没叠成两层后缀', !cfgTestOut.text.includes('（已隐藏）…（已隐藏）'));

  /* 收尾：删掉临时配置、把选中的配置还回去、把临时填上的 key 清掉、切回 OCR 页签 —— 别污染后面的小节 */
  await opt.evaluate(async (prevId) => {
    const { state } = await chrome.storage.local.get('state');
    state.configs = state.configs.filter((c) => c.id !== 'e2e-keycfg');
    if (prevId && state.configs.some((c) => c.id === prevId)) state.activeConfigId = prevId;
    state.vars = state.vars.map((v) => (v.name === 'apiKey' ? { ...v, value: '' } : v));
    await chrome.storage.local.set({ state });
  }, prevActiveCfg);
  await opt.reload();
  await opt.waitForTimeout(900);
  await opt.evaluate(() => document.querySelector('.tab[data-tab="ocr"]')?.click());
  await opt.waitForTimeout(250);
  /* reload 会把 <input type=file> 里选的图清空 —— 上面那块为了切标签页 reload 了两次，
     这里得把图重选回来，不然下面「撞过的那个 400」点测试时会退化成「读剪切板→拿不到图」。 */
  await opt.setInputFiles('#ocr-test-img', { name: 'probe.png', mimeType: 'image/png', buffer: probeBuf });

  // 真发出去的那份请求体里**不能有** max_tokens —— 这就是 DeepSeek-OCR 那次 400 的根因
  let sentOcrBody = {};
  try {
    sentOcrBody = JSON.parse(lastOcrRequest || '{}');
  } catch {
    /* 解析不了交给下面那条报 */
  }
  check('真发出去的请求体里没有 max_tokens（交给服务端按模型上限定）',
    !('max_tokens' in sentOcrBody), Object.keys(sentOcrBody).join(','));
  check('该带的还在：model / messages / temperature',
    sentOcrBody.model === 'e2e-ocr-model' && Array.isArray(sentOcrBody.messages) &&
      sentOcrBody.temperature === 0.01,
    JSON.stringify(Object.keys(sentOcrBody)));

  /* ---- OCR 供应商也能挂**后备请求**（kniph 2026-10-14：「中转OCR还是只能填一个请求」）----
     主请求打 /ocr-reject（假接口必回 400），后备打 /ocr（正常回识别文字）。
     真点一次「测试」：要看到「主请求挂了 → 自动试后备 → 后备成的」，
     并且**说清是后备成的**（不然用户不知道该改哪一段）。 */
  const activeBeforeFb = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    return state.ocr.activeId || '';
  });
  const fbMain =
    "curl -X POST 'http://127.0.0.1:" + port + "/ocr-reject' \\\n" +
    "  -H 'Content-Type: application/json' \\\n" +
    "  -H 'Authorization: Bearer {{apiKey}}' \\\n" +
    "  -d '{\"model\":\"e2e-ocr\",\"messages\":[{\"role\":\"user\",\"content\":[" +
    '{"type":"image_url","image_url":{"url":"{{image}}"}}]}]}\'';
  const fbBack = fbMain.replace('/ocr-reject', '/ocr');

  await opt.click('#btn-ocr-new');
  await opt.waitForTimeout(900);
  await opt.evaluate(async (tpl) => {
    const set = (i, v) => {
      const box = document.querySelectorAll('#ocr-blocks .req-block .rb-request')[i];
      box.value = v;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set(0, tpl);
    const name = document.querySelector('#o-name');
    name.value = 'e2e-ocr-chain';
    name.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
  }, fbMain);
  await opt.click('#btn-ocr-add-fallback');
  await opt.waitForTimeout(900);
  const fbBlocks = await opt.evaluate(() =>
    [...document.querySelectorAll('#ocr-blocks .req-block')].map((b) => ({
      tag: (b.querySelector('.rb-tag') || {}).textContent,
      main: b.dataset.main === '1' || !!b.querySelector('.rb-tag')
    }))
  );
  check('＋ 加一条后备请求：OCR 栏也多出一块（主请求 + 后备各一块）',
    fbBlocks.length === 2, JSON.stringify(fbBlocks.map((b) => b.tag)));

  await opt.evaluate(async (tpl) => {
    const box = document.querySelectorAll('#ocr-blocks .req-block .rb-request')[1];
    box.value = tpl;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
  }, fbBack);

  // 结果框里还留着上一次的内容 —— 不清掉的话「等 HTTP d」会当场命中旧的那块
  await opt.evaluate(() => {
    const el = document.querySelector('#ocr-test-result');
    el.hidden = true;
    el.innerHTML = '';
  });
  const fbHitsBefore = ocrHits;
  await opt.setInputFiles('#ocr-test-img', { name: 'probe.png', mimeType: 'image/png', buffer: probeBuf });
  await opt.click('#btn-ocr-test');
  await opt
    .waitForFunction(
      () => {
        const el = document.querySelector('#ocr-test-result');
        return !!el && !el.hidden && /HTTP \d/.test(el.textContent);
      },
      null,
      { timeout: 30000 }
    )
    .catch(() => {});
  const fbOut = await opt.evaluate(() => {
    const el = document.querySelector('#ocr-test-result');
    return { text: el.textContent, html: el.innerHTML };
  });
  check('主请求挂了，OCR 也自动去试后备（假接口被打两次：主 → 后备）',
    ocrHits === fbHitsBefore + 2, `假接口被打 ${ocrHits - fbHitsBefore} 次`);
  check('后备成的就报「后备」（不然不知道该改哪一段）',
    fbOut.text.includes('后备'), fbOut.text.slice(0, 160));
  check('拿到的还是识别文字（整条链真跑通了）',
    fbOut.text.includes(OCR_TEXT) && /HTTP 200/.test(fbOut.text), fbOut.text.slice(0, 160));
  check('摊出来的是**成的那条**请求（地址是 /ocr，不是那条 400）',
    fbOut.html.includes(`127.0.0.1:${port}/ocr'`) ||
      fbOut.html.includes(`127.0.0.1:${port}/ocr<`) ||
      !fbOut.html.includes('/ocr-reject'),
    fbOut.html.slice(0, 160));

  // 收尾：把临时那条供应商删掉、选中还回原样（后面几节按内置那三条挑对象）
  // ⚠️ 上面为了切页签 reload 过一次，`window.confirm` 那根桩已经没了 —— 不重新打桩的话
  //    删除会被原生 confirm 挡掉（playwright 默认 dismiss），供应商删不掉。
  await opt.evaluate(() => { window.confirm = () => true; });
  await opt.click('#btn-ocr-delete');
  await opt.waitForTimeout(1200);
  await opt.evaluate(async (id) => {
    const row = [...document.querySelectorAll('#ocr-list .cfg-row')].find((r) => r.dataset.id === id);
    row?.querySelector('.cfg-item')?.click();
  }, activeBeforeFb);
  await opt.waitForTimeout(800);
  const afterFbCleanup = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    return { n: state.ocr.providers.length, active: state.ocr.activeId };
  });
  // 结果框清干净 —— 下一节等的是 HTTP 400，留着这块 HTTP 200 会被当场命中
  await opt.evaluate(() => {
    const el = document.querySelector('#ocr-test-result');
    el.hidden = true;
    el.innerHTML = '';
  });
  check('（收尾）临时那条供应商删掉了、选中还回去了',
    afterFbCleanup.n === 3 && afterFbCleanup.active === activeBeforeFb,
    JSON.stringify(afterFbCleanup));

  /* ---- 撞过的那个 400：提示得说出改哪儿，不能只丢一句原始报文 ---- */
  await opt.evaluate(async (tpl) => {
    const el = document.querySelector('#ocr-blocks .req-block .rb-request');
    el.value = tpl;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
  }, ocrTpl(`http://127.0.0.1:${port}/ocr-reject`));
  await opt.click('#btn-ocr-test');
  await opt
    .waitForFunction(
      () => {
        const el = document.querySelector('#ocr-test-result');
        return !!el && !el.hidden && /HTTP 400/.test(el.textContent);
      },
      null,
      { timeout: 30000 }
    )
    .catch(() => {});
  const rejectOut = await opt.evaluate(() => document.querySelector('#ocr-test-result').textContent);
  check('max_seq_len 那种 400 原样摊出来了', /HTTP 400/.test(rejectOut) && /max_seq_len/.test(rejectOut),
    rejectOut.slice(0, 160));
  check('并且直接说了改哪儿（去模板里删 max_tokens 那行）',
    rejectOut.includes('max_tokens'), rejectOut.slice(0, 200));

  /* 失败这块默认折起来 —— 和配置栏共用 resultBlockHtml（kniph 2026-10-14 要求的「覆盖到 OCR 栏」） */
  const rejectFold = await opt.evaluate(() => {
    const box = document.querySelector('#ocr-test-result');
    const d = box.querySelector('details.test-fold');
    const sum = d ? d.querySelector('summary') : null;
    return {
      folded: !!d,
      open: d ? d.open : null,
      // 收起来 = 框高只剩标题栏那行（别用 offsetParent：收起的 <details> 在这个 Edge 上量不出来）
      h: d ? Math.round(d.getBoundingClientRect().height) : -1,
      sumH: sum ? Math.round(sum.getBoundingClientRect().height) : -1,
      fullH: Math.round(box.getBoundingClientRect().height),
      why: (box.querySelector('.test-fold > summary .why') || {}).textContent || ''
    };
  });
  check('OCR 测试失败的那块默认折起来（报错正文 / 请求 / 响应都不占屏）',
    rejectFold.folded && rejectFold.open === false && rejectFold.h <= rejectFold.sumH + 2 &&
      rejectFold.fullH < 80,
    JSON.stringify(rejectFold));
  check('折起来的块头写着「为什么挂」（从 400 的正文里捞的 message，不是一串 { "error": {）',
    /max_seq_len/.test(rejectFold.why) && !rejectFold.why.includes('{'), rejectFold.why);

  // 把地址还原回能出结果的假接口，后面那节还要用
  await opt.evaluate(async (tpl) => {
    const el = document.querySelector('#ocr-blocks .req-block .rb-request');
    el.value = tpl;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
  }, ocrTpl(`http://127.0.0.1:${port}/ocr`));

  // 清掉选的图 → 回到「读剪切板」那条路。无头窗口的剪切板是桩实现，拿不到图，
  // 正好验一下「拿不到图」是不是给了一句人话（而不是静默什么都不做）
  await opt.setInputFiles('#ocr-test-img', []);
  await opt.click('#btn-ocr-test');
  await opt
    .waitForFunction(
      () => {
        const el = document.querySelector('#ocr-test-result');
        return !!el && /剪切板/.test(el.textContent);
      },
      null,
      { timeout: 10000 }
    )
    .catch(() => {});
  const clipBranch = await opt.evaluate(() => document.querySelector('#ocr-test-result').textContent);
  check('没选图时去读剪切板，读不到就直说（不静默）', /剪切板/.test(clipBranch), clipBranch.slice(0, 140));

  /* 勾上「禁用外置 OCR」之后那块「测试」不关掉，而是**换个对象**：
     不测这条 OCR 供应商，改测左边选中那条图片配置的「图片请求模板」。
     不然勾上之后这条路就没法试了 —— 只能右键截一张图才知道配没配对。 */
  const testBtnOff = await opt.evaluate(() => {
    const el = document.querySelector('#o-disabled');
    el.checked = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return {
      disabled: document.querySelector('#btn-ocr-test').disabled,
      label: document.querySelector('#o-test-label').textContent,
      ocrHintHidden: document.querySelector('#ocr-test-hint').hidden,
      imgHintHidden: document.querySelector('#imgcfg-test-hint').hidden,
      summary: document.querySelector('#o-preview-summary').textContent,
      btnVisible: document.querySelector('#o-test-field').offsetParent !== null,
      // 这块「测试」什么时候都不该被压暗 —— 它一直是个能点的按钮。
      // （踩过：.is-off 那条压暗规则和 .is-imgcfg 是同一个开关 toggle 的，
      //   供应商字段全藏起来之后，只剩下它和请求预览挨着，看着像被禁用了。）
      testOpacity: getComputedStyle(document.querySelector('#o-test-field')).opacity,
      previewOpacity: getComputedStyle(document.querySelector('#o-preview').closest('.preview')).opacity
    };
  });
  check('勾了「禁用外置 OCR」后「测试」那块没有藏起来',
    testBtnOff.btnVisible === true, JSON.stringify(testBtnOff));
  check('测试按钮没被禁用（有几条图片配置在，正好拿来测）',
    testBtnOff.disabled === false, String(testBtnOff.disabled));
  check('标签改成「测试图片配置」', testBtnOff.label === '测试图片配置', testBtnOff.label);
  check('「测试」那块没被压暗（它一直是个能点的按钮）',
    testBtnOff.testOpacity === '1', String(testBtnOff.testOpacity));
  check('请求预览也没被压暗（这时摊的是图片配置那一份）',
    testBtnOff.previewOpacity === '1', String(testBtnOff.previewOpacity));
  check('说明换成图片配置那一套（OCR 那段收起来）',
    testBtnOff.ocrHintHidden === true && testBtnOff.imgHintHidden === false,
    `ocr 隐藏=${testBtnOff.ocrHintHidden}｜图片提示露着=${!testBtnOff.imgHintHidden}`);
  check('预览标题说明这是示例图（真截图是一整段 data URL）',
    /示例图/.test(testBtnOff.summary), testBtnOff.summary);

  /* 勾上之后左栏还得整栏换成「图片配置」—— 那份列表是配置栏数据的**过滤视图**：
     只列填过「图片请求模板」的配置（= 能看图的那些），选中项存在 state.ocr.imageConfigId。 */
  const imgCfgMode = await opt.evaluate(() => ({
    ocrListHidden: document.querySelector('#ocr-list').hidden,
    imgListHidden: document.querySelector('#imgcfg-list').hidden,
    title: document.querySelector('#ocr-list-title').textContent,
    newHidden: document.querySelector('#btn-ocr-new').hidden,
    footHidden: document.querySelector('#imgcfg-foot').hidden,
    hintHidden: document.querySelector('#imgcfg-hint').hidden,
    editorImgCfg: document.querySelector('#ocr-editor').classList.contains('is-imgcfg'),
    // 请求模板整块（现在是个 details）也得跟着收 —— 隐藏清单是按 #editor 的直接子元素逐个点的，
    // 漏一个就是「模式变了但旧东西还在」
    blocksHidden: document.querySelector('#ocr-blocks').offsetParent === null,
    addFbHidden: document.querySelector('#btn-ocr-add-fallback').offsetParent === null,
    checked: document.querySelector('#o-disabled').checked
  }));
  check('勾了之后左栏换成「图片配置」',
    imgCfgMode.ocrListHidden && !imgCfgMode.imgListHidden, JSON.stringify(imgCfgMode));
  check('左栏标题跟着换', imgCfgMode.title === '图片配置', imgCfgMode.title);
  check('「新建供应商」收起来（图片配置的增删改只在「配置」栏）',
    imgCfgMode.newHidden === true, String(imgCfgMode.newHidden));
  /* 请求模板那块现在是一整组**请求块**（#ocr-blocks）—— 直传模式下连同「＋ 加一条后备
     请求」一起收掉：隐藏清单是按 #editor 的直接子元素逐个点的，漏一个就是「旧东西还在」。 */
  check('右边供应商那套字段收起来（请求块整组 + 「加后备」都得收）、只留「图片直传」那句说明',
    imgCfgMode.editorImgCfg && imgCfgMode.blocksHidden && imgCfgMode.addFbHidden && !imgCfgMode.hintHidden,
    `is-imgcfg=${imgCfgMode.editorImgCfg}｜请求块藏着=${imgCfgMode.blocksHidden}｜加后备藏着=${imgCfgMode.addFbHidden}｜hint 露着=${!imgCfgMode.hintHidden}`);

  const imgCfgConsistent = await opt.evaluate(async () => {
    // 行是 .cfg-row（id 挂在它身上），可点的是里面的 .cfg-item
    const ids = [...document.querySelectorAll('#imgcfg-list .cfg-row')].map((b) => b.dataset.id);
    const { state } = await chrome.storage.local.get('state');
    const all = state.configs.filter((c) => String(c.imageRequest || '').trim()).map((c) => c.id);
    return { ids, same: ids.join(',') === all.join(','), all };
  });
  check('列表里不多不少，正好是填过「图片请求模板」的那些',
    imgCfgConsistent.same,
    `列表=[${imgCfgConsistent.ids}]｜存档=[${imgCfgConsistent.all}]`);

  /* 左栏那几条得**一样宽**。踩过（kniph 报的「左边收束的几个选项宽度不一样」）：
     `.cfg-item` 是 <button>，而 `width: auto` 对按钮来说是「**收缩到内容宽度**」
     （fit-content 那套），`flex: 1` 在直接躺在 `.list-body` 里的那些条上又是死的 ——
     结果名字长的条宽、名字短的条窄。

     两种列表现有两种长相，判据得同时容得下：
       · 「OCR 供应商」= `.list-body > .cfg-item`（条目直接躺列表里，靠 width:100% 铺满）
       · 「图片配置」= `.list-body > .cfg-row > .cfg-item`（行是 flex，条目靠 flex:1 拉平，
         行里还夹着手柄和 ↑↓）
     所以量的是「条目 + 同一行里除它以外的那些」= 行宽：这样两种长相都能说
     「每行正好占满列表可用宽度」。**只有一条也能测** —— 有 bug 时它会缩成一个窄条。 */
  const colW = (sel) =>
    opt.evaluate((s) => {
      const list = document.querySelector(s);
      const cs = getComputedStyle(list);
      const inner = list.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const items = [...list.querySelectorAll('.cfg-item')];
      return {
        ws: items.map((el) => Math.round(el.getBoundingClientRect().width)),
        // 同一行里条目之外还占了多少（手柄 + 上下移 + 间隙）；直接躺列表里的那些是 0
        chrome: items.map((el) => {
          const row = el.closest('.cfg-row');
          if (!row) return 0;
          return Math.round(row.getBoundingClientRect().width - el.getBoundingClientRect().width);
        }),
        inner: Math.round(inner),
        // 名字长度跟着一起报出来 —— 宽度真出问题时，一眼就能看出是「跟着文字走的」
        lens: items.map((el) => (el.querySelector('.name').textContent || '').length)
      };
    }, sel);

  /** 每一行（条目 + 行内其他东西）是不是都正好占满列表可用宽度 */
  const fillsList = (m) => m.ws.map((w, i) => Math.abs(w + m.chrome[i] - m.inner)).every((d) => d <= 1);

  const imgColW = await colW('#imgcfg-list');
  imgCfgRowChrome = await opt.evaluate(() =>
    [...document.querySelectorAll('#imgcfg-list .cfg-row')].map((r) => ({
      rowH: Math.round(r.getBoundingClientRect().height),
      chrome: Math.round(r.getBoundingClientRect().width - r.querySelector('.cfg-item').getBoundingClientRect().width),
      grips: r.querySelectorAll('.cfg-grip').length,
      mv: r.querySelectorAll('.cfg-mv-btn').length
    }))
  );
  check('（脚手架）直传模式下左栏有图片配置在', imgColW.ws.length >= 1, String(imgColW.ws.length));
  check('左栏那几条一样宽（不是各自缩到自己文字的宽度）',
    new Set(imgColW.ws).size === 1,
    `${imgColW.ws.join(' / ')}｜名字长度 ${imgColW.lens.join('/')}`);
  check('而且每行都占满列表的可用宽度',
    fillsList(imgColW),
    `条 ${imgColW.ws[0]} + 行内 ${imgColW.chrome[0]} ｜ 可用 ${imgColW.inner}`);

  /* ---- 图片配置列表也能拖动排序 / 上下移（和「配置」栏同一套逻辑）----
     kniph 要的：「禁用外置 OCR 时左边的配置也要和配置列表一样可以拖动排序」。
     那份列表是 state.configs 的**过滤视图**，所以排序动的还是 state.configs 本身 ——
     副作用是「配置」栏的先后跟着一起变，这正是「逻辑一样」的意思，两边都得验。 */
  // 这会儿只有一条图片配置，一条没法测排序 —— 真走一遍 UI，给另一条配置填上图片模板凑第二条
  await opt.evaluate(() => document.querySelector('.tab[data-tab="configs"]')?.click());
  await opt.waitForTimeout(180);
  await opt.evaluate(async () => {
    const row = [...document.querySelectorAll('#cfg-list .cfg-row')]
      .find((r) => r.dataset.id === 'builtin-deepseek');
    row?.querySelector('.cfg-item')?.click();
    await new Promise((r) => setTimeout(r, 250));
    document.querySelector('#req-blocks .req-block:first-child .img-tpl').open = true; // 默认收起的 <details>
    const box = document.querySelector('#req-blocks .req-block:first-child .rb-image-request');
    box.value = '{"mode":"e2e-imgcfg-2","text":"{{image}}"}';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1100));
  });
  await opt.evaluate(async () => {
    document.querySelector('.tab[data-tab="ocr"]')?.click();
    await new Promise((r) => setTimeout(r, 250));
  });
  await opt.waitForTimeout(250);

  /** 过滤视图里的顺序 / 存档里的顺序 / 「配置」栏当前画出来的顺序 */
  const imgOrder = () =>
    opt.evaluate(async () => {
      const dom = [...document.querySelectorAll('#imgcfg-list .cfg-row')].map((r) => r.dataset.id);
      const { state } = await chrome.storage.local.get('state');
      return {
        dom,
        cfgDom: [...document.querySelectorAll('#cfg-list .cfg-row')].map((r) => r.dataset.id),
        saved: state.configs.map((c) => c.id),
        visible: state.configs.filter((c) => String(c.imageRequest || '').trim()).map((c) => c.id)
      };
    });

  const imgShape = await opt.evaluate(() => {
    const rows = [...document.querySelectorAll('#imgcfg-list .cfg-row')];
    return {
      rows: rows.length,
      grips: document.querySelectorAll('#imgcfg-list .cfg-grip').length,
      mvs: document.querySelectorAll('#imgcfg-list .cfg-mv-btn').length,
      firstUp: rows[0].querySelector('.cfg-mv-btn[data-mv="-1"]').disabled,
      lastDown: rows[rows.length - 1].querySelector('.cfg-mv-btn[data-mv="1"]').disabled
    };
  });
  check('（脚手架）凑够两条图片配置，才测得了排序', imgShape.rows >= 2, String(imgShape.rows));
  check('图片配置每行也有手柄 + 上下移（和「配置」栏长得一样）',
    imgShape.grips === imgShape.rows && imgShape.mvs === imgShape.rows * 2,
    `${imgShape.rows} 行 / ${imgShape.grips} 个手柄 / ${imgShape.mvs} 个按钮`);
  check('图片配置的头尾 ↑ ↓ 也各禁掉一边',
    imgShape.firstUp === true && imgShape.lastDown === true);

  const imgBefore = await imgOrder();
  check('（脚手架）存档里能翻图的正好就是屏幕上那几条',
    JSON.stringify(imgBefore.visible) === JSON.stringify(imgBefore.dom),
    `屏幕 ${imgBefore.dom}｜存档 ${imgBefore.visible}`);

  /** 图片配置列表里每一行的几何（拖动要用） */
  const imgBoxes = () =>
    opt.evaluate(() =>
      [...document.querySelectorAll('#imgcfg-list .cfg-row')].map((r) => {
        const b = r.getBoundingClientRect();
        const g = r.querySelector('.cfg-grip').getBoundingClientRect();
        return {
          id: r.dataset.id,
          top: b.top,
          bottom: b.bottom,
          gripX: g.left + g.width / 2,
          gripY: g.top + g.height / 2
        };
      })
    );

  // 把最后一条拖到第一条上半区（dragTo 是第 7 节那套手势，这里复用）
  let ib = await imgBoxes();
  let iSrc = ib[ib.length - 1];
  let iDst = ib[0];
  await dragTo(iSrc, iDst.top + 2);

  const imgMark = await opt.evaluate(() => {
    const t = document.querySelector('#imgcfg-list .cfg-row.drop-before');
    const h = document.querySelector('#imgcfg-list .cfg-row.dragging');
    return { before: t ? t.dataset.id : '', dragging: h ? h.dataset.id : '' };
  });
  check('图片配置拖动时也画「会插到这儿」的指示线', imgMark.before === iDst.id, imgMark.before || '(没有)');
  check('图片配置被拖的那一行也有反馈', imgMark.dragging === iSrc.id, imgMark.dragging || '(没有)');

  await opt.mouse.up();
  await opt.waitForTimeout(1300);
  const imgAfter = await imgOrder();
  check('拖到最前面之后，图片配置的顺序真的变了',
    imgAfter.dom[0] === iSrc.id, imgAfter.dom.join(','));
  check('就那么几条，没多没少',
    imgAfter.dom.length === imgBefore.dom.length, `${imgBefore.dom.length} → ${imgAfter.dom.length}`);
  check('排序动的是 state.configs 本身（存档里能翻图的几条，顺序和屏幕一致）',
    JSON.stringify(imgAfter.visible) === JSON.stringify(imgAfter.dom),
    `存档 ${imgAfter.visible}｜屏幕 ${imgAfter.dom}`);
  check('「配置」栏跟着一起重排了（同一份数据 —— 这就是「逻辑一样」）',
    JSON.stringify(imgAfter.cfgDom) === JSON.stringify(imgAfter.saved) &&
      JSON.stringify(imgAfter.cfgDom) !== JSON.stringify(imgBefore.cfgDom),
    `${imgBefore.cfgDom.slice(0, 4).join(',')} → ${imgAfter.cfgDom.slice(0, 4).join(',')}`);

  const imgLeftover = await opt.evaluate(
    () =>
      document.querySelectorAll(
        '#imgcfg-list .drop-before, #imgcfg-list .drop-after, #imgcfg-list .dragging'
      ).length
  );
  check('图片配置松手后指示线 / 拖动态也清干净了', imgLeftover === 0, `${imgLeftover} 个残留`);

  // 反向：把现在最前面那条拖到末尾（off-by-one 正好藏在这个方向）
  ib = await imgBoxes();
  iSrc = ib[0];
  iDst = ib[ib.length - 1];
  await dragTo(iSrc, iDst.bottom - 2);
  await opt.mouse.up();
  await opt.waitForTimeout(1300);
  const imgBack = await imgOrder();
  check('往回拖到末尾也对（可见项的先后回到原样）',
    JSON.stringify(imgBack.dom) === JSON.stringify(imgBefore.dom), imgBack.dom.join(','));

  /* 收尾：把临时借来那条图片模板清掉 —— 后面那节按「有图片配置在」挑测试对象，
     多一条会让「挑中哪一条」变得看运气。顺序不动（后面几节不依赖它）。 */
  await opt.evaluate(() => document.querySelector('.tab[data-tab="configs"]')?.click());
  await opt.waitForTimeout(180);
  await opt.evaluate(async () => {
    const row = [...document.querySelectorAll('#cfg-list .cfg-row')]
      .find((r) => r.dataset.id === 'builtin-deepseek');
    row?.querySelector('.cfg-item')?.click();
    await new Promise((r) => setTimeout(r, 250));
    document.querySelector('#req-blocks .req-block:first-child .img-tpl').open = true;
    const box = document.querySelector('#req-blocks .req-block:first-child .rb-image-request');
    box.value = '';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1100));
  });
  const afterCleanup = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    return state.configs.filter((c) => String(c.imageRequest || '').trim()).map((c) => c.id);
  });
  check('收尾：临时那条图片模板清掉了（回到原来那一条）',
    afterCleanup.length === 1, afterCleanup.join(',') || '(一条都没有)');

  /* ---- 真跑一次「测试图片配置」：本地图片 → 假接口 → 译文摆出来 ---- */
  /* 先给选中的那条图片配置写一段能解析的模板（配置栏那条原本只是个 JSON 片段，
     没有地址，解析不出请求）。这一段就是设置页预览 / 测试要发的东西。 */
  const imgTestCfgId = imgCfgConsistent.ids[0];
  const imgTestTpl =
    `curl -X POST 'http://127.0.0.1:${port}/imgtest' \\\n` +
    '  -H "Content-Type: application/json" \\\n' +
    '  -d \'{"model":"see","messages":[{"role":"user","content":[' +
    '{"type":"image_url","image_url":{"url":"{{image}}"}},' +
    '{"type":"text","text":"翻成{{target}}"}]}]}\'';

  await opt.evaluate(async () => {
    document.querySelector('.tab[data-tab="config"]')?.click();
  });
  await opt.waitForTimeout(150);
  await opt.evaluate(async (id) => {
    // 配置行是 .cfg-row（dataset.id），可点的是里面的 .cfg-item
    const row = [...document.querySelectorAll('#cfg-list .cfg-row')].find((b) => b.dataset.id === id);
    const item = row && row.querySelector('.cfg-item');
    if (item) item.click();
  }, imgTestCfgId);
  await opt.waitForTimeout(200);
  await opt.evaluate(async (tpl) => {
    document.querySelector('#req-blocks .req-block:first-child .img-tpl').open = true;
    const box = document.querySelector('#req-blocks .req-block:first-child .rb-image-request');
    box.value = tpl;
    box.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
  }, imgTestTpl);

  /* 填了「图片请求模板」的那条，块头上要有一枚小标记 —— 配置栏里图片模板是**块内的二级
     details**（没填时收起），不搁这个标记，收起状态的块头压根看不出「这条能翻图」。 */
  const imgBadge = await opt.evaluate(async (id) => {
    const row = [...document.querySelectorAll('#cfg-list .cfg-row')].find((b) => b.dataset.id === id);
    const item = row && row.querySelector('.cfg-item');
    if (item) item.click();
    await new Promise((r) => setTimeout(r, 250));
    const head = document.querySelector('#req-blocks .req-block:first-child .rb-head');
    const badge = head && head.querySelector('.rb-badge');
    if (!badge) return { badge: false };
    const cs = getComputedStyle(badge);
    return { badge: true, text: badge.textContent.trim(), width: Math.round(badge.getBoundingClientRect().width), title: badge.title };
  }, imgTestCfgId);
  check('填了图片模板的那条，块头上有一枚「图」标记',
    imgBadge.badge && imgBadge.text === '图', JSON.stringify(imgBadge));
  check('标记是固定宽度的（不把块头那句摘要挤歪）',
    imgBadge.badge && imgBadge.width <= 26, `宽 ${imgBadge.width}px`);
  check('鼠标停上去说清它是干什么的',
    imgBadge.badge && /图片请求模板/.test(imgBadge.title), imgBadge.title || '(没有 title)');
  await opt.evaluate(async () => {
    document.querySelector('.tab[data-tab="ocr"]')?.click();
    await new Promise((r) => setTimeout(r, 300));
  });
  await opt.waitForTimeout(300);

  // 预览先摊出来（不用发请求就能看到会发什么）
  const imgTestPreview = await opt.evaluate(() => document.querySelector('#o-preview').textContent);
  check('直传模式下预览摊的是图片请求模板（地址 / 图片占位符都在）',
    imgTestPreview.includes(`http://127.0.0.1:${port}/imgtest`) &&
      imgTestPreview.includes('image_url') &&
      imgTestPreview.includes('data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='),
    imgTestPreview.slice(0, 140));

  // 真发一次
  const imgTestHitsBefore = imgTestHits;
  await opt.setInputFiles('#ocr-test-img', { name: 'probe.png', mimeType: 'image/png', buffer: probeBuf });
  await opt.evaluate(() => {
    document.querySelector('#btn-ocr-test').click();
  });
  await opt
    .waitForFunction(
      (needle) => {
        const box = document.querySelector('#ocr-test-result');
        return box && !box.hidden && box.textContent.includes(needle);
      },
      IMG_TEST_TEXT,
      { timeout: 15000 }
    )
    .catch(() => {});
  const imgTestOut = await opt.evaluate(() => document.querySelector('#ocr-test-result').textContent);
  check('「测试图片配置」真的发出去了、结果摆出来了',
    imgTestOut.includes(IMG_TEST_TEXT), imgTestOut.slice(0, 200));
  check('结果那块写的是「译文」（不是「识别到的文字」）',
    imgTestOut.includes('译文') && !imgTestOut.includes('识别到的文字'), imgTestOut.slice(0, 80));
  check('假接口确实被打了一次', imgTestHits === imgTestHitsBefore + 1,
    `${imgTestHitsBefore} → ${imgTestHits}`);
  check('发出去的请求里图片是真图片的 data URL',
    /"url":"data:image\/png;base64,[A-Za-z0-9+/]{100,}/.test(lastImgTestRequest),
    lastImgTestRequest.slice(0, 140));
  check('{{target}} 也按当前目标语言填了（不是留着一个占位符）',
    lastImgTestRequest.includes('翻成简体中文'), lastImgTestRequest.slice(0, 160));
  // 假接口回的是 SSE（分三帧，中间那帧还切两半）—— 结果要正好攒成一整句
  check('SSE 的响应也读得出来（不再误报「返回的不是 JSON」）',
    !imgTestOut.includes('不是 JSON'), imgTestOut.slice(0, 200));

  await opt.evaluate(async () => {
    const el = document.querySelector('#o-disabled');
    el.checked = false;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
  });

  // 取消勾选之后供应商那套字段要回来（别一勾一拨就回不去），而那块「测试」
  // 在两种模式下都不该被压暗
  const testBtnOn = await opt.evaluate(() => ({
    checked: document.querySelector('#o-disabled').checked,
    imgCfg: document.querySelector('#ocr-editor').classList.contains('is-imgcfg'),
    reqVisible: (document.querySelector('#ocr-blocks .req-block .rb-request') || {}).closest('.req-block').offsetParent !== null,
    label: document.querySelector('#o-test-label').textContent,
    opacity: getComputedStyle(document.querySelector('#o-test-field')).opacity
  }));
  check('取消勾选后供应商那套字段回来（不再是图片配置模式）',
    testBtnOn.checked === false && testBtnOn.imgCfg === false && testBtnOn.reqVisible === true,
    JSON.stringify(testBtnOn));
  check('两种模式下那块「测试」都不被压暗', testBtnOn.opacity === '1', String(testBtnOn.opacity));
  check('标签也变回「测试」', testBtnOn.label === '测试', testBtnOn.label);

  /* 供应商那三条名字长短差得挺多（硅基流动 / 百度 OCR（高精度版）/ OpenAI 兼容（任意视觉模型）），
     正好拿来测「宽度是不是跟着文字走的」—— 有 bug 时这三条会是三个不同的宽度。 */
  const ocrColW = await colW('#ocr-list');
  check('供应商几条名字长短不一，但列出来一样宽',
    ocrColW.ws.length >= 3 && new Set(ocrColW.ws).size === 1,
    `${ocrColW.ws.join(' / ')}｜名字长度 ${ocrColW.lens.join('/')}`);
  check('供应商那几条也占满列表可用宽度',
    fillsList(ocrColW),
    `条 ${ocrColW.ws[0]} + 行内 ${ocrColW.chrome[0]} ｜ 可用 ${ocrColW.inner}`);

  /* ---- OCR 供应商那栏也是同一套行（原来是自己拼的裸按钮：没有手柄 / ↑↓ 那两列，
         切模式时列表会「跳一下」）。kniph 2026-10-14 要的统一；
         「连排序的用处也统一」—— 所以它现在也是**能拖 / 能上下移**的。 ---- */
  const ocrRowShape = await opt.evaluate(() =>
    [...document.querySelectorAll('#ocr-list .cfg-row')].map((r) => ({
      rowH: Math.round(r.getBoundingClientRect().height),
      chrome: Math.round(r.getBoundingClientRect().width - r.querySelector('.cfg-item').getBoundingClientRect().width),
      grips: r.querySelectorAll('.cfg-grip').length,
      slots: r.querySelectorAll('.cfg-slot').length,
      mv: r.querySelectorAll('.cfg-mv-btn').length,
      firstUp: r.querySelector('.cfg-mv-btn[data-mv="-1"]').disabled,
      lastDown: r.querySelector('.cfg-mv-btn[data-mv="1"]').disabled
    }))
  );
  check('OCR 供应商的行也包在 .cfg-row 里（不再是直接躺列表里的裸按钮）',
    ocrRowShape.length >= 3, String(ocrRowShape.length));
  check('供应商那栏也摆着手柄 + ↑↓ 两枚（不再只是两个同宽空位）',
    ocrRowShape.every((r) => r.grips === 1 && r.mv === 2) && ocrRowShape[0].slots === 0,
    JSON.stringify(ocrRowShape[0]));
  check('供应商那栏也只禁头尾各一边（中间两头的按钮都能点）',
    ocrRowShape[0].firstUp === true && ocrRowShape[0].lastDown === false &&
      ocrRowShape[ocrRowShape.length - 1].lastDown === true,
    JSON.stringify({ first: ocrRowShape[0], last: ocrRowShape[ocrRowShape.length - 1] }));
  check('三处左栏的行内留白一模一样（行宽 − 条目宽）',
    new Set([...cfgRowChrome, ...imgCfgRowChrome, ...ocrRowShape].map((r) => r.chrome)).size === 1,
    `配置 ${cfgRowChrome[0] && cfgRowChrome[0].chrome}｜图片配置 ${imgCfgRowChrome[0] && imgCfgRowChrome[0].chrome}｜供应商 ${ocrRowShape[0] && ocrRowShape[0].chrome}`);
  check('三处左栏的**行高**也一样（差 3px 就是还有一条按 id 写的特例 CSS）',
    new Set([...cfgRowChrome, ...imgCfgRowChrome, ...ocrRowShape].map((r) => r.rowH)).size === 1,
    `配置 ${cfgRowChrome[0] && cfgRowChrome[0].rowH}｜图片配置 ${imgCfgRowChrome[0] && imgCfgRowChrome[0].rowH}｜供应商 ${ocrRowShape[0] && ocrRowShape[0].rowH}`);
  check('↑↓ 三处都摆着、都点得到（一致性的那条硬判据）',
    cfgRowChrome.every((r) => r.mv === 2) && imgCfgRowChrome.every((r) => r.mv === 2) &&
      ocrRowShape.every((r) => r.mv === 2));

  /* ---- 供应商那栏**真的**能排序（kniph 原话：「中转OCR左边栏的操作逻辑还是没法像
         配置栏一样可拖动、可上下移」）。只验「有按钮」不算 —— 得真点、真拖。 ---- */
  const ocrOrder = () =>
    opt.evaluate(async () => {
      const { state } = await chrome.storage.local.get('state');
      return {
        dom: [...document.querySelectorAll('#ocr-list .cfg-row')].map((r) => r.dataset.id),
        saved: state.ocr.providers.map((p) => p.id),
        active: state.ocr.activeId,
        activeDom: (document.querySelector('#ocr-list .cfg-row:has(> .cfg-item.is-active)') || { dataset: {} }).dataset.id || ''
      };
    });

  const ocrBefore = await ocrOrder();
  check('（脚手架）供应商那栏有三条可排', ocrBefore.dom.length >= 3, ocrBefore.dom.join(','));
  check('（脚手架）屏幕上和存档里的顺序一致',
    JSON.stringify(ocrBefore.dom) === JSON.stringify(ocrBefore.saved),
    `屏幕 ${ocrBefore.dom}｜存档 ${ocrBefore.saved}`);

  // 点第一行的 ↓ —— 前两条换位
  await opt.evaluate(() => {
    document.querySelector('#ocr-list .cfg-row .cfg-mv-btn[data-mv="1"]')?.click();
  });
  await opt.waitForTimeout(1300);
  const ocrAfterDown = await ocrOrder();
  check('点 ↓ 之后供应商的前两条换了位',
    ocrAfterDown.dom[0] === ocrBefore.dom[1] && ocrAfterDown.dom[1] === ocrBefore.dom[0],
    `${ocrBefore.dom.slice(0, 3).join(',')} → ${ocrAfterDown.dom.slice(0, 3).join(',')}`);
  check('供应商的新顺序也落盘了', JSON.stringify(ocrAfterDown.saved) === JSON.stringify(ocrAfterDown.dom));
  check('排供应商不会顺手改掉「当前选中」的那条',
    ocrAfterDown.active === ocrBefore.active && ocrAfterDown.activeDom === ocrBefore.activeDom,
    `${ocrBefore.active} → ${ocrAfterDown.active}`);

  // 真鼠标拖：把最后一条拖到第一行上半区（dragTo 是第 7 节那套手势，这里复用）
  const ocrBoxes = () =>
    opt.evaluate(() =>
      [...document.querySelectorAll('#ocr-list .cfg-row')].map((r) => {
        const b = r.getBoundingClientRect();
        const g = r.querySelector('.cfg-grip').getBoundingClientRect();
        return { id: r.dataset.id, top: b.top, bottom: b.bottom, gripX: g.left + g.width / 2, gripY: g.top + g.height / 2 };
      })
    );
  let ob = await ocrBoxes();
  let oSrc = ob[ob.length - 1];
  let oDst = ob[0];
  await dragTo(oSrc, oDst.top + 2);
  const ocrMark = await opt.evaluate(() => ({
    before: (document.querySelector('#ocr-list .cfg-row.drop-before') || { dataset: {} }).dataset.id || '',
    dragging: (document.querySelector('#ocr-list .cfg-row.dragging') || { dataset: {} }).dataset.id || ''
  }));
  check('拖供应商时也画「会插到这儿」的指示线', ocrMark.before === oDst.id, ocrMark.before || '(没有)');
  check('被拖的那条也有反馈', ocrMark.dragging === oSrc.id, ocrMark.dragging || '(没有)');
  await opt.mouse.up();
  await opt.waitForTimeout(1300);
  const ocrAfterDrag = await ocrOrder();
  check('拖到最前面之后供应商的顺序真的变了', ocrAfterDrag.dom[0] === oSrc.id, ocrAfterDrag.dom.join(','));
  check('拖动后的顺序也落盘了', JSON.stringify(ocrAfterDrag.saved) === JSON.stringify(ocrAfterDrag.dom));
  check('还是那几条，没多没少',
    ocrAfterDrag.dom.length === ocrBefore.dom.length, `${ocrBefore.dom.length} → ${ocrAfterDrag.dom.length}`);
  const ocrLeftover = await opt.evaluate(
    () => document.querySelectorAll('#ocr-list .drop-before, #ocr-list .drop-after, #ocr-list .dragging').length
  );
  check('松手后指示线 / 拖动态清干净了', ocrLeftover === 0, `${ocrLeftover} 个残留`);

  // 反向拖回去（off-by-one 藏在这个方向），顺便把顺序还原给后面几节
  ob = await ocrBoxes();
  oSrc = ob[0];
  oDst = ob[ob.length - 1];
  await dragTo(oSrc, oDst.bottom - 2);
  await opt.mouse.up();
  await opt.waitForTimeout(1300);
  const ocrBack = await ocrOrder();
  check('往下拖到末尾也对（正好排在最后，没多挪一位）',
    ocrBack.dom[ocrBack.dom.length - 1] === oSrc.id, ocrBack.dom.join(','));

  /* OCR 栏的页脚也补了「已保存」——两栏共用一个存档，提示得同步 */
  check('OCR 栏页脚也有「已保存」（和配置栏同一处 setSaveStatus 一起写）',
    await opt.evaluate(() => document.querySelectorAll('.save-status').length === 2));

  /* ---- 两栏的「主请求」落在同一相对位置（kniph 2026-10-14 的「强迫症」）----
     原来配置栏是「名称 → 一句说明 → 请求块」、OCR 栏是「一句说明 → 名称 → 备注 → 请求块」，
     块差 76px（140 vs 216），切页签时上下跳。现在两栏都是「说明 → 名称 → 说明 → 块」。
     ⚠️ 只能**量几何**：差 19px 就说明某一行掉了 `.wide`（`.hint` 11.5px vs `.wide` 12.5px+18 边距）。 */
  /* ⚠️ 必须先切到那一栏再量：没激活的 `.tabpanel` 是 `display: none`，
     里面所有东西的 `getBoundingClientRect()` 全是 0（量出来「配置 0px」就是这么来的）。 */
  const paneTop = async (tab, sel, blocksSel) => {
    await opt.evaluate((t) => {
      document.querySelector(`.tab[data-tab="${t}"]`)?.click();
    }, tab);
    await opt.waitForTimeout(250);
    return opt.evaluate(
      ([s, b]) => {
        const ed = document.querySelector(s);
        const base = ed.getBoundingClientRect().top;
        return Math.round(document.querySelector(b).getBoundingClientRect().top - base);
      },
      [sel, blocksSel]
    );
  };
  const cfgBlocksTop = await paneTop('configs', '#editor', '#req-blocks');
  const ocrBlocksTop = await paneTop('ocr', '#ocr-editor', '#ocr-blocks');
  check('两栏的请求块在同一个高度（切页签不再上下跳）',
    Math.abs(cfgBlocksTop - ocrBlocksTop) <= 2, `配置 ${cfgBlocksTop}px ｜ OCR ${ocrBlocksTop}px`);

  /* 「两栏同一套」的硬证据：名称那一块（label + input）抹掉 id / 文案之后必须**逐字一样** ——
     它们本来就是同一个 `editorHeadHtml()` 画出来的，手抄第二份的话这里必然分叉。
     只比 `.editor-head` 那一块：上面的提示槽条数本来就该不同（OCR 那栏多一句「图片直传」
     的互斥提示），那是内容差异、不是模板分叉。 */
  const headSame = await opt.evaluate(() => {
    const norm = (sel) =>
      document
        .querySelector(sel)
        .querySelector('.editor-head').innerHTML
        .replace(/id="[^"]*"/g, 'id="_"')
        .replace(/for="[^"]*"/g, 'for="_"')
        .replace(/placeholder="[^"]*"/g, 'placeholder="_"')
        .replace(/\s+/g, ' ')
        .trim();
    return { cfg: norm('#cfg-head'), ocr: norm('#ocr-head') };
  });
  check('两栏的头部是同一个模板出来的（名称那块抹掉 id 和文案后逐字相同）',
    headSame.cfg === headSame.ocr,
    headSame.cfg === headSame.ocr ? '一致' : `配置 ${headSame.cfg}\n   ≠ OCR ${headSame.ocr}`);

  /* 备注时有时无（自建那条是空的）—— 切一条配置就该跳一下，除非给它留了行高 */
  const ocrTopFor = async (id) => {
    await opt.evaluate((i) => {
      const row = [...document.querySelectorAll('#ocr-list .cfg-row')].find((r) => r.dataset.id === i);
      row?.querySelector('.cfg-item')?.click();
    }, id);
    await opt.waitForTimeout(320);
    return opt.evaluate(() => {
      const ed = document.querySelector('#ocr-editor');
      const base = ed.getBoundingClientRect().top;
      return {
        top: Math.round(document.querySelector('#ocr-blocks').getBoundingClientRect().top - base),
        noteH: Math.round(document.querySelector('#o-note').getBoundingClientRect().height)
      };
    });
  };
  const tops = [];
  for (const id of ['builtin-siliconflow', 'builtin-baidu-ocr', 'builtin-openai-vl']) {
    tops.push(await ocrTopFor(id));
  }
  check('切到哪一条（含备注空的那条）请求块都不动',
    new Set(tops.map((t) => t.top)).size === 1 && new Set(tops.map((t) => t.noteH)).size === 1,
    JSON.stringify(tops));

  /* ---- 真剪切板 + 假 OCR 接口 ---- */
  /* 这一段必须开**有头**窗口。实测（tools 里探过）：无头 Chromium 的剪切板是
     桩实现，文字和图片都读回来是空的 —— 这是 Chromium 的行为，不是扩展的问题。
     所以这里单开一个有头上下文，其余各节继续跑无头，互不打扰。 */

  const shotPng = path.join(os.tmpdir(), 'rt-e2e-ocr-shot.png');
  await page.screenshot({ path: shotPng });
  const clipOk = setClipboard('image', shotPng);

  if (!clipOk) {
    console.log('     跳过：这台机器上塞不进系统剪切板（只有 Windows + PowerShell 能干这事）');
  } else {
    const clipProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-e2e-clip-'));
    let cctx = null;
    try {
      cctx = await chromium.launchPersistentContext(clipProfile, {
        executablePath: edge,
        headless: false,
        viewport: null,
        args: [
          `--disable-extensions-except=${ROOT}`,
          `--load-extension=${ROOT}`,
          '--window-size=1200,900',
          '--no-first-run',
          '--no-default-browser-check'
        ]
      });

      const csw = cctx.serviceWorkers()[0] ||
        (await cctx.waitForEvent('serviceworker', { timeout: 15000 }));
      check('有头窗口里扩展也起来了', !!csw);
      const cpage = cctx.pages()[0] || (await cctx.newPage());

      // 翻译配置和 OCR 供应商都指到本地假接口（新档案，得重新填一遍）。
      // 注意两件事：
      //  1. service worker 里不能用 import()（HTML 规范禁止），所以别想着借扩展的
      //     loadState() —— 只能自己读 storage。
      //  2. 新档案刚起来时 background 的 loadState() 还没写盘，直接读会拿到 undefined；
      //     而且它可能写两次（onInstalled + 顶层 ensureMenu），所以「等它出现 → 改 →
      //     回读确认没被打回」这三步都得做。
      await csw.evaluate(async (u) => {
        const read = async () => (await chrome.storage.local.get('state')).state || null;
        let state = await read();
        for (let i = 0; i < 100 && !state; i++) {
          await new Promise((r) => setTimeout(r, 100));
          state = await read();
        }
        if (!state) throw new Error('storage 里始终没有 state（background 没写出初始状态？）');

        for (let i = 0; i < 30; i++) {
          const cfg = {
            id: 'e2e-local',
            name: '本地假接口',
            note: '',
            adapter: '',
            // 和真实模板同形：**外层 shell 单引号 + 内层 JSON 字符串**。
            // {{text}} 两侧不是引号（前后是 \n），只有「逐层转义」才能把
            // 撇号安全地送进去 —— 这里就是那条回归的现场。
            request:
              "curl -X POST -H 'Content-Type: application/json' " +
              "-d '{\"model\":\"e2e-local-model\",\"role\":\"user\",\"content\":\"翻成{{target}}：\\n\\\"\\\"\\\"\\n{{text}}\\n\\\"\\\"\\\"\"}' " +
              u.text,
            path: '',
            responseMode: 'text'
          };
          const j = state.configs.findIndex((c) => c.id === 'e2e-local');
          if (j >= 0) state.configs[j] = cfg;
          else state.configs.push(cfg);
          state.activeConfigId = 'e2e-local';
          state.settings = { ...state.settings, showOriginal: true };
          // v7 起 OCR 供应商是模板形状 —— 老字段（endpoint/model/…）不再驱动请求，
          // 直接把选中那条的 request 换成指向本地假接口的模板
          const p = state.ocr.providers.find((x) => x.id === state.ocr.activeId);
          p.request = u.ocrTpl;
          await chrome.storage.local.set({ state });

          const back = await read();
          if (back && back.activeConfigId === 'e2e-local' &&
              back.configs.some((c) => c.id === 'e2e-local') &&
              String((state.ocr.providers.find((x) => x.id === state.ocr.activeId) || {}).request || '')
                .includes('/ocr')) return;
          state = back || state;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('改好的 state 一直被打回（有别的上下文在并发写 storage）');
      }, { text: `http://127.0.0.1:${port}/text`, ocrTpl: ocrTpl(`http://127.0.0.1:${port}/ocr`) });

      await cpage.goto(`http://127.0.0.1:${port}/`);
      await cpage.bringToFront();
      await cpage
        .waitForFunction(() => !!document.getElementById('request-translate-host'), null, { timeout: 10000 })
        .catch(() => {});
      await cpage.waitForTimeout(400);

      /** 触发右键菜单里那条消息（菜单是原生的，点不到，但它发的就是这条） */
      await csw.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find((x) => x.url && x.url.includes('127.0.0.1'));
        if (t) await chrome.tabs.sendMessage(t.id, { type: 'rt-ocr-clipboard' });
      });

      await cpage
        .waitForFunction(
          (needle) => {
            const root = document.getElementById('request-translate-host')?.shadowRoot;
            const out = root?.querySelector('.rt-out');
            return !!out && out.textContent.includes(needle);
          },
          '本地假译文',
          { timeout: 30000 }
        )
        .catch(() => {});

      const ocrOut = await cpage.evaluate(() => {
        const root = document.getElementById('request-translate-host').shadowRoot;
        return {
          out: root.querySelector('.rt-out').textContent,
          src: root.querySelector('.rt-src').textContent,
          msg: root.querySelector('.rt-msg').textContent,
          dot: root.querySelector('.rt-dot').className,
          dotTitle: root.querySelector('.rt-dot').title,
          diag: root.querySelector('.rt-diag').textContent
        };
      });
      check('真剪切板里的截图被认出来了（文字进了原文区）',
        ocrOut.src.includes("Pixeldrain's"), ocrOut.src.slice(0, 60));
      check('接着按正常配置翻译出了结果', ocrOut.out.includes('本地假译文'), `${ocrOut.msg}｜${ocrOut.out}`);
      check('状态栏标明了这是截图来的', ocrOut.msg.includes('截图 OCR'), ocrOut.msg);
      check('翻译成功后顶栏那盏灯是绿的（不是灭灯）',
        /(^|\s)ok(\s|$)/.test(ocrOut.dot), ocrOut.dot);
      check('绿灯悬停时给一句「翻译成功」',
        ocrOut.dotTitle === '翻译成功', String(ocrOut.dotTitle));
      check('诊断里记了这次 OCR（哪条供应商 / 多大图）',
        ocrOut.diag.includes('截图 OCR'), ocrOut.diag.slice(0, 90));
      check('「…」里也交代了这次调的是哪个模型',
        ocrOut.diag.includes('e2e-local-model'), ocrOut.diag.slice(0, 120));
      check('面板没抱怨请求体不是合法 JSON',
        !ocrOut.diag.includes('不是合法 JSON'), ocrOut.diag.slice(0, 120));

      /* 这一段是回归现场：模板是 `-d '{…JSON…}'`（外层 shell 单引号 + 内层 JSON），
         而 OCR 文本里有撇号。只做 JSON 转义的话，撇号会把外层单引号提前闭合，
         body 从那儿截断 —— 服务端收到的就是「JSON parse 到一半结束了」。 */
      let ocrTranslateBody = null;
      try {
        ocrTranslateBody = JSON.parse(lastTextRequest || '');
      } catch {
        /* 解析不了就让下面两条断言去报 */
      }
      check('翻译请求体本身是合法 JSON（撇号没把 shell 那层截断）',
        !!ocrTranslateBody, String(lastTextRequest).slice(0, 100));
      check('OCR 文字原样进了请求体（撇号 / 双引号 / 换行都还原回来了）',
        !!ocrTranslateBody && typeof ocrTranslateBody.content === 'string' &&
          ocrTranslateBody.content.includes(OCR_TEXT),
        JSON.stringify((ocrTranslateBody || {}).content || '').slice(0, 160));

      const ocrReq = JSON.parse(lastOcrRequest || '{}');
      const parts = (((ocrReq.messages || [])[0] || {}).content) || [];
      check('请求带上了设置里填的模型名', ocrReq.model === 'e2e-ocr-model', String(ocrReq.model));
      check(
        '图片是以 data URL 发过去的（不是空串）',
        /^data:image\/[a-z]+;base64,[A-Za-z0-9+/]{100,}/.test(String((parts[0] || {}).image_url?.url || '')),
        String((parts[0] || {}).image_url?.url || '').slice(0, 48)
      );
      check('提示词跟在图片后面（官方那串：<image> + 换行 + Free OCR.）',
        (parts[1] || {}).text === '<image>\nFree OCR.', JSON.stringify(parts[1]));

      /* ---- 剪切板里是纯文字时，要明说没有图片 ---- */
      /* 计数按「进入这一小节之前」为准，别写死绝对值 ——
         前面设置页那个「测试」也会打同一个假接口。 */
      const ocrHitsBeforeNoImg = ocrHits;
      await cpage.keyboard.press('Escape');
      setClipboard('text', 'plain text, definitely not an image');
      await cpage.waitForTimeout(200);
      await csw.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find((x) => x.url && x.url.includes('127.0.0.1'));
        if (t) await chrome.tabs.sendMessage(t.id, { type: 'rt-ocr-clipboard' });
      });

      await cpage
        .waitForFunction(
          () => {
            const root = document.getElementById('request-translate-host')?.shadowRoot;
            const t = root?.querySelector('.rt-msg')?.textContent || '';
            return t && t !== '正在读取剪切板…';
          },
          null,
          { timeout: 15000 }
        )
        .catch(() => {});

      const noImg = await cpage.evaluate(() => {
        const root = document.getElementById('request-translate-host').shadowRoot;
        return {
          msg: root.querySelector('.rt-msg').textContent,
          cls: root.querySelector('.rt-msg').className,
          dot: root.querySelector('.rt-dot').className,
          out: root.querySelector('.rt-out').textContent
        };
      });
      check('剪切板里是文字时，明说「剪切板里没有图片」', noImg.msg.includes('剪切板里没有图片'), noImg.msg);
      check('这句是红字的（err），不是普通提示', /err/.test(noImg.cls), noImg.cls);
      check('顶栏那盏灯也跟着变红', /(^|\s)err(\s|$)/.test(noImg.dot), noImg.dot);
      check('没有图片时不会瞎翻一段东西出来', !noImg.out.includes('本地假译文'), noImg.out);
      check('没图片时压根不会往 OCR 接口发请求', ocrHits === ocrHitsBeforeNoImg,
        `这一小节里假接口被打 ${ocrHits - ocrHitsBeforeNoImg} 次`);

      /* ---- 两段模板：文字一段、图片一段，各走各的 ---- */
      /* 一条配置带两段请求模板（config.request / config.imageRequest）。
         这里给两段各塞一个不同的标记（"mode":"text" / "mode":"image"），
         然后分别触发「普通划词」和「截图直传」，看假接口收到的到底是哪一段。
         state.ocr.disabled 就是设置页里那个「禁用外置 OCR」。 */
      const waitForTextReq = async (needle, ms = 10000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          if (lastTextRequest.includes(needle)) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return false;
      };

      await csw.evaluate(async (u) => {
        const read = async () => (await chrome.storage.local.get('state')).state || null;
        let state = await read();
        for (let i = 0; i < 30; i++) {
          const cfg = state.configs.find((c) => c.id === 'e2e-local');
          if (!cfg) throw new Error('找不到 e2e-local 配置（上一步没写进去？）');
          cfg.request =
            "curl -X POST -H 'Content-Type: application/json' " +
            "-d '{\"mode\":\"text\",\"text\":\"{{text}}\"}' " + u.text;
          cfg.imageRequest = '';
          /* 真正能翻图的那条**挂在后备上**：主请求的图片模板留空、文字模板有。
             直传时必须**跳过主请求**、只试后备 —— `requestTemplateFor` 对空图片模板会
             回退到文字那段，不跳过就会白发一次根本不含 {{image}} 的请求（必失败还报错）。 */
          cfg.fallbacks = [
            {
              id: 'e2e-img',
              enabled: true,
              adapter: '',
              request:
                "curl -X POST -H 'Content-Type: application/json' " +
                '-d \'{"mode":"text","text":"{{text}}"}\' ' + u.text,
              imageRequest:
                "curl -X POST -H 'Content-Type: application/json' " +
                "-d '{\"mode\":\"image\",\"content\":[" +
                "{\"type\":\"image_url\",\"image_url\":{\"url\":\"{{image}}\"}}," +
                '{"type":"text","text":"看图"}]}\' ' + u.text,
              path: '',
              responseMode: 'auto'
            }
          ];
          state.activeConfigId = 'e2e-local';
          state.ocr.disabled = true; // ← 设置页里那个「禁用外置 OCR」
          await chrome.storage.local.set({ state });

          const back = await read();
          const b = back && back.configs.find((c) => c.id === 'e2e-local');
          // 图片模板挂在后备上（主请求那张留空），校验要跟着看后备
          if (
            b &&
            (b.fallbacks || []).some((f) => String(f.imageRequest || '').includes('"mode":"image"')) &&
            !String(b.imageRequest || '').trim() &&
            back.ocr.disabled === true
          ) return;
          state = back || state;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('两段模板的 state 没写进去');
      }, { text: `http://127.0.0.1:${port}/text` });
      await cpage.waitForTimeout(500); // 让 content.js 的 storage.onChanged 把新配置吃进去

      /* ---- ① 有图：应该用「图片请求模板」 ---- */
      setClipboard('image', shotPng);
      await cpage.waitForTimeout(300);
      const textHitsBefore = textHits;
      const ocrHitsBefore = ocrHits;
      lastTextRequest = '';

      await csw.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find((x) => x.url && x.url.includes('127.0.0.1'));
        if (t) await chrome.tabs.sendMessage(t.id, { type: 'rt-ocr-clipboard' });
      });

      const sawImageReq = await waitForTextReq('"mode":"image"');
      await cpage
        .waitForFunction(
          (needle) => {
            const root = document.getElementById('request-translate-host')?.shadowRoot;
            const out = root?.querySelector('.rt-out');
            return !!out && out.textContent.includes(needle);
          },
          '本地假译文',
          { timeout: 30000 }
        )
        .catch(() => {});

      const directOut = await cpage.evaluate(() => {
        const root = document.getElementById('request-translate-host').shadowRoot;
        return {
          out: root.querySelector('.rt-out').textContent,
          src: root.querySelector('.rt-src').textContent,
          msg: root.querySelector('.rt-msg').textContent
        };
      });
      check('直传模式下也照样翻出了结果', directOut.out.includes('本地假译文'), `${directOut.msg}｜${directOut.out}`);
      check('原文区写明「没有先做外置 OCR」（不然用户以为坏了）',
        directOut.src.includes('没有先做外置 OCR'), directOut.src.slice(0, 60));
      check('状态栏标的是「截图直传」，不是「截图 OCR」', directOut.msg.includes('截图直传'), directOut.msg);

      check('有图那一次走的是「图片请求模板」（不是文字那段）', sawImageReq, lastTextRequest.slice(0, 90));

      let imgBody = {};
      try {
        imgBody = JSON.parse(lastTextRequest || '{}');
      } catch {
        /* 解析不了就让下面那条断言去报 */
      }
      check(
        '图片段里的 {{image}} 是真图片的 data URL',
        /^data:image\/[a-z]+;base64,[A-Za-z0-9+/]{100,}/.test(
          String(((imgBody.content || [])[0] || {}).image_url?.url || '')
        ),
        String(((imgBody.content || [])[0] || {}).image_url?.url || '').slice(0, 48)
      );
      check('直传模式下确实发了一次翻译请求', textHits === textHitsBefore + 1,
        `${textHitsBefore} → ${textHits}`);
      check('直传模式下不会去打 OCR 接口（就是不做外置识别）', ocrHits === ocrHitsBefore,
        `OCR 接口被打 ${ocrHits - ocrHitsBefore} 次`);
      /* 脚手架把能翻图的那条挂在**后备**上、主请求的图片模板留空 —— 直传必须跳过主请求。
         只发一次（textHits +1）就是硬证据：跳过了就等于没白发那次请求。 */
      check('图片模板空的那条被跳过了（没白发一次不含 {{image}} 的请求）',
        textHits === textHitsBefore + 1 && sawImageReq,
        `发了 ${textHits - textHitsBefore} 次，最后一次是：${lastTextRequest.slice(0, 70)}`);

      /* ---- ①.5 原文区贴的就是那张截图本身（直传专属）---- */
      /* kniph 要的：直传时原文区别只留一句话，把截的那张图贴出来。
         顺带把两条硬约束量了：图真的渲染出来了（不是 0×0 空壳）、
         被 CSS 压在高度上限里（长截图不该把面板撑破）。 */
      const srcShot = await cpage.evaluate(() => {
        const root = document.getElementById('request-translate-host').shadowRoot;
        const box = root.querySelector('.rt-src');
        const img = box.querySelector('img.rt-srcimg');
        const r = img ? img.getBoundingClientRect() : null;
        return {
          has: !!img,
          src: img ? img.getAttribute('src') || '' : '',
          w: r ? Math.round(r.width) : 0,
          h: r ? Math.round(r.height) : 0,
          // 上限是 11em，em 取 .rt-src 自己的字号（跟着设置里的字号走，别写死 px）
          limit: Math.ceil(parseFloat(getComputedStyle(box).fontSize) * 11),
          text: box.textContent
        };
      });
      check('原文区贴了一张图', srcShot.has, JSON.stringify(srcShot).slice(0, 80));
      check('贴的就是刚才发出去那张（img.src === 请求体里的 {{image}}）',
        !!srcShot.src && srcShot.src === String(((imgBody.content || [])[0] || {}).image_url?.url || ''),
        `${srcShot.src.slice(0, 40)}…`);
      check('图真的渲染出来了（不是 0×0 空壳）', srcShot.w > 0 && srcShot.h > 0,
        `${srcShot.w}×${srcShot.h}`);
      check('图被压在高度上限内（长截图不该把面板撑破）', srcShot.h <= srcShot.limit,
        `${srcShot.h} ≤ ${srcShot.limit}`);
      check('图下面那句说明还在（原文区为什么是张图，得有交代）',
        srcShot.text.includes('没有先做外置 OCR'), srcShot.text.slice(0, 60));

      /* ---- ② 没图：应该回到「文字那段模板」 ---- */
      lastTextRequest = '';
      await csw.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find((x) => x.url && x.url.includes('127.0.0.1'));
        if (t) {
          await chrome.tabs.sendMessage(t.id, { type: 'rt-translate-selection', text: 'plain selection text' });
        }
      });

      const sawTextReq = await waitForTextReq('"mode":"text"');
      check('没有图那一次回到了「文字请求模板」', sawTextReq, lastTextRequest.slice(0, 90));

      let txtBody = {};
      try {
        txtBody = JSON.parse(lastTextRequest || '{}');
      } catch {
        /* 同上 */
      }
      check('文字那段里的 {{text}} 就是选中的文字', txtBody.text === 'plain selection text',
        JSON.stringify(txtBody.text));
      check('文字那一次没混进图片（content 结构都和图片段不一样）', txtBody.content === undefined,
        JSON.stringify(Object.keys(txtBody)));

      /* ---- ②.1 直传失败后点 ↻：重发的是**刚才那张图**，不碰剪切板 ---- */
      /* 报过的 bug：点 ↻ 会去剪切板找图 —— 用户在那之后复制了别的东西，
         重试就发了一张毫不相干的图。这里把剪切板**换成另一张**再点 ↻，
         旧实现会把第二张发出去，一比就露。
         怎么让第一次必然失败：图片模板临时改指 /directfail（怎么发都回 500）。 */
      const shotPng2 = path.join(os.tmpdir(), 'rt-e2e-ocr-shot2.png');
      await page.screenshot({ path: shotPng2, clip: { x: 0, y: 0, width: 320, height: 180 } });

      const waitUntil = async (fn, ms = 10000) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
          if (fn()) return true;
          await new Promise((r) => setTimeout(r, 100));
        }
        return false;
      };
      const imgTplTo = (u) =>
        "curl -X POST -H 'Content-Type: application/json' " +
        "-d '{\"mode\":\"image\",\"content\":[" +
        "{\"type\":\"image_url\",\"image_url\":{\"url\":\"{{image}}\"}}," +
        '{"type":"text","text":"看图"}]}\' ' + u;
      const setImgTpl = async (url) => {
        await csw.evaluate(async (tpl) => {
          const { state } = await chrome.storage.local.get('state');
          state.configs.find((c) => c.id === 'e2e-local').imageRequest = tpl;
          state.ocr.disabled = true; // 走「截图直传」
          await chrome.storage.local.set({ state });
        }, imgTplTo(url));
        await cpage.waitForTimeout(400);
      };
      const bodyImg = (body) => {
        try {
          return String(((JSON.parse(body || '{}').content || [])[0] || {}).image_url?.url || '');
        } catch {
          return '';
        }
      };
      const retryReady = () =>
        cpage
          .waitForFunction(
            () => {
              const root = document.getElementById('request-translate-host')?.shadowRoot;
              const btn = root?.querySelector('.rt-btn[data-act="retry"]');
              return !!btn && !btn.disabled;
            },
            null,
            { timeout: 15000 }
          )
          .then(() => true)
          .catch(() => false);
      const fireClipboardOcr = () =>
        csw.evaluate(async () => {
          const tabs = await chrome.tabs.query({});
          const t = tabs.find((x) => x.url && x.url.includes('127.0.0.1'));
          if (t) await chrome.tabs.sendMessage(t.id, { type: 'rt-ocr-clipboard' });
        });

      await setImgTpl(`http://127.0.0.1:${port}/directfail`);
      setClipboard('image', shotPng);
      await cpage.waitForTimeout(300);
      lastTextRequest = '';
      const hitsBeforeDirectFail = textHits;
      await fireClipboardOcr();
      const directFailed = await waitUntil(() => textHits >= hitsBeforeDirectFail + 1);
      const firstImg = bodyImg(lastTextRequest);
      check('（脚手架）第一次直传真的打到了会失败的那条接口',
        directFailed && !!firstImg, `textHits ${hitsBeforeDirectFail} → ${textHits}`);
      check('（脚手架）面板停在失败态，↻ 可以点', await retryReady(), `textHits ${textHits}`);

      // 换一张完全不同的图（320×180）：重试要是去读剪切板，发出去的就是它
      setClipboard('image', shotPng2);
      await cpage.waitForTimeout(400);
      const hitsBeforeRetry = textHits;
      await cpage.click('.rt-btn[data-act="retry"]', { force: true });
      const didRetry = await waitUntil(() => textHits >= hitsBeforeRetry + 1);
      check('点 ↻ 真的重发了一条（没卡在失败态里）', didRetry,
        `textHits ${hitsBeforeRetry} → ${textHits}`);
      const retryImg = bodyImg(lastTextRequest);
      check('重发的是**刚才那张图**，不是剪切板里换过的那张',
        !!retryImg && retryImg === firstImg,
        `${firstImg.slice(0, 40)}… / ${retryImg.slice(0, 40)}…`);
      const retrySize = pngSizeOf(retryImg);
      check('重发出去那张不是新换的 320×180（反证它压根没读剪切板）',
        !!retrySize && !(retrySize.w === 320 && retrySize.h === 180), JSON.stringify(retrySize));
      check('重试时也不去打 OCR 接口（直传就是不识别）', ocrHits === ocrHitsBefore,
        `OCR 接口被打 ${ocrHits - ocrHitsBefore} 次`);

      /* ---- ②.15 页面 CSP 挡掉 data: 图时的兜底 ---- */
      /* 这条测试页没有 CSP，真拦不住。能验的是**兜底那一支**：
         手动派一次 error，图该撤掉、那句话该回来。 */
      const srcFallback = await cpage.evaluate(() => {
        const root = document.getElementById('request-translate-host').shadowRoot;
        const box = root.querySelector('.rt-src');
        const img = box.querySelector('img.rt-srcimg');
        if (!img) return { ok: false, why: '没有图' };
        img.dispatchEvent(new Event('error'));
        return {
          ok: !box.querySelector('img.rt-srcimg'),
          text: box.textContent,
          cls: box.className
        };
      });
      check('CSP 兜底：图撤掉、那句话回来（被挡时不该只剩一片空白）',
        srcFallback.ok && srcFallback.text.includes('没有先做外置 OCR'),
        JSON.stringify(srcFallback).slice(0, 90));
      check('兜底时 has-img 也摘掉（那块高度上限不白撑着）',
        !/has-img/.test(srcFallback.cls || ''), srcFallback.cls);

      /* ---- ②.2 截图 OCR 失败后点 ↻：一样重发刚才那张（这次图在后台手里）---- */
      /* 剪切板 / 框选这两条路，图从来没进过页面，靠后台发 reuse 接着用上一次那张。
         验法：OCR 模板改指 /ocr-reject（400，必失败），重试前把剪切板换成第二张，
         断言后台收到的那条请求体**和第一次一字不差**（同图 + 同模板 = 同一个 body）。 */
      await csw.evaluate(async (tpl) => {
        const { state } = await chrome.storage.local.get('state');
        state.ocr.providers.find((x) => x.id === state.ocr.activeId).request = tpl;
        state.ocr.disabled = false; // 走真的外置 OCR
        await chrome.storage.local.set({ state });
      }, ocrTpl(`http://127.0.0.1:${port}/ocr-reject`));
      await cpage.waitForTimeout(400);

      setClipboard('image', shotPng);
      await cpage.waitForTimeout(300);
      lastOcrRequest = '';
      const ocrHitsBeforeFail = ocrHits;
      await fireClipboardOcr();
      const ocrFailed = await waitUntil(() => ocrHits >= ocrHitsBeforeFail + 1);
      const firstOcrBody = lastOcrRequest;
      check('（脚手架）第一次识别真的打到了会失败的那条接口',
        ocrFailed && firstOcrBody.includes('data:image'), `ocrHits ${ocrHitsBeforeFail} → ${ocrHits}`);
      check('（脚手架）面板停在失败态，↻ 可以点', await retryReady(), `ocrHits ${ocrHits}`);

      setClipboard('image', shotPng2);
      await cpage.waitForTimeout(400);
      const ocrHitsBeforeRetry = ocrHits;
      await cpage.click('.rt-btn[data-act="retry"]', { force: true });
      const ocrRetried = await waitUntil(() => ocrHits >= ocrHitsBeforeRetry + 1);
      check('OCR 那条路的 ↻ 也重发了一条', ocrRetried,
        `ocrHits ${ocrHitsBeforeRetry} → ${ocrHits}`);
      check('重发的还是刚才那张图：请求体和第一次一字不差（后台没去读换掉的剪切板）',
        lastOcrRequest === firstOcrBody && lastOcrRequest.length > 0,
        `${lastOcrRequest.length} vs ${firstOcrBody.length} 字节`);

      /* 收拾：模板与开关都还原，别留给后面几节 */
      await setImgTpl(`http://127.0.0.1:${port}/text`);
      await csw.evaluate(async (tpl) => {
        const { state } = await chrome.storage.local.get('state');
        state.ocr.providers.find((x) => x.id === state.ocr.activeId).request = tpl;
        await chrome.storage.local.set({ state });
      }, ocrTpl(`http://127.0.0.1:${port}/ocr`));
      await cpage.waitForTimeout(300);
      fs.rmSync(shotPng2, { force: true });

      /* ---- ②.5 图片改道：图片可以另指一条配置，文字不动 ---- */
      /* 上面那两次用的是同一条配置（e2e-local）的两段模板。
         真实场景是：文字翻译走便宜的文字模型，图片翻译另指一个能看图的模型。
         这里再塞两条能看图的（e2e-img / e2e-img2），把 state.ocr.imageConfigId 指到第一条，
         看图片那次是不是改道了、文字那次是否仍然待在 activeConfigId 上。
         两条是为了能测「在面板里拨那个下拉」。 */
      const imgCfgTpl = (u, mode) =>
        "curl -X POST -H 'Content-Type: application/json' " +
        `-d '{"mode":"${mode}","content":[` +
        '{"type":"image_url","image_url":{"url":"{{image}}"}},' +
        '{"type":"text","text":"看图"}]}\' ' + u;

      const imgCfgs = [
        { id: 'e2e-img', name: '看图那条', imageRequest: imgCfgTpl(`http://127.0.0.1:${port}/text`, 'imgcfg') },
        { id: 'e2e-img2', name: '看图二号', imageRequest: imgCfgTpl(`http://127.0.0.1:${port}/text`, 'imgcfg2') }
      ];

      await csw.evaluate(async ({ textUrl, cfgs }) => {
        const read = async () => (await chrome.storage.local.get('state')).state || null;
        let state = await read();
        for (let i = 0; i < 30; i++) {
          for (const c of cfgs) {
            if (!state.configs.some((x) => x.id === c.id)) {
              state.configs.push({
                id: c.id,
                name: c.name,
                // 文字那段给个**不一样**的标记：不然「文字那次用的是哪条」分不出来
                request: 'curl -X POST -d \'{"mode":"textcfg"}\' ' + textUrl,
                imageRequest: c.imageRequest
              });
            }
          }
          state.activeConfigId = 'e2e-local'; // 文字仍旧走这条
          state.ocr.imageConfigId = 'e2e-img'; // 图片改走新加的这条
          state.ocr.disabled = true;
          await chrome.storage.local.set({ state });
          const back = await read();
          const b = back && back.configs.find((c) => c.id === 'e2e-img');
          if (b && b.imageRequest.includes('imgcfg') && back.ocr.imageConfigId === 'e2e-img') return;
          state = back || state;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('图片配置（e2e-img / e2e-img2 + imageConfigId）没写进去');
      }, { textUrl: `http://127.0.0.1:${port}/text`, cfgs: imgCfgs });
      await cpage.waitForTimeout(500);

      lastTextRequest = '';
      await csw.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find((x) => x.url && x.url.includes('127.0.0.1'));
        if (t) await chrome.tabs.sendMessage(t.id, { type: 'rt-ocr-clipboard' });
      });
      const sawImgCfgReq = await waitForTextReq('"mode":"imgcfg"');
      await cpage
        .waitForFunction(
          (needle) => {
            const root = document.getElementById('request-translate-host')?.shadowRoot;
            const out = root?.querySelector('.rt-out');
            return !!out && out.textContent.includes(needle);
          },
          '本地假译文',
          { timeout: 30000 }
        )
        .catch(() => {});
      check('图片那次改道去了 imageConfigId 指的那条', sawImgCfgReq, lastTextRequest.slice(0, 90));

      /* ---- ②.6 面板顶栏那个下拉：图片这一屏要收束成「图片配置」那一份，而且拨得动 ---- */
      /* 之前这儿是坏的：下拉照列全部配置（里面一堆纯文字接口），拨一下也不生效 ——
         因为后台只认 state.ocr.imageConfigId，面板那条选中值压根没写回存档。
         现在两边是同一份数据 + 同一个选中项（和设置页 OCR 栏那份列表同源）。 */
      const readCfgSelect = () =>
        cpage.evaluate(() => {
          const root = document.getElementById('request-translate-host').shadowRoot;
          const sel = root.querySelector('.rt-cfg');
          return { opts: [...sel.options].map((o) => o.value), value: sel.value, title: sel.title };
        });

      const imgSel = await readCfgSelect();
      check(
        '图片那一屏：顶栏下拉只列能翻图的配置（带图片模板的那几条）',
        imgSel.opts.length === 3 && imgSel.opts.join(',') === 'e2e-local,e2e-img,e2e-img2',
        JSON.stringify(imgSel.opts)
      );
      check('图片那一屏：纯文字的内置配置一条都不在里面',
        !imgSel.opts.some((id) => id.startsWith('builtin-')), JSON.stringify(imgSel.opts));
      check('图片那一屏：下拉停在存档里的 imageConfigId 上（不是顶栏那条）',
        imgSel.value === 'e2e-img', `${imgSel.value}｜顶栏 activeConfigId 是 e2e-local`);
      check('图片那一屏：tooltip 说的是「图片接口」', /^图片接口：/.test(imgSel.title), imgSel.title);

      /* 拨到另一条：得真的换过去（请求走新那条 + 存档里的选中项也改了） */
      lastTextRequest = '';
      await cpage.evaluate(() => {
        const root = document.getElementById('request-translate-host').shadowRoot;
        const sel = root.querySelector('.rt-cfg');
        sel.value = 'e2e-img2';
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      const sawSwitched = await waitForTextReq('"mode":"imgcfg2"');
      check('图片那一屏：拨一下真的换成新那条了（请求带的是 imgcfg2）', sawSwitched,
        lastTextRequest.slice(0, 90));
      check('拨完没有再走原来那条', !lastTextRequest.includes('"mode":"imgcfg"'),
        lastTextRequest.slice(0, 90));

      let storedImgCfg = '';
      for (let i = 0; i < 30; i++) {
        storedImgCfg = await csw.evaluate(async () => {
          const { state } = await chrome.storage.local.get('state');
          return state.ocr.imageConfigId;
        });
        if (storedImgCfg === 'e2e-img2') break;
        await cpage.waitForTimeout(100);
      }
      check('拨完写回了存档 —— 和设置页 OCR 栏那个选中项是同一个（不是各选各的）',
        storedImgCfg === 'e2e-img2', storedImgCfg);

      await cpage
        .waitForFunction(
          (needle) => {
            const root = document.getElementById('request-translate-host')?.shadowRoot;
            const out = root?.querySelector('.rt-out');
            return !!out && out.textContent.includes(needle);
          },
          '本地假译文',
          { timeout: 30000 }
        )
        .catch(() => {});

      lastTextRequest = '';
      await csw.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find((x) => x.url && x.url.includes('127.0.0.1'));
        if (t) {
          await chrome.tabs.sendMessage(t.id, { type: 'rt-translate-selection', text: 'still text config' });
        }
      });
      const sawTextStill = await waitForTextReq('"mode":"text"');
      check('文字那次不受 imageConfigId 影响（还在 activeConfigId 那条）', sawTextStill,
        lastTextRequest.slice(0, 90));
      check('文字那次没有误用图片配置那条', !lastTextRequest.includes('imgcfg'),
        lastTextRequest.slice(0, 90));

      // 收拾干净：把临时那条配置删掉、选中项清空（别留给后面几节）
      await csw.evaluate(async () => {
        const { state } = await chrome.storage.local.get('state');
        state.configs = state.configs.filter((c) => c.id !== 'e2e-img');
        state.ocr.imageConfigId = '';
        await chrome.storage.local.set({ state });
      });
      await cpage.waitForTimeout(300);

      /* ---- ②.7 主请求挂了，自动按顺序试「勾上的后备请求」---- */
      /* 一条配置里能挂几条后备请求（每条都是完整的一段请求：自己的适配器 / 模板 /
         提取路径 / 响应模式），主请求挂了（网络断、模型下线、key 过期）就自动换下一条
         再试 —— 用户不用手动切配置。
         怎么让主请求必然失败：它的模板指到 /chainfail（怎么发都回 500，也抠不出译文）。
         两条后备一条勾着一条没勾 —— 「勾了的真发、没勾的一条都不发」一起验。
         顺序只看 textSeq（服务器按收到顺序记的），lastTextRequest 分不出先后。 */
      const chainTpl = (u, mode) =>
        "curl -X POST -H 'Content-Type: application/json' " +
        `-d '{"mode":"${mode}","text":"{{text}}"}' ` + u;

      const writeChain = async (flags) => {
        await csw.evaluate(
          async ({ main, on, off, enabled }) => {
            const { state } = await chrome.storage.local.get('state');
            const cfg = state.configs.find((c) => c.id === 'e2e-local');
            cfg.request = main;
            cfg.mainEnabled = true;
            /* **必须是 auto**：e2e-local 建的时候存的是 `text`，而 `text` 模式的意思是
               「整段响应体就是译文」—— 500 那个 JSON 错误体会被当成译文、直接算成功，
               主请求压根不算「挂了」，链子也就不会往下走（第一次写这节就栽在这儿：
               面板上显示的是 `{"error":{"message":"main request down"}}` 当译文）。 */
            cfg.responseMode = 'auto';
            cfg.fallbacks = [
              {
                id: 'fb-on', enabled: enabled[0], adapter: '',
                request: on, imageRequest: '', path: '', responseMode: 'auto'
              },
              {
                id: 'fb-off', enabled: enabled[1], adapter: '',
                request: off, imageRequest: '', path: '', responseMode: 'auto'
              }
            ];
            state.activeConfigId = 'e2e-local';
            await chrome.storage.local.set({ state });
          },
          {
            main: chainTpl(`http://127.0.0.1:${port}/chainfail`, 'main'),
            on: chainTpl(`http://127.0.0.1:${port}/text`, 'on'),
            off: chainTpl(`http://127.0.0.1:${port}/text`, 'off'),
            enabled: flags
          }
        );
        await cpage.waitForTimeout(400);
      };

      const fireText = async (text) => {
        lastTextRequest = '';
        textSeq = [];
        await csw.evaluate(async (t) => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((x) => x.url && x.url.includes('127.0.0.1'));
          if (tab) await chrome.tabs.sendMessage(tab.id, { type: 'rt-translate-selection', text: t });
        }, text);
      };

      const panelOut = () =>
        cpage.evaluate(() => {
          const root = document.getElementById('request-translate-host').shadowRoot;
          return {
            out: root.querySelector('.rt-out').textContent,
            msg: root.querySelector('.rt-msg').textContent,
            dot: root.querySelector('.rt-dot').className
          };
        });

      // 主请求必挂 + 后备甲勾着 / 后备乙没勾
      await writeChain([true, false]);
      const chainState = await csw.evaluate(async () => {
        const { state } = await chrome.storage.local.get('state');
        const cfg = state.configs.find((c) => c.id === 'e2e-local');
        return {
          mode: cfg.responseMode,
          fb: (cfg.fallbacks || []).map((f) => f.id + ':' + (f.enabled !== false)).join(','),
          main: cfg.mainEnabled !== false
        };
      });
      check('（脚手架）后备与响应格式都真写进了存档',
        chainState.mode === 'auto' && chainState.fb === 'fb-on:true,fb-off:false' && chainState.main,
        JSON.stringify(chainState));

      await fireText('chain rotation');
      const sawFallback = await waitForTextReq('"mode":"on"', 15000);
      const chainPaths = textSeq.map((r) => r.path);
      const iMain = textSeq.findIndex((r) => r.path.startsWith('/chainfail'));
      const iOn = textSeq.findIndex((r) => r.body.includes('"mode":"on"'));

      check('（脚手架）主请求真打到了那条会挂的接口', iMain >= 0, chainPaths.join(' → '));
      check('主请求挂了之后自动发了勾上的那条后备', sawFallback, chainPaths.join(' → '));
      check('先后也对：先主请求、挂了才切后备', iMain >= 0 && iOn > iMain, chainPaths.join(' → '));
      check('最终那条用的就是后备自己的模板（不是主请求那段）',
        lastTextRequest.includes('"mode":"on"'), lastTextRequest.slice(0, 90));
      check('没勾上的那条后备一次都没发（勾是唯一的开关）',
        !textSeq.some((r) => r.body.includes('"mode":"off"')), chainPaths.join(' → '));

      await cpage
        .waitForFunction(
          (needle) => {
            const root = document.getElementById('request-translate-host')?.shadowRoot;
            const out = root?.querySelector('.rt-out');
            return !!out && out.textContent.includes(needle);
          },
          '本地假译文',
          { timeout: 30000 }
        )
        .catch(() => {});
      const chainOut = await panelOut();
      check('主请求失败没把整次翻译判死（面板上是后备回来的译文）',
        chainOut.out.includes('本地假译文'), `${chainOut.msg}｜${chainOut.out.slice(0, 40)}`);
      check('顶栏那盏灯是绿的（切换成功，没当成失败）',
        !/(^|\s)err(\s|$)/.test(chainOut.dot), chainOut.dot);

      /* 一条都没勾时必须**退回主请求** —— 一条配置存在却什么都不发，
         是个没人看得懂的死状态（也等于「全不勾 = 只跑主请求」）。 */
      await writeChain([false, false]);
      await fireText('none checked');
      const mainOnly = await waitUntil(() => textSeq.length >= 1);
      await cpage.waitForTimeout(600); // 等它跑完收尾，别把半截状态留给下一节
      check('一条后备都没勾时照旧跑主请求（不会一条都不发）',
        mainOnly && textSeq.every((r) => r.path.startsWith('/chainfail')),
        textSeq.map((r) => r.path).join(' → '));
      check('没勾任何后备时自然不会去碰后备那两条',
        !textSeq.some((r) => /"mode":"(on|off)"/.test(r.body)),
        textSeq.map((r) => r.path).join(' → '));

      // 收拾：后备摘掉、主请求和响应格式都还原成进这节之前的样子
      await csw.evaluate(async (tpl) => {
        const { state } = await chrome.storage.local.get('state');
        const cfg = state.configs.find((c) => c.id === 'e2e-local');
        cfg.request = tpl;
        cfg.fallbacks = [];
        cfg.mainEnabled = true;
        cfg.responseMode = 'text'; // e2e-local 建出来就是 text（别改造成 auto 留给后面几节）
        await chrome.storage.local.set({ state });
      }, chainTpl(`http://127.0.0.1:${port}/text`, 'text'));
      await cpage.waitForTimeout(300);

      /* ---- ③ 顶栏那盏状态灯：紫 = 正在翻译 / 绿 = 成功 / 红 = 失败 ---- */
      /* 「飞行中」这个瞬间不拿东西顶住就采不到，所以借用 /slow（挂 1.2 秒）。
         它顺带覆盖了「OCR 返回的不是 JSON」这条失败路径 —— 正好凑齐红绿两边。
         绿灯那两条断言在上一节的 ocrOut 里（那次是真翻成功了）。
         注意要把上一小节留下的 ocr.disabled 复位 —— 留着 true 就走「截图直传」
         了，压根不会去打 OCR 接口，这里也就采不到失败态。 */
      await csw.evaluate(async (tpl) => {
        const { state } = await chrome.storage.local.get('state');
        const p = state.ocr.providers.find((x) => x.id === state.ocr.activeId);
        p.request = tpl;
        state.ocr.disabled = false;
        await chrome.storage.local.set({ state });
      }, ocrTpl(`http://127.0.0.1:${port}/slow`));

      const slowScaffold = await csw.evaluate(async () => {
        const { state } = await chrome.storage.local.get('state');
        const p = state.ocr.providers.find((x) => x.id === state.ocr.activeId);
        return { request: p.request, disabled: state.ocr.disabled };
      });
      check('（脚手架）OCR 接口指到了 /slow，而且没开着「禁用外置 OCR」',
        slowScaffold.request.includes('/slow') && slowScaffold.disabled === false,
        JSON.stringify(slowScaffold).slice(0, 80));

      const dotState = () =>
        cpage.evaluate(() => {
          const root = document.getElementById('request-translate-host').shadowRoot;
          const d = root.querySelector('.rt-dot');
          return { cls: d.className, title: d.title, msg: root.querySelector('.rt-msg').textContent };
        });

      await csw.evaluate(async () => {
        const tabs = await chrome.tabs.query({});
        const t = tabs.find((x) => x.url && x.url.includes('127.0.0.1'));
        if (t) await chrome.tabs.sendMessage(t.id, { type: 'rt-ocr-clipboard' });
      });

      // 等它真的进入「正在翻译」再采样 —— 固定睡多久都是在赌
      await cpage
        .waitForFunction(() => {
          const root = document.getElementById('request-translate-host')?.shadowRoot;
          return /(^|\s)on(\s|$)/.test(root?.querySelector('.rt-dot')?.className || '');
        }, null, { timeout: 8000 })
        .catch(() => {});
      const dotBusy = await dotState();
      check('请求还在飞的时候灯是紫的（正在翻译）',
        /(^|\s)on(\s|$)/.test(dotBusy.cls), `${dotBusy.cls}｜${dotBusy.msg}｜${lastPath}`);
      check('紫灯悬停给的是「正在翻译…」', dotBusy.title === '正在翻译…', dotBusy.title);

      await cpage
        .waitForFunction(() => {
          const root = document.getElementById('request-translate-host')?.shadowRoot;
          return /(^|\s)err(\s|$)/.test(root?.querySelector('.rt-dot')?.className || '');
        }, null, { timeout: 15000 })
        .catch(() => {});
      const dotFail = await dotState();
      check('失败之后灯变红（不是把灯灭掉）',
        /(^|\s)err(\s|$)/.test(dotFail.cls), `${dotFail.cls}｜${dotFail.msg}｜${lastPath}`);
      check('红灯悬停给的是「翻译失败」', dotFail.title === '翻译失败', dotFail.title);

      /* ---- 「框选截图翻译」：菜单点下去后 background 截好图发来，页面负责框选 ----
         captureVisibleTab 那一步在 e2e 里绕开（要真实手势），直接把 content
         会收到的那条消息塞进去：dataUrl 现画一张，拖框后送同一条 OCR 链。
         上一小节把 OCR 接口指到了 /slow（测紫灯超时用的），这里先指回 /ocr，
         别让这一节继承上一节的 endpoint。 */
      console.log('   框选截图：拖一块区域，裁出来的图走同一条 OCR 链');
      await csw.evaluate(async (tpl) => {
        const { state } = await chrome.storage.local.get('state');
        const p = state.ocr.providers.find((x) => x.id === state.ocr.activeId);
        p.request = tpl;
        await chrome.storage.local.set({ state });
      }, ocrTpl(`http://127.0.0.1:${port}/ocr`));
      const shotDataUrl = await cpage.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = 300;
        c.height = 150;
        c.getContext('2d').fillStyle = '#ffffff';
        c.getContext('2d').fillRect(0, 0, 300, 150);
        return c.toDataURL('image/png');
      });
      const shotHitBefore = ocrHits;
      /* 找测试页要么按**完整 URL**（带 `/` 结尾那条），要么按标题认。
         只写 `url.includes('127.0.0.1')` 会把**设置页**也挑进来（它的 URL 同样是
         127.0.0.1）—— 挑错了那一发消息就发给设置页了，测试页这边遮罩一直不出来，
         后面的断言全是「拿一个不存在的遮罩在量」（踩过：调试到一半才发现）。 */
      const shotMsg = (dataUrl) =>
        csw.evaluate(async (d) => {
          const tabs = await chrome.tabs.query({});
          const t = tabs.find((x) => x.title === 'rt-e2e') ||
            tabs.find((x) => x.url && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(x.url));
          if (t) await chrome.tabs.sendMessage(t.id, { type: 'rt-shot-translate', dataUrl: d });
          return t ? t.id : null;
        }, dataUrl);
      const shotOverlay = () => cpage.evaluate(() => !!document.querySelector('[data-rt-shot]'));
      /** 覆盖层的形态。
          A 方案（kniph 定）下覆盖层**不铺位图** —— 只有 `.veil`（铺满、接指针）、
          `.sel`（挖洞）和提示条 `.tip`。这里同时量「哪层在」和**命中测试**：
          真实鼠标点下去那一处必须落在覆盖层里，否则就是 kniph 报的
          「按住鼠标根本框选不了」（脚本直接派发事件能过，真人点不到 —— 踩过）。 */
      const shotPreview = (x = 200, y = 200) =>
        cpage.evaluate(({ px, py }) => {
          const h = document.querySelector('[data-rt-shot]');
          if (!h) return { overlay: false };
          const root = h.shadowRoot;
          // 真命中测试：这一点最上层是谁？遮罩必须接得住
          const hit = document.elementFromPoint(px, py);
          return {
            overlay: true,
            hasImg: !!root.querySelector('.img'),
            hasSel: !!root.querySelector('.sel'),
            hasVeil: !!root.querySelector('.veil'),
            hasTip: !!root.querySelector('.tip'),
            tip: root.querySelector('.tip')?.textContent || '',
            hitIsHost: hit === h,
            hitTag: hit ? hit.tagName : null,
            clientW: document.documentElement.clientWidth,
            clientH: document.documentElement.clientHeight,
            innerW: window.innerWidth,
            innerH: window.innerHeight
          };
        }, { px: x, py: y });
      const shotDrag = (pts) =>
        cpage.evaluate((p) => {
          const h = document.querySelector('[data-rt-shot]');
          if (!h) return '遮罩不在';
          // 监听挂在 hostEl 上（真实可命中元素）。从 hostEl 派发即可 ——
          // 别挂 shadow root：它不是事件目标，只有内部可命中元素冒泡才触发。
          const fire = (type, x, y) =>
            h.dispatchEvent(new PointerEvent(type, {
              bubbles: true, composed: true, clientX: x, clientY: y, button: 0,
              pointerId: 1, isPrimary: true, pointerType: 'mouse'
            }));
          fire('pointerdown', p[0][0], p[0][1]);
          for (let i = 1; i < p.length - 1; i++) fire('pointermove', p[i][0], p[i][1]);
          fire('pointerup', p[p.length - 1][0], p[p.length - 1][1]);
          return null;
        }, pts);

      await shotMsg(shotDataUrl);
      await cpage.waitForFunction(() => !!document.querySelector('[data-rt-shot]'), null, { timeout: 8000 })
        .catch(() => {});
      check('框选那条消息送到了：遮罩盖上来等着框选', await shotOverlay(), String(await shotOverlay()));
      const pvInit = await shotPreview();
      check('覆盖层只有挖洞层 + 接指针层（不铺底图 —— 页面就是背景）',
        pvInit.hasVeil === true && pvInit.hasSel === true && pvInit.hasImg === false,
        JSON.stringify(pvInit));
      check('提示条说明了「可滚动页面」', pvInit.tip.includes('可滚动页面'), pvInit.tip);
      /* 关键：真鼠标点在这一处，最上层必须是遮罩（不然「按住拖框」点不到） */
      check('（脚手架）鼠标点得到遮罩：命中测试落在覆盖层上',
        pvInit.hitIsHost === true, `hit=${pvInit.hitTag}`);

      const dragErr = await shotDrag([[60, 40], [120, 80], [180, 120]]);
      check('（脚手架）拖框事件发进去了', dragErr === null, String(dragErr));

      // 遮罩收掉 + 假 OCR 接口挨了一发 + 面板出译文 —— 按结果等，别按元素在不在等
      // （面板从上一节就开着，.rt-out 一直都在，等元素等于不等）
      await cpage.waitForFunction(() => !document.querySelector('[data-rt-shot]'), null, { timeout: 8000 })
        .catch(() => {});
      await cpage.waitForFunction((needle) => {
        const root = document.getElementById('request-translate-host')?.shadowRoot;
        return !!root && root.querySelector('.rt-out')?.textContent.includes(needle);
      }, '本地假译文', { timeout: 30000 }).catch(() => {});
      const shotOut = await cpage.evaluate(() => {
        const root = document.getElementById('request-translate-host')?.shadowRoot;
        return {
          overlay: !!document.querySelector('[data-rt-shot]'),
          out: root?.querySelector('.rt-out')?.textContent || '',
          src: root?.querySelector('.rt-src')?.textContent || '',
          msg: root?.querySelector('.rt-msg')?.textContent || '',
          dot: root?.querySelector('.rt-dot')?.className || ''
        };
      });
      check('框完遮罩收掉了（不会一直糊在页面上）', shotOut.overlay === false, String(shotOut.overlay));
      check('框选裁出的图送去了 OCR（假接口挨了一发）', ocrHits === shotHitBefore + 1,
        `${ocrHits}（之前 ${shotHitBefore}）｜${lastPath}`);
      check('识别结果进了原文区并照常翻了出来',
        shotOut.src.includes("Pixeldrain's") && shotOut.out.includes('本地假译文'),
        `${shotOut.msg}｜${shotOut.src.slice(0, 40)}`);
      check('状态栏标了「截图 OCR」（框选和剪切板同一条链）', shotOut.msg.includes('截图 OCR'), shotOut.msg);

      /* Esc 取消：遮罩收掉、不发请求 */
      await shotMsg(shotDataUrl);
      await cpage.waitForFunction(() => !!document.querySelector('[data-rt-shot]'), null, { timeout: 8000 })
        .catch(() => {});
      await cpage.evaluate(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      const escClosed = await shotOverlay();
      check('Esc 收掉遮罩、不发请求', escClosed === false && ocrHits === shotHitBefore + 1,
        `overlay=${escClosed}｜ocrHits=${ocrHits}`);

      /* 空点（没拖动）当误触：遮罩收掉、不发请求 */
      await shotMsg(shotDataUrl);
      await cpage.waitForFunction(() => !!document.querySelector('[data-rt-shot]'), null, { timeout: 8000 })
        .catch(() => {});
      const tapErr = await shotDrag([[100, 100], [101, 101]]);
      await cpage.waitForFunction(() => !document.querySelector('[data-rt-shot]'), null, { timeout: 8000 })
        .catch(() => {});
      const tapClosed = await shotOverlay();
      check('空点（没怎么拖）当误触，整个取消、不发请求',
        tapErr === null && tapClosed === false && ocrHits === shotHitBefore + 1,
        `err=${tapErr}｜overlay=${tapClosed}｜ocrHits=${ocrHits}`);

      /* ---- 右边那条滚动条不能被裁进去 ----------------------------------
         captureVisibleTab 的位图 = **整块可见区域 × dpr**（含页面自己那条滚动条），
         而拖框坐标是在**内容区**坐标系里量的（不含滚动条）。A 方案把这一刀收敛进
         `cropShot()`：先按「视口 − 内容区」算出该切多少，比例再按「位图 − 那一条」算。
         这一节跑在**有头窗口**里，能挂出一条真滚动条（overflow-y:scroll，经典滚动条
         占布局），不用去伪 innerWidth —— content script 在隔离世界里，页面改
         window.innerWidth 它根本看不见。 */
      console.log('   框选截图：右边那条滚动条不会被裁进去');
      const shotDims = () =>
        cpage.evaluate(() => ({
          innerW: window.innerWidth,
          innerH: window.innerHeight,
          clientW: document.documentElement.clientWidth,
          clientH: document.documentElement.clientHeight
        }));
      const waitOcrHit = async (before, timeoutMs = 15000) => {
        const t0 = Date.now();
        while (ocrHits <= before && Date.now() - t0 < timeoutMs) {
          await new Promise((r) => setTimeout(r, 50));
        }
        return ocrHits > before;
      };
      const fullDrag = (w, h) =>
        shotDrag([[0, 0], [Math.round(w / 2), Math.round(h / 2)], [w, h]]);

      /* ---- 真鼠标拖拽：走浏览器的命中测试 ------------------------------
         `shotDrag` 是**直接派发事件**，绕过命中测试 —— 所以它测不出
         「覆盖层根本吃不到鼠标」这类 bug（kniph 报过：按住鼠标框选不了，
         脚本却全绿）。这里用 Playwright 的**真鼠标**按下去拖：如果最上层不是遮罩，
         pointerdown 会落在页面上、`start` 永远是 null，遮罩收不掉、也不发请求。 */
      await shotMsg(shotDataUrl);
      await cpage.waitForFunction(() => !!document.querySelector('[data-rt-shot]'), null, { timeout: 8000 })
        .catch(() => {});
      const realBefore = ocrHits;
      await cpage.mouse.move(240, 200);
      await cpage.mouse.down();
      await cpage.mouse.move(340, 260, { steps: 5 });
      await cpage.mouse.move(420, 320, { steps: 5 });
      await cpage.mouse.up();
      const realSent = await waitOcrHit(realBefore);
      await cpage.waitForFunction(() => !document.querySelector('[data-rt-shot]'), null, { timeout: 8000 })
        .catch(() => {});
      const realClosed = (await shotOverlay()) === false;
      check('真鼠标按住拖框：遮罩收掉并真的发了请求（覆盖层吃得到鼠标）',
        realSent && realClosed, `发出的请求=${realSent}｜遮罩收掉=${realClosed}`);
      /** 底图按真实 captureVisibleTab 的样子造：宽高 = innerWidth × innerHeight
          （**含**滚动条那一条 —— 这正是要考的点）。 */
      const bigShot = await cpage.evaluate(() => {
        const c = document.createElement('canvas');
        c.width = window.innerWidth;
        c.height = window.innerHeight;
        const g = c.getContext('2d');
        g.fillStyle = '#f4f4f8';
        g.fillRect(0, 0, c.width, c.height);
        return c.toDataURL('image/png');
      });

      // 一档：没有滚动条 —— 框满整屏就该原样裁出整张（老行为一个字不变）
      await cpage.evaluate(() => { document.documentElement.style.overflowY = 'hidden'; });
      const noBar = await shotDims();
      check('（脚手架）这一档真的没有滚动条：内容区 = 视口', noBar.clientW === noBar.innerW,
        JSON.stringify(noBar));

      let shotHits = ocrHits;
      await shotMsg(bigShot);
      await cpage.waitForFunction(() => !!document.querySelector('[data-rt-shot]'), null, { timeout: 8000 })
        .catch(() => {});
      await fullDrag(noBar.clientW, noBar.clientH);
      await waitOcrHit(shotHits);
      await cpage.waitForFunction(() => !document.querySelector('[data-rt-shot]'), null, { timeout: 8000 })
        .catch(() => {});
      const cropNoBar = pngSizeOf(lastOcrRequest);
      near('没有滚动条时：框满整屏，裁出来就是整张（老行为不变）',
        cropNoBar && cropNoBar.w, noBar.clientW, 3, 'px');

      // 二档：挂一条真滚动条，「同一屏」再截一次 —— 裁出来必须真的窄那一条
      await cpage.evaluate(() => { document.documentElement.style.overflowY = 'scroll'; });
      const withBar = await shotDims();
      const barW = withBar.innerW - withBar.clientW;
      check('（脚手架）页面真挂上滚动条了（内容区比视口窄一条）', barW > 0, JSON.stringify(withBar));

      shotHits = ocrHits;
      await shotMsg(bigShot);
      await cpage.waitForFunction(() => !!document.querySelector('[data-rt-shot]'), null, { timeout: 8000 })
        .catch(() => {});
      await fullDrag(withBar.clientW, withBar.clientH);
      await waitOcrHit(shotHits);
      await cpage.waitForFunction(() => !document.querySelector('[data-rt-shot]'), null, { timeout: 8000 })
        .catch(() => {});
      const cropBar = pngSizeOf(lastOcrRequest);
      near('框满整屏时：裁出来的宽 = 内容区宽（右边那条滚动条被切掉了）',
        cropBar && cropBar.w, withBar.clientW, 3,
        `px（位图宽 ${withBar.innerW}，滚动条 ${barW}）`);
      near('切掉的正好是滚动条那一条（两张图宽度差 = 滚动条宽）',
        cropBar && cropNoBar && cropNoBar.w - cropBar.w, barW, 3, 'px');

      // 恢复，别把这档的滚动条留给后面的小节
      await cpage.evaluate(() => { document.documentElement.style.overflowY = ''; });
    } catch (err) {
      fail += 1;
      console.log(`  FAIL 有头那段跑挂了：${err && err.message ? err.message : String(err)}`);
    } finally {
      try {
        await cctx?.close();
      } catch {
        /* 忽略 */
      }
      try {
        fs.rmSync(clipProfile, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    }
  }
  fs.rmSync(shotPng, { force: true });

  /* ------------------------------------------------------------------ */
  /* 11. 换配置：翻过的直接放回来，没翻过的当场翻                         */
  /* ------------------------------------------------------------------ */
  /* kniph 报的：切到 A 翻完 → 切到 B → 切回 A 又发了一次请求。
     他要的是「a 翻 - 切 b（b 自己翻）- 切回 a（看到 a 刚才那条，不重发）」。
     所以：翻过的配置放回缓存里的结果，没翻过的当场发一条，
     「↻」只负责**重发同一条请求**（结果不满意时才按）。 */

  console.log('\n11. 换配置：翻过的放回缓存，没翻过的当场翻');

  await opt.evaluate(async (u) => {
    const read = async () => (await chrome.storage.local.get('state')).state || null;
    const mk = (id, name, tag) => ({
      id,
      name,
      note: '',
      adapter: '',
      request: `curl ${u}?tag=${tag}`,
      path: '',
      responseMode: 'text'
    });
    for (let i = 0; i < 30; i++) {
      const st = await read();
      st.configs = [mk('e2e-pick-a', '假接口 A', 'alpha'), mk('e2e-pick-b', '假接口 B', 'beta')];
      st.activeConfigId = 'e2e-pick-a';
      await chrome.storage.local.set({ state: st });
      const back = await read();
      if (back.configs.length === 2 && back.activeConfigId === 'e2e-pick-a') return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('两个假配置没写进去');
  }, `http://127.0.0.1:${port}/text`);

  await page.waitForTimeout(700); // 等内容脚本把新配置吃进顶栏下拉

  const readPanel = () =>
    page.evaluate(() => {
      const root = document.getElementById('request-translate-host').shadowRoot;
      return {
        cfg: root.querySelector('.rt-cfg').value,
        out: root.querySelector('.rt-out').textContent,
        msg: root.querySelector('.rt-msg').textContent,
        dot: root.querySelector('.rt-dot').className
      };
    });

  /** 像用户那样拨一下顶栏的下拉（监听的就是 change 这个口子） */
  const pickConfig = (id) =>
    page.evaluate((v) => {
      const sel = document
        .getElementById('request-translate-host')
        .shadowRoot.querySelector('.rt-cfg');
      sel.value = v;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, id);

  /** 等面板自己安静下来（发请求的那条路要等译文铺上去） */
  const settlePanel = async () => {
    await page
      .waitForFunction(
        () => {
          const root = document.getElementById('request-translate-host').shadowRoot;
          return !/(^|\s)on(\s|$)/.test(root.querySelector('.rt-dot').className);
        },
        null,
        { timeout: 6000 }
      )
      .catch(() => {});
    await page.waitForTimeout(120);
  };

  await selectText();
  await page.waitForTimeout(250);
  await page.click('.rt-trigger', { force: true });
  await settle();

  const p0 = await readPanel();
  check(
    '（脚手架）顶栏选中 A，翻出来的是 A 的译文',
    p0.cfg === 'e2e-pick-a' && p0.out.includes('本地假译文【alpha】'),
    `${p0.cfg}｜${p0.msg}｜${p0.out}`
  );

  const reqA = textHits;

  /* 切到还没翻过的 B：当场就用 B 翻一次 */
  await pickConfig('e2e-pick-b');
  await settlePanel();
  const p1 = await readPanel();
  check(
    '切到没翻过的配置：自己发了一条请求（不用等用户点 ↻）',
    textHits === reqA + 1,
    `textHits ${reqA} → ${textHits}｜lastPath ${lastPath}`
  );
  check('出来的是 B 自己的译文', p1.out.includes('本地假译文【beta】'), `${p1.msg}｜${p1.out}`);
  check('B 也拿到绿灯', /(^|\s)ok(\s|$)/.test(p1.dot), p1.dot);

  const reqB = textHits;

  /* 切回 A：直接把 A 上次的结果放回来，一个请求都不发 */
  await pickConfig('e2e-pick-a');
  await page.waitForTimeout(700); // 给够时间 —— 万一它偷偷发请求，这里就能抓到
  const p2 = await readPanel();
  check('切回翻过的配置：没发请求', textHits === reqB, `textHits ${reqB} → ${textHits}`);
  check(
    '立刻看到 A 自己的译文（不是 B 留在界面上的）',
    p2.out.includes('本地假译文【alpha】'),
    `${p2.msg}｜${p2.out}`
  );
  check('灯恢复成绿灯', /(^|\s)ok(\s|$)/.test(p2.dot), p2.dot);

  /* 再切到 B：同样放回来 */
  await pickConfig('e2e-pick-b');
  await page.waitForTimeout(700);
  const p3 = await readPanel();
  check('再切到 B：一样是放回缓存', textHits === reqB, `textHits ${reqB} → ${textHits}`);
  check('B 的译文也还留着', p3.out.includes('本地假译文【beta】'), `${p3.msg}｜${p3.out}`);

  /* ↻ 的语义：用当前配置**重发同一条请求**（这是唯一该重发的地方） */
  await page.click('.rt-btn[data-act="retry"]', { force: true });
  await settlePanel();
  const p4 = await readPanel();
  check('点 ↻：用当前配置（B）重发了一条', textHits === reqB + 1, `textHits ${reqB} → ${textHits}`);
  check('重发后 B 的译文还在', p4.out.includes('本地假译文【beta】'), `${p4.msg}｜${p4.out}`);

  const reqRetry = textHits;

  /* 换一段原文 → 所有配置的旧结果都得作废：
     不然切配置会把上一段文字的译文端出来，冒充这一次的结果。
     参数是选几个字 —— 不同长度就是不同原文（缓存作废的判据是原文本身）。 */
  const selectRange = (n) =>
    page.evaluate((k) => {
      const t0 = document.getElementById('t').childNodes[0];
      const range = document.createRange();
      range.setStart(t0, 0);
      range.setEnd(t0, Math.min(k, t0.textContent.length));
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
      const segs = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
      const tail = segs[segs.length - 1];
      document.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          composed: true,
          clientX: tail.right - 2,
          clientY: tail.top + tail.height / 2
        })
      );
    }, n);

  await selectRange(3);
  await page.waitForTimeout(250);
  await page.click('.rt-trigger', { force: true });
  await settle();
  const p5 = await readPanel();
  check(
    '换了原文：当前选中的配置（B）照常翻译',
    p5.out.includes('本地假译文【beta】'),
    `${p5.msg}｜${p5.out}`
  );

  const reqOther = textHits;
  await pickConfig('e2e-pick-a');
  await settlePanel();
  const p6 = await readPanel();
  check(
    '新原文下 A 是没翻过的 → 当场翻（旧译文不作数）',
    p6.out.includes('本地假译文【alpha】'),
    `${p6.msg}｜${p6.out}`
  );
  check('而且只发了一条', textHits === reqOther + 1, `textHits ${reqOther} → ${textHits}`);

  /* 请求还在飞的时候切走：切到**有缓存**的配置时那条请求不会被中止（后台只在
     收到新的 translate 时才 abort），它的流还会继续来 —— 不许糊到眼前这屏上。
     这条就是为它准备的：A 换成慢速流式接口，B 仍是即答。 */
  await opt.evaluate(async (u) => {
    const read = async () => (await chrome.storage.local.get('state')).state || null;
    for (let i = 0; i < 30; i++) {
      const st = await read();
      const a = st.configs.find((c) => c.id === 'e2e-pick-a');
      a.request = `curl ${u}?tag=alpha`;
      a.responseMode = 'auto'; // 让引擎自己认出 event-stream，走真正的 SSE 解析
      await chrome.storage.local.set({ state: st });
      const back = await read();
      if (back.configs.find((c) => c.id === 'e2e-pick-a').request.includes('/stream')) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('A 没换成流式接口');
  }, `http://127.0.0.1:${port}/stream`);
  await page.waitForTimeout(700);

  /* 切回 B，然后把面板收起来 —— 面板就压在第一行的选区上，
     新选区冒出来的小圆点会被它盖住（Playwright 的点击会落到面板上）。
     Esc 只是把面板藏起来，缓存和下拉选中的配置都还在。 */
  await pickConfig('e2e-pick-b'); // B 在老原文上有缓存 → 只是铺回旧结果，不发请求
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
  const panelHidden = await page.evaluate(
    () =>
      !document
        .getElementById('request-translate-host')
        .shadowRoot.querySelector('.rt-panel')
        .classList.contains('show')
  );
  check('（脚手架）Esc 把面板收起来了，小圆点不会再被压住', panelHidden);

  /* 先把 B 在这段**新**原文上翻好并缓存住（故意选 6 个字，和上面那段不同 ——
     不然 A 在老原文上的缓存还在，切过去直接铺回来了，那条流压根不会发） */
  await selectRange(6);
  await page.waitForTimeout(250);
  const reqB2 = textHits;
  await page.click('.rt-trigger', { force: true }); // 新原文 → 旧结果作废，用 B 发一条
  await settle();
  const p7 = await readPanel();
  check(
    '（脚手架）B 用新原文发了一条，并翻好了',
    textHits === reqB2 + 1 && p7.out.includes('本地假译文【beta】'),
    `textHits ${reqB2} → ${textHits}｜${p7.msg}｜${p7.out}`
  );

  const reqFlow = textHits;

  /* 切到 A（这段原文它没翻过）→ 走 /stream，开始一段一段吐 */
  await pickConfig('e2e-pick-a');
  await page
    .waitForFunction(
      () => {
        const root = document.getElementById('request-translate-host').shadowRoot;
        return root.querySelector('.rt-out').textContent.includes('分段1');
      },
      null,
      { timeout: 6000 }
    )
    .catch(() => {});
  const flying = await readPanel();
  check(
    '（脚手架）A 的流已经吐到一半了',
    flying.out.includes('分段1'),
    `${flying.msg}｜${flying.out}`
  );
  check(
    '切到没翻过的配置就用它发了请求（不用等用户点 ↻）',
    textHits === reqFlow + 1,
    `textHits ${reqFlow} → ${textHits}｜lastPath ${lastPath}`
  );

  /* 流还在飞的时候切回有缓存的 B */
  await pickConfig('e2e-pick-b');
  const p8 = await readPanel();
  check(
    '流在飞的时候切回有缓存的配置：立刻铺上它自己的译文',
    p8.out.includes('本地假译文【beta】') && !p8.out.includes('分段'),
    `${p8.msg}｜${p8.out}`
  );

  /* 等 A 那条流吐完（剩下的分段全落在「不在看的配置」上） */
  await page.waitForTimeout(STREAM_CHUNKS * STREAM_GAP_MS + 900);
  const p9 = await readPanel();
  check(
    'A 后面几段没糊到 B 的脸上',
    p9.out.includes('本地假译文【beta】') && !p9.out.includes('分段'),
    `${p9.msg}｜${p9.out}`
  );
  check('状态栏也没被 A 的「请求中…」改掉', !p9.msg.includes('请求中'), p9.msg);
  check('灯还是 B 的绿灯', /(^|\s)ok(\s|$)/.test(p9.dot), p9.dot);

  /* A 那条结果虽然没显示，但**进了它自己的缓存**：切回去立刻能看到，不用重发 */
  const reqLate = textHits;
  await pickConfig('e2e-pick-a');
  await page.waitForTimeout(700);
  const p10 = await readPanel();
  check(
    'A 的结果在后台存下来了：切回去就看得到',
    p10.out.includes('分段1') && p10.out.includes('分段' + STREAM_CHUNKS),
    `${p10.msg}｜${p10.out}`
  );
  check('看到它也不用再发请求', textHits === reqLate, `textHits ${reqLate} → ${textHits}`);
  check('而且已经不是「请求中」了', !p10.msg.includes('请求中'), p10.msg);

  await opt.close();

  /* ------------------------------------------------------------------ */
  /* 12. 网页想给滚动条上色？面板不吃这一套                              */
  /* ------------------------------------------------------------------ */

  console.log('\n12. 网页把滚动条染成浅蓝，面板里那条还得是自己的灰滑块');

  await page.bringToFront();
  // 架一个「滚动条配色陷阱」：scrollbar-color 是**继承属性**，写在 html 上会一路
  // 穿进我们的 shadow DOM（kniph 截图抓到的那条浅蓝滑块就是这么来的）。
  // 一旦它在面板内部算出来不是 auto，浏览器就把我们自绘的 ::-webkit-scrollbar
  // 整段忽略 —— 这条断言盯的就是「显式写回 auto」那两行还在不在。
  await page.addStyleTag({ content: 'html { scrollbar-color: lightblue #eeeeee; }' });
  await page.waitForTimeout(120);

  const sb = await page.evaluate(() => {
    const host = document.getElementById('request-translate-host');
    const root = host && host.shadowRoot;
    const cs = (s) => {
      const el = root && root.querySelector(s);
      return el ? getComputedStyle(el).scrollbarColor : null;
    };
    return {
      supported: typeof CSS !== 'undefined' && CSS.supports('scrollbar-color', 'auto'),
      body: getComputedStyle(document.body).scrollbarColor,
      out: cs('.rt-out'),
      src: cs('.rt-src'),
      diag: cs('.rt-diag')
    };
  });

  if (!sb.supported) {
    console.log('     跳过：这个 Edge 还不认 scrollbar-color');
  } else {
    // 先证明陷阱真的架起来了，不然下面三条是空跑
    check('测试页真把滚动条染成浅蓝了（陷阱生效）', /173,\s*216,\s*230/.test(sb.body || ''), sb.body);
    check('正文区不吃网页的滚动条配色（auto = 自绘规则生效）', sb.out === 'auto', sb.out);
    check('原文区不吃网页的滚动条配色', sb.src === 'auto', sb.src);
    check('「…」诊断区不吃网页的滚动条配色', sb.diag === 'auto', sb.diag);

    // 光写回 auto 只是「不挡着」—— 真正画滚动条的还是下面这条自绘规则。
    // 两半缺一半都会退化（滑块变回系统灰、或干脆不生效），所以配对一起盯。
    const thumb = await page.evaluate(() => {
      const host = document.getElementById('request-translate-host');
      const st = host && host.shadowRoot && host.shadowRoot.querySelector('style');
      const rules = (st && st.sheet && st.sheet.cssRules) || [];
      for (const r of Array.from(rules)) {
        if (r.selectorText && r.selectorText.includes('-webkit-scrollbar-thumb')) {
          return r.style.background || r.style.backgroundColor || '';
        }
      }
      return null;
    });
    check('自绘滑块规则也还在（写在 auto 旁边的那半）', /rt-scroll/.test(thumb || ''), thumb);
  }

  /* ------------------------------------------------------------------ */
  /* 13. 导出 / 导入                                                     */
  /* ------------------------------------------------------------------ */
  /* 多设备搬家的唯一一条路：导出成 JSON，在新设备上导入。整份存档都会被换掉，
     所以「导出的是不是当下这一份」和「点了取消会不会照样覆盖」都得真的走一遍。 */

  console.log('\n13. 导出 / 导入：换台设备能把配置原样搬过去');

  // 第 12 节结束时把设置页关了，这里另开一个（顺便盯住导入导出过程中没报错）
  const opt2 = await ctx.newPage();
  const ioErrors = [];
  opt2.on('console', (m) => {
    if (m.type() === 'error') ioErrors.push(m.text());
  });
  opt2.on('pageerror', (e) => ioErrors.push(String((e && e.message) || e)));
  await opt2.goto(`chrome-extension://${extId}/options.html`, { waitUntil: 'load' });
  await opt2.waitForSelector('#cfg-list .cfg-item', { timeout: 8000 });
  await opt2.waitForTimeout(300);

  await opt2.evaluate(() => document.querySelector('.tab[data-tab="settings"]')?.click());
  await opt2.waitForTimeout(200);

  // 先改一处一眼能认出来的东西（面板字号），证明导出的确实是**当前**状态
  await opt2.evaluate(() => {
    const el = document.getElementById('s-font');
    el.value = '27';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await opt2.waitForTimeout(1300);

  const dl = await Promise.all([opt2.waitForEvent('download', { timeout: 15000 }), opt2.click('#btn-export')]).then(
    ([d]) => d
  );
  const dlPath = await dl.path();
  const jsonText = fs.readFileSync(dlPath, 'utf8');
  const exported = JSON.parse(jsonText); // 解析不了就直接抛，等于一条硬断言
  check(
    '导出的文件名带日期（多设备来回导出不会互相盖）',
    /^request-translate-config-\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()),
    dl.suggestedFilename()
  );
  check('文件是合法 JSON，且带我们的 kind', exported.kind === 'request-translate', String(exported.kind));
  check(
    '导出的是刚刚那一刻的状态（面板字号 27 跟着走了）',
    exported.settings && exported.settings.fontSize === 27,
    JSON.stringify(exported.settings && exported.settings.fontSize)
  );
  check(
    '四条主线数据一条不少',
    ['configs', 'vars', 'settings', 'ocr'].every((k) => k in exported),
    Object.keys(exported).join(',')
  );
  const statusAfterExport = await opt2.evaluate(() => document.getElementById('save-status').textContent);
  check('状态栏说了导出了几条', /已导出\s*\d+\s*条/.test(statusAfterExport), statusAfterExport);

  /* 造一份「别的设备导出的」文件：第一条改个名、字号改 31、只留两条 */
  const incoming = JSON.parse(jsonText);
  incoming.configs = incoming.configs.slice(0, 2).map((c, i) =>
    i === 0 ? { ...c, name: '从别的设备搬来的' } : c
  );
  incoming.settings.fontSize = 31;
  const incomingFile = path.join(profile, 'incoming.json');
  fs.writeFileSync(incomingFile, JSON.stringify(incoming, null, 2), 'utf8');

  /** 接管这次导入弹出的 confirm / alert */
  const dialogs = [];
  let dialogAction = 'accept';
  const onDialog = async (d) => {
    dialogs.push({ type: d.type(), message: d.message() });
    if (dialogAction === 'accept') await d.accept();
    else await d.dismiss();
  };
  opt2.on('dialog', onDialog);

  const stateNow = () =>
    opt2.evaluate(async () => {
      const { state } = await chrome.storage.local.get('state');
      return {
        count: state.configs.length,
        firstName: state.configs[0] ? state.configs[0].name : '',
        fontSize: state.settings.fontSize,
        status: document.getElementById('save-status').textContent
      };
    });

  const beforeImport = await stateNow();

  // —— 先点取消：一个字都不该动
  dialogAction = 'dismiss';
  await opt2.setInputFiles('#file-import', incomingFile);
  await opt2.waitForTimeout(700);
  const afterCancel = await stateNow();
  check(
    '导入框里点了取消 → 什么都没动',
    afterCancel.count === beforeImport.count && afterCancel.firstName === beforeImport.firstName &&
      afterCancel.fontSize === beforeImport.fontSize,
    JSON.stringify(afterCancel)
  );

  // —— 正经导入
  dialogAction = 'accept';
  await opt2.setInputFiles('#file-import', incomingFile);
  await opt2.waitForTimeout(1500);
  const afterImport = await stateNow();
  check(
    '导入后配置换成了文件里那两条',
    afterImport.count === 2 && afterImport.firstName === '从别的设备搬来的',
    JSON.stringify(afterImport)
  );
  check('设置也一起搬过来了（字号 31）', afterImport.fontSize === 31, String(afterImport.fontSize));
  check('状态栏报了声「导入完成」', /导入完成/.test(afterImport.status), afterImport.status);

  const confirmMsg = dialogs.map((d) => d.message).join(' ｜ ');
  check(
    '确认框说了会替换掉几条（不是干巴巴一句「确定吗」）',
    /替换/.test(confirmMsg) && /2\s*条/.test(confirmMsg),
    confirmMsg.slice(0, 120)
  );

  // —— 列表 / 编辑器也得跟着重画，不能只有存档变了
  await opt2.evaluate(() => document.querySelector('.tab[data-tab="configs"]')?.click());
  await opt2.waitForTimeout(200);
  const redrawn = await opt2.evaluate(() => ({
    rows: document.querySelectorAll('#cfg-list .cfg-row').length,
    firstName: (document.querySelector('#cfg-list .cfg-item .name') || {}).textContent || '',
    editorName: (document.getElementById('f-name') || {}).value || ''
  }));
  check(
    '列表和编辑器都按新存档重画了',
    redrawn.rows === 2 && redrawn.firstName.includes('从别的设备搬来的') &&
      redrawn.editorName.includes('从别的设备搬来的'),
    JSON.stringify(redrawn)
  );

  // —— 坏文件：要拦住，而且要明说为什么，别把存档搞坏
  const badFile = path.join(profile, 'bad.json');
  fs.writeFileSync(badFile, '{ 这不是 json', 'utf8');
  dialogs.length = 0;
  await opt2.setInputFiles('#file-import', badFile);
  await opt2.waitForTimeout(700);
  const afterBad = await stateNow();
  check(
    '坏文件被挡在门外，存档原样',
    dialogs.some((d) => d.type === 'alert' && /导入失败/.test(d.message) && /JSON/.test(d.message)) &&
      afterBad.count === 2,
    JSON.stringify({ dialogs, count: afterBad.count })
  );

  // —— 别人家的 JSON（kind 对不上）：同样拦住
  const foreignFile = path.join(profile, 'foreign.json');
  fs.writeFileSync(foreignFile, JSON.stringify({ kind: 'some-other-app', configs: [{ id: 'a' }] }), 'utf8');
  dialogs.length = 0;
  await opt2.setInputFiles('#file-import', foreignFile);
  await opt2.waitForTimeout(700);
  check(
    '别的软件导出的文件也会被拒（并说清原因）',
    dialogs.some((d) => d.type === 'alert' && /kind/.test(d.message)),
    JSON.stringify(dialogs)
  );

  opt2.off('dialog', onDialog);
  check('导出导入全程没报错', ioErrors.length === 0, ioErrors.join(' | '));
  await opt2.close();

  /* ------------------------------------------------------------------ */
  /* 14. 顶栏换目标语言；流式输出不甩着滚动条跑                          */
  /* ------------------------------------------------------------------ */
  /* kniph 提的两条：①想换门语言翻，不该还得开设置页 —— 顶栏「翻译接口」
     旁边再加一个「目标语言」选择框；②流式输出吐得快的时候滚动条被文字牵着跑
     就看不了了 —— 视口原地不动，要追尾巴自己拖。 */

  console.log('\n14. 顶栏直接换目标语言；流式输出时滚动条不跟着跑');

  await page.bringToFront();

  /* 网页那边是主世界，`chrome.storage` 在那儿是 undefined —— 改存档只能用
     扩展自己的页面（关掉 opt / opt2 之后另开一个）。 */
  const opt3 = await ctx.newPage();
  await opt3.goto(`chrome-extension://${extId}/options.html`, { waitUntil: 'load' });
  await opt3.waitForTimeout(400);

  /* 13 节把配置换成了导入进来那两条、字号还留着 31 —— 这一节重架一条自己的配置，
     顺手把字号 / 面板宽度**归位**：小节之间互相污染过，别让上一节的决定影响这一节的度量。
     请求模板里带 {{targetCode}} 并把它当 ?tag= —— 「到底换没换成英语」看
     假接口收到的路径就知道（后台每次发请求都重读一遍设置，所以这也顺带验了落盘）。 */
  await opt3.evaluate(async (u) => {
    const read = async () => (await chrome.storage.local.get('state')).state || null;
    for (let i = 0; i < 30; i++) {
      const st = await read();
      st.configs = [{
        id: 'e2e-lang',
        name: '假语言接口',
        note: '',
        adapter: '',
        request: `curl ${u}?tag={{targetCode}}`,
        path: '',
        responseMode: 'text'
      }];
      st.activeConfigId = 'e2e-lang';
      st.settings.targetLang = '简体中文';
      st.settings.fontSize = 20;
      st.settings.panelWidth = 460;
      await chrome.storage.local.set({ state: st });
      const back = await read();
      if (back.configs.length === 1 && back.configs[0].id === 'e2e-lang') return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('假语言接口没写进去');
  }, `http://127.0.0.1:${port}/text`);
  await page.waitForTimeout(700);

  // 12 节留下的面板可能还开着（它压着选区，小圆点点不到）
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  await page.waitForTimeout(200);

  const langPanel = () =>
    page.evaluate(() => {
      const root = document.getElementById('request-translate-host').shadowRoot;
      const sel = root.querySelector('.rt-lang');
      const head = root.querySelector('.rt-head');
      const out = root.querySelector('.rt-out');
      return {
        value: sel ? sel.value : null,
        options: sel ? Array.from(sel.options).map((o) => o.value) : [],
        cfgW: root.querySelector('.rt-cfg').getBoundingClientRect().width,
        langW: sel ? sel.getBoundingClientRect().width : 0,
        headOverflow: head.scrollWidth - head.clientWidth,
        out: out.textContent,
        scrollTop: out.scrollTop,
        scrollH: out.scrollHeight,
        clientH: out.clientHeight,
        msg: root.querySelector('.rt-msg').textContent,
        dot: root.querySelector('.rt-dot').className
      };
    });

  /** 像用户那样拨一下顶栏的语言下拉（监听的就是 change 这个口子） */
  const pickLang = (v) =>
    page.evaluate((val) => {
      const sel = document
        .getElementById('request-translate-host')
        .shadowRoot.querySelector('.rt-lang');
      sel.value = val;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }, v);

  await selectRange(2);
  await page.waitForTimeout(250);
  await page.click('.rt-trigger', { force: true });
  await settle();

  const lp0 = await langPanel();
  check('顶栏多了个目标语言下拉，候选是后台发过来的那一套',
    lp0.options.length >= 20, `${lp0.options.length} 项`);
  check('候选里有关键的几个（英语 / 荷兰语 / 地区变体 EN-GB）',
    ['英语', '荷兰语', 'EN-GB'].every((v) => lp0.options.includes(v)),
    lp0.options.slice(0, 6).join(','));
  check('它显示的就是存档里的目标语言', lp0.value === '简体中文', String(lp0.value));
  check('两个下拉并排没把顶栏挤溢出', lp0.headOverflow <= 1, `溢出 ${lp0.headOverflow}px`);
  check('语言那条没反过来把接口那条压没', lp0.cfgW > lp0.langW, `cfg ${lp0.cfgW} ｜ lang ${lp0.langW}`);
  check('请求里带上了当前语言的代码（tag=ZH-HANS）', /tag=ZH-HANS/.test(lastPath), lastPath);
  check('译文也认这门语言', lp0.out.includes('【ZH-HANS】'), `${lp0.msg}｜${lp0.out}`);

  /* 拨一下就换语言：当场重发，不用回去开设置页、也不用再点 ↻ */
  const reqLang = textHits;
  await pickLang('英语');
  await settlePanel();
  const lp1 = await langPanel();
  check('换语言当场重发一条', textHits === reqLang + 1, `textHits ${reqLang} → ${textHits}`);
  check('这一条带的是 EN', /tag=EN$/.test(lastPath), lastPath);
  check('回来的是这门语言的译文（不是把上一条留在界面上）',
    lp1.out.includes('【EN】'), `${lp1.msg}｜${lp1.out}`);
  check('下拉停在刚挑的那门语言上', lp1.value === '英语', String(lp1.value));

  const reqLang2 = textHits;
  await pickLang('简体中文');
  await settlePanel();
  check('再换回中文：又发一条，带的是 ZH-HANS',
    textHits === reqLang2 + 1 && /tag=ZH-HANS/.test(lastPath),
    `textHits ${reqLang2} → ${textHits}｜${lastPath}`);

  /* —— 流式输出：字一段段涌出来，滚动条不许被带着走 —— */
  await opt3.evaluate(async (u) => {
    const read = async () => (await chrome.storage.local.get('state')).state || null;
    for (let i = 0; i < 30; i++) {
      const st = await read();
      st.configs[0].request = `curl ${u}?tag=long`;
      st.configs[0].responseMode = 'auto'; // 让引擎自己认出 event-stream，走真正的 SSE 解析
      await chrome.storage.local.set({ state: st });
      const back = await read();
      if (back.configs[0].request.includes('/streamlong')) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('没换成流式接口');
  }, `http://127.0.0.1:${port}/streamlong`);
  await page.waitForTimeout(700);

  const reqLong = textHits;
  await page.click('.rt-btn[data-act="retry"]', { force: true });
  // 等它吐到「已经该出滚动条」的长度，量一次正在流的时候
  await page
    .waitForFunction(
      () =>
        document.getElementById('request-translate-host').shadowRoot.querySelector('.rt-out')
          .textContent.length > 400,
      null,
      { timeout: 6000 }
    )
    .catch(() => {});
  const midScroll = await langPanel();
  await page.waitForTimeout(LONG_CHUNKS * LONG_GAP_MS + 1200);
  const endScroll = await langPanel();

  check('（脚手架）长流式接口从头吐到尾了',
    endScroll.out.includes(`第${LONG_CHUNKS}段`) && endScroll.out.length > 200,
    `${endScroll.out.length} 字｜hits ${reqLong} → ${textHits}｜${lastPath}｜msg ${endScroll.msg}｜${endScroll.dot}`);
  check('内容确实长到该出现滚动条了',
    endScroll.scrollH > endScroll.clientH + 20,
    `视口 ${endScroll.clientH} ｜ 内容 ${endScroll.scrollH}`);
  check('流到一半时视口没被甩着往下跑', midScroll.scrollTop === 0, String(midScroll.scrollTop));
  check('流完了还停在原地（能从头安静读完）', endScroll.scrollTop === 0, String(endScroll.scrollTop));

  /* —— 结果区最大高度（设置里那条）：量**算出来的** max-height，不是变量名 —— */
  /* 自适应时 `.rt-out` 以前写死 46vh，译文一长就卡在那儿。现在这个上限可调，
     下面三条盯的是「设置 → 面板」这条链真的通了：默认还是 46 → 拨到 30 跟着走
     → 填 0 不再封顶。用不上滚动条的那条（scrollH/clientH）比只看 max-height
     更实在 —— 只改个变量而没真生效，它不会动。 */
  const outShape = () =>
    page.evaluate(() => {
      const root = document.getElementById('request-translate-host').shadowRoot;
      const out = root.querySelector('.rt-out');
      const panel = root.querySelector('.rt-panel');
      const max = getComputedStyle(out).maxHeight;
      return {
        max,
        px: parseFloat(max),
        clientH: out.clientHeight,
        scrollH: out.scrollHeight,
        vh: window.innerHeight,
        zoom: parseFloat(getComputedStyle(panel).getPropertyValue('--rt-zoom')) || 1
      };
    });

  /** 从设置页改这一条（和用户手输一样，走的是 storage + onChanged 那条路） */
  const setMaxH = (v) =>
    opt3.evaluate(async (val) => {
      const read = async () => (await chrome.storage.local.get('state')).state || null;
      for (let i = 0; i < 30; i++) {
        const st = await read();
        st.settings.panelMaxHeight = val;
        await chrome.storage.local.set({ state: st });
        const back = await read();
        if (back.settings.panelMaxHeight === val) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('panelMaxHeight 没写进去');
    }, v);

  const mhDefault = await outShape();
  check('默认封在 46% 视口高（和写死那个值一样，升级看不出变化）',
    Math.abs(mhDefault.px - 0.46 * mhDefault.vh * mhDefault.zoom) <= 2,
    `${mhDefault.max}｜视口 ${mhDefault.vh}`);

  await setMaxH(30);
  await page.waitForTimeout(400);
  const mh30 = await outShape();
  check('拨到 30，上限就封在 30% 视口高',
    Math.abs(mh30.px - 0.3 * mh30.vh * mh30.zoom) <= 2,
    `${mh30.max}｜视口 ${mh30.vh}`);
  check('正文区真的跟着矮了（不是只改了个变量没生效）',
    mh30.clientH < mhDefault.clientH - 20,
    `46vh 时 ${mhDefault.clientH}px → 30vh 时 ${mh30.clientH}px`);
  check('压到这个高度，内容还是长的（所以确实在滚动）',
    mh30.scrollH > mh30.clientH + 20, `视口 ${mh30.clientH} ｜ 内容 ${mh30.scrollH}`);

  await setMaxH(0);
  await page.waitForTimeout(400);
  const mhNone = await outShape();
  check('填 0 = 不限，max-height 变成 none', mhNone.max === 'none', mhNone.max);
  check('不限之后内容整个铺开，滚动条也没了',
    mhNone.clientH >= mhNone.scrollH - 2, `视口 ${mhNone.clientH} ｜ 内容 ${mhNone.scrollH}`);

  // 拨回默认，别让后面收到一个「不限」的面板
  await setMaxH(46);

  /* ------------------------------------------------------------------ */
  /* 15. 按钮：贴鼠标 / 键盘贴光标 / 什么时候自己消失                       */
  /* ------------------------------------------------------------------ */

  console.log('\n15. 按钮怎么贴、什么时候自己消失');

  /* 把这一页拉回前台：这一节前面已经开过好几个页签（opt / opt2 / opt3），而这一节
     全是靠「计时器到点没有」判的用例 —— 后台页上的鼠标事件会被拖慢（实测 1 秒一个），
     往返一趟就把短计时拖过去了。 */
  await page.bringToFront();
  await page.waitForTimeout(200);

  /** 从设置页改这两条（和用户手输一样，走 storage + onChanged 那条路） */
  const setTriggerSec = (idle, leave) =>
    opt3.evaluate(async ([i, l]) => {
      const read = async () => (await chrome.storage.local.get('state')).state || null;
      for (let n = 0; n < 30; n++) {
        const st = await read();
        st.settings.triggerIdleSec = i;
        st.settings.triggerLeaveSec = l;
        await chrome.storage.local.set({ state: st });
        const back = await read();
        if (back.settings.triggerIdleSec === i && back.settings.triggerLeaveSec === l) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('按钮的两个消失时间没写进去');
    }, [idle, leave]);

  const trigShape = () =>
    page.evaluate(() => {
      const root = document.getElementById('request-translate-host').shadowRoot;
      const tr = root.querySelector('.rt-trigger');
      const r = tr.getBoundingClientRect();
      const panel = root.querySelector('.rt-panel');
      return {
        show: tr.classList.contains('show'),
        display: getComputedStyle(tr).display,
        x: r.x,
        y: r.y,
        w: r.width,
        zoom: parseFloat(panel.style.getPropertyValue('--rt-zoom')) || 1
      };
    });

  const trigShown = (s) => !!(s && s.show && s.display !== 'none');

  // 面板先关掉：它和按钮都是 fixed，开着的时候会盖住按钮，下面要往按钮上放鼠标。
  // 两个时间也先关成 0，定位才好量（否则按钮会在量的半路自己消失）。
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  await setTriggerSec(0, 0);
  await page.waitForTimeout(300);

  await selectText();
  await page.waitForTimeout(1600);
  const idleOff = await trigShape();
  check('两个时间都填 0 → 按钮一直留着（不自己消失）', trigShown(idleOff),
    `show=${idleOff.show} display=${idleOff.display}`);

  /* 键盘扩展选区：鼠标扔到老远，再用 Shift+方向键动选区 —— 按钮必须贴「光标那一行」。
     要是还拿 lastMouse 当锚点，它会跑到 (900, 600) 那一带去。
     选区得是**真拖**出来的（脚本造的选区 Chrome 不让键盘动它），光标的位置下面实测。 */
  await page.mouse.click(20, 20);          // 先让这一页拿到键盘焦点
  await page.waitForTimeout(120);
  const pRect = await page.evaluate(() => {
    const r = document.getElementById('t').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  await page.mouse.move(pRect.x + 8, pRect.y + 14);
  await page.mouse.down();
  await page.mouse.move(pRect.x + 300, pRect.y + 56, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(200);

  await page.mouse.move(900, 600);         // 鼠标挪远：坐标新鲜，但和光标不是一回事了
  await page.waitForTimeout(120);
  await page.keyboard.down('Shift');
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight');
  await page.keyboard.up('Shift');
  await page.waitForTimeout(250);

  const kbSel = await page.evaluate(() => {
    const s = window.getSelection();
    const r = document.createRange();
    r.setStart(s.focusNode, s.focusOffset);
    r.collapse(true);
    const b = r.getBoundingClientRect();
    return { text: s.toString(), right: b.right, bottom: b.bottom };
  });
  check('前置条件：拖出来的选区里有字', kbSel.text.length > 3, `选了「${kbSel.text.slice(0, 18)}…」`);

  const kbTrig = await trigShape();
  check('键盘动过选区之后按钮还在', trigShown(kbTrig), `show=${kbTrig.show} display=${kbTrig.display}`);
  if (trigShown(kbTrig)) {
    near('贴的是光标那一行的右下角', kbTrig.x - kbSel.right, 6, 3, 'px');
    near('纵向也是那一行', kbTrig.y - kbSel.bottom, 6, 3, 'px');
    check('没拿那次旧的鼠标坐标当锚点',
      Math.abs(kbTrig.x - 914) > 100 && Math.abs(kbTrig.y - 614) > 100,
      `按钮 x=${fmt(kbTrig.x)} y=${fmt(kbTrig.y)}，旧鼠标在 (900, 600)`);
  }

  /* 自己消失：鼠标停着不动 → idle 到点；停在按钮上 → 不算；移开 → 短计时（移回则作废）。
     时间比默认值（5 / 0.5）放大一圈，好让「等得比计时器久」这件事有余量。 */
  const IDLE = 2.5;
  const LEAVE = 1.5;
  /* 挪鼠标一律**多步**：指针离开按钮是一**串** mousemove，一步跳过去测不出
     「第二个 mousemove 把移开短计时盖成主计时」那个 bug（kniph 就是这么发现的）。
     **每步的实际耗时在这台机器上会变**（实测过 1 秒一步：真扩展 + 真页面单独跑是 60ms，
     只在整套 e2e 里这么慢），所以凡是靠「往返比计时器快」的用例都得先自检耗时。 */
  const moveTo = (x, y) => page.mouse.move(x, y, { steps: 6 });
  /** 单步挪（一个 mousemove）。往返要抢在计时器前面时就只能用这个。 */
  const snapTo = (x, y) => page.mouse.move(x, y);
  /** 指针此刻是不是真在按钮上（量 shadow 里的命中元素）—— 当脚手架用，
      别让「鼠标压根没 hover 上」冒充成「计时器行为正确」 */
  const hoverHit = (x, y) =>
    page.evaluate(([px, py]) => {
      const root = document.getElementById('request-translate-host').shadowRoot;
      const tr = root.querySelector('.rt-trigger');
      if (!tr || !tr.classList.contains('show')) return false;
      const el = root.elementFromPoint(px, py);
      return !!(el && tr.contains(el));
    }, [x, y]);
  const midOf = (s) => ({ x: s.x + s.w / 2, y: s.y + s.w / 2 });

  await setTriggerSec(IDLE, LEAVE);
  await page.waitForTimeout(300);
  await moveTo(700, 600);
  await selectText();
  await page.waitForTimeout(400);   // 越过「刚出现那 250ms 不算 hover」的窗口

  const beforeHover = await trigShape();
  check('（脚手架）按钮已经在等着被 hover 了', trigShown(beforeHover),
    `show=${beforeHover.show} display=${beforeHover.display}`);
  const mid0 = midOf(beforeHover);
  await moveTo(mid0.x, mid0.y);
  check('（脚手架）指针确实停在按钮上', await hoverHit(mid0.x, mid0.y));
  await page.waitForTimeout((IDLE + 0.5) * 1000);
  const onHover = await trigShape();
  check(`鼠标停在按钮上 → 一直不消失（早就过了 ${IDLE}s）`, trigShown(onHover),
    `show=${onHover.show} display=${onHover.display}`);

  // 移开 → 短计时到点消失（不是主计时：主计时比它长）
  await moveTo(700, 600);
  await page.waitForTimeout((LEAVE + 0.6) * 1000);
  const left = await trigShape();
  check(`鼠标移开 → 按「移开后消失」那个时间走（${LEAVE}s，不是 ${IDLE}s）`, !trigShown(left),
    `show=${left.show} display=${left.display}`);

  /* 「移回则作废」：这条要**来回挪两次**，而每次挪的耗时取决于环境（这套 e2e 里实测过
     1 秒一个鼠标事件 —— 单独复现同样的页面只要 60ms，纯属环境问题）。所以这里
     ① 往返都用**单步**移动（一个 mousemove），把往返压到最短；
     ② 短计时给到 3s；③ **实测往返耗时**，一旦超过短计时就把这条判挂 ——
     宁可报「脚手架太慢」，也不让「按钮到点没了」冒充成「作废生效」。 */
  const LEAVE2 = 3;
  await setTriggerSec(6, LEAVE2);
  await page.waitForTimeout(300);
  await snapTo(700, 600);
  await selectText();
  await page.waitForTimeout(400);
  const again = await trigShape();
  check('（脚手架）移回那段：按钮又出现了', trigShown(again),
    `show=${again.show} display=${again.display}`);
  const mid = midOf(again);
  await snapTo(mid.x, mid.y);
  check('（脚手架）先 hover 上', await hoverHit(mid.x, mid.y));

  const tAway = Date.now();
  await snapTo(700, 600);          // 单步离开 → 起 3s 短计时
  await snapTo(mid.x, mid.y);      // 远没到点就单步移回来 → 短计时该作废
  const roundTrip = Date.now() - tAway;
  check('（脚手架）往返比短计时快（慢了这条就测不出东西）',
    roundTrip < LEAVE2 * 1000, `往返 ${roundTrip}ms ＜ ${LEAVE2 * 1000}ms`);
  check('（脚手架）移回来后指针又回到按钮上', await hoverHit(mid.x, mid.y));
  await page.waitForTimeout((LEAVE2 + 0.5) * 1000);  // 停在按钮上，比短计时还久
  const backAgain = await trigShape();
  check('移开后又马上移回按钮上 → 短计时作废，按钮还在', trigShown(backAgain),
    `show=${backAgain.show} display=${backAgain.display}`);

  // 一直没碰过按钮、鼠标也不动 → 主计时到点消失（换回短时间，重新划一次让两个计时归位）
  await setTriggerSec(IDLE, LEAVE);
  await page.waitForTimeout(300);
  await moveTo(700, 600);
  await selectText();
  await page.waitForTimeout((IDLE + 0.6) * 1000);
  const idleGone = await trigShape();
  check(`鼠标停着不动、过了 ${IDLE} 秒 → 自己消失`, !trigShown(idleGone),
    `show=${idleGone.show} display=${idleGone.display}`);

  // 恢复默认，别把改过的设置留给后面
  await setTriggerSec(5, 0.5);

  /* ------------------------------------------------------------------ */
  /* 16. 一个 model 变量填多行 → 第一个挂了自动试第二个                     */
  /* ------------------------------------------------------------------ */

  console.log('\n16. 变量填多行：model 第一个挂了自动换第二个');

  /* 这条配置的请求体里带 {{model}}，打到 /modelfail：
     model = bad-model 的回 500（第一次必挂），别的回译文。
     变量表里给 model 填**两行**：第一行 bad-model（挂），第二行 good-model（通）。 */
  await opt3.evaluate(async (u) => {
    const read = async () => (await chrome.storage.local.get('state')).state || null;
    for (let i = 0; i < 30; i++) {
      const st = await read();
      st.configs = [{
        id: 'e2e-model',
        name: '假多模型接口',
        note: '',
        adapter: '',
        request: `curl -X POST ${u} -H 'Content-Type: application/json' -d '{"model":"{{model}}","messages":[{"role":"user","content":"{{text}}"}]}'`,
        path: '',
        responseMode: 'json'
      }];
      // 变量：model 填两行 —— 就是「换 model 重试」的全部开关
      st.vars = [{ name: 'model', value: 'bad-model\ngood-model' }];
      st.activeConfigId = 'e2e-model';
      st.settings.targetLang = '简体中文';
      st.settings.fontSize = 20;
      st.settings.panelWidth = 460;
      await chrome.storage.local.set({ state: st });
      const back = await read();
      if (back.configs.length === 1 && back.configs[0].id === 'e2e-model') return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('假多模型接口没写进去');
  }, `http://127.0.0.1:${port}/modelfail`);
  await page.waitForTimeout(700);

  // 关掉可能还开着的面板，再重新划词触发一次
  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  await page.waitForTimeout(200);

  modelTries = [];
  await selectRange(2);
  await page.waitForTimeout(250);
  await page.click('.rt-trigger', { force: true });
  await settle();
  await page.waitForTimeout(400);

  const modelPanel = await page.evaluate(() => {
    const root = document.getElementById('request-translate-host').shadowRoot;
    return {
      out: root.querySelector('.rt-out').textContent,
      msg: root.querySelector('.rt-msg').textContent
    };
  });

  check('第一个 model 挂了，自动换了第二个 → 拿到第二个的译文',
    modelPanel.out.includes('重试后的译文【good-model】'),
    `${modelPanel.msg}｜${modelPanel.out}`);

  check('确实先发了 bad-model 再发 good-model（不是一开始就用第二个）',
    modelTries.length >= 2 && modelTries[0] === 'bad-model' && modelTries[1] === 'good-model',
    JSON.stringify(modelTries));

  check('第一个挂了以后不继续没完没了地试（第二行通了就停）',
    modelTries.filter((m) => m === 'good-model').length === 1,
    JSON.stringify(modelTries));

  /* 单行变量 = 普通单值，不该有任何「重试」的多余请求（退化情形） */
  await opt3.evaluate(async () => {
    const read = async () => (await chrome.storage.local.get('state')).state || null;
    for (let i = 0; i < 30; i++) {
      const st = await read();
      st.vars = [{ name: 'model', value: 'good-model' }];
      await chrome.storage.local.set({ state: st });
      const back = await read();
      if (back.vars.length === 1 && back.vars[0].value === 'good-model') return;
      await new Promise((r) => setTimeout(r, 100));
    }
  });
  await page.waitForTimeout(400);

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  await page.waitForTimeout(200);
  modelTries = [];
  await selectRange(2);
  await page.waitForTimeout(250);
  await page.click('.rt-trigger', { force: true });
  await settle();
  await page.waitForTimeout(300);

  check('单行 model（普通单值）只发一次请求，没有多余重试',
    modelTries.length === 1 && modelTries[0] === 'good-model',
    JSON.stringify(modelTries));

  /* ---- 变量叫 GEMINI_MODEL（kniph 的真实形态）：判据是「**名字含 model**、不看大小写」----
     以前只认死名字 `model`，于是 `{{GEMINI_MODEL}}` 这份配置整段多行值被原样塞进地址、
     请求根本发不出去，用户只会觉得「模型轮换坏了」。这里连**地址路径里的占位符**一起验。 */
  await opt3.evaluate(async (u) => {
    const read = async () => (await chrome.storage.local.get('state')).state || null;
    for (let i = 0; i < 30; i++) {
      const st = await read();
      st.configs = [{
        id: 'e2e-model',
        name: '假多模型接口',
        note: '',
        adapter: '',
        // 模型名写在**地址路径**里（Gemini 那种），key 也在地址里 —— 两处都走变量
        request:
          `curl -X POST "${u}?alt=sse&key={{GEMINI_API_KEY}}" ` +
          `-H 'Content-Type: application/json' ` +
          `-d '{"model":"{{GEMINI_MODEL}}","messages":[{"role":"user","content":"{{text}}"}]}'`,
        path: '',
        responseMode: 'json'
      }];
      st.vars = [
        { name: 'GEMINI_MODEL', value: 'bad-model\ngood-model' },
        { name: 'GEMINI_API_KEY', value: 'sk-e2e-gemini-key' }
      ];
      st.activeConfigId = 'e2e-model';
      await chrome.storage.local.set({ state: st });
      const back = await read();
      if (back.vars.length === 2 && back.vars[0].name === 'GEMINI_MODEL') return;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('GEMINI_MODEL 那份配置没写进去');
  }, `http://127.0.0.1:${port}/modelfail`);
  await page.waitForTimeout(500);

  await page.evaluate(() =>
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  await page.waitForTimeout(200);

  modelTries = [];
  modelFailUrls = [];
  await selectRange(2);
  await page.waitForTimeout(250);
  await page.click('.rt-trigger', { force: true });
  await settle();
  await page.waitForTimeout(400);

  const geminiPanel = await page.evaluate(() => {
    const root = document.getElementById('request-translate-host').shadowRoot;
    return root.querySelector('.rt-out').textContent;
  });

  check('变量叫 GEMINI_MODEL 也一样轮换（判据是「名字含 model」，不是死名字）',
    geminiPanel.includes('重试后的译文【good-model】'), geminiPanel.slice(0, 80));
  check('覆盖的是 GEMINI_MODEL 这个键（写死覆盖 vars.model 的话这儿一动不动）',
    JSON.stringify(modelTries) === JSON.stringify(['bad-model', 'good-model']),
    JSON.stringify(modelTries));
  check('地址里的 {{GEMINI_MODEL}} 每轮换成了对应的那个（不是四行串一串）',
    modelFailUrls.length >= 2 &&
      !modelFailUrls.some((u) => u.includes('\n')) &&
      modelFailUrls[0].includes('/modelfail?alt=sse&key=sk-e2e-gemini-key'),
    JSON.stringify(modelFailUrls));
  check('打码只影响展示：真发出去的地址里 key 还是真的（没有「（已隐藏）」）',
    modelFailUrls.every((u) => !u.includes('已隐藏')), JSON.stringify(modelFailUrls));

  /* ---- 设置页那个「测试」也得逐个试 model（kniph 报的）----
     原来只发第一个 model：他第一个模型恰好是坏的 → 面板上好好的，点测试永远一片红，
     得出的结论是「这条配置坏了」。 */
  await opt3.reload();
  await opt3.waitForTimeout(900);
  await opt3.evaluate(() => document.querySelector('.tab[data-tab="configs"]')?.click());
  await opt3.waitForTimeout(250);

  const cfgPreviewNote = await opt3.evaluate(() => document.querySelector('#f-preview').textContent);
  check('配置预览的备注里交代了「只摊第一个、真跑会逐个试」（不然以为扩展不认后面几行）',
    /model 轮换：GEMINI_MODEL 填了 2 个候选/.test(cfgPreviewNote), cfgPreviewNote.slice(-140));

  await opt3.click('#btn-test');
  await opt3
    .waitForFunction(
      () => /HTTP \d/.test(document.querySelector('#test-result')?.textContent || ''),
      null,
      { timeout: 30000 }
    )
    .catch(() => {});
  const cfgModelTest = await opt3.evaluate(() => {
    const el = document.querySelector('#test-result');
    return { text: el.textContent, html: el.innerHTML };
  });

  check('设置页「测试」也逐个试 model（不再只发第一个）',
    cfgModelTest.text.includes('重试后的译文【good-model】') &&
      cfgModelTest.text.includes('第 2 个 model 拿到译文'),
    cfgModelTest.text.slice(0, 120));
  check('两次尝试都摊出来了，各自带着自己的 model 名（分得清哪块是哪个）',
    cfgModelTest.html.includes('bad-model') && cfgModelTest.html.includes('good-model') &&
      cfgModelTest.text.includes('HTTP 500'),
    cfgModelTest.html.length + ' 字节');
  check('头部明说「最多发几次」（不写「按顺序试 N 条」那种会读成「都会发」的话）',
    cfgModelTest.text.includes('链上共 1 条请求') && cfgModelTest.text.includes('model 逐个试，最多发 2 次'),
    cfgModelTest.text.slice(0, 60));

  /* ---- 报错的那几块默认折起来（kniph 报的：测试完直接冒出来好几屏）---- */
  const cfgFold = await opt3.evaluate(() => {
    const box = document.querySelector('#test-result');
    const items = [...box.querySelectorAll('.test-item')];
    return {
      total: items.length,
      folded: items.filter((el) => el.querySelector('details.test-fold')).length,
      openFolded: box.querySelectorAll('details.test-fold[open]').length,
      // 摊开的那块 = .result-body 直接挂在 .test-item 下（折起来的那个在 details 里）
      expanded: items.filter((el) => el.querySelector(':scope > .result-body')).length,
      why: [...box.querySelectorAll('.test-fold > summary .why')].map((el) => el.textContent)
    };
  });
  check('报错那块默认折起来（不再一屏一屏地摊报错正文 / 请求体 / 原始响应）',
    cfgFold.total === 2 && cfgFold.folded === 1 && cfgFold.openFolded === 0,
    JSON.stringify({ total: cfgFold.total, folded: cfgFold.folded, open: cfgFold.openFolded }));
  check('拿到译文的那块保持摊开（要看的译文直接可见）',
    cfgFold.expanded === 1, String(cfgFold.expanded));
  check('折起来的块头一行就说清「为什么挂」（从错误 JSON 里取的 message，不是一串 { "error": {）',
    cfgFold.why.length === 1 && cfgFold.why[0] === 'model not available',
    JSON.stringify(cfgFold.why));

  // 点块头能摊开 —— ▸ 得真的可点，不然折起来就等于看不见
  await opt3.locator('#test-result details.test-fold > summary').first().click();
  await opt3.waitForTimeout(200);
  const foldedOpened = await opt3.evaluate(() => {
    const d = document.querySelector('#test-result details.test-fold');
    return { open: d.open, text: d.textContent };
  });
  check('点块头能摊开（错误 / 实际请求 / 原始响应都还在里面）',
    foldedOpened.open && foldedOpened.text.includes('错误') &&
      foldedOpened.text.includes('实际请求') && foldedOpened.text.includes('原始响应'),
    `open=${foldedOpened.open}`);

  await opt3.close();

  /* ------------------------------------------------------------------ */

  console.log('\n' + '='.repeat(46));
  console.log(`UI 回归：${pass} 项通过，${fail} 项失败`);
  console.log('='.repeat(46) + '\n');
} catch (err) {
  fail += 1;
  console.log(`\n  FAIL 执行出错：${err && err.message ? err.message : String(err)}`);
} finally {
  try {
    await ctx?.close();
  } catch {
    /* 忽略 */
  }
  server.close();
  try {
    fs.rmSync(profile, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}

process.exit(fail ? 1 : 0);
