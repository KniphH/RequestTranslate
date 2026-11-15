/**
 * popup：配置快切 + 手动翻译
 */

import { loadState, saveState, buildVars, getConfig } from './lib/store.js';
import { TARGET_PRESETS, orderedLangCodes, langDisplayName } from './lib/template.js';
import { runRequest } from './lib/engine.js';

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

function uiText(key, params) {
  let out = null;
  if (packStrings && typeof packStrings[key] === 'string') out = packStrings[key];
  if (out == null) {
    try {
      const got = chrome.i18n && chrome.i18n.getMessage(key, params);
      if (got) out = got;
    } catch { /* 忽略 */ }
  }
  if (out == null) out = key;
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
const statusEl = $('#status');
const goBtn = $('#btn-go');

let state = null;
let controller = null;
/** run 序号：连点两次时，旧那轮恢复后不许再写界面 */
let runSeq = 0;

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
  /* **语言包要先载入再铺界面**（第十一版 §1：popup 整页没进 i18n）。
     顺序反了用户会先看见中文再闪成英文。 */
  await loadPopupPack();
  applyPopupI18n();

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

  /* 目标语言：和设置页 / 面板顶栏同一个值（settings.targetLang，存的是代码）。
     显示名优先取用户在「语言代码表」里改过的那个。 */
  if (langSel) {
    /* **顺序要和设置页 / 面板同源**：都走 orderedLangCodes（langOrder 打头
       → 未提到的按内置序 → 去重）。以前这里用 TARGET_PRESETS.slice()，
       用户在语言表里排的顺序在 popup 里完全看不到（第八版 §1 指出）。 */
    const codes = orderedLangCodes(state.settings && state.settings.langOrder);
    const curLang = String(state.settings.targetLang || '');
    if (curLang && !codes.includes(curLang)) codes.unshift(curLang);
    langSel.innerHTML = '';
    for (const code of codes) {
      const o = document.createElement('option');
      o.value = code;
      o.textContent = langNameOf(code);
      langSel.appendChild(o);
    }
    langSel.value = curLang || codes[0];
  }

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

/* 目标语言：写回存档。后台每次发请求都重读设置，所以改完立刻生效。 */
if (langSel) {
  langSel.addEventListener('change', async () => {
    state.settings.targetLang = langSel.value;
    await saveState(state);
  });
}

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
  setStatus(uiText('popup_copied'));
  setTimeout(() => setStatus(''), 1500);
});

$('#btn-clear').addEventListener('click', () => {
  if (controller) controller.abort();
  txt.value = '';
  setOut(uiText('popup_waiting_input'), true);
  setStatus('');
  txt.focus();
});

$('#btn-open').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#link-options').addEventListener('click', () => chrome.runtime.openOptionsPage());

async function run() {
  const text = txt.value.trim();
  if (!text) {
    setStatus(uiText('popup_need_text'), true);
    return;
  }

  const cfg = getConfig(state, sel.value);
  if (!cfg) {
    setStatus(uiText('popup_no_config'), true);
    return;
  }

  /* 连点两次时，先发起那轮恢复后**不许**再写界面 —— 否则旧结果盖掉新一轮。 */
  const myRun = ++runSeq;
  if (controller) controller.abort();
  controller = new AbortController();
  cancelStreamRender();

  try {
  goBtn.disabled = true;
  goBtn.textContent = uiText('popup_translating');
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
      /* 旧那轮的 delta 不许再写界面（连点时旧请求可能还在推流） */
      if (myRun === runSeq) queueOut(current);
    }
  });

    if (myRun !== runSeq) return;   // 期间又点了一次，这轮作废

  // done 与最后一个 delta 几乎同时到，挂起的那一帧必须先撤掉，
  // 否则它会用更旧的文本覆盖下面的最终结果
  cancelStreamRender();


  if (result.text) {
    setOut(result.text);
    const bits = [];
    if (result.status) bits.push('HTTP ' + result.status);
    bits.push((result.ms / 1000).toFixed(1) + 's');
    if (result.usedPath) bits.push(result.usedPath);
    if (result.reasoningChars) bits.push(uiText('popup_reasoning') + ' ' + result.reasoningChars);
    else if (result.warnings && result.warnings.length) bits.push(result.warnings[0]);
    setStatus(bits.join(' · '));
  } else {
    setOut(result.error || uiText('popup_no_result'), true);
    setStatus(uiText('popup_failed'), true);
  }
  } finally {
    /* runRequest 抛异常时按钮会永久禁用 —— 必须兜住 */
    if (myRun === runSeq) {
      goBtn.disabled = false;
    goBtn.textContent = uiText('popup_translate');
    }
  }
}

init().catch((err) => {
  setStatus(uiText('popup_init_failed') + (err && err.message), true);
});
