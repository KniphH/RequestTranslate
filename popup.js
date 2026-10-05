/**
 * popup：配置快切 + 手动翻译
 */

import { loadState, saveState, buildVars, getConfig, wantDirect } from './lib/store.js';
import { runRequest } from './lib/engine.js';

const $ = (s) => document.querySelector(s);

const sel = $('#sel');
const txt = $('#txt');
const out = $('#out');
const statusEl = $('#status');
const goBtn = $('#btn-go');

let state = null;
let controller = null;

function setStatus(text, isErr = false) {
  statusEl.textContent = text || '';
  statusEl.className = isErr ? 'err' : '';
}

function setOut(text, empty = false) {
  out.textContent = text;
  out.classList.toggle('empty', empty);
}

/* ------------------------------------------------------------------ */
/* 流式渲染：按时间节流（理由与参数见 content.js 里的同段注释）          */
/* ------------------------------------------------------------------ */

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

  out.classList.remove('empty');
  const atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
  out.textContent = text;
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
}

async function init() {
  state = await loadState();
  applyTheme();

  sel.innerHTML = '';
  for (const c of state.configs) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.name;
    sel.appendChild(o);
  }
  sel.value = state.activeConfigId;

  // 带上页面里选中的文字
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) {
      const res = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => String(window.getSelection() || '').trim()
      });
      const selected = res && res[0] && res[0].result;
      if (selected) {
        txt.value = selected.slice(0, state.settings.maxChars);
      }
    }
  } catch {
    /* 某些页面取不到选区，忽略 */
  }

  if (txt.value.trim()) txt.focus();
}

sel.addEventListener('change', async () => {
  state.activeConfigId = sel.value;
  await saveState(state);
});

goBtn.addEventListener('click', run);

txt.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    run();
  }
});

$('#btn-copy').addEventListener('click', async () => {
  const text = out.classList.contains('empty') ? '' : out.textContent;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus('已复制');
  setTimeout(() => setStatus(''), 1500);
});

$('#btn-clear').addEventListener('click', () => {
  if (controller) controller.abort();
  txt.value = '';
  setOut('等待输入…', true);
  setStatus('');
  txt.focus();
});

$('#btn-open').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#link-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

async function run() {
  const text = txt.value.trim();
  if (!text) {
    setStatus('先输入点内容', true);
    return;
  }

  const cfg = getConfig(state, sel.value);
  if (!cfg) {
    setStatus('没有可用配置', true);
    return;
  }

  if (controller) controller.abort();
  controller = new AbortController();
  cancelStreamRender();

  goBtn.disabled = true;
  goBtn.textContent = '翻译中…';
  setStatus('');
  setOut('', true);
  out.dataset.placeholder = '';

  const vars = buildVars(state, text, { url: 'popup', title: document.title });

  const result = await runRequest({
    requestText: cfg.request,
    adapter: cfg.adapter,
    vars,
    path: cfg.path,
    responseMode: cfg.responseMode,
    direct: wantDirect(state.settings, cfg),
    signal: controller.signal,
    onDelta: (current) => {
      queueOut(current);
    }
  });

  // done 与最后一个 delta 几乎同时到，挂起的那一帧必须先撤掉，
  // 否则它会用更旧的文本覆盖下面的最终结果
  cancelStreamRender();

  goBtn.disabled = false;
  goBtn.textContent = '翻译';

  if (result.text) {
    setOut(result.text);
    const bits = [];
    if (result.status) bits.push('HTTP ' + result.status);
    bits.push((result.ms / 1000).toFixed(1) + 's');
    if (result.usedPath) bits.push(result.usedPath);
    if (result.reasoningChars) bits.push('思考 ' + result.reasoningChars + ' 字');
    else if (result.warnings && result.warnings.length) bits.push(result.warnings[0]);
    setStatus(bits.join(' · '));
  } else {
    setOut(result.error || '没有拿到结果', true);
    setStatus('失败', true);
  }
}

init().catch((err) => {
  setStatus('初始化失败：' + (err && err.message), true);
});
