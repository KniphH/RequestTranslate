/**
 * 性能探针
 * ------------------------------------------------------------------
 * 用系统 Edge 真加载扩展，量四个场景的真实开销：
 *   1. 空闲      —— 页面静止，看有没有常驻消耗
 *   2. 滚动      —— 触发 scroll → hideTrigger 这条无条件写 DOM 的路径
 *   3. 连续划词  —— 触发 mouseup → readSelection（含 getClientRects 强制布局）
 *   4. 流式翻译  —— 触发 delta → 全量 textContent 重写 + scrollHeight 强制布局
 *
 * 两个视角同时看：
 *   - 主线程指标（CDP Performance.getMetrics）：脚本 / 布局 / 样式重算各占多少
 *   - 进程 CPU 时间（PowerShell 采样 msedge 全部进程）：整机视角的真实消耗
 *
 * 用法：node tools/perf-probe.mjs [--keep]
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

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable'
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
  for (const p of [
    'playwright-core',
    path.join(
      process.env.USERPROFILE || process.env.HOME || '',
      '.workbuddy/binaries/node/workspace/node_modules/playwright-core'
    )
  ]) {
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
  console.log('没找到 Edge，跳过性能测试。');
  process.exit(0);
}
if (!chromium) {
  console.log('没找到 playwright-core，跳过性能测试。');
  process.exit(0);
}

const fmt = (v, d = 1) => (typeof v === 'number' && isFinite(v) ? v.toFixed(d) : String(v));
const pad = (s, n) => String(s).padEnd(n, ' ');

// 只跑指定档位，用于快速做 A/B 对照（例：PERF_ONLY=heavy node tools/perf-probe.mjs）
const ONLY = process.env.PERF_ONLY || '';

/* ------------------------------------------------------------------ */
/* 进程 CPU 采样（Windows）                                            */
/* ------------------------------------------------------------------ */

const isWin = process.platform === 'win32';

/**
 * 只统计本次测试启动的 Edge 进程。
 * 机器上通常还开着用户自己的 Edge（几十个进程），直接求和会把浏览活动算进来。
 * 用 --user-data-dir 里的临时目录名做过滤，这是唯一能区分两批进程的稳定标志。
 */
let profileTag = '';

function edgeCpuSample() {
  if (!isWin) return null;
  if (!profileTag) return null;
  try {
    // 注意：PowerShell 5.1 不允许管道符出现在行首，整条语句必须写在一行
    const ps =
      `$p = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" -ErrorAction SilentlyContinue | ` +
      `Where-Object { $_.CommandLine -like '*${profileTag}*' }; ` +
      `$sum = 0; foreach ($x in $p) { $sum += ($x.KernelModeTime + $x.UserModeTime) }; ` +
      `Write-Output "$($p.Count)|$sum"`;
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', ps],
      { encoding: 'utf8', timeout: 25000 }
    ).trim();
    const [n, raw] = out.split('|');
    // KernelModeTime / UserModeTime 单位是 100 纳秒
    return { count: parseInt(n, 10) || 0, seconds: (parseFloat(raw) || 0) / 1e7 };
  } catch {
    return null;
  }
}

const cpuCores = os.cpus().length;

/* ------------------------------------------------------------------ */
/* 假 API：按需吐 SSE 分片                                             */
/* ------------------------------------------------------------------ */

// 四档对照，用来区分「文本长度」和「分片次数」各自贡献多少布局开销
const LOADS = [
  { key: 'normal', chars: 800, chunks: 100, label: 'A 常规：800 字 / 100 分片' },
  { key: 'fewLong', chars: 8000, chunks: 20, label: 'B 长文本少分片：8000 字 / 20 分片' },
  { key: 'manyShort', chars: 1000, chunks: 500, label: 'C 短文本多分片：1000 字 / 500 分片' },
  { key: 'heavy', chars: 8000, chunks: 500, label: 'D 极端：8000 字 / 500 分片' }
];

let currentLoad = LOADS[0];

// 生成一段像样的中文译文，按字数裁
const FILLER =
  '这句话用来模拟真实的译文长度，内容本身没有意义，只是让浏览器有足够的文本要排版和绘制。';
