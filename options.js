/**
 * 设置页逻辑
 */

import {
  loadState,
  saveState,
  buildVars,
  uid,
  exportState,
  importState,
  wantDirect,
  moveItem,
  dropIndex
} from './lib/store.js';
import { runRequest, previewRequest } from './lib/engine.js';
import { acquireDirect, isDirectActive } from './lib/network.js';
import { ADAPTERS } from './lib/adapters.js';
import { BUILTIN_VAR_HINTS, TARGET_PRESETS } from './lib/template.js';
import {
  toDataUrl,
  pickImageMime,
  NO_IMAGE_MESSAGE,
  CLIPBOARD_UNAVAILABLE_MESSAGE
} from './lib/clipboard.js';
import {
  TRIGGER_STYLES,
  TRIGGER_CSS,
  TRIGGER_SVG_SAMPLE,
  getTriggerStyle,
  clampTriggerSize,
  parseTriggerSvg
} from './lib/trigger-styles.js';
import {
  OCR_PROVIDERS,
  BUILTIN_OCR_IDS,
  DEFAULT_OCR_PROMPT,
  normalizeOcrProvider,
  normalizeOcrState,
  normalizeMaxTokens,
  previewOcrRequest,
  runOcr,
  endpointHost
} from './lib/ocr.js';

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */

let state = null;
let editingId = '';
let editingOcrId = '';
let saveTimer = null;
/** OCR 测试要用的那张本地图片（没选就用剪切板里的） */
let ocrTestFile = null;
/** 最后一处获得焦点的模板输入框（文字 / 图片两个框共用一排标签） */
let focusedTemplate = null;

const $ = (sel) => document.querySelector(sel);

const els = {
  cfgList: $('#cfg-list'),
  editor: $('#editor'),
  emptyHint: $('#empty-hint'),
  name: $('#f-name'),
  kind: $('#f-kind'),
  mode: $('#f-mode'),
  modeField: $('#f-mode-field'),
  adapterField: $('#f-adapter-field'),
  adapter: $('#f-adapter'),
  adapterHint: $('#f-adapter-hint'),
  requestOnly: $('#request-only'),
  request: $('#f-request'),
  imageRequest: $('#f-image-request'),
  path: $('#f-path'),
  direct: $('#f-direct'),
  trigStyles: $('#trig-styles'),
  trigSize: $('#s-trigsize'),
  trigSvg: $('#s-trigsvg'),
  trigSvgMsg: $('#s-trigsvg-msg'),
  btnTrigSvgDemo: $('#btn-trigsvg-demo'),
  btnTrigSvgClear: $('#btn-trigsvg-clear'),
  trigPreview: $('#trig-preview'),
  preview: $('#f-preview'),
  testText: $('#test-text'),
  testResult: $('#test-result'),
  saveStatus: $('#save-status'),
  chips: $('#chips'),
  varsBody: $('#vars-body'),
  builtinBody: $('#builtin-body'),
  fileImport: $('#file-import'),
  langSelect: $('#s-lang'),
  langOther: $('#s-lang-other'),

  // OCR
  ocrList: $('#ocr-list'),
  ocrEditor: $('#ocr-editor'),
  ocrEmpty: $('#ocr-empty'),
  oName: $('#o-name'),
  oEndpoint: $('#o-endpoint'),
  oModel: $('#o-model'),
  oMaxTokens: $('#o-maxtokens'),
  oKey: $('#o-key'),
  oPrompt: $('#o-prompt'),
  oPreview: $('#o-preview'),
  oDirect: $('#o-direct'),
  oNote: $('#o-note'),
  oDisabled: $('#o-disabled'),
  oDisabledNote: $('#o-disabled-note'),
  btnOcrNew: $('#btn-ocr-new'),
  btnOcrDuplicate: $('#btn-ocr-duplicate'),
  btnOcrDelete: $('#btn-ocr-delete'),
  ocrTestImg: $('#ocr-test-img'),
  ocrTestBtn: $('#btn-ocr-test'),
  ocrTestResult: $('#ocr-test-result')
};

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

init().catch((err) => {
  document.body.innerHTML =
    '<pre style="padding:24px;color:#f87171">设置页初始化失败：' + escapeHtml(err && err.message) + '</pre>';
});

async function init() {
  state = await loadState();
  editingId = state.activeConfigId;
  editingOcrId = state.ocr.activeId;

  bindTabs();
  bindConfigList();
  bindEditor();
  bindOcr();
  bindVars();
  bindSettings();
  bindImportExport();

  renderConfigList();
  renderAdapterOptions();
  renderEditor();
  renderOcrList();
  renderOcrEditor();
  renderVars();
  renderSettings();
}

/* ------------------------------------------------------------------ */
/* Tab                                                                 */
/* ------------------------------------------------------------------ */

function bindTabs() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-active', b === btn));
      document.querySelectorAll('.tabpanel').forEach((p) => {
        p.classList.toggle('is-active', p.dataset.panel === btn.dataset.tab);
      });
    });
  });
}

/* ------------------------------------------------------------------ */
/* 配置列表                                                            */
/* ------------------------------------------------------------------ */

/* 拖动手柄的图标（两列三点）。真正的手柄只有一个 10×14 的 svg，
   点上去别的地方不响应 —— 见下面 .cfg-grip 的说明 */
const GRIP_SVG =
  '<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">' +
  '<circle cx="3" cy="2" r="1.15"/><circle cx="7" cy="2" r="1.15"/>' +
  '<circle cx="3" cy="7" r="1.15"/><circle cx="7" cy="7" r="1.15"/>' +
  '<circle cx="3" cy="12" r="1.15"/><circle cx="7" cy="12" r="1.15"/>' +
  '</svg>';

function renderConfigList() {
  const total = state.configs.length;
  els.cfgList.innerHTML = '';

  state.configs.forEach((cfg, idx) => {
    const row = document.createElement('div');
    row.className = 'cfg-row';
    row.dataset.id = cfg.id;

    // 一整行 = 手柄 + 可点的主体 + 上下移。
    // 只有手柄是拖拽源：整行可拖会跟「点一下选中」抢鼠标，点一下都可能变成拖。
    const grip = document.createElement('span');
    grip.className = 'cfg-grip';
    grip.title = '按住拖动，调整顺序';
    grip.setAttribute('aria-hidden', 'true'); // 键盘走右边的 ↑ ↓
    grip.innerHTML = GRIP_SVG;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cfg-item' + (cfg.id === editingId ? ' is-active' : '');

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = cfg.name || '(未命名)';

    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = summarizeRequest(cfg.request);

    btn.append(name, sub);
    btn.addEventListener('click', () => selectConfig(cfg.id));

    const mv = document.createElement('div');
    mv.className = 'cfg-mv';
    mv.append(moveButton(cfg, idx, -1, total), moveButton(cfg, idx, 1, total));

    row.append(grip, btn, mv);
    els.cfgList.appendChild(row);
  });
}

