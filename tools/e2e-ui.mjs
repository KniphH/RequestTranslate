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

/** 假 OCR 接口收到的最后一个请求体，用来断言图片真的以 data URL 发过去了 */
let lastOcrRequest = '';
/** 假 OCR 接口被打了几次。用来反证「剪切板里没图时压根不会发请求」 */
let ocrHits = 0;
/** 假翻译接口收到的最后一个请求体。直传模式下 {{image}} 有没有塞进请求，只看这里 */
let lastTextRequest = '';
/** 假翻译接口被打了几次 */
let textHits = 0;
/** 假接口收到的最后一个请求路径 —— 断言挂了的时候用来判断「请求到底打到哪条路由」 */
let lastPath = '';

/** 慢速**流式**接口：先建连、再一段一段吐，用来量「请求在飞的时候用户切走了」。
    分段数和间隔要够大，大到用户切完之后它还在吐 —— 不然那种「半路的流糊到
    别人脸上」的问题根本采不到。 */
const STREAM_CHUNKS = 3;
const STREAM_GAP_MS = 400;

const server = http.createServer(async (req, res) => {
  lastPath = req.url || '';
  if (req.url && req.url.startsWith('/slow')) {
    await new Promise((r) => setTimeout(r, SLOW_MS));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('慢速响应');
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
      // 默认回「本地假译文」；带 ?tag=xxx 时缀一个标记 ——
      // 「换配置不重发」那一节靠它认「切回来看到的是这个配置自己的译文」，
      // 而不是上一个配置留在界面上的东西。
      const tag = new URL(req.url, 'http://x').searchParams.get('tag');
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('本地假译文' + (tag ? '【' + tag + '】' : ''));
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
      document.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          composed: true,
          clientX: tail.right - 2,
          clientY: tail.top + tail.height / 2
        })
      );
      return {
        segCount: segs.length,
        tailRight: tail.right,
        tailBottom: tail.bottom,
        wholeRight: whole.right
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
    const dx = m1.trigger.x - sel.tailRight;
    between('小圆点贴着最后一个字（右下方一点）', dx, 2, 14, 'px');
    const farFromWhole = sel.wholeRight - sel.tailRight;
    check(
      '没被整段选区的右边界带跑',
      farFromWhole > 100 && m1.trigger.x < sel.wholeRight - 100,
      `整段右边界 ${fmt(sel.wholeRight)}，末尾 ${fmt(sel.tailRight)}，圆点 x=${fmt(m1.trigger.x)}`
    );
  }

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
    const dxPhys = (m3b.trigger.x - sel3.tailRight) * 1.5;
    between('缩放后仍然贴着最后一个字', dxPhys, 2, 14, 'px');
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
  between('缩回 100% 后仍然贴着最后一个字', m4.trigger.x - sel4.tailRight, 2, 14, 'px');

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
  /* 5. 设置页：新加的「临时直连」开关                                   */
  /* ------------------------------------------------------------------ */
  /* 静态检查只能证明 id 对得上，开关到底渲没渲染出来、能不能存下去，
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

  // 「设置」是第二个 tab，不点开的话里面的元素量不到尺寸
  await opt.evaluate(() => {
    document.querySelector('.tab[data-tab="settings"]')?.click();
  });
  await opt.waitForTimeout(150);

  const netSwitch = await opt.evaluate(() => {
    const el = document.getElementById('s-direct');
    const box = el ? el.getBoundingClientRect() : null;
    const hint = el ? el.closest('.stack')?.querySelector('.hint') : null;
    return {
      exists: !!el,
      visible: !!box && box.height > 0,
      checked: el ? el.checked : null,
      label: el ? (el.closest('.switch')?.textContent || '').trim().slice(0, 24) : '',
      hint: hint ? (hint.textContent || '').replace(/\s+/g, ' ').trim() : ''
    };
  });
  check('网络设置里有「临时直连」开关', netSwitch.exists && netSwitch.visible, netSwitch.label);
  check('开关默认是关的', netSwitch.checked === false, `checked = ${netSwitch.checked}`);
  check('hint 里推荐了「代理客户端加直连规则」这个做法',
    netSwitch.hint.includes('DOMAIN-SUFFIX'), netSwitch.hint.slice(0, 60));
  check('旁边写了 TUN 模式的例外', netSwitch.hint.includes('TUN'), netSwitch.hint.slice(0, 40));

  // 打开它，看有没有落盘
  await opt.evaluate(() => {
    const el = document.getElementById('s-direct');
    el.checked = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await opt.waitForTimeout(1300);
  const savedOn = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    return state.settings.directAdapter;
  });
  check('打开后写进了存储', savedOn === true, `directAdapter = ${JSON.stringify(savedOn)}`);

  // 再关回去 —— 两个方向都得能存
  await opt.evaluate(() => {
    const el = document.getElementById('s-direct');
    el.checked = false;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await opt.waitForTimeout(1300);
  const savedOff = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    return state.settings.directAdapter;
  });
  check('关掉后也写进了存储', savedOff === false, `directAdapter = ${JSON.stringify(savedOff)}`);

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

  // 回到「配置」tab，切到一条「自定义请求」配置，勾上强制直连
  await opt.evaluate(() => {
    document.querySelector('.tab[data-tab="configs"]')?.click();
    const items = [...document.querySelectorAll('#cfg-list .cfg-item')];
    const target = items.find((b) => /OpenAI/.test(b.textContent)) || items[1];
    if (target) target.click();
  });
  await opt.waitForTimeout(350);

  const fieldBox = await opt.evaluate(() => {
    const el = document.getElementById('f-direct');
    if (!el) return null;
    const r = el.closest('.field').getBoundingClientRect();
    return { visible: r.height > 0, top: r.top };
  });
  check('自定义配置里能看到「强制直连」', !!fieldBox && fieldBox.visible);

  await opt.evaluate(() => {
    const el = document.getElementById('f-direct');
    el.checked = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await opt.waitForTimeout(1300);
  const savedCfg = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    return state.configs.find((c) => c.id === 'builtin-openai')?.direct;
  });
  check('勾上之后写进了那条配置', savedCfg === true, `config.direct = ${JSON.stringify(savedCfg)}`);

  check('操作完仍然没有报错', errors.length === 0, errors.join(' | '));

  /* ------------------------------------------------------------------ */
  /* 6. 翻译按钮：预设 / 大小 / 自定义 SVG                              */
  /* ------------------------------------------------------------------ */

  console.log('\n6. 翻译按钮：换预设、改大小、填一段自己的 SVG');

  await opt.evaluate(() => document.querySelector('.tab[data-tab="settings"]')?.click());
  await opt.waitForTimeout(200);

  const cards = await opt.evaluate(() =>
    [...document.querySelectorAll('#trig-styles .trig-card')].map((b) => ({
      id: b.dataset.style,
      on: b.classList.contains('on'),
      hasSvg: !!b.querySelector('svg')
    }))
  );
  check('三个样式卡都渲染出来了', cards.length === 3, cards.map((c) => c.id).join(','));
  check('默认选中「译字方块」', !!(cards[0] && cards[0].on && cards[0].id === 'badge'));
  check('地球 / 笔尖的卡上画了 SVG', cards.filter((c) => c.hasSvg).length === 2);

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

  // 切到一条「自定义请求」型的配置。默认选中的是 Bing 那条（适配器型），
  // 它的编辑器里压根没有请求模板可编辑。
  const tplSwitched = await opt.evaluate(async () => {
    const row = [...document.querySelectorAll('#cfg-list .cfg-row')]
      .find((r) => r.dataset.id === 'builtin-ollama');
    const item = row && row.querySelector('.cfg-item');
    if (item) item.click();
    await new Promise((r) => setTimeout(r, 500));
    const { state } = await chrome.storage.local.get('state');
    return {
      active: state.activeConfigId,
      hasBox: !!document.querySelector('#f-image-request'),
      imgVal: (document.querySelector('#f-image-request') || {}).value,
      requestVisible: !document.querySelector('#request-only').hidden
    };
  });
  check('切到自定义请求型配置后，图片模板的输入框在', tplSwitched.hasBox && tplSwitched.requestVisible,
    JSON.stringify(tplSwitched));
  check('图片模板默认是空的（老配置读出来就是空串）', tplSwitched.imgVal === '',
    JSON.stringify(tplSwitched.imgVal));

  // 写一段进去：它和普通模板要各存各的
  const wroteImg = await opt.evaluate(async () => {
    const box = document.querySelector('#f-image-request');
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

  // 上面那排标签应该插进「当前光标所在的框」—— 这里光标在图片模板里。
  // 挑 {{date}}：Ollama 那条内置模板里没有它，才不会把「本来就有」看成「刚插进去」。
  const chipInto = await opt.evaluate(async () => {
    const box = document.querySelector('#f-image-request');
    box.focus();
    box.selectionStart = box.selectionEnd = box.value.length;
    const before = box.value;
    const chip = [...document.querySelectorAll('#chips .chip')].find((c) => c.dataset.ins === '{{date}}');
    if (chip) chip.click();
    await new Promise((r) => setTimeout(r, 1000));
    const { state } = await chrome.storage.local.get('state');
    const cfg = state.configs.find((c) => c.id === 'builtin-ollama');
    return { grew: box.value.length - before.length, img: cfg.imageRequest, text: cfg.request };
  });
  check('那排标签会插进「当前光标所在的框」（这里是图片模板）',
    chipInto.grew > 0 && String(chipInto.img).includes('{{date}}'), JSON.stringify(chipInto));
  check('标签没跑进普通模板里', !String(chipInto.text).includes('{{date}}'), String(chipInto.text).slice(0, 40));

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
      responseMode: 'text',
      direct: false
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
  check('刷新后第一次划词就是存下来的样式', /s-globe/.test(mFresh.triggerCls), mFresh.triggerCls);
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

  /* ---- 设置页的 OCR 那一栏 ---- */
  await opt.evaluate(() => document.querySelector('.tab[data-tab="ocr"]')?.click());
  await opt.waitForTimeout(250);

  const ocrShape = await opt.evaluate(() => ({
    rows: [...document.querySelectorAll('#ocr-list .cfg-item')].map((b) => b.dataset.id),
    active: (document.querySelector('#ocr-list .cfg-item.is-active') || { dataset: {} }).dataset.id || '',
    prompts: document.querySelectorAll('#o-prompts .chip').length,
    endpoint: document.querySelector('#o-endpoint').value,
    model: document.querySelector('#o-model').value,
    hasMaxTokensField: !!document.querySelector('#o-maxtokens'),
    maxTokens: document.querySelector('#o-maxtokens').value
  }));
  check('列表里内置的那两条都在', ocrShape.rows.length >= 2, ocrShape.rows.join(','));
  check('默认选中硅基流动那条', ocrShape.active === 'builtin-siliconflow', ocrShape.active);
  check(
    '编辑器显示的就是选中那条的接口与模型',
    ocrShape.endpoint === 'https://api.siliconflow.cn/v1/chat/completions' &&
      ocrShape.model === 'deepseek-ai/DeepSeek-OCR',
    `${ocrShape.endpoint} / ${ocrShape.model}`
  );
  check('提示词给了可以点的短指令', ocrShape.prompts >= 1, String(ocrShape.prompts));
  check(
    '「最大输出长度」默认显示为空 = 不发送（写死一个数会在上下文窄的模型上 400）',
    ocrShape.hasMaxTokensField && ocrShape.maxTokens === '',
    JSON.stringify(ocrShape)
  );

  // 点另一条 → 切过去 + 落盘
  await opt.evaluate(() => {
    const b = [...document.querySelectorAll('#ocr-list .cfg-item')]
      .find((x) => x.dataset.id === 'builtin-openai-vl');
    if (b) b.click();
  });
  await opt.waitForTimeout(1300);
  const switched = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    return {
      saved: state.ocr.activeId,
      dom: (document.querySelector('#ocr-list .cfg-item.is-active') || { dataset: {} }).dataset.id || ''
    };
  });
  check(
    '点一条就切过去，而且立刻落盘',
    switched.saved === 'builtin-openai-vl' && switched.dom === 'builtin-openai-vl',
    JSON.stringify(switched)
  );

  // 把选中那条指到本地假 OCR 接口
  await opt.evaluate(async (url) => {
    const set = (sel, v) => {
      const el = document.querySelector(sel);
      el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('#o-endpoint', url);
    set('#o-model', 'e2e-ocr-model');
    set('#o-key', 'sk-e2e');
    set('#o-prompt', 'Free OCR.');
    await new Promise((r) => setTimeout(r, 1000));
  }, `http://127.0.0.1:${port}/ocr`);
  await opt.waitForTimeout(1300);

  const ocrSaved = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    const p = state.ocr.providers.find((x) => x.id === state.ocr.activeId);
    return { endpoint: p.endpoint, model: p.model, key: p.apiKey, prompt: p.prompt };
  });
  check(
    '改过的 OCR 供应商落盘了',
    ocrSaved.endpoint.includes('/ocr') && ocrSaved.model === 'e2e-ocr-model' &&
      ocrSaved.key === 'sk-e2e' && ocrSaved.prompt === 'Free OCR.',
    JSON.stringify(ocrSaved)
  );

  /* ---- 最大输出长度：填了才发，清空就不发 ---- */
  await opt.evaluate(async () => {
    const el = document.querySelector('#o-maxtokens');
    el.value = '2048';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1000));
  });
  const maxSaved = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    const p = state.ocr.providers.find((x) => x.id === state.ocr.activeId);
    return { maxTokens: p.maxTokens, field: document.querySelector('#o-maxtokens').value };
  });
  check('填了 2048 就按数字存下来（不是字符串）',
    maxSaved.maxTokens === 2048 && maxSaved.field === '2048', JSON.stringify(maxSaved));

  await opt.evaluate(async () => {
    const el = document.querySelector('#o-maxtokens');
    el.value = '';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 1000));
  });
  const maxCleared = await opt.evaluate(async () => {
    const { state } = await chrome.storage.local.get('state');
    const p = state.ocr.providers.find((x) => x.id === state.ocr.activeId);
    return p.maxTokens;
  });
  check('清空之后存的是 0（= 不发送这个字段）', maxCleared === 0, String(maxCleared));

  // 新建 / 删除
  const beforeNew = await opt.evaluate(() => document.querySelectorAll('#ocr-list .cfg-item').length);
  await opt.click('#btn-ocr-new');
  await opt.waitForTimeout(1300);
  const afterNew = await opt.evaluate(() => ({
    n: document.querySelectorAll('#ocr-list .cfg-item').length,
    active: (document.querySelector('#ocr-list .cfg-item.is-active') || { dataset: {} }).dataset.id || '',
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
    return { text: el.textContent, html: el.innerHTML };
  });
  check('设置页点「测试」真的发了一次 OCR 请求', ocrHits === hitsBeforeOcrTest + 1,
    `假接口被打 ${ocrHits - hitsBeforeOcrTest} 次`);
  check('结果显示假接口返回的识别文字', ocrTestOut.text.includes(OCR_TEXT), ocrTestOut.text.slice(0, 140));
  check('标了 HTTP 200，也带上了这张图的来源和大小',
    /HTTP 200/.test(ocrTestOut.text) && /本地图片 probe\.png · \d/.test(ocrTestOut.text),
    ocrTestOut.text.slice(0, 140));
  check('把实际请求和原始响应都摊出来了',
    ocrTestOut.html.includes('实际请求') && ocrTestOut.html.includes('原始响应'),
    ocrTestOut.html.slice(0, 140));
  check('摊出来的请求头里 key 是打码的（别让设置页截图带走 key）',
    ocrTestOut.html.includes('Bearer ***') && !ocrTestOut.html.includes('sk-e2e'),
    ocrTestOut.text.slice(0, 140));

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

  /* ---- 撞过的那个 400：提示得说出改哪儿，不能只丢一句原始报文 ---- */
  await opt.evaluate(async (url) => {
    const el = document.querySelector('#o-endpoint');
    el.value = url;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
  }, `http://127.0.0.1:${port}/ocr-reject`);
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
  check('并且直接说了改哪儿（去清空「最大输出长度」）',
    rejectOut.includes('最大输出长度'), rejectOut.slice(0, 200));

  // 把地址还原回能出结果的假接口，后面那节还要用
  await opt.evaluate(async (url) => {
    const el = document.querySelector('#o-endpoint');
    el.value = url;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
  }, `http://127.0.0.1:${port}/ocr`);

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

  // 勾上「禁用外置 OCR」时这条供应商根本不会被动用，测试按钮该禁用
  const testBtnOff = await opt.evaluate(() => {
    const el = document.querySelector('#o-disabled');
    el.checked = true;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return document.querySelector('#btn-ocr-test').disabled;
  });
  check('勾了「禁用外置 OCR」后测试按钮禁用', testBtnOff === true, String(testBtnOff));
  await opt.evaluate(async () => {
    const el = document.querySelector('#o-disabled');
    el.checked = false;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 900));
  });

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
              "-d '{\"role\":\"user\",\"content\":\"翻成{{target}}：\\n\\\"\\\"\\\"\\n{{text}}\\n\\\"\\\"\\\"\"}' " +
              u.text,
            path: '',
            responseMode: 'text',
            direct: false
          };
          const j = state.configs.findIndex((c) => c.id === 'e2e-local');
          if (j >= 0) state.configs[j] = cfg;
          else state.configs.push(cfg);
          state.activeConfigId = 'e2e-local';
          state.settings = { ...state.settings, showOriginal: true };
          const p = state.ocr.providers.find((x) => x.id === state.ocr.activeId);
          p.endpoint = u.ocr;
          p.model = 'e2e-ocr-model';
          p.apiKey = 'sk-e2e';
          p.prompt = 'Free OCR.';
          await chrome.storage.local.set({ state });

          const back = await read();
          if (back && back.activeConfigId === 'e2e-local' &&
              back.configs.some((c) => c.id === 'e2e-local')) return;
          state = back || state;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('改好的 state 一直被打回（有别的上下文在并发写 storage）');
      }, { text: `http://127.0.0.1:${port}/text`, ocr: `http://127.0.0.1:${port}/ocr` });

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
      check('提示词跟在图片后面', (parts[1] || {}).text === 'Free OCR.', JSON.stringify(parts[1]));

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
          cfg.imageRequest =
            "curl -X POST -H 'Content-Type: application/json' " +
            "-d '{\"mode\":\"image\",\"content\":[" +
            "{\"type\":\"image_url\",\"image_url\":{\"url\":\"{{image}}\"}}," +
            '{"type":"text","text":"看图"}]}\' ' + u.text;
          state.activeConfigId = 'e2e-local';
          state.ocr.disabled = true; // ← 设置页里那个「禁用外置 OCR」
          await chrome.storage.local.set({ state });

          const back = await read();
          const b = back && back.configs.find((c) => c.id === 'e2e-local');
          if (b && b.imageRequest.includes('mode') && back.ocr.disabled === true) return;
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

      /* ---- ③ 顶栏那盏状态灯：紫 = 正在翻译 / 绿 = 成功 / 红 = 失败 ---- */
      /* 「飞行中」这个瞬间不拿东西顶住就采不到，所以借用 /slow（挂 1.2 秒）。
         它顺带覆盖了「OCR 返回的不是 JSON」这条失败路径 —— 正好凑齐红绿两边。
         绿灯那两条断言在上一节的 ocrOut 里（那次是真翻成功了）。
         注意要把上一小节留下的 ocr.disabled 复位 —— 留着 true 就走「截图直传」
         了，压根不会去打 OCR 接口，这里也就采不到失败态。 */
      await csw.evaluate(async (u) => {
        const { state } = await chrome.storage.local.get('state');
        const p = state.ocr.providers.find((x) => x.id === state.ocr.activeId);
        p.endpoint = u;
        p.model = 'e2e-ocr-model';
        p.apiKey = 'sk-e2e';
        p.prompt = 'Free OCR.';
        state.ocr.disabled = false;
        await chrome.storage.local.set({ state });
      }, `http://127.0.0.1:${port}/slow`);

      const slowScaffold = await csw.evaluate(async () => {
        const { state } = await chrome.storage.local.get('state');
        const p = state.ocr.providers.find((x) => x.id === state.ocr.activeId);
        return { endpoint: p.endpoint, disabled: state.ocr.disabled };
      });
      check('（脚手架）OCR 接口指到了 /slow，而且没开着「禁用外置 OCR」',
        slowScaffold.endpoint.includes('/slow') && slowScaffold.disabled === false,
        JSON.stringify(slowScaffold));

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
  /* 11. 临时直连：真会切代理、也真会切回来                              */
  /* ------------------------------------------------------------------ */
  /* 这一段量的是「机制」，不是「效果」——
     能不能真的绕过代理，取决于系统代理是谁设的，测试机上没法复现。
     能在这里验的是最容易出事的两个点：请求期间代理确实被改了、
     请求结束后确实交还了控制权（不会把浏览器一直按在直连上）。
     注意：127.0.0.1 属于 loopback，Chromium 默认不套代理，
     所以就算设了黑洞代理请求也照样能通，这里不拿它当「绕过了」的证据。 */

  const slow = `http://127.0.0.1:${port}/slow`;

  /* 扩展页面的 CSP 是 script-src 'self'，new Function / eval 一律被拒，
     所以这个采样函数必须在每个 evaluate 里各写一份。 */
  const probeA = await opt.evaluate(
    async ({ slowUrl }) => {
      const { runRequest } = await import('./lib/engine.js');
      const snap = async () => {
        const c = await chrome.proxy.settings.get({ incognito: false });
        return {
          mode: c && c.value ? c.value.mode : null,
          control: c ? c.levelOfControl : null,
          pac: c && c.value && c.value.pacScript ? String(c.value.pacScript.data || '') : ''
        };
      };

      const before = await snap();
      const pending = runRequest({ requestText: 'curl ' + slowUrl, direct: true });
      const during = [];
      for (let i = 0; i < 6; i += 1) {
        await new Promise((r) => setTimeout(r, 110));
        during.push(await snap());
      }
      const result = await pending;
      return {
        before,
        during,
        after: await snap(),
        ok: result.ok,
        text: result.text,
        direct: result.direct,
        error: result.error
      };
    },
    { slowUrl: slow }
  );

  const grabbed = probeA.during.find((s) => s.control === 'controlled_by_this_extension');
  check('请求飞行期间代理确实被接管了', !!grabbed, JSON.stringify(probeA.during.map((s) => s.mode + '/' + s.control)));
  check(
    '没配代理时切的是「整机直连」',
    !!grabbed && grabbed.mode === 'direct',
    grabbed ? `mode = ${grabbed.mode}` : '一次都没抓到'
  );
  check('请求本身正常完成', probeA.ok && probeA.text.includes('慢速响应'), probeA.error || probeA.text);
  check('结果里标了「本次已直连」', probeA.direct === true);
  check(
    '请求结束后控制权交还了',
    probeA.after.control !== 'controlled_by_this_extension' && probeA.after.mode === probeA.before.mode,
    `${probeA.before.mode}/${probeA.before.control} → ${probeA.after.mode}/${probeA.after.control}`
  );

  const probeB = await opt.evaluate(
    async ({ slowUrl }) => {
      const { runRequest } = await import('./lib/engine.js');
      const snap = async () => {
        const c = await chrome.proxy.settings.get({ incognito: false });
        return {
          mode: c && c.value ? c.value.mode : null,
          control: c ? c.levelOfControl : null,
          pac: c && c.value && c.value.pacScript ? String(c.value.pacScript.data || '') : ''
        };
      };

      // 摆一个固定的假代理出来：地址能被读出来，所以应该走 PAC 而不是整机直连
      await chrome.proxy.settings.set({
        value: {
          mode: 'fixed_servers',
          rules: { singleProxy: { scheme: 'http', host: '127.0.0.1', port: 9 } }
        },
        scope: 'regular'
      });
      const configured = await snap();

      const pending = runRequest({ requestText: 'curl ' + slowUrl, direct: true });
      const during = [];
      for (let i = 0; i < 6; i += 1) {
        await new Promise((r) => setTimeout(r, 110));
        during.push(await snap());
      }
      const result = await pending;
      const after = await snap();

      await chrome.proxy.settings.clear({ scope: 'regular' }); // 收尾：清掉测试用的假代理
      return {
        configured,
        during,
        after,
        cleaned: await snap(),
        ok: result.ok,
        text: result.text,
        direct: result.direct,
        error: result.error
      };
    },
    { slowUrl: slow }
  );

  check('测试用假代理已生效', probeB.configured.mode === 'fixed_servers', probeB.configured.mode);

  const pacSample = probeB.during.find((s) => s.mode === 'pac_script');
  check('读得到原代理时改用 PAC（不是整机直连）', !!pacSample, probeB.during.map((s) => s.mode).join(','));
  if (pacSample) {
    check('PAC 里放行了本次请求的域名', pacSample.pac.includes('127.0.0.1'), pacSample.pac.split('\n')[0]);
    check('PAC 里其余流量仍走原代理', pacSample.pac.includes('PROXY 127.0.0.1:9'));
  }

  check('走 PAC 时请求也正常完成', probeB.ok && probeB.text.includes('慢速响应'), probeB.error || probeB.text);
  check('结果里同样标了直连', probeB.direct === true);
  check(
    '结束后没赖着不放',
    probeB.after.control !== 'controlled_by_this_extension',
    `after = ${probeB.after.mode}/${probeB.after.control}`
  );
  check('收尾后回到系统设置', probeB.cleaned.mode === 'system', probeB.cleaned.mode);

  /* ------------------------------------------------------------------ */
  /* 12. 换配置：翻过的直接放回来，没翻过的当场翻                         */
  /* ------------------------------------------------------------------ */
  /* kniph 报的：切到 A 翻完 → 切到 B → 切回 A 又发了一次请求。
     他要的是「a 翻 - 切 b（b 自己翻）- 切回 a（看到 a 刚才那条，不重发）」。
     所以：翻过的配置放回缓存里的结果，没翻过的当场发一条，
     「↻」只负责**重发同一条请求**（结果不满意时才按）。 */

  console.log('\n12. 换配置：翻过的放回缓存，没翻过的当场翻');

  await opt.evaluate(async (u) => {
    const read = async () => (await chrome.storage.local.get('state')).state || null;
    const mk = (id, name, tag) => ({
      id,
      name,
      note: '',
      adapter: '',
      request: `curl ${u}?tag=${tag}`,
      path: '',
      responseMode: 'text',
      direct: false
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
  /* 13. 网页想给滚动条上色？面板不吃这一套                              */
  /* ------------------------------------------------------------------ */

  console.log('\n13. 网页把滚动条染成浅蓝，面板里那条还得是自己的灰滑块');

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