function makeText(chars) {
  let s = '';
  while (s.length < chars) s += FILLER;
  return s.slice(0, chars);
}

const PAGE = `<!doctype html>
<html lang="zh"><head><meta charset="utf-8"><title>rt-perf</title>
<style>
  body { margin: 0; padding: 40px; font: 16px/28px "Microsoft YaHei", sans-serif; background: #fff; color: #000; }
  #t { width: 700px; }
  .filler { margin-top: 14px; color: #666; }
</style></head>
<body>
<p id="t">第一行文字稍微长一点，长到能把整段选区的右边界推到很远的地方<br>第二行是中等长度的文字，用来撑出多行选区<br>短短一行</p>
${'<p class="filler">用来撑出滚动条的段落，重复很多次。</p>'.repeat(60)}
</body></html>`;

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/chat/completions')) {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { chars, chunks } = currentLoad;
      const full = makeText(chars);
      const step = Math.ceil(full.length / chunks);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive'
      });

      let i = 0;
      let sent = 0;
      const tick = () => {
        if (sent >= full.length) {
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        const piece = full.slice(sent, sent + step);
        sent += step;
        i += 1;
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`
        );
        // 模拟真实网络的到达节奏：每片之间 ~15ms
        setTimeout(tick, 15);
      };
      tick();
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGE);
});

const port = await new Promise((resolve) => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

/* ------------------------------------------------------------------ */
/* 启动                                                               */
/* ------------------------------------------------------------------ */

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-perf-'));
profileTag = path.basename(profile);
console.log(`Edge: ${edge}`);
console.log(`逻辑核心数: ${cpuCores}`);
console.log(`本次 profile 标记: ${profileTag}（只统计命令行含它的 msedge 进程）\n`);

const rows = [];

async function scenario(cdp, name, wallTarget, fn) {
  await cdp.send('Performance.enable');
  const c0 = await cdp.send('Performance.getMetrics');
  const m0 = Object.fromEntries(c0.metrics.map((m) => [m.name, m.value]));
  const p0 = edgeCpuSample();
  const t0 = Date.now();

  await fn();

  const t1 = Date.now();
  const p1 = edgeCpuSample();
  const c1 = await cdp.send('Performance.getMetrics');
  const m1 = Object.fromEntries(c1.metrics.map((m) => [m.name, m.value]));

  const wall = (t1 - t0) / 1000;
  const d = (k) => (m1[k] || 0) - (m0[k] || 0);

  const task = d('TaskDuration');
  const script = d('ScriptDuration');
  const layout = d('LayoutDuration');
  const style = d('RecalcStyleDuration');

  let procCpu = null;
  let procPct = null;
  let nproc = 0;
  if (p0 && p1) {
    nproc = p1.count;
    procCpu = p1.seconds - p0.seconds;
    // 归一化到「占满一个核心的百分比」
    procPct = (procCpu / wall) * 100;
  }

  rows.push({
    name,
    wall,
    task,
    script,
    layout,
    style,
    busyPct: (task / wall) * 100,
    procPpu: procPct,
    procCpu,
    nproc
  });

  console.log(`${name}`);
  console.log(
    `  墙钟 ${fmt(wall, 2)}s ｜ 主线程任务 ${fmt(task * 1000, 0)}ms（占 ${fmt(
      (task / wall) * 100,
      1
    )}%）`
  );
  console.log(
    `  其中 脚本 ${fmt(script * 1000, 0)}ms ｜ 布局 ${fmt(layout * 1000, 0)}ms ｜ 样式重算 ${fmt(
      style * 1000,
      0
    )}ms`
  );
  if (procCpu !== null) {
    console.log(
      `  Edge 全进程 CPU ${fmt(procCpu, 2)}s = 占单核 ${fmt(procPct, 1)}%（${fmt(
        procPct / cpuCores,
        2
      )}% 整机）｜ 采样到 ${nproc} 个进程`
    );
  }
  console.log();
}

let ctx;
try {
  ctx = await chromium.launchPersistentContext(profile, {
    executablePath: edge,
    headless: true,
    viewport: null,
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--window-size=1200,900',
      '--no-first-run',
      '--no-default-browser-check'
    ]
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) {
    try {
      sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
    } catch {
      sw = null;
    }
  }
  if (!sw) throw new Error('扩展没加载');

  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForTimeout(800);

  const cdp = await ctx.newCDPSession(page);

  /* ---- 装一套指向假 API 的配置 ---- */
  await sw.evaluate(
    async ({ base }) => {
      const st = await chrome.storage.local.get('state');
      const s = st.state || {};
      const cfg = {
        id: 'perf-mock',
        name: 'Perf Mock',
        note: '',
        request: `curl ${base}/v1/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"m","messages":[{"role":"user","content":"{{text}}"}],"stream":true}'`,
        path: '',
        responseMode: 'auto'
      };
      s.configs = [cfg, ...(s.configs || []).filter((c) => c.id !== 'perf-mock')];
      s.activeConfigId = 'perf-mock';
      s.settings = { ...(s.settings || {}), trigger: 'button', showOriginal: true, panelWidth: 460 };
      await chrome.storage.local.set({ state: s });
    },
    { base: `http://127.0.0.1:${port}` }
  );

  // 让页面重新取一次状态
  await page.reload({ waitUntil: 'load' });
  await page.waitForTimeout(900);

  /* ---- 划线工具 ---- */
  const select = (variant = 0) =>
    page.evaluate((v) => {
      const p = document.getElementById('t');
      const [t0, , , , t2] = p.childNodes;
      const range = document.createRange();
      if (v === 0) {
        range.setStart(t0, 2);
        range.setEnd(t2, t2.textContent.length);
      } else {
        range.setStart(t0, 0);
        range.setEnd(t0, t0.textContent.length);
      }
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(range);
      const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
      const tail = rects[rects.length - 1];
      document.dispatchEvent(
        new MouseEvent('mouseup', {
          bubbles: true,
          composed: true,
          clientX: tail.right - 2,
          clientY: tail.top + tail.height / 2
        })
      );
      return true;
    }, variant);

  const shadowState = () =>
    page.evaluate(() => {
      const host = document.getElementById('request-translate-host');
      const r = host && host.shadowRoot;
      const q = (s) => (r ? r.querySelector(s) : null);
      const out = q('.rt-out');
      const src = q('.rt-src');
      const show = (el) => !!el && !el.classList.contains('hidden') && el.offsetParent !== null;
      return {
        hasHost: !!host,
        head: show(src),
        srcChars: src ? src.textContent.length : 0,
        outChars: out ? out.textContent.length : 0,
        outVisible: !!out && out.offsetHeight > 0
      };
    });

  console.log('='.repeat(58));
  console.log('场景实测');
  console.log('='.repeat(58) + '\n');

  if (!ONLY) {
    /* ---- 1. 空闲 ---- */
    await scenario(cdp, '1. 空闲（页面静止，无选区、无面板）', 5000, async () => {
      await page.waitForTimeout(5000);
    });

    /* ---- 2. 滚动 ---- */
    await scenario(cdp, '2. 连续滚动 3 秒（scroll → hideTrigger）', 3000, async () => {
      const end = Date.now() + 3000;
      while (Date.now() < end) {
        await page.mouse.wheel(0, 120);
        await page.waitForTimeout(16);
      }
    });

    /* ---- 3. 连续划词 ---- */
    await scenario(cdp, '3. 连续划词 40 次（mouseup → readSelection）', 4000, async () => {
      for (let i = 0; i < 40; i += 1) {
        await select(i % 2);
        await page.waitForTimeout(60);
      }
      await page.keyboard.press('Escape');
    });
  }

  /* ---- 4~7. 流式渲染：四档对照 ---- */

  /* ---- 直接数「渲染了几次」，别靠猜 ---- */
  const startCountRender = () =>
    page.evaluate(() => {
      const host = document.getElementById('request-translate-host');
      const out = host && host.shadowRoot && host.shadowRoot.querySelector('.rt-out');
      if (!out) return false;
      document.documentElement.dataset.rtApplyN = '0';
      if (window.__rtMo) window.__rtMo.disconnect();
      window.__rt = { n: 0, gaps: [], last: 0 };
      window.__rtMo = new MutationObserver(() => {
        const t = performance.now();
        if (window.__rt.last) window.__rt.gaps.push(t - window.__rt.last);
        window.__rt.last = t;
        window.__rt.n += 1;
      });
      window.__rtMo.observe(out, { childList: true, characterData: true, subtree: true });
      return true;
    });

  const readRenderStats = () =>
    page.evaluate(() => {
      if (window.__rtMo) window.__rtMo.disconnect();
      const r = window.__rt || { n: 0, gaps: [] };
      const g = r.gaps.slice().sort((a, b) => a - b);
      return {
        renders: r.n,
        avgGap: g.length ? g.reduce((a, b) => a + b, 0) / g.length : 0,
        medianGap: g.length ? g[Math.floor(g.length / 2)] : 0,
        applyN: Number(document.documentElement.dataset.rtApplyN || 0)
      };
    });

  /** 走一次完整链路：划词 → 点小圆点 → 等流式渲染结束 */
  const streamOnce = async () => {
    await startCountRender();
    await select(0);
    await page.waitForTimeout(120);

    const box = await page.evaluate(() => {
      const host = document.getElementById('request-translate-host');
      const t = host && host.shadowRoot.querySelector('.rt-trigger');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, show: t.classList.contains('show') };
    });
    if (!box || !box.show) throw new Error('小圆点没出来');
    await page.mouse.click(box.x, box.y);

    // 等输出字数不再增长
    let last = -1;
    let stable = 0;
    for (let i = 0; i < 120; i += 1) {
      await page.waitForTimeout(200);
      const st = await shadowState();
      if (st.outChars === last && st.outChars > 0) {
        stable += 1;
        if (stable >= 3) break;
      } else {
        stable = 0;
      }
      last = st.outChars;
    }
    return { ...(await shadowState()), ...(await readRenderStats()) };
  };

  const streamRows = [];
  for (let i = 0; i < LOADS.length; i += 1) {
    const load = LOADS[i];
    if (ONLY && load.key !== ONLY) continue;
    currentLoad = load;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    let st = null;
    await scenario(cdp, `${4 + i}. 流式翻译 ${load.label}`, 0, async () => {
      st = await streamOnce();
    });
    streamRows.push({ load, st, row: rows[rows.length - 1] });
    console.log(
      `  渲染结果：面板 ${st.outChars} 字 ｜ applyDelta ${st.applyN} 次 ｜ observer 记到 ${st.renders} 次 ` +
        `｜ 分片中位间隔 ${fmt(st.medianGap, 0)}ms\n`
    );
  }

  /* ---- 汇总 ---- */
  console.log('='.repeat(58));
  console.log('汇总');
  console.log('='.repeat(58));
  console.log(
    pad('场景', 34) + pad('主线程', 10) + pad('占空比', 10) + 'Edge 本批进程（单核）'
  );
  for (const r of rows) {
    console.log(
      pad(r.name.replace(/^\d+\.\s*/, '').slice(0, 33), 34) +
        pad(`${fmt(r.task * 1000, 0)}ms`, 10) +
        pad(`${fmt(r.busyPct, 1)}%`, 10) +
        (r.procPpu === null ? '—' : `${fmt(r.procPpu, 1)}%`)
    );
  }
  console.log();

  /* ---- 布局归因：文本长度 vs 分片次数 ---- */
  console.log('流式渲染：布局开销归因（同一份代码，只改负载形状）');
  console.log('='.repeat(58));
  console.log(
    pad('负载', 26) + pad('分片数', 9) + pad('applyDelta', 11) + pad('observer', 10) + pad('总布局', 10) + '每次渲染'
  );
  for (const s of streamRows) {
    const layoutMs = s.row.layout * 1000;
    const renders = s.st.applyN || s.load.chunks;
    console.log(
      pad(s.load.label.split('：')[0], 26) +
        pad(s.load.chunks, 9) +
        pad(s.st.applyN, 11) +
        pad(s.st.renders, 10) +
        pad(`${fmt(layoutMs, 0)}ms`, 10) +
        `${fmt(layoutMs / renders, 3)}ms`
    );
  }
  console.log();
} catch (err) {
  console.error('性能测试出错：', err && err.message ? err.message : err);
  if (err && err.stack) console.error(err.stack.split('\n').slice(0, 4).join('\n'));
} finally {
  if (ctx) await ctx.close().catch(() => {});
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