/** 上移 / 下移按钮。头尾各禁用一边，省得点了没反应还不知道为什么 */
function moveButton(cfg, idx, delta, total) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cfg-mv-btn';
  b.dataset.mv = String(delta);
  b.textContent = delta < 0 ? '↑' : '↓';
  b.disabled = delta < 0 ? idx === 0 : idx === total - 1;
  const label = delta < 0 ? '上移' : '下移';
  b.title = label;
  b.setAttribute('aria-label', `${label}「${cfg.name || '未命名'}」`);

  b.addEventListener('click', () => {
    moveConfig(cfg.id, idx + delta);
    // 重渲染之后把焦点还给同一个按钮 —— 连着按 ↑ 才不要每按一次就去找鼠标
    const again = els.cfgList.querySelector(
      `.cfg-row[data-id="${cfg.id}"] .cfg-mv-btn[data-mv="${delta}"]`
    );
    if (again && !again.disabled) again.focus();
  });
  return b;
}

/** 把一条配置挪到新位置（`to` 是移除后的坐标），重渲染 + 落盘 */
function moveConfig(id, to) {
  flushEditor();
  const from = state.configs.findIndex((c) => c.id === id);
  if (from < 0) return false;
  const next = moveItem(state.configs, from, to);
  if (next === state.configs) return false; // 原地没动
  state.configs = next;
  renderConfigList();
  persist();
  return true;
}

/** 指针落在哪一行、上半区还是下半区。用坐标算，不做命中测试 ——
    拖动时指针是「抓」在手柄上的，elementFromPoint 只会把手柄自己还回来 */
function dropSpot(y) {
  const rows = [...els.cfgList.querySelectorAll('.cfg-row')];
  if (!rows.length) return null;
  for (const row of rows) {
    const b = row.getBoundingClientRect();
    if (y < b.bottom) return { row, after: y > b.top + b.height / 2 };
  }
  // 拖到列表下方的空白处 = 放到最后
  return { row: rows[rows.length - 1], after: true };
}

/**
 * 拖动排序。
 *
 * 用 pointer 事件而不是 HTML5 的 draggable —— 后者在触屏上压根不触发，
 * 而且原生拖影在设置页里很脏。代价是插入指示线得自己画（见 options.css）。
 */
function bindConfigSort() {
  const list = els.cfgList;
  let drag = null; // { id, pointerId, y0, y, moved }

  const clearMarks = () => {
    for (const row of list.querySelectorAll('.cfg-row')) {
      row.classList.remove('dragging', 'drop-before', 'drop-after');
    }
  };

  list.addEventListener('pointerdown', (e) => {
    const grip = e.target instanceof Element ? e.target.closest('.cfg-grip') : null;
    if (!grip || e.button !== 0) return;
    e.preventDefault(); // 别顺手选中文字，也别触发浏览器自己的选择 / 拖拽
    drag = {
      id: grip.closest('.cfg-row').dataset.id,
      pointerId: e.pointerId,
      y0: e.clientY,
      y: e.clientY,
      moved: false
    };
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      /* 拿不到指针也不影响：pointermove 照样会冒泡上来 */
    }
  });

  list.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.y = e.clientY;
    // 先给个抖动阈值：只是点了一下手柄、手晃了 2px，不该算拖动
    if (!drag.moved) {
      if (Math.abs(e.clientY - drag.y0) < 4) return;
      drag.moved = true;
      list.classList.add('is-dragging');
    }

    const spot = dropSpot(e.clientY);
    clearMarks();
    if (!spot) return;
    spot.row.classList.add(spot.after ? 'drop-after' : 'drop-before');
    const self = list.querySelector(`.cfg-row[data-id="${drag.id}"]`);
    if (self) self.classList.add('dragging');
  });

  const finish = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    list.classList.remove('is-dragging');
    clearMarks();
    if (!d.moved) return; // 只是点了一下手柄，什么都没发生

    const spot = dropSpot(d.y);
    if (!spot) return;
    const ids = [...list.querySelectorAll('.cfg-row')].map((r) => r.dataset.id);
    const to = dropIndex(ids, d.id, spot.row.dataset.id, spot.after);
    if (to < 0) return;
    moveConfig(d.id, to);
  };

  list.addEventListener('pointerup', finish);
  // 指针拖到列表外面才松手时也要收尾 —— 万一 setPointerCapture 没成功，
  // 事件就落不到 list 上了，drag 会一直挂着，下一次 pointermove 会接着上次的拖
  window.addEventListener('pointerup', finish);
  const abort = () => {
    if (!drag) return;
    drag = null;
    list.classList.remove('is-dragging');
    clearMarks();
  };
  list.addEventListener('pointercancel', abort);
  window.addEventListener('pointercancel', abort);
}

