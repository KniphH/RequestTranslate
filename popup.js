/**
 * popup：配置快切 + 手动翻译
 */

import { loadState, saveState, buildVars, getConfig } from './lib/store.js';
import { runRequest } from './lib/engine.js';

const $ = (s) => document.querySelector(s);

/* 文案查表。popup 是 module（不能像普通脚本那样用全局 T 包装），
   但 lib/i18n.js 已经在 popup.html 里先加载了，直接取它的 t。 */
function T(key, fallback) {
  const api = window.RTI18n;
  if (api && typeof api.t === "function") {
    const got = api.t(key);
    if (got && got !== key) return got;
  }
  return fallback;
}

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
  const i18nApi = window.RTI18n;
  state = await loadState();
  if (i18nApi && i18nApi.applyI18n) i18nApi.applyI18n(document);
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
        // 和 content.js / background.js 同一条守卫：清空设置项后会存成 0，
        // slice(0, 0) 会把选中的文字整个吞掉、弹窗里一片空白
        const limit = Math.max(1, Number(state.settings.maxChars) || 8000);
        txt.value = selected.slice(0, limit);
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
  setStatus(T('popup_copied', '已复制'));
  setTimeout(() => setStatus(''), 1500);
});

$('#btn-clear').addEventListener('click', () => {
  if (controller) controller.abort();
  txt.value = '';
  setOut(T('popup_waiting', '等待输入…'), true);
  setStatus('');
  txt.focus();
});

$('#btn-open').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#link-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

async function run() {
  const text = txt.value.trim();
  if (!text) {
    setStatus(T('popup_need_input', '先输入点内容'), true);
    return;
  }

  const cfg = getConfig(state, sel.value);
  if (!cfg) {
    setStatus(T('popup_no_config', '没有可用配置'), true);
    return;
  }

  if (controller) controller.abort();
  controller = new AbortController();
  cancelStreamRender();

  goBtn.disabled = true;
  goBtn.textContent = T('panel_status_translating', '翻译中…');
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
    signal: controller.signal,
    onDelta: (current) => {
      queueOut(current);
    }
  });

  // done 与最后一个 delta 几乎同时到，挂起的那一帧必须先撤掉，
  // 否则它会用更旧的文本覆盖下面的最终结果
  cancelStreamRender();

  goBtn.disabled = false;
  goBtn.textContent = T('popup_translate', '翻译');

  if (result.text) {
    setOut(result.text);
    const bits = [];
    if (result.status) bits.push('HTTP ' + result.status);
    bits.push((result.ms / 1000).toFixed(1) + 's');
    if (result.usedPath) bits.push(result.usedPath);
    if (result.reasoningChars) bits.push(T('popup_reasoning', '思考') + ' ' + result.reasoningChars + ' ' + T('popup_chars', '字'));
    else if (result.warnings && result.warnings.length) bits.push(result.warnings[0]);
    setStatus(bits.join(' · '));
  } else {
    setOut(result.error || T('popup_no_result', '没有拿到结果'), true);
    setStatus('失败', true);
  }
}

init().catch((err) => {
  setStatus('初始化失败：' + (err && err.message), true);
});