function summarizeRequest(text) {
  const firstUrl = String(text || '').match(/https?:\/\/[^\s'"\\]+/);
  if (!firstUrl) return '(空)';
  return firstUrl[0].replace(/^https?:\/\//, '').slice(0, 40);
}

function selectConfig(id) {
  flushEditor();
  editingId = id;
  state.activeConfigId = id;
  renderConfigList();
  renderEditor();
  persist(false);
}

/* ------------------------------------------------------------------ */
/* 编辑器                                                              */
/* ------------------------------------------------------------------ */

function currentConfig() {
  return state.configs.find((c) => c.id === editingId) || null;
}

function renderEditor() {
  const cfg = currentConfig();

  if (!cfg) {
    els.editor.hidden = true;
    els.emptyHint.hidden = false;
    return;
  }

  els.editor.hidden = false;
  els.emptyHint.hidden = true;

  els.name.value = cfg.name || '';
  els.mode.value = cfg.responseMode || 'auto';
  els.request.value = cfg.request || '';
  els.imageRequest.value = cfg.imageRequest || '';
  els.path.value = cfg.path || '';
  els.direct.checked = !!cfg.direct;
  els.testResult.hidden = true;

  els.kind.value = cfg.adapter ? 'adapter' : 'request';
  if (cfg.adapter) els.adapter.value = cfg.adapter;
  syncEditorMode();

  updatePreview();
  setSaveStatus('');
}

/** 适配器下拉里列出所有内置适配器 */
function renderAdapterOptions() {
  els.adapter.innerHTML = '';
  for (const a of Object.values(ADAPTERS)) {
    const o = document.createElement('option');
    o.value = a.id;
    o.textContent = a.label;
    els.adapter.appendChild(o);
  }
}

/** 按「自定义请求 / 内置适配器」切换该显示哪些字段 */
function syncEditorMode() {
  const isAdapter = els.kind.value === 'adapter';
  els.adapterField.hidden = !isAdapter;
  els.requestOnly.hidden = isAdapter;
  els.modeField.hidden = isAdapter;
  if (isAdapter) {
    const a = ADAPTERS[els.adapter.value];
    els.adapterHint.textContent = a ? a.hint : '';
  }
}

function collectEditor() {
  const cfg = currentConfig();
  if (!cfg) return null;
  cfg.name = els.name.value.trim() || '未命名配置';
  cfg.responseMode = els.mode.value;
  // 适配器模式下请求模板被隐藏了，但值留着 —— 切回来不丢
  cfg.adapter = els.kind.value === 'adapter' ? els.adapter.value : '';
  cfg.request = els.request.value;
  cfg.imageRequest = els.imageRequest.value;
  cfg.path = els.path.value.trim();
  cfg.direct = !!els.direct.checked;
  return cfg;
}

function bindConfigList() {
  bindConfigSort();

  $('#btn-new').addEventListener('click', () => {
    flushEditor();
    const cfg = {
      id: uid(),
      name: '新配置',
      note: '',
      adapter: '',
      request:
        'curl https://example.com/v1/chat/completions \\\n' +
        '  -H "Content-Type: application/json" \\\n' +
        '  -H "Authorization: Bearer {{apiKey}}" \\\n' +
        "  -d '{\n" +
        '  "model": "your-model",\n' +
        '  "messages": [{"role": "user", "content": "{{text}}"}],\n' +
        '  "stream": true\n' +
        "}'",
      path: '',
      responseMode: 'auto',
      imageRequest: '',
      direct: false
    };
    state.configs.push(cfg);
    editingId = cfg.id;
    state.activeConfigId = cfg.id;
    renderConfigList();
    renderEditor();
    persist();
    els.name.focus();
    els.name.select();
  });
}

function bindEditor() {
  const onInput = () => {
    collectEditor();
    updatePreview();
    scheduleSave();
    // 名字改了要同步左栏
    renderConfigList();
  };

  els.name.addEventListener('input', onInput);
  els.mode.addEventListener('input', onInput);
  els.request.addEventListener('input', onInput);
  els.imageRequest.addEventListener('input', onInput);
  els.path.addEventListener('input', onInput);
  els.direct.addEventListener('input', onInput);

  // 类型 / 适配器是下拉，用 change
  els.kind.addEventListener('change', () => {
    syncEditorMode();
    collectEditor();
    updatePreview();
    scheduleSave();
  });
  els.adapter.addEventListener('change', () => {
    syncEditorMode();
    collectEditor();
    updatePreview();
    scheduleSave();
  });

  // Tab 键插入两个空格而不是跳焦点；顺便记住光标在哪个框，
  // 好让上面那排标签插到「当前正在写的那一段」里
  bindTemplateBox(els.request);
  bindTemplateBox(els.imageRequest);

  els.chips.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    insertAtCursor(focusedTemplate || els.request, chip.dataset.ins);
  });

  $('#btn-duplicate').addEventListener('click', () => {
    const cfg = currentConfig();
    if (!cfg) return;
    const copy = { ...cfg, id: uid(), name: cfg.name + ' 副本' };
    const idx = state.configs.findIndex((c) => c.id === cfg.id);
    state.configs.splice(idx + 1, 0, copy);
    editingId = copy.id;
    state.activeConfigId = copy.id;
    renderConfigList();
    renderEditor();
    persist();
  });

  $('#btn-delete').addEventListener('click', () => {
    const cfg = currentConfig();
    if (!cfg) return;
    if (state.configs.length === 1) {
      alert('至少要留一条配置。');
      return;
    }
    if (!confirm(`确定删除「${cfg.name || '未命名'}」？此操作不可撤销。`)) return;

    const idx = state.configs.findIndex((c) => c.id === cfg.id);
    state.configs.splice(idx, 1);
    editingId = state.configs[Math.max(0, idx - 1)].id;
    state.activeConfigId = editingId;
    renderConfigList();
    renderEditor();
    persist();
  });

  $('#btn-test').addEventListener('click', runTest);
  els.testText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runTest();
  });
}

function insertAtCursor(textarea, text) {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  textarea.value = value.slice(0, start) + text + value.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  textarea.focus();
  textarea.dispatchEvent(new Event('input'));
}

/** 给一个模板输入框装上「Tab 缩进」和「记住焦点」 */
function bindTemplateBox(el) {
  el.addEventListener('focus', () => {
    focusedTemplate = el;
  });
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    e.preventDefault();
    insertAtCursor(el, '  ');
  });
}

/* ------------------------------------------------------------------ */
/* 预览                                                                */
/* ------------------------------------------------------------------ */

let previewTimer = null;

function updatePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    if (els.kind.value === 'adapter') {
      const a = ADAPTERS[els.adapter.value];
      els.preview.textContent = a
        ? `内置适配器：${a.label}\n\n${a.hint}\n\n这条配置不走请求模板，翻译流程由扩展内置的代码完成。`
        : '(没有可用的内置适配器)';
      return;
    }

    const text = els.request.value;
    if (!text.trim()) {
      els.preview.textContent = '(请求模板为空)';
      return;
    }

    const sample = 'Hello, world! 这是一段示例文本。';
    let vars;
    try {
      vars = buildVars(state, sample, { url: 'https://example.com/page', title: '示例页面' });
    } catch {
      vars = { text: sample };
    }

    const info = previewRequest(text, vars, els.path.value.trim());

    const lines = [];
    lines.push('写法：' + (info.request.style === 'raw' ? '原始 HTTP 报文' : 'curl'));
    lines.push('方法：' + info.request.method);
    lines.push('地址：' + info.request.url);
    lines.push('');

    if (info.missing.length) {
      lines.push('未定义的变量：' + info.missing.map((m) => '{{' + m + '}}').join(' '));
      lines.push('');
    }
    if (info.problems.length) {
      lines.push('问题：' + info.problems.join('；'));
      lines.push('');
    }
    if (info.notes.length) {
      lines.push('修正：' + info.notes.join('；'));
      lines.push('');
    }

    lines.push('—— 实际会发出的内容 ——');
    lines.push('');
    lines.push(info.rendered);

    // 图片请求模板顺手也渲一遍。{{image}} 给一张假图，不然这里看着跟空的一样。
    const imgTpl = els.imageRequest.value.trim();
    if (imgTpl) {
      lines.push('');
      lines.push('══════ 图片请求模板（截图直传那一次用它）══════');
      lines.push('（下面 {{image}} 是一张假的示例图，实际是一整段 data URL）');
      lines.push('');
      let ivars;
      try {
        ivars = buildVars(state, '', {
          url: 'https://example.com/page',
          title: '示例页面',
          image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
        });
      } catch {
        ivars = { image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' };
      }
      const iinfo = previewRequest(imgTpl, ivars, els.path.value.trim());
      lines.push('写法：' + (iinfo.request.style === 'raw' ? '原始 HTTP 报文' : 'curl'));
      lines.push('方法：' + iinfo.request.method);
      lines.push('地址：' + iinfo.request.url);
      if (iinfo.missing.length) {
        lines.push('未定义的变量：' + iinfo.missing.map((m) => '{{' + m + '}}').join(' '));
      }
      if (iinfo.problems.length) lines.push('问题：' + iinfo.problems.join('；'));
      if (iinfo.notes.length) lines.push('修正：' + iinfo.notes.join('；'));
      lines.push('');
      lines.push('—— 实际会发出的内容 ——');
      lines.push('');
      lines.push(iinfo.rendered);
    }

    els.preview.textContent = lines.join('\n');
  }, 180);
}

/* ------------------------------------------------------------------ */
/* 测试请求                                                            */
/* ------------------------------------------------------------------ */

async function runTest() {
  collectEditor();
  await persist(false);

  const cfg = currentConfig();
  if (!cfg) return;

  const text = els.testText.value.trim() || 'Hello, world!';
  const btn = $('#btn-test');
  btn.disabled = true;
  btn.textContent = '发送中…';

  els.testResult.hidden = false;
  els.testResult.innerHTML = '<div class="result-head"><span class="badge">请求中…</span></div>';

  let result;
  try {
    const vars = buildVars(state, text, { url: location.href, title: 'RequestTranslate 测试' });
    result = await runRequest({
      requestText: cfg.request,
      adapter: cfg.adapter,
      vars,
      path: cfg.path,
      responseMode: cfg.responseMode,
      direct: wantDirect(state.settings, cfg)
    });
  } catch (err) {
    result = { ok: false, status: 0, ms: 0, text: '', error: String(err && err.message), warnings: [], raw: '' };
  }

  btn.disabled = false;
  btn.textContent = '发送';
  renderTestResult(result);
}

function renderTestResult(r) {
  const rows = [];

  const badges = [
    `<span class="badge ${r.ok ? 'ok' : 'err'}">HTTP ${r.status || '失败'}</span>`,
    `<span class="badge">${r.ms} ms</span>`
  ];
  if (r.usedPath) badges.push(`<span class="badge">${escapeHtml(r.usedPath)}</span>`);
  if (r.direct) badges.push('<span class="badge">已直连</span>');
  for (const w of r.warnings || []) badges.push(`<span class="badge warn">${escapeHtml(w)}</span>`);
  if (r.missingVars && r.missingVars.length) {
    badges.push(`<span class="badge warn">未填变量 ${r.missingVars.map(escapeHtml).join(', ')}</span>`);
  }

  if (r.error) {
    rows.push(
      `<div class="row"><div class="row-title">错误</div><pre class="err-text">${escapeHtml(r.error)}</pre></div>`
    );
  }

  if (r.text) {
    rows.push(
      `<div class="row"><div class="row-title">提取到的译文</div><pre class="translated">${escapeHtml(r.text)}</pre></div>`
    );
  }

  if (r.request) {
    rows.push(
      `<div class="row"><div class="row-title">实际请求</div><pre>${escapeHtml(
        `${r.request.method} ${r.request.url}\n` +
          Object.entries(r.request.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n') +
          (r.request.body ? '\n\n' + r.request.body : '')
      )}</pre></div>`
    );
  }

  if (r.raw) {
    const raw = r.raw.length > 8000 ? r.raw.slice(0, 8000) + '\n\n…（已截断）' : r.raw;
    rows.push(
      `<div class="row"><div class="row-title">原始响应</div><pre>${escapeHtml(raw)}</pre></div>`
    );
  }

  els.testResult.innerHTML =
    `<div class="result-head">${badges.join('')}</div><div class="result-body">${rows.join('')}</div>`;
}

/* ------------------------------------------------------------------ */
/* 变量                                                                */
/* ------------------------------------------------------------------ */

function bindVars() {
  $('#btn-add-var').addEventListener('click', () => {
    state.vars.push({ name: '', value: '' });
    renderVars();
    persist();
    const inputs = els.varsBody.querySelectorAll('input[data-kind="name"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
}

function renderVars() {
  els.varsBody.innerHTML = '';

  state.vars.forEach((v, idx) => {
    const tr = document.createElement('tr');

    const nameTd = document.createElement('td');
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = v.name;
    nameInput.placeholder = 'apiKey';
    nameInput.dataset.kind = 'name';
    nameInput.spellcheck = false;
    nameInput.addEventListener('input', () => {
      state.vars[idx].name = nameInput.value.replace(/[^\w.-]/g, '');
      if (nameInput.value !== state.vars[idx].name) nameInput.value = state.vars[idx].name;
      scheduleSave();
      updatePreview();
    });
    nameTd.appendChild(nameInput);

    const valueTd = document.createElement('td');
    const valueInput = document.createElement('input');
    valueInput.type = 'text';
    valueInput.value = v.value;
    valueInput.placeholder = '值';
    valueInput.spellcheck = false;
    valueInput.addEventListener('input', () => {
      state.vars[idx].value = valueInput.value;
      scheduleSave();
      updatePreview();
    });
    valueTd.appendChild(valueInput);

    const delTd = document.createElement('td');
    const del = document.createElement('button');
    del.className = 'row-del';
    del.textContent = '✕';
    del.title = '删除';
    del.addEventListener('click', () => {
      state.vars.splice(idx, 1);
      renderVars();
      persist();
      updatePreview();
    });
    delTd.appendChild(del);

    tr.append(nameTd, valueTd, delTd);
    els.varsBody.appendChild(tr);
  });

  els.builtinBody.innerHTML = Object.entries(BUILTIN_VAR_HINTS)
    .map(([k, hint]) => `<tr><td>{{${escapeHtml(k)}}}</td><td>${escapeHtml(hint)}</td></tr>`)
    .join('');
}

/* ------------------------------------------------------------------ */
/* OCR 供应商                                                          */
/* ------------------------------------------------------------------ */
/* 结构刻意和配置列表一样（点一条就切过去），少一套心智模型。
   区别只有一个：OCR 不做拖动排序 —— 顺序没有意义，只有「选中哪条」有意义。 */

function currentOcrProvider() {
  return state.ocr.providers.find((p) => p.id === editingOcrId) || null;
}

/** 列表里那行小字：接口地址 + 模型名，够认人就行 */
function summarizeOcr(p) {
  const host = String(p.endpoint || '').replace(/^https?:\/\//, '');
  if (!host) return '(还没填接口地址)';
  const short = host.length > 34 ? host.slice(0, 34) + '…' : host;
  return p.model ? short + ' · ' + p.model : short;
}

function renderOcrList() {
  els.ocrList.innerHTML = '';

  for (const p of state.ocr.providers) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cfg-item' + (p.id === state.ocr.activeId ? ' is-active' : '');
    btn.dataset.id = p.id;

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = p.name || '(未命名)';

    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = summarizeOcr(p);

    btn.append(name, sub);
    btn.addEventListener('click', () => selectOcr(p.id));
    els.ocrList.appendChild(btn);
  }
}

/** 「禁用外置 OCR」是全局开关，不属于任何一条供应商 */
function renderOcrDisabled() {
  const off = !!state.ocr.disabled;
  els.oDisabled.checked = off;
  els.oDisabledNote.hidden = !off;
  // 关掉之后下面那些供应商字段都用不上了，压暗一点省得看岔
  els.ocrEditor.classList.toggle('is-off', off);
  // 直传模式下这条供应商根本不会被动用，测试也就没意义了
  els.ocrTestBtn.disabled = off;
  els.ocrTestBtn.title = off ? '现在勾了「禁用外置 OCR」，截图直接交给多模态模型，这条供应商不会被用到' : '';
}

function renderOcrEditor() {
  renderOcrDisabled();
  const p = currentOcrProvider();

  if (!p) {
    els.ocrEditor.hidden = true;
    els.ocrEmpty.hidden = false;
    return;
  }

  els.ocrEditor.hidden = false;
  els.ocrEmpty.hidden = true;

  els.oName.value = p.name || '';
  els.oEndpoint.value = p.endpoint || '';
  els.oModel.value = p.model || '';
  // 0 = 不发送这个字段，输入框里显示成空（不然会出现一个孤零零的 0）
  els.oMaxTokens.value = p.maxTokens > 0 ? String(p.maxTokens) : '';
  els.oKey.value = p.apiKey || '';
  els.oPrompt.value = p.prompt || '';
  els.oDirect.checked = !!p.direct;
  els.oNote.textContent = p.note || '';

  // 换了一条供应商，上一次的测试结果就不是这条的了 —— 收起来，免得看岔
  els.ocrTestResult.hidden = true;

  // 提示词故意**不给预设按钮**：各家格式互不相通（DeepSeek-OCR 认 `Free OCR.`、
  // PaddleOCR-VL 认 `OCR:`），摆一排只对某一家有效的按钮反而误导。说明写在 HTML 里。

  renderOcrPreview();

  // 只剩一条时不让删：删空了功能就没了（内置那条就算删了下次启动也会被补回来）
  els.btnOcrDelete.disabled = state.ocr.providers.length <= 1;
}

/* ------------------------------------------------------------------ */
/* OCR 的「完整请求」预览                                              */
/* ------------------------------------------------------------------ */
/* 和配置栏那个「渲染预览」一个意思：**别让人猜扩展到底发了什么**。
   OCR 这条路虽然不开放手写模板（形状是固定的，见 lib/ocr.js 顶部注释），
   但接口地址 / 模型 / 提示词 / max_tokens 都是用户填的 —— 摊出来才看得清。
   图片位置塞一张**假的**小图：真截图是几十万字符的 data URL，摊出来没法读。 */

const OCR_SAMPLE_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function renderOcrPreview() {
  const p = currentOcrProvider();
  if (!p) return;

  // 组装和真发出去的是同一个函数（lib/ocr.js 的 previewOcrRequest）
  const req = previewOcrRequest(p, OCR_SAMPLE_IMAGE);

  const missing = [];
  if (!String(p.endpoint || '').trim()) missing.push('接口地址');
  if (!String(p.model || '').trim()) missing.push('模型');
  if (!String(p.apiKey || '').trim()) missing.push('API Key');

  const lines = [];
  lines.push('方法：' + req.method);
  lines.push('地址：' + (req.url || '(还没填)'));
  lines.push('请求头：');
  for (const [k, v] of Object.entries(req.headers)) lines.push('  ' + k + ': ' + v);
  lines.push('');
  lines.push('—— 实际会发出的请求体 ——');
  lines.push('');
  try {
    // 从**同一份** body 反序列化再缩进，保证屏幕上这段就是真发出去的那段
    lines.push(JSON.stringify(JSON.parse(req.body), null, 2));
  } catch {
    lines.push(req.body);
  }
  lines.push('');
  lines.push('（上面 image_url 里是一张假的示例图，真截图换成一整段 data URL；');
  lines.push('  「测试」跑完后的「原始请求」里是那一份真的，Key 同样打码）');
  if (!String(p.prompt || '').trim()) {
    lines.push('');
    lines.push('提示词留空 → 会发默认的那句：' + DEFAULT_OCR_PROMPT);
  }
  const mt = normalizeMaxTokens(p.maxTokens);
  if (mt > 0) {
    lines.push('');
    lines.push('「最大输出长度」填了 ' + mt + ' → 这次会带上 max_tokens（注意它和提示词一起占上下文）');
  }
  if (missing.length) {
    lines.push('');
    lines.push('还差：' + missing.join(' / ') + ' —— 补齐之前发出去会失败');
  }
  els.oPreview.textContent = lines.join('\n');
}

/** 把编辑框里的东西写回当前那条供应商。切走之前必须调一次 */
function collectOcrEditor() {
  const p = currentOcrProvider();
  if (!p) return null;
  p.name = els.oName.value.trim() || '未命名供应商';
  p.endpoint = els.oEndpoint.value.trim();
  p.model = els.oModel.value.trim();
  p.maxTokens = normalizeMaxTokens(els.oMaxTokens.value);
  p.apiKey = els.oKey.value;
  p.prompt = els.oPrompt.value;
  p.direct = !!els.oDirect.checked;
  return p;
}

function selectOcr(id) {
  collectOcrEditor();
  editingOcrId = id;
  state.ocr.activeId = id;
  renderOcrList();
  renderOcrEditor();
  persist(false);
}

function bindOcr() {
  const fields = [
    [els.oName, 'name', false],
    [els.oEndpoint, 'endpoint', false],
    [els.oModel, 'model', false],
    [els.oMaxTokens, 'maxTokens', false],
    [els.oKey, 'apiKey', false],
    [els.oPrompt, 'prompt', false],
    [els.oDirect, 'direct', true]
  ];

  for (const [el, key, isCheck] of fields) {
    el.addEventListener('input', () => {
      const p = currentOcrProvider();
      if (!p) return;
      if (isCheck) p[key] = el.checked;
      else if (key === 'maxTokens') p[key] = normalizeMaxTokens(el.value); // 数字字段，空 = 0 = 不发送
      else p[key] = el.value;
      // 名称 / 地址 / 模型都会出现在列表那行小字里，改了就顺手刷一下
      if (key === 'name' || key === 'endpoint' || key === 'model') renderOcrList();
      // 除了名称，其它几个都会进请求体（地址 / 模型 / key / 提示词 / max_tokens）
      if (key !== 'name') renderOcrPreview();
      scheduleSave();
    });
  }

  els.oDisabled.addEventListener('input', () => {
    state.ocr.disabled = els.oDisabled.checked;
    renderOcrDisabled();
    scheduleSave();
  });

  els.btnOcrNew.addEventListener('click', () => {
    collectOcrEditor();
    const p = normalizeOcrProvider({
      name: '新供应商',
      prompt: DEFAULT_OCR_PROMPT,
      note: '自己填接口地址和模型名 —— 任何按 OpenAI 格式收图的接口都行。'
    });
    state.ocr.providers.push(p);
    editingOcrId = state.ocr.activeId = p.id;
    renderOcrList();
    renderOcrEditor();
    els.oEndpoint.focus();
    scheduleSave();
  });

  els.btnOcrDuplicate.addEventListener('click', () => {
    const src = currentOcrProvider();
    if (!src) return;
    collectOcrEditor();
    const copy = normalizeOcrProvider({
      ...src,
      id: '',
      name: (src.name || '未命名') + ' 副本'
    });
    state.ocr.providers.push(copy);
    editingOcrId = state.ocr.activeId = copy.id;
    renderOcrList();
    renderOcrEditor();
    scheduleSave();
  });

  els.btnOcrDelete.addEventListener('click', () => {
    const p = currentOcrProvider();
    if (!p || state.ocr.providers.length <= 1) return;
    if (!confirm(`删除 OCR 供应商「${p.name}」？`)) return;

    const idx = state.ocr.providers.findIndex((x) => x.id === p.id);
    state.ocr.providers.splice(idx, 1);
    // 内置的那两条会在 loadState 里被自动补齐 —— 删掉就得记一笔，否则下次启动又回来了
    if (BUILTIN_OCR_IDS.includes(p.id) && !state.ocr.hidden.includes(p.id)) {
      state.ocr.hidden.push(p.id);
    }

    const next = state.ocr.providers[Math.min(idx, state.ocr.providers.length - 1)];
    editingOcrId = state.ocr.activeId = next.id;
    renderOcrList();
    renderOcrEditor();
    persist();
  });

  els.ocrTestBtn.addEventListener('click', runOcrTest);

  els.ocrTestImg.addEventListener('change', () => {
    const f = els.ocrTestImg.files && els.ocrTestImg.files[0];
    ocrTestFile = f || null;
    els.ocrTestResult.hidden = true; // 换图了就把上次的结果收起来
  });
}

/* ------------------------------------------------------------------ */
/* OCR 测试                                                            */
/* ------------------------------------------------------------------ */
/* 和配置栏那个「测试」同构：发一次真请求，把结果摊开看。
   区别只在输入 —— 那边是一段文本，这边是一张图片：默认拿**剪切板里的第一张图**
   （就是你平时右键要翻的那张），也可以先挑一张本地图片再点。 */

function formatBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(b < 10240 ? 1 : 0) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

function truncateText(s, n) {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) + '\n\n…（已截断，共 ' + t.length + ' 字）' : t;
}

/** 剪切板里的第一张图。「里面没图」和「压根读不到」分开报 */
async function clipboardImage() {
  if (!navigator.clipboard || !navigator.clipboard.read) {
    throw new Error(CLIPBOARD_UNAVAILABLE_MESSAGE);
  }

  let items;
  try {
    items = await navigator.clipboard.read();
  } catch (err) {
    throw new Error(CLIPBOARD_UNAVAILABLE_MESSAGE + '（' + ((err && err.message) || err) + '）');
  }

  for (const item of items || []) {
    const type = pickImageMime(item && item.types);
    if (!type) continue;
    const blob = await item.getType(type);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return { dataUrl: toDataUrl(bytes, type), bytes: bytes.length, source: '剪切板' };
  }

  throw new Error(NO_IMAGE_MESSAGE);
}

async function fileImage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return { dataUrl: toDataUrl(bytes, file.type), bytes: bytes.length, source: '本地图片 ' + file.name };
}

async function runOcrTest() {
  collectOcrEditor();
  await persist(false);

  const p = currentOcrProvider();
  if (!p) return;

  const btn = els.ocrTestBtn;
  const box = els.ocrTestResult;
  box.hidden = false;

  let shot = null;
  try {
    shot = ocrTestFile ? await fileImage(ocrTestFile) : await clipboardImage();
  } catch (err) {
    box.innerHTML =
      '<div class="result-head"><span class="badge err">没拿到图片</span>' +
      `<span class="badge">${escapeHtml(p.name)}</span></div>` +
      '<div class="result-body"><div class="row"><div class="row-title">原因</div>' +
      `<pre class="err-text">${escapeHtml((err && err.message) || err)}</pre></div></div>`;
    return;
  }

  const srcLabel = shot.source + ' · ' + formatBytes(shot.bytes);
  btn.disabled = true;
  btn.textContent = '识别中…';
  box.innerHTML =
    '<div class="result-head"><span class="badge">请求中…</span>' +
    `<span class="badge">${escapeHtml(p.name)}</span>` +
    `<span class="badge">${escapeHtml(srcLabel)}</span></div>`;

  let r = null;
  let err = null;
  let release = null;
  try {
    // 和 background 里那条路一样：这条供应商自己勾了直连就先切过去
    if (p.direct) release = await acquireDirect([endpointHost(p.endpoint)]);
    r = await runOcr({ provider: p, dataUrl: shot.dataUrl });
  } catch (e) {
    err = e;
  } finally {
    // 交还失败别盖住真正的错
    if (release) { try { await release(); } catch { /* ignore */ } }
  }

  btn.disabled = false;
  btn.textContent = '测试';
  renderOcrTestResult({ name: p.name, srcLabel, r, err, direct: isDirectActive() });
}

function renderOcrTestResult({ name, srcLabel, r, err, direct }) {
  const status = err ? (err.status || '失败') : r.status;
  const ms = err ? err.ms : r.ms;

  const badges = [`<span class="badge ${err ? 'err' : 'ok'}">HTTP ${escapeHtml(String(status))}</span>`];
  if (typeof ms === 'number') badges.push(`<span class="badge">${ms} ms</span>`);
  if (direct) badges.push('<span class="badge">已直连</span>');
  badges.push(`<span class="badge">${escapeHtml(name)}</span>`);
  badges.push(`<span class="badge">${escapeHtml(srcLabel)}</span>`);

  const rows = [];
  if (err) {
    rows.push(
      `<div class="row"><div class="row-title">错误</div><pre class="err-text">${escapeHtml(
        (err && err.message) || String(err)
      )}</pre></div>`
    );
  }
  if (r && r.text) {
    rows.push(
      `<div class="row"><div class="row-title">识别到的文字</div><pre class="translated">${escapeHtml(
        r.text
      )}</pre></div>`
    );
  }

  // 失败时也要把请求和响应摊出来 —— 配错了（模型名、key、提示词）全靠这两块定位
  const req = (err && err.request) || (r && r.request);
  if (req) {
    rows.push(
      `<div class="row"><div class="row-title">实际请求</div><pre>${escapeHtml(
        `${req.method} ${req.url}\n` +
          Object.entries(req.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n') +
          (req.body ? '\n\n' + truncateText(req.body, 2000) : '')
      )}</pre></div>`
    );
  }

  const raw = (err && err.raw) || (r && r.raw);
  if (raw) {
    rows.push(
      `<div class="row"><div class="row-title">原始响应</div><pre>${escapeHtml(
        truncateText(raw, 8000)
      )}</pre></div>`
    );
  }

  els.ocrTestResult.innerHTML =
    `<div class="result-head">${badges.join('')}</div><div class="result-body">${rows.join('')}</div>`;
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

const SETTING_MAP = {
  '#s-trigger': ['settings', 'trigger', 'value'],
  '#s-ctx': ['settings', 'contextMenu', 'checked'],
  '#s-ocrmenu': ['settings', 'ocrMenu', 'checked'],
  // '#s-lang'（目标语言）不在这儿 —— 它是「下拉 + 其他自己填」两个控件，
  // 合起来才是一个值，见下面的 renderTargetLang / bindTargetLang
  '#s-max': ['settings', 'maxChars', 'number'],
  '#s-width': ['settings', 'panelWidth', 'number'],
  '#s-height': ['settings', 'panelHeight', 'number'],
  '#s-font': ['settings', 'fontSize', 'number'],
  '#s-theme': ['settings', 'theme', 'value'],
  '#s-showsrc': ['settings', 'showOriginal', 'checked'],
  '#s-direct': ['settings', 'directAdapter', 'checked'],
  '#s-trigsize': ['settings', 'triggerSize', 'number'],
  '#s-trigsvg': ['settings', 'triggerSvg', 'value']
};

function renderSettings() {
  $('#s-trigger').value = state.settings.trigger;
  $('#s-ctx').checked = !!state.settings.contextMenu;
  // 缺席按「开」算 —— 这条是新加的，老存档里没有这个字段
  $('#s-ocrmenu').checked = state.settings.ocrMenu !== false;
  renderTargetLang();
  $('#s-max').value = state.settings.maxChars;
  $('#s-width').value = state.settings.panelWidth;
  $('#s-height').value = state.settings.panelHeight;
  $('#s-font').value = state.settings.fontSize;
  $('#s-theme').value = state.settings.theme;
  $('#s-showsrc').checked = !!state.settings.showOriginal;
  // 缺席按「关」算，和 DEFAULT_SETTINGS 保持一致
  $('#s-direct').checked = state.settings.directAdapter === true;
  els.trigSize.value = clampTriggerSize(state.settings.triggerSize);
  els.trigSvg.value = state.settings.triggerSvg || '';
  renderTriggerStyles();
  updateTriggerSvgMsg();
  renderPreview();
  applyTheme();
}

/* ---- 翻译按钮：样式卡 / 自定义 SVG / 实时预览 ---------------------- */

function renderTriggerStyles() {
  const cur = state.settings.triggerStyle || 'badge';
  els.trigStyles.innerHTML = TRIGGER_STYLES.map((s) => {
    const icon = s.svg || escapeHtml(s.text || '');
    return (
      '<button type="button" class="trig-card' + (s.id === cur ? ' on' : '') +
      '" data-style="' + s.id + '" title="' + escapeHtml(s.hint) + '">' +
      '<span class="trig-prev' + (s.round ? ' round' : '') + '">' + icon + '</span>' +
      '<span class="trig-name">' + escapeHtml(s.name) + '</span>' +
      '</button>'
    );
  }).join('');
}

/** 自定义 SVG 的检查结果：不通过时直接告诉用户卡在哪一条 */
function updateTriggerSvgMsg() {
  if (!els.trigSvgMsg) return;
  const raw = els.trigSvg.value.trim();
  if (!raw) {
    els.trigSvgMsg.hidden = true;
    els.trigSvgMsg.textContent = '';
    return;
  }
  const { svg, reason } = parseTriggerSvg(raw);
  els.trigSvgMsg.hidden = false;
  els.trigSvgMsg.className = 'trig-svg-msg' + (svg ? ' ok' : ' bad');
  els.trigSvgMsg.textContent = svg
    ? '这段用上了'
    : '这段没用上 —— ' + reason + '。改好之前按钮还是显示上面的预设。';
}

/* 预览活在自己的 shadow root 里，注入的是和真实按钮**同一份** TRIGGER_CSS ——
   这里看到什么样，页面上就是什么样。顺便也不会让预览的样式漏进设置页本身。 */
let previewRoot = null;

function ensurePreviewRoot() {
  if (previewRoot) return previewRoot;
  if (!els.trigPreview) return null;
  previewRoot = els.trigPreview.attachShadow({ mode: 'open' });
  previewRoot.innerHTML =
    '<style>' + TRIGGER_CSS + '</style>' +
    // 真实按钮是 fixed 定位、靠 .show 才显示；预览里让它老实待在框里
    '<style>.rt-trigger { position: relative; display: flex; }</style>' +
    '<div class="rt-trigger"><span class="rt-ico"></span></div>';
  return previewRoot;
}

function renderPreview() {
  const root = ensurePreviewRoot();
  if (!root || !state) return;

  const s = getTriggerStyle(state.settings.triggerStyle);
  const el = root.querySelector('.rt-trigger');
  const light = document.documentElement.dataset.theme === 'light';
  const size = Math.min(72, clampTriggerSize(state.settings.triggerSize));

  el.className = 'rt-trigger s-' + s.id + (light ? ' light' : '');
  el.style.setProperty('--rt-tr-size', size + 'px');
  el.style.setProperty('--rt-tr-radius', s.round ? (size * 0.29).toFixed(2) + 'px' : '50%');
  el.style.setProperty('--rt-tr-font', (size * 0.47).toFixed(2) + 'px');
  // 和 content.js 一样：自己填的 SVG 优先，底座仍按选中的预设
  const custom = parseTriggerSvg(state.settings.triggerSvg).svg;
  root.querySelector('.rt-ico').innerHTML = custom || s.svg || escapeHtml(s.text || '');
}

/** 设置页自己也跟着主题走（划词面板由 content.js 单独处理） */
function applyTheme() {
  const t = (state && state.settings && state.settings.theme) || 'auto';
  let dark = true;
  if (t === 'light') dark = false;
  else if (t === 'auto') {
    const q = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
    dark = q ? !q.matches : true;
  }
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  renderPreview(); // 预览里的按钮底色也跟着主题变
}

function bindSettings() {
  // 选项要先填好，renderSettings 才摆得对（它靠 select.value 回填）
  fillTargetLangOptions();
  bindTargetLang();

  for (const [sel, [, key, kind]] of Object.entries(SETTING_MAP)) {
    const el = $(sel);
    el.addEventListener('input', () => {
      if (kind === 'checked') state.settings[key] = el.checked;
      else if (kind === 'number') state.settings[key] = Number(el.value) || 0;
      else state.settings[key] = el.value;
      scheduleSave();
      if (key === 'theme') applyTheme();
      // 按钮的大小 / 自定义图标都是即时可见的，改一下就刷一次预览
      if (key === 'triggerSize') renderPreview();
      if (key === 'triggerSvg') {
        updateTriggerSvgMsg();
        renderPreview();
      }
    });
  }

  els.trigStyles.addEventListener('click', (e) => {
    const card = e.target.closest('.trig-card');
    if (!card) return;
    state.settings.triggerStyle = card.dataset.style;
    renderTriggerStyles();
    renderPreview();
    scheduleSave();
  });

  // 示例图标 / 清空：都走 input 事件，保存和预览跟着走同一套
  const setTriggerSvg = (value) => {
    els.trigSvg.value = value;
    els.trigSvg.dispatchEvent(new Event('input', { bubbles: true }));
  };
  els.btnTrigSvgDemo.addEventListener('click', () => setTriggerSvg(TRIGGER_SVG_SAMPLE));
  els.btnTrigSvgClear.addEventListener('click', () => setTriggerSvg(''));

  $('#btn-reset').addEventListener('click', async () => {
    if (!confirm('会删掉你所有自定义配置，恢复成内置的那几条。确定？')) return;
    await chrome.storage.local.remove('state');
    state = await loadState();
    editingId = state.activeConfigId;
    editingOcrId = state.ocr.activeId;
    renderConfigList();
    renderEditor();
    renderOcrList();
    renderOcrEditor();
    renderVars();
    renderSettings();
    setSaveStatus('已恢复默认');
  });
}

/* ------------------------------------------------------------------ */
/* 导入导出                                                            */
/* ------------------------------------------------------------------ */

function bindImportExport() {
  $('#btn-export').addEventListener('click', () => {
    collectEditor();
    const blob = new Blob([exportState(state)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'request-translate-config.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  $('#btn-import').addEventListener('click', () => els.fileImport.click());

  els.fileImport.addEventListener('change', async () => {
    const file = els.fileImport.files && els.fileImport.files[0];
    els.fileImport.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const parsed = importState(text);
      if (!confirm(`导入 ${parsed.configs.length} 条配置？当前的配置会被替换。`)) return;

      state = { ...state, ...parsed };
      editingId = state.activeConfigId = state.configs[0].id;
      editingOcrId = state.ocr.activeId;
      // 先按新 state 重画，再落盘 —— persist() 会把编辑器里的值收回去，
      // 顺序反了就是把「上一条」的内容写进「新导入的那条」里
      renderConfigList();
      renderEditor();
      renderOcrList();
      renderOcrEditor();
      renderVars();
      renderSettings();
      await persist();
      setSaveStatus('导入完成');
    } catch (err) {
      alert('导入失败：' + (err && err.message));
    }
  });
}

/* ------------------------------------------------------------------ */
/* 保存                                                                */
/* ------------------------------------------------------------------ */

function scheduleSave() {
  clearTimeout(saveTimer);
  setSaveStatus('编辑中…');
  saveTimer = setTimeout(() => persist(), 700);
}

function flushEditor() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
    collectEditor();
    persist(false);
  }
}

async function persist(showStatus = true) {
  clearTimeout(saveTimer);
  saveTimer = null;
  // 存之前把两个编辑器都收一遍：谁在打字谁就得落盘
  collectEditor();
  collectOcrEditor();
  await saveState(state);
  if (showStatus) flashSaved();
}

function setSaveStatus(text, saved = false) {
  els.saveStatus.textContent = text;
  els.saveStatus.classList.toggle('saved', saved);
}

let savedTimer = null;
function flashSaved() {
  const t = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  setSaveStatus(`已保存 ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`, true);
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => setSaveStatus(''), 2500);
}

/* ------------------------------------------------------------------ */
/* 目标语言：下拉挑预设，「其他」自己填                                   */
/* 候选只有一处真相源（lib/template.js 的 TARGET_PRESETS）                */
/* HTML 里那个 select 是空容器，选项在这儿填 —— 别再去 HTML 手抄一份      */
/* ------------------------------------------------------------------ */

// 下拉里「自己填」那一项的 value。真语言名 / 代码都不可能是这个样子，
// 所以拿它当哨兵很安全。
const LANG_OTHER = '__other__';

/** 选项：常用语言名 + 几个地区变体 + 末尾的「其他」 */
function fillTargetLangOptions() {
  for (const name of TARGET_PRESETS) {
    els.langSelect.appendChild(newOption(name, name));
  }
  els.langSelect.appendChild(newOption(LANG_OTHER, '其他（自己填）'));
}

function newOption(value, text) {
  const opt = document.createElement('option');
  opt.value = value;
  opt.textContent = text;
  return opt;
}

/** 把存档里的值摆到界面上：在预设里就选中它，不在就当「其他」放进输入框 */
function renderTargetLang() {
  const cur = String(state.settings.targetLang || '');
  if (cur && !TARGET_PRESETS.includes(cur)) {
    els.langSelect.value = LANG_OTHER;
    els.langOther.value = cur;
    els.langOther.hidden = false;
  } else {
    els.langSelect.value = cur || TARGET_PRESETS[0];
    els.langOther.hidden = true;
  }
}

function setTargetLang(value) {
  state.settings.targetLang = value;
  scheduleSave();
  updatePreview();
}

function bindTargetLang() {
  els.langSelect.addEventListener('input', () => {
    if (els.langSelect.value === LANG_OTHER) {
      els.langOther.hidden = false;
      els.langOther.focus();
      // 框里还留着上次填的就接着用；空着先不动存档 ——
      // 等用户打第一个字再改（下面那个监听），免得 {{target}} 变成空串
      const kept = els.langOther.value.trim();
      if (kept) setTargetLang(kept);
      return;
    }
    els.langOther.hidden = true;
    setTargetLang(els.langSelect.value);
  });

  els.langOther.addEventListener('input', () => {
    // 只敲了空格等于没填，别把存档里的语言冲掉
    const v = els.langOther.value.trim();
    if (v) setTargetLang(v);
  });
}

window.addEventListener('beforeunload', () => {
  if (saveTimer) {
    clearTimeout(saveTimer);
    collectEditor();
    collectOcrEditor();
    saveState(state);
  }
});
