/**
 * 设置页逻辑
 */

/* 样式表来自 lib/panel-core.js（唯一真相源，它先于 options.js 加载）：
   const { PANEL_CSS } = window.RTPanelCore; */
import {
  loadState,
  saveState,
  buildVars,
  exportState,
  importState,
  moveItem,
  moveVisibleItem,
  dropIndex,
  canTranslateImage,
  PANEL_OWNED_SETTING_KEYS,
  adoptPanelOwned,
  getConfig
} from './lib/store.js';

/* 两个样式表都由 lib/panel-core.js 提供（普通脚本、挂在 window.RTPanelCore 上，
   options.html 里它在 options.js 之前加载）。以前是 import 两个 module，现在一处。
   原因见 lib/panel-core.js 头注：content script 不能 import，样式表必须能两边共用。 */
const { TRIGGER_CSS, PANEL_CSS } = window.RTPanelCore;

/* 文案查表。lib/i18n.js 是普通脚本、在 options.html 里排在 options.js 之前；
   万一没加载，回落成中文原文 —— 设置页不能因为少一个文件就显示成 key。 */
function T(key, fallback, params) {
  const api = window.RTI18n;
  if (api && typeof api.t === "function") {
    // params 走 i18n 的 $1 $2 替换（同 chrome.i18n 的写法），数字位置由译文决定
    const got = api.t(key, params);
    if (got && got !== key) return got;
  }
  return fallback;
}
/* 「主请求 + 后备」那套链函数住在 lib/requests.js —— 配置和 OCR 供应商共用
   （store.js 和 ocr.js 都 import 它，谁也不用反过来依赖谁）。 */
import { uid, allRequests, requestChain, requestTemplateFor } from './lib/requests.js';
import { runRequest, previewRequest } from './lib/engine.js';
import { encryptExport, decryptExport, isEncryptedExport } from './lib/crypto.js';
import { ADAPTERS } from './lib/adapters.js';
import { BUILTIN_VAR_HINTS, VAR_HINT_KEYS, TARGET_PRESETS, isSecretVar, modelCandidates, modelVarFor } from './lib/template.js';
import {
  toDataUrl,
  pickImageMime,
  NO_IMAGE_MESSAGE,
  CLIPBOARD_UNAVAILABLE_MESSAGE
} from './lib/clipboard.js';
import { TRIGGER_STYLES, TRIGGER_SVG_SAMPLE, getTriggerStyle, clampTriggerSize, parseTriggerSvg } from './lib/trigger-styles.js';
import {
  OCR_PROVIDERS,
  BUILTIN_OCR_IDS,
  normalizeOcrProvider,
  normalizeOcrItem,
  previewOcrRequest,
  runOcr,
  runImageTranslate
} from './lib/ocr.js';

/* ---- 状态 ---- */

let state = null;
let editingId = '';
let editingOcrId = '';
let saveTimer = null;
/** 这次会话里**用户在设置页改过**的那几个「面板也会写」的键（见 adoptPanelOwned） */
const panelTouched = new Set();
/** OCR 测试要用的那张本地图片（没选就用剪切板里的） */
let ocrTestFile = null;
/** 最后一处获得焦点的模板输入框（文字 / 图片两个框共用一排标签） */
let focusedTemplate = null;
/** 每个请求块展开还是收起（块 id → 布尔）。**没记过的一律收起（主请求也一样，
    kniph 2026-10-13 定的；判据见 foldOpen）**。纯界面状态，不进存档。 */
let blockFold = new Map();

const $ = (sel) => document.querySelector(sel);

const els = {
  cfgList: $('#cfg-list'),
  editor: $('#editor'),
  emptyHint: $('#empty-hint'),
  /* 右栏头部容器：里面那一套（说明槽 → 名称 → 说明槽）是 `editorHeadHtml()` 画的，
     两栏共用 —— 所以 `#f-name` / `#o-name` / `#o-note` 也得等画完再取（见 init）。 */
  cfgHead: $('#cfg-head'),
  name: null,
  // 主请求 + 后备请求都渲染在这个容器里（同一套模板，见 renderBlocks）
  blocks: $('#req-blocks'),
  btnAddFallback: $('#btn-add-fallback'),
  trigStyles: $('#trig-styles'),
  trigSvg: $('#s-trigsvg'),
  trigSvgMsg: $('#s-trigsvg-msg'),
  btnTrigSvgDemo: $('#btn-trigsvg-demo'),
  btnTrigSvgClear: $('#btn-trigsvg-clear'),
  trigPreview: $('#trig-preview'),
  preview: $('#f-preview'),
  testText: $('#test-text'),
  testResult: $('#test-result'),
  varsBody: $('#vars-body'),
  builtinBody: $('#builtin-body'),
  fileImport: $('#file-import'),
  chkEncrypt: $('#chk-encrypt'),
  panelCss: $('#s-panelcss'),
  btnPanelCssWarm: $('#btn-panelcss-warm'),
  btnPvOpen: $('#btn-pv-open'),
  btnPanelCssClear: $('#btn-panelcss-clear'),
  passDialog: $('#pass-dialog'),
  langSelect: $('#s-lang'),
  langOther: $('#s-lang-other'),

  // OCR
  ocrList: $('#ocr-list'),
  // 勾了「禁用外置 OCR」时，左栏换成这个 —— 列的是「填了图片请求模板」的配置
  imgcfgList: $('#imgcfg-list'),
  imgcfgFoot: $('#imgcfg-foot'),
  ocrHead: $('#ocr-head'),
  imgcfgHint: null,
  oName: null,
  oNote: null,
  ocrListTitle: $('#ocr-list-title'),
  ocrEditor: $('#ocr-editor'),
  ocrEmpty: $('#ocr-empty'),
  // OCR 供应商也是「主请求 + 后备」—— 和配置栏**同一套请求块**（blockHtml），只是少两项字段
  ocrBlocks: $('#ocr-blocks'),
  btnOcrAddFallback: $('#btn-ocr-add-fallback'),
  oPreview: $('#o-preview'),
  oDisabled: $('#o-disabled'),
  btnOcrNew: $('#btn-ocr-new'),
  btnOcrDuplicate: $('#btn-ocr-duplicate'),
  btnOcrDelete: $('#btn-ocr-delete'),
  ocrTestImg: $('#ocr-test-img'),
  ocrTestBtn: $('#btn-ocr-test'),
  ocrTestResult: $('#ocr-test-result'),
  oPreviewSummary: $('#o-preview-summary'),
  oTestLabel: $('#o-test-label'),
  ocrTestHint: $('#ocr-test-hint'),
  imgcfgTestHint: $('#imgcfg-test-hint')
};

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---- 启动 ---- */

init().catch((err) => {
  document.body.innerHTML =
    '<pre style="padding:24px;color:#f87171">' + T('opt_err_boot', '设置页初始化失败：') + escapeHtml(err && err.message) + '</pre>';
});

async function init() {
  const i18nApi = window.RTI18n;
  state = await loadState();

  /* HTML 里带 data-i18n / data-i18n-title / data-i18n-ph 的节点在这里统一填。
     只做一次：那些文案是静态的，后续重渲染不会碰它们。 */
  if (i18nApi && i18nApi.applyI18n) i18nApi.applyI18n(document);

  editingId = state.activeConfigId;
  editingOcrId = state.ocr.activeId;

  /* 头部（说明槽 → 名称 → 说明槽）两栏共用一份，先画出来 —— 里面那几个输入框
     是后面所有绑定要用的，晚一步取就是 null。 */
  renderEditorHeads();

  bindTabs();
  bindConfigList();
  bindEditor();
  bindOcr();
  bindVars();
  bindSettings();
  bindImportExport();

  renderConfigList();
  renderEditor();
  renderOcrList();
  renderOcrEditor();
  renderVars();
  renderSettings();
  syncGroupCounts();
  renderPanelPreview();
  applyHintHides();

  /* 收尾再填一次 —— 上面那些 renderXxx 会新建节点（编辑器头部、列表、预览），
     它们里面的 data-i18n 在第一次 applyI18n 时还不存在。
     这里补一次最省事，也比在每个 render 里各调一次好维护。 */
  if (i18nApi && i18nApi.applyI18n) i18nApi.applyI18n(document);
  /* ⚠️ 必须再跑一次 applyHintHides：上面的 applyI18n 里，data-i18n-html 那条会
     用 innerHTML 整段覆盖，把之前 applyHintHides 挂上去的「不再显示」按钮一起抹掉。
     它是幂等的（已经有 .hint-hide 就跳过），重复调用没有副作用。 */
  applyHintHides();
}

/* ---- 右栏头部：两栏**共用这一份** ----

   结构固定是「一句说明 → 名称 → 一句说明」，每一段说明待在一个**固定占位的槽**里
   （`.hint-slot`，见 options.css）。两栏各传自己的句子和 id，剩下的结构 / 类名 / 槽全在一处。

   为什么要抽成一个函数（kniph 2026-10-14：「你完全可以把代码进行一个复用啊」）：
   原来两栏各写一份，于是「配置栏靠多加一句话、OCR 栏靠给备注留 min-height」这种
   一边一套的补丁就长出来了 —— 顾头不顾尾，两边行数一变就出现高度差。现在只有一处
   能改，改了两边一起变，**想让它们不齐都做不到**。

   槽为什么必须固定占位：说明**能被用户收掉**（`.hint-off` = `display: none`）、
   备注**时有时无**（自建那条是空的）—— 靠文字的自然高度凑，一收一空就散了。 */
function editorHeadHtml({ nameId, placeholder, top, bottom }) {
  const hint = (h) =>
    `<p class="hint wide"${h.id ? ` id="${h.id}"` : ''}` +
    `${h.hint ? ` data-hint="${h.hint}"` : ''}${h.hidden ? ' hidden' : ''}` +
    `${h.htmlKey ? ` data-i18n-html="${h.htmlKey}"` : ''}>${h.html || ''}</p>`;
  return `
    <div class="hint-slot">${top.map(hint).join('')}</div>
    <div class="editor-head">
      <div class="field grow">
        <label for="${nameId}">${T('opt_label_name', '名称')}</label>
        <input id="${nameId}" type="text" placeholder="${escapeHtml(placeholder)}" autocomplete="off">
      </div>
    </div>
    <div class="hint-slot">${hint(bottom)}</div>`;
}

/* `top` 里可以放**互斥**的几句（直传 / 不走直传），同一个槽 —— 换哪句都不影响下面的位置。 */
function renderEditorHeads() {
  els.cfgHead.innerHTML = editorHeadHtml({
    nameId: 'f-name',
    placeholder: T('opt_ph_cfgname', '例如：DeepSeek 翻译 / 本地 Ollama'),
    top: [
      {
        hint: 'cfg-intro',
        htmlKey: 'opt_cfg_intro',
        html: T('opt_cfg_intro', '照着内置那条改：换地址、模型名、提示词，<b>占位符别动</b>。')
      }
    ],
    bottom: {
      hint: 'cfg-requests',
      htmlKey: 'opt_cfg_requests',
      html: T('opt_cfg_requests', '一条配置能挂好几条请求：<b>主请求</b>先发，它挂了就按顺序试勾上的<b>后备请求</b>。')
    }
  });

  els.ocrHead.innerHTML = editorHeadHtml({
    nameId: 'o-name',
    placeholder: T('opt_ph_ocrname', '例如：硅基流动'),
    top: [
      {
        id: 'o-hint',
        hint: 'ocr',
        htmlKey: 'opt_ocr_intro',
        html: T('opt_ocr_intro', '<b>「翻译剪切板中的截图」</b>和<b>「框选截图翻译」</b>都先用这里<b>选中</b>的配置把图转成文字，再交给「配置」翻译。')
      },
      {
        id: 'imgcfg-hint',
        hint: 'imgcfg',
        hidden: true,
        htmlKey: 'opt_ocr_direct_intro',
        html: T('opt_ocr_direct_intro', '现在是<b>图片直传</b>：截图不过 OCR，直接交给左边选中那条的<b>「图片请求模板」</b>去翻。')
      }
    ],
    /* 这一条的备注（内置那几条自带，只读；自建那条是空的）。跟着选中项走，
       放在名称旁边 —— 以前在整栏最底下，等看见它时人早就写完了。 */
    bottom: { id: 'o-note' }
  });

  /* 上面刚画出来的那几个，画完才有 —— 用容器里的 querySelector 取。
     ⚠️ 别在别处按 id 直接取它们：check-dom 会拿那个 id 去 HTML 里找、找不着就报错
     （它认的是「HTML 里写死的 id」，认不到脚本拼出来的 —— class 那边倒是认）。 */
  els.name = els.cfgHead.querySelector('#f-name');
  els.oName = els.ocrHead.querySelector('#o-name');
  els.oNote = els.ocrHead.querySelector('#o-note');
  els.imgcfgHint = els.ocrHead.querySelector('#imgcfg-hint');
}

/* ---- Tab ---- */

function bindTabs() {
  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('is-active', b === btn));
      document.querySelectorAll('.tabpanel').forEach((p) => {
        p.classList.toggle('is-active', p.dataset.panel === btn.dataset.tab);
      });
      // 「图片配置」那个列表是配置栏那份数据的**过滤视图**：刚在配置栏填过 / 清空过
      // 图片模板的话，切回来得重算一次，不然这边还停在上一版（预览同理）
      if (btn.dataset.tab === 'ocr' && state.ocr && state.ocr.disabled) {
        renderImageConfigList();
        renderOcrPreview();
      }
      // 变量栏的值输入框是按内容撑高的，但藏着的标签量不到高度 —— 显示出来了补量一次，
      // 不然存档里的多行值还缩在一条缝里（kniph 报过）
      if (btn.dataset.tab === 'vars') growVarValues();
      // 设置页签刚显示出来 —— 之前藏着的预览量不到尺寸，这里补画一次
      if (btn.dataset.tab === 'settings' && pvNeedsRender) renderPanelPreview();
    });
  });
}

/* ---- 配置列表 ---- */

/* 拖动手柄的图标（两列三点）。真正的手柄只有一个 10×14 的 svg，
   点上去别的地方不响应 —— 见下面 .cfg-grip 的说明 */
const GRIP_SVG =
  '<svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">' +
  '<circle cx="3" cy="2" r="1.15"/><circle cx="7" cy="2" r="1.15"/>' +
  '<circle cx="3" cy="7" r="1.15"/><circle cx="7" cy="7" r="1.15"/>' +
  '<circle cx="3" cy="12" r="1.15"/><circle cx="7" cy="12" r="1.15"/>' +
  '</svg>';

/* 变量值那一列的眼睛（睁眼 = 点一下显示，划斜杠 = 点一下藏回去）。
   用 SVG 不用 emoji：这几个字号的 emoji 在 Windows 上会被渲染成彩色的。 */
const EYE_SVG =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
  'stroke-width="1.3" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M1.6 8s2.5-4.3 6.4-4.3S14.4 8 14.4 8s-2.5 4.3-6.4 4.3S1.6 8 1.6 8Z"/>' +
  '<circle cx="8" cy="8" r="1.8"/></svg>';
/**
 * 预览的缩放比与假想视口高度。
 *
 * 真面板宽度可以到 1600px，塞不进设置页 —— 整体乘一个统一的比例缩下来，
 * **所有量共用同一个比例**，这样预览里「宽 460 : 字号 20」的比值和真面板一致。
 * 以前三个量各乘各的（0.45 / 0.75 / …），所以看着对不上（kniph 2026-10-17）。
 */
const PV_SCALE = 0.42;
/** 换算 vh 用的假想视口高度（真面板按浏览器窗口算，预览没窗口可用） */
const PV_VIEWPORT_H = 800;

/** 「面板显示条数」的取值范围（1~4）。**只在这里写一次** ——
 *  原来这个夹取散在 6 处（store 归一化 / 设置页读 / 写 / 两处业务判断 / 预览），
 *  改上限时漏一处就会打架（kniph 2026-10-17 通读时指出）。 */
const SLOT_MIN = 1;
const SLOT_MAX = 4;
const clampSlots = (v) => Math.min(SLOT_MAX, Math.max(SLOT_MIN, Math.round(Number(v)) || SLOT_MIN));

/** 改这些设置会直接影响面板外观 → 触发预览重画 */
const PREVIEW_KEYS = new Set(['fontSize', 'panelWidth', 'panelHeight', 'panelMaxHeight', 'panelCss']);

const EYE_OFF_SVG =
  '<svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
  'stroke-width="1.3" stroke-linecap="round" aria-hidden="true">' +
  '<path d="M1.6 8s2.5-4.3 6.4-4.3S14.4 8 14.4 8s-2.5 4.3-6.4 4.3S1.6 8 1.6 8Z"/>' +
  '<circle cx="8" cy="8" r="1.8"/><path d="M3.2 12.8 12.8 3.2"/></svg>';

/**
 * 「配置变了」之后的统一收尾：重画左栏 + 重画编辑器 + 落盘。
 *
 * 这三步在 4 处（新建 / 删除 / 切选中 / 改名）连着出现 —— 抽出来，
 * 以后多一个「跟着配置变」的面板只改这一处，不会漏（kniph 2026-10-17 通读）。
 *
 * `save` 传 false 时只重画不落盘（调用方自己已经在存 / 不想立刻存）。
 */
function refreshConfigViews(save = true) {
  renderConfigList();
  renderEditor();
  if (save) persist(false);
}

function renderConfigList() {
  const total = state.configs.length;
  els.cfgList.innerHTML = '';

  state.configs.forEach((cfg, idx) => {
    els.cfgList.appendChild(sortableRow({
      id: cfg.id,
      name: cfg.name,
      sub: summarizeUrl(cfg.request, T('opt_empty', '(空)')),
      active: cfg.id === editingId,
      inCompare: slotConfigIds().includes(cfg.id),
      index: idx,
      total,
      listEl: els.cfgList,
      onSelect: () => selectConfig(cfg.id),
      onMove: moveConfig,
      onAddToCompare: toggleSlotConfig,
      onRemoveFromCompare: (cid) => toggleSlotConfig(cid, { force: false })
    }));
  });
  syncSlotsHint();
}

/** 当前参与对比的配置 id（存档里的 slotConfigs；空表 = 只用当前选中那条） */
function slotConfigIds() {
  return Array.isArray(state.settings.slotConfigs) ? state.settings.slotConfigs : [];
}

/* 图片直传那一屏的对比名单**单独一份**（settings.imageSlotConfigs）。
   和文字那份互不覆盖：两屏各有各的池子（文字=全部配置，图片=填了图片模板的），
   共用一份的话来回切一次就把对方的组合顶掉了（2026-10-18）。 */
function imgSlotConfigIds() {
  return Array.isArray(state.settings.imageSlotConfigs) ? state.settings.imageSlotConfigs : [];
}

/**
 * 把一条配置加入 / 移出对比集合。
 *
 * **多条可以同时亮** —— 这就是「显示 X 条」的那个 X（kniph 2026-10-17 定的：
 * 以前列表里只能亮一条 = 单选，现在要能亮 X 条）。
 * 上限跟着「面板显示条数」走：满了再加就顶掉最前面那条（和面板里的规矩一致）。
 * 全空 = 只用当前选中的那条（老行为，升级看不出变化）。
 *
 * **存下来的顺序始终按配置列表的顺序排**（kniph 2026-10-17：面板的默认顺序要和
 * 设置里一样）—— 所以写入前统一过一遍 `sortByConfigOrder`，而不是按点击先后 append。
 */
/**
 * 把一条**图片配置**加入 / 移出「图片直传」那一屏的对比集合。
 *
 * 和 toggleSlotConfig 同形，只有两点不同：名单存在 `imageSlotConfigs`、
 * 上限仍跟着「面板显示条数」。重画的是图片配置那个列表。
 */
function toggleImgSlotConfig(id, opts) {
  const redraw = !(opts && opts.redraw === false);
  const cur = imgSlotConfigIds();
  const max = clampSlots(state.settings.panelSlots);
  const has = cur.includes(id);
  const force = opts && typeof opts.force === 'boolean' ? opts.force : !has;
  let next;
  if (force) {
    if (has) return;
    next = [...cur, id];
    if (next.length > max) next = next.slice(next.length - max);
  } else {
    if (!has) return;
    next = cur.filter((x) => x !== id);
  }
  // 顺序按配置列表排（和文字那份同一个规矩：面板默认顺序要跟设置一致）
  const order = state.configs.map((c) => c.id);
  next.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  state.settings.imageSlotConfigs = next;
  scheduleSave();
  if (redraw) renderImageConfigList();
}

function toggleSlotConfig(id, opts) {
  const redraw = !(opts && opts.redraw === false);
  const cur = slotConfigIds();
  const max = clampSlots(state.settings.panelSlots);
  const has = cur.includes(id);
  // opts 里 force 明确给值就用它（右键取消传 false）；否则按「点一下切换」来
  const force = opts && typeof opts.force === 'boolean' ? opts.force : !has;
  let next;
  if (force) {
    if (has) return;
    next = [...cur, id];
    if (next.length > max) next = next.slice(next.length - max); // 顶掉最早那条
  } else {
    if (!has) return;
    next = cur.filter((x) => x !== id);
  }
  state.settings.slotConfigs = sortByConfigOrder(next);
  // 左键那条路紧随其后会 selectConfig() 重画（传 redraw:false 就不在这里画，避免闪）
  if (redraw) renderConfigList();
  persist(false);
  setSaveStatus(next.length ? T('opt_compare', '对比 $1$ 条', [String(next.length)]) : T('opt_compare_cleared', '对比已清空'));
}

/** 把一组配置 id 按**设置页列表的当前顺序**排好（面板默认顺序靠它和设置一致） */
function sortByConfigOrder(ids) {
  const order = new Map(state.configs.map((c, i) => [c.id, i]));
  return ids.slice().sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
}

/** 条数改了之后，把超出的对比项裁掉并提示一句 */
function syncSlotsHint() {
  const max = clampSlots(state.settings.panelSlots);
  const cur = slotConfigIds();
  if (cur.length > max) {
    state.settings.slotConfigs = cur.slice(cur.length - max);
  }
}

/**
 * 列表里的一行 = 手柄 + 可点的主体 + 上下移。
 *
 * **三处左栏共用**（「配置」栏 / OCR 供应商 / 图片配置）—— 长得一样、操作也一样，
 * 各写一套迟早长歪（OCR 供应商那份原来是自己拼的裸按钮，行宽和另外两处都不一样）。
 * 只有手柄是拖拽源：整行可拖会跟「点一下选中」抢鼠标。
 *
 * 三处一律**都能排**（kniph 2026-10-14：「连排序的用处也统一」）。原来供应商那栏是
 * 「顺序没意义 → 摆两个同宽空位对齐」的特例，留着它就会长歪 —— 干脆没有这个分支。
 */
function sortableRow({ id, name, sub, active, inCompare, index, total, listEl, onSelect, onMove, onAddToCompare, onRemoveFromCompare }) {
  const row = document.createElement('div');
  row.className = 'cfg-row';
  row.dataset.id = id;

  const grip = document.createElement('span');
  grip.className = 'cfg-grip';
  grip.innerHTML = GRIP_SVG;
  grip.title = T('opt_drag_hint', '按住拖动，调整顺序');
  grip.setAttribute('aria-hidden', 'true'); // 键盘走右边的 ↑ ↓

  const btn = document.createElement('button');
  btn.type = 'button';
  // is-active = 正在编辑的那条（永远只有一条）；in-compare = 参与对比（可以多条）
  btn.className = 'cfg-item' + (active ? ' is-active' : '') + (inCompare ? ' in-compare' : '');

  const nameEl = document.createElement('div');
  nameEl.className = 'name';
  nameEl.textContent = name || T('opt_unnamed', '(未命名)');

  const subEl = document.createElement('div');
  subEl.className = 'sub';
  subEl.textContent = sub;

  btn.append(nameEl, subEl);
  /* 左键 = 选中来编辑；**已点亮的不再取消**（kniph 2026-10-17 报的：
     「左键可能只是想查看一下、改请求」，不该顺手把对比关掉）。
     所以左键只在「还没点亮」时加入对比；已经点亮了就只管切换编辑。
     取消对比一律走右键（明确的意图，见下）。
     **先改对比集合、再 onSelect** —— onSelect 里会 renderConfigList() 重画一次，
     那时读到的就是刚更新的 slotConfigs，所以不需要各自画一次（会闪）。 */
  btn.addEventListener('click', () => {
    if (!inCompare && typeof onAddToCompare === 'function') {
      onAddToCompare(id, { redraw: false });
    }
    if (typeof onSelect === 'function') onSelect();
  });
  /* 右键 = 取消这条的对比点亮（kniph 2026-10-17：「右键取消应用」）。
     不在对比里就不拦，交给浏览器（比如「在新标签打开」这类原生菜单）。 */
  if (typeof onRemoveFromCompare === 'function') {
    btn.addEventListener('contextmenu', (e) => {
      if (!inCompare) return;
      e.preventDefault();
      onRemoveFromCompare(id);
    });
  }

  const mv = document.createElement('div');
  mv.className = 'cfg-mv';
  mv.append(
    moveButton({ listEl, id, name, index, delta: -1, total, onMove }),
    moveButton({ listEl, id, name, index, delta: 1, total, onMove })
  );

  row.append(grip, btn, mv);
  return row;
}

/** 上移 / 下移按钮。头尾各禁用一边，省得点了没反应还不知道为什么 */
function moveButton({ listEl, id, name, index, delta, total, onMove }) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'cfg-mv-btn';
  b.dataset.mv = String(delta);
  b.textContent = delta < 0 ? '↑' : '↓';
  b.disabled = delta < 0 ? index === 0 : index === total - 1;
  const label = delta < 0 ? T('opt_move_up_word', '上移') : T('opt_move_down_word', '下移');
  b.title = label;
  b.setAttribute('aria-label', `${label}「${name || '未命名'}」`);

  b.addEventListener('click', () => {
    onMove(id, index + delta);
    // 重渲染之后把焦点还给同一个按钮 —— 连着按 ↑ 才不要每按一次就去找鼠标
    const again = listEl.querySelector(
      `.cfg-row[data-id="${id}"] .cfg-mv-btn[data-mv="${delta}"]`
    );
    if (again && !again.disabled) again.focus();
  });
  return b;
}

/**
 * 请求块的公共点击行为 —— **配置栏和 OCR 栏共用**（两栏的块是同一个 `blockHtml` 画的）。
 *
 * 两件事：
 *   1. **点块头折叠 / 展开**（整条标题栏，和页面上所有 `<details>` 一个手势）。
 *      右上角那枚 ▾ 只是**指示器**：它仍是 button（键盘要有个能 Tab 到的东西），
 *      点它照样冒泡到这条路上，不会再单独折一次。勾选 / ↑↓× 是块头里的控件，碰它们不折叠。
 *   2. 后备块的 ↑↓×：挪位置、删掉。名字按位置现算（存档里不存 `name`，见 `allRequests`）。
 *
 * `collect()` 把界面写回数据（返回顶层那条），`render()` 按新数据重画 + 刷预览。
 * 以前这两套逻辑在配置栏里写死，OCR 栏要再抄一份 —— 那就是「OCR 只能填一条请求」的由来。
 *
 * ⚠️ 解构的参数放**第一个**（`{ collect, render }, container`）：`check-globals` 只认
 * `function f({ a, b })` 这种「花括号紧跟在括号后」的写法，放第二个参数它就把
 * `collect` / `render` 报成「没定义」（`moveButton({ … })` 同一个原因，见 TESTING.md）。
 */
/** 请求块的输入事件（打字 / 下拉 / 勾选框）。
    请求块是动态画的 → 事件全挂容器上（委托），别在每个块上各挂一遍。
    两栏是同一个 `blockHtml` 画的，这套委托也共用一份 —— 只差 `after` 里各刷新什么。 */
function bindBlockInputs(container, after) {
  container.addEventListener('input', (e) => {
    if (e.target.classList.contains('rb-request')) {
      // 块头那句「这条打到哪儿」跟着请求模板走（收起时全靠它认人）
      const node = e.target.closest('.req-block');
      const b = readBlock(node);
      node.querySelector('.rb-sub').textContent = blockSummary(b, b.kind);
    }
    after();
  });
  container.addEventListener('change', (e) => {
    const t = e.target;
    if (t.classList.contains('rb-enable')) {
      // 勾掉了整块压暗：一眼看出这条不参与
      t.closest('.req-block').classList.toggle('rb-off', !t.checked);
    }
    after();
  });
}

function bindBlockActions({ collect, render }, container) {
  container.addEventListener('click', (e) => {
    const head = e.target.closest('.rb-head');
    if (head && !e.target.closest('.rb-on, .rb-mini')) {
      const node = head.closest('.req-block');
      const open = node.classList.toggle('open');
      blockFold.set(node.dataset.id, open);
      return;
    }

    const btn = e.target.closest('button');
    const node = btn && btn.closest('.req-block');
    if (!btn || !node) return;
    const cfg = collect();
    if (!cfg) return;
    const i = (cfg.fallbacks || []).findIndex((f) => f.id === node.dataset.id);

    if (btn.classList.contains('rb-del') && i >= 0) {
      const item = cfg.fallbacks[i];
      if (item.request.trim() && !confirm(`删掉「后备 ${i + 1}」？此操作不可撤销。`)) return;
      cfg.fallbacks.splice(i, 1);
      blockFold.delete(item.id);
    } else if (btn.classList.contains('rb-up') && i > 0) {
      // moveItem 返回新数组（它不改原数组），别忘了接回来
      cfg.fallbacks = moveItem(cfg.fallbacks, i, i - 1);
    } else if (btn.classList.contains('rb-down') && i >= 0 && i < cfg.fallbacks.length - 1) {
      cfg.fallbacks = moveItem(cfg.fallbacks, i, i + 1);
    } else {
      return; // 点的是别的按钮，没有可处理的
    }

    /* 上/下移之后把焦点还给同一个位置的同名按钮（左栏 moveButton 的先例）——
       整批重画会掉焦点，键盘用户连按第二下 ↑ 得重新 Tab 一长串。删除不用还（那条没了）。 */
    const movedBtn = btn.classList.contains('rb-up') || btn.classList.contains('rb-down');

    render();
    persist();

    if (movedBtn) {
      const again = container.querySelector(
        `.req-block[data-id="${node.dataset.id}"] .rb-${btn.classList.contains('rb-up') ? 'up' : 'down'}`
      );
      if (again) again.focus();
    }
  });
}

/** 把一条配置挪到新位置（`to` 是**完整数组**里、移除之后的坐标），重渲染 + 落盘 */
function moveConfig(id, to) {
  flushEditor();
  const from = state.configs.findIndex((c) => c.id === id);
  if (from < 0) return false;
  const next = moveItem(state.configs, from, to);
  if (next === state.configs) return false; // 原地没动
  state.configs = next;
  /* 配置顺序变了 → 对比名单也要跟着重排（面板的默认顺序 = 设置里的顺序，
     kniph 2026-10-17）。不重排的话拖一次顺序，面板里那几条就还是老次序。 */
  state.settings.slotConfigs = sortByConfigOrder(slotConfigIds());
  renderConfigList();
  persist();
  return true;
}

/** 指针落在哪一行、上半区还是下半区。用坐标算，不做命中测试 ——
    拖动时指针是「抓」在手柄上的，elementFromPoint 只会把手柄自己还回来 */
function dropSpot(listEl, y, itemSel) {
  const rows = [...listEl.querySelectorAll(itemSel)];
  if (!rows.length) return null;
  for (const row of rows) {
    const b = row.getBoundingClientRect();
    if (y < b.bottom) return { row, after: y > b.top + b.height / 2 };
  }
  // 拖到列表下方的空白处 = 放到最后
  return { row: rows[rows.length - 1], after: true };
}

/**
 * 拖动排序（三个左栏 + 变量卡片共用）。
 *
 * 用 pointer 事件而不是 HTML5 的 `draggable` —— 后者在触屏上不触发，原生拖影也脏；
 * 代价是插入指示线得自己画（见 options.css）。
 * `applyMove(id, to)` 的 `to` 是**屏幕上这个列表**里的下标（「图片配置」是过滤视图的，自己再换算）。
 *
 * `opts.grid` = 变量卡片那种**二维网格**：一行的卡 Y 相同，按 Y 算落点会分不清落在哪一列，
 * 所以改成「离指针最近的卡 + 它左半边还是右半边」。同一个函数，不另写第二套。
 */
function bindSortDrag(listEl, applyMove, opts = {}) {
  const ITEM = opts.itemSel || '.cfg-row';
  const GRIP = opts.gripSel || '.cfg-grip';
  const isGrid = !!opts.grid;
  let drag = null; // { id, pointerId, y0, y, x, moved }

  const clearMarks = () => {
    for (const row of listEl.querySelectorAll(ITEM)) {
      row.classList.remove('dragging', 'drop-before', 'drop-after');
    }
  };

  /** 网格落点：离指针最近的卡，看指针在它左半边还是右半边。
      找不到（指针在所有卡外面）就退回按 Y 找第一行 —— 至少给个能落的地方。 */
  const gridSpot = (x, y) => {
    const cards = [...listEl.querySelectorAll(ITEM)];
    if (!cards.length) return null;
    let best = null;
    let bestD = Infinity;
    for (const c of cards) {
      const b = c.getBoundingClientRect();
      // 指针到卡片矩形中心的距离（卡片小，用中心比用边距准）
      const d = Math.hypot(x - (b.left + b.width / 2), y - (b.top + b.height / 2));
      if (d < bestD) {
        bestD = d;
        best = { row: c, after: x > b.left + b.width / 2 };
      }
    }
    return best;
  };

  const spotAt = (x, y) => (isGrid ? gridSpot(x, y) : dropSpot(listEl, y, ITEM));

  listEl.addEventListener('pointerdown', (e) => {
    const grip = e.target instanceof Element ? e.target.closest(GRIP) : null;
    if (!grip || e.button !== 0) return;
    e.preventDefault(); // 别顺手选中文字，也别触发浏览器自己的选择 / 拖拽
    drag = {
      id: grip.closest(ITEM).dataset.id,
      pointerId: e.pointerId,
      y0: e.clientY,
      x0: e.clientX,
      y: e.clientY,
      x: e.clientX,
      moved: false
    };
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {
      /* 拿不到指针也不影响：pointermove 照样会冒泡上来 */
    }
  });

  listEl.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.y = e.clientY;
    drag.x = e.clientX;
    // 先给个抖动阈值：只是点了一下手柄、手晃了 2px，不该算拖动
    if (!drag.moved) {
      // 网格里两个方向都算位移 —— 只想横着换列（同一行内挪）也算拖动
      const d = isGrid
        ? Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0)
        : Math.abs(e.clientY - drag.y0);
      if (d < 4) return;
      drag.moved = true;
      listEl.classList.add('is-dragging');
    }

    const spot = spotAt(e.clientX, e.clientY);
    clearMarks();
    if (!spot) return;
    spot.row.classList.add(spot.after ? 'drop-after' : 'drop-before');
    const self = listEl.querySelector(`[data-id="${drag.id}"]`);
    if (self) self.classList.add('dragging');
  });

  const finish = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    listEl.classList.remove('is-dragging');
    clearMarks();
    if (!d.moved) return; // 只是点了一下手柄，什么都没发生

    const spot = spotAt(d.x, d.y);
    if (!spot) return;
    const ids = [...listEl.querySelectorAll(ITEM)].map((r) => r.dataset.id);
    const to = dropIndex(ids, d.id, spot.row.dataset.id, spot.after);
    if (to < 0) return;
    applyMove(d.id, to);
  };

  listEl.addEventListener('pointerup', finish);
  // 指针拖到列表外面才松手时也要收尾 —— 万一 setPointerCapture 没成功，
  // 事件就落不到 listEl 上了，drag 会一直挂着，下一次 pointermove 会接着上次的拖
  window.addEventListener('pointerup', finish);
  const abort = () => {
    if (!drag) return;
    drag = null;
    listEl.classList.remove('is-dragging');
    clearMarks();
  };
  listEl.addEventListener('pointercancel', abort);
  window.addEventListener('pointercancel', abort);
}

/** 列表里那行小字：请求模板里第一个 URL，够认人就行。
    `empty` 是「没填」时那句提示，两处用词不同（翻译配置 / OCR 供应商）。 */
function summarizeUrl(text, empty) {
  const m = String(text || '').match(/https?:\/\/[^\s'"\\]+/);
  if (!m) return empty;
  const url = m[0].replace(/^https?:\/\//, '');
  return url.length > 40 ? url.slice(0, 40) + '…' : url;
}

function selectConfig(id) {
  flushEditor();
  editingId = id;
  state.activeConfigId = id;
  refreshConfigViews();
}

/* ---- 编辑器 ---- */

function currentConfig() {
  return state.configs.find((c) => c.id === editingId) || null;
}

/* ---- 请求块（主请求 + 后备请求，同一套控件） ---- */

/* 一块「请求」长什么样：类型 / 适配器 / 请求模板 / 图片模板 / 响应格式 / 提取路径。
   主请求和后备请求**就是同一种东西**，所以只写一个模板 —— 两处各维护一份的话，
   将来加个字段必然只加一边（这插件栽过：语言映射表手抄了两份）。 */

/* 这里原来有一个「类型」下拉：自定义请求 / 内置适配器。**已删掉**（kniph 2026-10-13）：
   内置适配器只有 Bing 一个，而且只有内置预设 `builtin-bing` 会用上它；用户自己加、自己改的
   配置**全都是自定义请求**。既然只有一个「不是自定义」的选项，那个下拉就不值一行控件 ——
   「这块是什么」改成**从数据上看**：条目带 `adapter` 就是内置通道，否则就是请求模板
   （见 `blockHtml` 的 `isAdapter`）。哪天有第二个适配器了再把它请回来。 */
const MODE_OPTIONS = [
  { v: 'auto', t: '自动识别', k: 'opt_mode_auto' },
  { v: 'sse', t: 'SSE 事件流', k: 'opt_mode_sse' },
  { v: 'json', t: '整体 JSON', k: 'opt_mode_json' },
  { v: 'text', t: '纯文本', k: 'opt_mode_text' }
];

function optionsHtml(list, value) {
  return list
    .map((o) => `<option value="${escapeHtml(o.v)}"${o.v === value ? ' selected' : ''}>${escapeHtml(o.k ? T(o.k, o.t) : o.t)}</option>`)
    .join('');
}

/* 请求模板里那排占位符标签。**配置栏和 OCR 栏同一套机制**（标签长在请求块里面，
   点一下插到**这一段自己**的模板里），只是两栏能用的占位符不一样。
   以前配置栏那排是 pane 级的（插进「光标所在的框」，得先点一下框）、OCR 那排在块里 ——
   两套位置，kniph 2026-10-14 要求统一到块里面。 */
const CHIPS = [
  { ins: '{{text}}', t: '选中/待翻译的文本', k: 'opt_chip_text' },
  { ins: '{{target}}', t: '设置里的目标语言，原样搬过来（给聊天模型看）', k: 'opt_chip_target' },
  {
    ins: '{{targetCode}}',
    k: 'opt_chip_targetcode',
    t: '映射成接口要的代码 ZH-HANS / JA，给 DeepL 这类只认代码的接口用。换服务就在请求文本里写一张 #@lang 表改掉（README 有现成的表）'
  },
  { ins: '{{image}}', t: '截图翻译直传模式下的图片（data URL）；普通翻译时是空串', k: 'opt_chip_image' },
  {
    ins: '{{imagePart}}',
    k: 'opt_chip_imagepart',
    t: '图片那一段（含前导逗号），写在 content 数组最后；没图时是空串。用它就能让一段模板同时翻文字和翻图'
  },
  { ins: '{{url}}', t: '页面地址', k: 'opt_chip_url' },
  { ins: '{{title}}', t: '页面标题', k: 'opt_chip_title' },
  { ins: '{{date}}', t: '今天日期', k: 'opt_chip_date' }
];
const OCR_CHIPS = [
  { ins: '{{image}}', t: '截图的 data URL（OpenAI 兼容接口用这个）', k: 'opt_chip_image' },
  { ins: '{{imageBase64}}', t: '裸 base64（不带 data: 前缀），给要纯 base64 的接口', k: 'opt_chip_imageb64' },
  { ins: '{{imageUrlEncoded}}', t: 'base64 再过一遍 URL 编码（百度这类表单接口要这种）', k: 'opt_chip_imageurl' },
  { ins: '{{apiKey}}', t: '「变量」页签里的 apiKey，和翻译配置共用', k: 'opt_chip_apikey' }
];

/** 一排占位符标签（`ins` 是插进去的文本，标签上显示的是去掉花括号的名字） */
function chipsHtml(list) {
  return `<div class="chips">` + list.map((c) =>
    `<button type="button" class="chip" data-ins="${c.ins}" title="${escapeHtml(c.k ? T(c.k, c.t) : c.t)}">` +
    `${escapeHtml(c.ins.slice(2, -2))}</button>`
  ).join('') + '</div>';
}

/** 内置适配器的显示名（`ADAPTERS` 里查不到就退回它的 id） */
function adapterLabel(id) {
  const a = ADAPTERS[id];
  // 自带 labelKey 的走查表（英文界面显示英文名），没有就退回中文原文
  if (a && a.labelKey) return T(a.labelKey, a.label);
  return a ? a.label : String(id || T('opt_unknown_adapter', '（未知适配器）'));
}

/** 适配器的说明文字（跟着界面语言） */
function adapterHint(id) {
  const a = ADAPTERS[id];
  if (a && a.hintKey) return T(a.hintKey, a.hint);
  return (a && a.hint) || '';
}

/** 块头右边那句「这条打到哪儿」—— 折叠起来之后全靠它认人 */
function blockSummary(item, kind) {
  if (kind === 'adapter') return T('opt_adapter_prefix', '内置适配器：') + adapterLabel(item.adapter);
  return summarizeUrl(item.request, T('opt_no_request', '（还没写请求模板）'));
}

/**
 * 一段请求模板：标题栏（点它折叠）+ 标签排 + 文本框 + 说明。
 *
 * 「文字那条」和「图片那条」**同一副骨架**，所以只有这一处实现 —— 各写一份的下场是
 * 标题元素（`label` / `summary`）、外层容器、hint 间距、文本框最小高度全各长各的
 * （kniph 2026-10-14 报的「完全是两套布局结构，明明可以复用一套代码」）。
 * 差别只剩几个参数：类名、标题文案、默认摊不摊开、给适配器条目 `hidden`。
 *
 /* 折叠手势也统一成「点这一条的标题栏」（`<details>` 的原生行为），和页面上的预览块一样；
 * 请求块的块头也是同一套（见 `els.blocks` 的 click 委托）。**这里只管块内那段 `<details>`**
 * —— 块自己默认收不收起归 `foldOpen` 管（默认全收起），两处别混。
 *
 * `wrapAttrs` / `boxAttrs` 传的是**整段属性串**（`'class="preview tpl-fold …"'`）而不是类名，
 * 因为 `check-dom` 是从 `class="…"` **字面量**里收类名的，插值进去的那一段它认不出
 * （`#req-blocks` 那块早就踩过，见 `renderBlocks` 的注释）。
 *
 * `opts.chips` = 这段前面那排占位符标签（配置栏 8 个 / OCR 栏 4 个）。
 * `opts.dismiss` = 这段说明的「不再显示」id（`data-hint`）—— 每个块各渲染一份说明，
 * 所以渲染完要再跑一次 `applyHintHides()` 把按钮补上（它幂等）。
 */
function templateFieldHtml({ wrapAttrs, boxAttrs, title, value, placeholder, hint, open, hidden, chips, dismiss }) {
  return `
        <details ${wrapAttrs}${hidden ? ' hidden' : ''}${open ? ' open' : ''}>
          <summary>${escapeHtml(title)}</summary>
          <div class="fold-body">
            ${chips ? chipsHtml(chips) : ''}
            <textarea ${boxAttrs} spellcheck="false" wrap="off"
              placeholder="${escapeHtml(placeholder)}">${escapeHtml(value)}</textarea>
            <p class="hint"${dismiss ? ` data-hint="${dismiss}"` : ''}>${hint}</p>
          </div>
        </details>`;
}

/* `idx` 是从 0 数起的位置（0 = 主请求），`lastIdx` 是最后一块的下标 —— 上下移按钮靠它禁用。

   **字段顺序**：两段模板挨着（请求模板 → 图片请求模板），两个「响应」字段挨着收尾
   （响应格式 → 响应提取路径）。响应那两项管的是**这条请求回来的东西怎么读**、而且两段模板
   共用同一套（`readResponseBody` 收的就是条目的 `responseMode` / `path`），夹在两段模板中间
   会被读成「只管上面那一段」（kniph 2026-10-14 报的「响应格式夹在两个模板中间是什么意思」）。

   `opts.chips`：这段模板前面那排占位符标签（配置栏 8 个 / OCR 栏 4 个，见 `CHIPS` / `OCR_CHIPS`）。
   `opts.ocr`：**OCR 供应商的条目** —— 同一套块，只是没有「图片请求模板 / 响应格式」两项
   （OCR 用不到），提取路径照旧有。这就是「配置栏和 OCR 栏复用同一套逻辑」的那一套。

   块不再让用户选「类型」：`data-adapter` 是空的 = 请求模板，带值（目前只有 Bing）= 内置通道。
   `data-adapter` 同时是 `readBlock()` 取 adapter 的**唯一来源**（那个下拉没了）。 */
function blockHtml(item, idx, lastIdx, opts = {}) {
  const isMain = !!item.main;
  const isAdapter = !!item.adapter;
  const kind = isAdapter ? 'adapter' : 'request';
  const hideReq = isAdapter ? ' hidden' : '';
  const ocr = !!opts.ocr;
  return `
    <div class="req-block" data-id="${escapeHtml(item.id)}" data-adapter="${escapeHtml(item.adapter || '')}">
      <div class="rb-head">
        <label class="rb-on" title="${T('opt_no_rotate', '不勾就不参与轮换（测试也不跑它）')}">
          <input type="checkbox" class="rb-enable"${item.enabled ? ' checked' : ''}>
        </label>
        <span class="rb-tag">${escapeHtml(isMain ? T('opt_main_req', '主请求') : item.name)}</span>
        <span class="rb-sub">${escapeHtml(blockSummary(item, kind))}</span>
        ${item.imageRequest && item.imageRequest.trim() ? `<span class="rb-badge" title="${T('opt_img_badge', '这条填了「图片请求模板」，截图翻译时会走它（图片直传模式）')}">图</span>` : ''}
        <span class="spacer"></span>
        ${isMain ? '' : `
          <button type="button" class="rb-mini rb-up" title="${T('opt_up', '上移（越靠前越先试）')}"${idx <= 1 ? ' disabled' : ''}>↑</button>
          <button type="button" class="rb-mini rb-down" title="${T('opt_down', '下移')}"${idx >= lastIdx ? ' disabled' : ''}>↓</button>
          <button type="button" class="rb-mini rb-del" title="${T('opt_del_fallback', '删掉这条后备请求')}">×</button>`}
        <button type="button" class="rb-fold" title="${T('opt_fold', '折叠 / 展开（点这一行也行）')}">▾</button>
      </div>
      <div class="rb-body">
        ${isAdapter ? `
        <div class="field rb-adapter-field">
          <label>${T('opt_label_adapter', '内置适配器')}</label>
          <p class="rb-adapter-note">${escapeHtml(adapterLabel(item.adapter))}</p>
          <p class="hint">${escapeHtml(adapterHint(item.adapter))}</p>
        </div>` : ''}
        ${templateFieldHtml({
          wrapAttrs: 'class="preview tpl-fold rb-only-request"',
          boxAttrs: 'class="rb-request"',
          title: T('opt_tpl_title', '请求模板'),
          value: item.request,
          placeholder: T('opt_tpl_ph', '在这里粘贴 curl，或者写原始 HTTP 报文'),
          open: true,
          hidden: isAdapter,
          chips: opts.chips,
          dismiss: ocr ? 'ocr-tpl' : 'cfg-tpl',
          hint: ocr
            ? T('opt_tpl_hint_ocr',
                '除占位符外一字不改地发出去；<b>提示词直接写在请求文本里</b>，不是占位符。' +
                '三个图片占位符的区别见上面那排标签的悬停提示 —— 百度那类表单接口要 ' +
                '<code>{{imageUrlEncoded}}</code>（base64 里的 <code>+</code> 不转成 <code>%2B</code> 会被当空格）。' +
                'Key 走 <code>{{apiKey}}</code>，别写死在模板里。')
            : T('opt_tpl_hint_text',
                'curl 和原始 HTTP 报文都行，除占位符外一字不改地发出去。' +
                'JSON 里不能有裸换行（写 <code>\\n</code>），双引号写 <code>\\"</code>；行首 <code>#</code> 是注释。')
        })}
        ${ocr ? '' : templateFieldHtml({
          wrapAttrs: 'class="preview tpl-fold img-tpl rb-only-request"',
          boxAttrs: 'class="rb-image-request"',
          title: T('opt_imgtpl_title', '图片请求模板（可选 · 点开填）'),
          value: item.imageRequest,
          placeholder: T('opt_imgtpl_ph', '留空 = 图片那次也用上面那段模板'),
          // 空的时候收起（多数人用不到），填过就摊开
          open: !!item.imageRequest.trim(),
          hidden: isAdapter,
          chips: opts.chips,
          dismiss: 'img-tpl',
          hint: T('opt_imgtpl_hint',
            '<b>填了这段（主请求或哪条后备都行），这条配置才会出现在 OCR 栏的「图片配置」列表里。</b>' +
            '它管翻图，上面那段继续管划词翻译；留空就回退到上面那段。<br>' +
            '写成多模态的样子，比如：' +
            '<code>{"role":"user","content":[{"type":"image_url","image_url":{"url":"{{image}}"}},{"type":"text","text":"把图里的文字翻成{{target}}，只输出译文"}]}</code><br>' +
            '这段里 <code>{{text}}</code> 是空串 —— 直传时图片本身就是原文。'),
        })}
        ${/* 两个「响应」字段收尾，见 blockHtml 上面那段字段顺序的注释 */ ''}
        ${ocr ? '' : `<div class="field mode-field rb-only-request"${hideReq}>
          <label>${T('opt_label_mode', '响应格式')}</label>
          <select class="rb-mode">${optionsHtml(MODE_OPTIONS, item.responseMode)}</select>
        </div>`}
        <div class="field rb-only-request"${hideReq}>
          <label>${T('opt_label_path', '响应提取路径（留空自动识别）')}</label>
          <input class="rb-path" type="text" spellcheck="false" placeholder="choices[0].message.content" value="${escapeHtml(item.path)}">
          <p class="hint" data-hint="${ocr ? 'ocr-path' : 'cfg-path'}">${ocr
            ? T('opt_path_hint_ocr', '点号 + 下标，例如百度的 <code>words_result</code>（一行一个对象，会按行拼成一段）。留空时依次尝试各家常见的返回结构。')
            : T('opt_path_hint_text', '点号 + 下标，例如 <code>data.translations[0].translatedText</code>。留空时会依次尝试各家常见的返回结构。')}</p>
        </div>
      </div>
    </div>`;
}

/** 这块现在该展开还是收起。**默认全收起**（主请求也一样，kniph 2026-10-13 定的）——
    一进来就是一列整齐的标题，页面短得多；点过 ▾ 的才记进 `blockFold`（只在内存，不进存档）。 */
function foldOpen(id) {
  return blockFold.get(id) === true;
}

/** 把一条配置（或一个 OCR 供应商）的请求块整批画出来（主请求在最上面，然后是各条后备）。
    两栏共用这一套 —— 只差标签排和 `ocr: true` 这两个参数（kniph 2026-10-14：
    「这三个部分都要复用同一套逻辑」，别再各写一遍）。 */
function renderBlocksInto(host, owner, opts) {
  const all = allRequests(owner);
  const tplSel = opts.ocr ? '.rb-request' : '.rb-request, .rb-image-request';
  host.innerHTML = all.map((it, i) => blockHtml(it, i, all.length - 1, opts)).join('');
  /* 折叠 / 勾选这两个状态是**这里贴上去的**，不写进模板 —— 模板里 `class="req-block${…}"`
     一旦插值，`check-dom` 那套「从 class="…" 字面量里收类名」就认不出 `req-block` 了。 */
  host.querySelectorAll('.req-block').forEach((node) => {
    node.classList.toggle('open', foldOpen(node.dataset.id));
    node.classList.toggle('rb-off', !node.querySelector('.rb-enable').checked);
  });
  // 动态建出来的模板框也要有「Tab 缩进 + 记住焦点」
  host.querySelectorAll(tplSel).forEach(bindTemplateBox);
  // 块里那几段说明的「不再显示」按钮是动态画的，得补一次（幂等）
  applyHintHides();
}

/** 配置栏那套请求块 */
function renderBlocks(cfg) {
  renderBlocksInto(els.blocks, cfg, { chips: CHIPS });
}

/** OCR 栏那套请求块 —— **和配置栏同一个 `blockHtml`**，只差两个参数（标签排 + `ocr: true`）。 */
function renderOcrBlocks(p) {
  renderBlocksInto(els.ocrBlocks, p, { chips: OCR_CHIPS, ocr: true });
}

/**
 * 一排占位符标签：点一下插到**这一块自己的**请求模板里。
 *
 * 配置栏和 OCR 栏共用这一个函数（两栏的标签排不一样，见 `CHIPS` / `OCR_CHIPS`，
 * 但插进去的逻辑一模一样）。以前配置栏那排是 pane 级的（插进「光标所在的框」，
 * 得先点一下框才行）、OCR 那排在块里 —— 两套位置，kniph 2026-10-14 要求统一到块里面。
 *
 * 光标在这个块里就插光标那儿，否则插这个块的**文字模板**；插之前把块和模板都摊开
 * （收起来的 `<details>` 里 `selectionStart` 恒为 0、`focus()` 是空操作）。
 */
function bindChips(container) {
  container.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    if (!chip) return;
    const block = chip.closest('.req-block');
    if (!block) return;
    const box = (focusedTemplate && block.contains(focusedTemplate))
      ? focusedTemplate
      : block.querySelector('.rb-request');
    if (!box) return;
    block.classList.add('open');
    blockFold.set(block.dataset.id, true);
    insertAtCursor(box, chip.dataset.ins);
  });
}

/** 读一块界面上现在填的是什么（收集 / 预览 / 块头摘要共用）。
    类型不在界面上选了 —— `data-adapter` 有值就是内置通道（只有 Bing 那条），否则是请求模板。
    OCR 栏的块没有「图片模板 / 响应格式」两项，所以那几个字段**容许不存在**（返回空串）。 */
function readBlock(node) {
  const adapter = node.dataset.adapter || '';
  const val = (sel) => {
    const el = node.querySelector(sel);
    return el ? el.value : '';
  };
  return {
    id: node.dataset.id,
    kind: adapter ? 'adapter' : 'request',
    adapter,
    request: val('.rb-request'),
    imageRequest: val('.rb-image-request'),
    path: val('.rb-path').trim(),
    responseMode: val('.rb-mode') || 'auto',
    enabled: node.querySelector('.rb-enable').checked
  };
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
  els.testResult.hidden = true;
  els.testResult.innerHTML = '';
  renderBlocks(cfg);

  updatePreview();
  setSaveStatus('');
}

/** 界面 → 数据。按 DOM 顺序走一遍，**主请求那块写回配置顶层，后备写回它自己那条**。 */
function collectEditor() {
  const cfg = currentConfig();
  if (!cfg) return null;
  cfg.name = els.name.value.trim() || T('opt_untitled_cfg', '未命名配置');

  for (const node of els.blocks.querySelectorAll('.req-block')) {
    const isMain = node.dataset.id === cfg.id;
    const item = isMain ? cfg : (cfg.fallbacks || []).find((f) => f.id === node.dataset.id);
    if (!item) continue;
    const b = readBlock(node);
    // 内置通道那条（Bing）没有请求模板，那几个字段就留空串
    const adapter = b.adapter;
    if (isMain) {
      cfg.adapter = adapter;
      cfg.request = b.request;
      cfg.imageRequest = b.imageRequest;
      cfg.path = b.path;
      cfg.responseMode = b.responseMode;
      cfg.mainEnabled = b.enabled;
    } else {
      item.adapter = adapter;
      item.request = b.request;
      item.imageRequest = b.imageRequest;
      item.path = b.path;
      item.responseMode = b.responseMode;
      item.enabled = b.enabled;
      // 名字不收集：后备叫什么由它在链里的位置决定（见 lib/store.js 的 allRequests）
    }
  }
  return cfg;
}

function bindConfigList() {
  // 「配置」栏和 OCR 栏那份「图片配置」共用同一套拖动 —— 逻辑一样，只是挪动落到哪不同
  bindSortDrag(els.cfgList, moveConfig);
  bindSortDrag(els.imgcfgList, moveImageConfig);

  $('#btn-new').addEventListener('click', () => {
    flushEditor();
    const cfg = {
      id: uid(),
      name: T('opt_new_cfg', '新配置'),
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
      mainEnabled: true,
      fallbacks: []
    };
    state.configs.push(cfg);
    editingId = cfg.id;
    state.activeConfigId = cfg.id;
    refreshConfigViews();
    els.name.focus();
    els.name.select();
  });
}

function bindEditor() {
  els.name.addEventListener('input', () => {
    collectEditor();
    updatePreview();
    scheduleSave();
    // 名字改了要同步左栏
    renderConfigList();
  });

  /* 块的输入事件 —— 和 OCR 栏共用一套（`bindBlockInputs`），只差收尾刷什么 */
  bindBlockInputs(els.blocks, () => {
    collectEditor();
    updatePreview();
    scheduleSave();
  });

  /* 块的公共点击行为（折叠 / ↑↓×）—— 配置栏和 OCR 栏共用，两栏的块是同一个 blockHtml 画的。 */
  bindBlockActions({
    collect: collectEditor,
    render: () => {
      renderBlocks(currentConfig());
      renderConfigList();
      updatePreview();
    }
  }, els.blocks);

  els.btnAddFallback.addEventListener('click', () => {
    const cfg = collectEditor();
    if (!cfg) return;
    /* 新后备抄一份主请求：多数后备只是换个服务商，从一段能用的模板上改
       比对着空白框重写省事（复制完记得把地址 / Key 换掉）。 */
    const item = {
      id: uid(),
      enabled: true,
      adapter: cfg.adapter,
      request: cfg.request,
      imageRequest: cfg.imageRequest,
      path: cfg.path,
      responseMode: cfg.responseMode
    };
    if (!Array.isArray(cfg.fallbacks)) cfg.fallbacks = [];
    cfg.fallbacks.push(item);
    blockFold.set(item.id, true);   // 刚加的这条摊开，好让用户马上填
    renderBlocks(cfg);
    renderConfigList();
    updatePreview();
    persist();
    // 落点放在请求模板里：刚抄来的是主请求那段，接下来多半就是改它
    // （顺带把那排标签的目标也指到这一块上）
    const box = els.blocks.querySelector(`.req-block[data-id="${item.id}"] .rb-request`);
    if (box) {
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
      box.scrollIntoView({ block: 'nearest' });
    }
  });

  /* 占位符标签：插到**这一块自己的**模板里。配置栏和 OCR 栏共用这一个函数
     （两栏的标签排不一样，见 CHIPS / OCR_CHIPS，但插进去的逻辑一模一样）。
     以前配置栏那排是 pane 级的（插进「光标所在的框」）、OCR 那排在块里 —— 两套位置，
     kniph 2026-10-14 要求统一到块里面：标签在哪段上，就插哪段。 */
  bindChips(els.blocks);
  bindChips(els.ocrBlocks);

$('#btn-duplicate').addEventListener('click', () => {
    const cfg = currentConfig();
    if (!cfg) return;
    const copy = {
      ...cfg,
      id: uid(),
      name: cfg.name + ' ' + T('opt_copy_suffix', '副本'),
      // 后备每条的 id 也得换新的，不然两份配置里的块 id 撞上
      fallbacks: (cfg.fallbacks || []).map((f) => ({ ...f, id: uid() }))
    };
    const idx = state.configs.findIndex((c) => c.id === cfg.id);
    state.configs.splice(idx + 1, 0, copy);
    editingId = copy.id;
    state.activeConfigId = copy.id;
    refreshConfigViews();
  });

  $('#btn-delete').addEventListener('click', () => {
    const cfg = currentConfig();
    if (!cfg) return;
    if (state.configs.length === 1) {
      alert(T('opt_need_one_cfg', '至少要留一条配置。'));
      return;
    }
    if (!confirm(T('opt_del_confirm_a', '确定删除「') + (cfg.name || T('opt_untitled', '未命名')) + T('opt_del_confirm_b', '」？此操作不可撤销。'))) return;

    const idx = state.configs.findIndex((c) => c.id === cfg.id);
    state.configs.splice(idx, 1);
    editingId = state.configs[Math.max(0, idx - 1)].id;
    state.activeConfigId = editingId;
    // 删掉的这条如果还在对比名单里，得摘掉（不然面板会拿到一个不存在的 id）
    state.settings.slotConfigs = sortByConfigOrder(
      slotConfigIds().filter((x) => x !== cfg.id)
    );
    refreshConfigViews();
  });

  $('#btn-test').addEventListener('click', runTest);
  els.testText.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runTest();
  });
}

function insertAtCursor(textarea, text) {
  /* 框被折起来时 `selectionStart` 恒为 0、`focus()` 是空操作 —— 字会插到最开头而且还看不见。
     所以插之前先把外面这道折摊开（模板那一段自己是一个 `<details>`；请求块那一层由调用方摊）。 */
  const fold = textarea.closest('details.tpl-fold');
  if (fold) fold.open = true;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const value = textarea.value;
  textarea.value = value.slice(0, start) + text + value.slice(end);
  textarea.selectionStart = textarea.selectionEnd = start + text.length;
  textarea.focus();
  /* **必须冒泡**：请求块是动态画的，`input` 监听器挂在容器 `#req-blocks` 上（委托）。
     不冒泡的话这一步只有框里的字变了、存档和预览都没跟上（e2e 抓过：
     点标签插进去后 `grew=8`，但 `imageRequest` 还是老值）。 */
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
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

/* ---- 预览 ---- */

let previewTimer = null;

/**
 * 两栏（配置 / OCR）预览共用的骨架 —— 功能一样，长相就必须一样。
 *
 * body 展示**原文**（不反序列化缩进）：用户写的转义原样可见，而且这就是真发出去的字节。
 */
function formatPreview(req, notes = []) {
  const lines = [];
  lines.push(T('opt_t_method', '方法：') + (req.method || 'GET'));
  lines.push(T('opt_t_url', '地址：') + (req.url || T('opt_t_nourl', '(没有 URL)')));
  lines.push('');
  lines.push(T('opt_t_headers', '请求头：'));
  for (const [k, v] of Object.entries(req.headers || {})) lines.push('  ' + k + ': ' + v);
  lines.push('');
  lines.push(T('opt_t_body', '—— 实际会发出的请求体 ——'));
  lines.push('');
  lines.push(req.body == null || req.body === '' ? T('opt_t_nobody', '(这条请求没有请求体)') : String(req.body));
  if (notes.length) {
    lines.push('');
    lines.push(T('opt_t_note', '—— 备注 ——'));
    for (const n of notes) lines.push('· ' + n);
  }
  return lines.join('\n');
}

/**
 * 预览 / 测试都用**第一个** model 候选 —— 但收敛这一步不在这儿做：
 * 它在渲染边界上（engine 的 previewRequest / runRequest，见 template.js 的 firstModelVars），
 * 所以「设置页预览」「OCR 预览」「真跑」看到的都是同一个 model，两边不会漂。
 */

/** 摊一块请求。适配器那条件走内置代码，没有请求模板可摊。 */
function previewBlock(b, vars, ivars) {
  if (b.kind === 'adapter') {
    const a = ADAPTERS[b.adapter];
    return a
      ? T('opt_adapter_prefix', '内置适配器：') + a.label + '\n\n' + a.hint + '\n\n' + T('opt_adapter_note', '这条请求不走请求模板，翻译流程由扩展内置的代码完成。')
      : T('opt_t_noadapter', '(没有可用的内置适配器)');
  }
  if (!b.request.trim()) return T('opt_t_notpl', '(请求模板为空)');

  const info = previewRequest(b.request, vars, b.path);
  const notes = [T('opt_style_prefix', '写法：') + (info.request.style === 'raw' ? T('opt_style_raw', '原始 HTTP 报文') : 'curl') + T('opt_style_auto', '（自动识别）')];
  /* 预览一次只摊一个 model（一次请求就是一个 model）—— 填了多行时在这儿交代一句，
     免得看到地址里只有第一个就以为扩展不认后面几行（kniph 报过这个疑惑）。 */
  const mkey = modelVarFor(b.request, vars);
  const models = modelCandidates(b.request, vars);
  if (models.length > 1) {
    notes.push(
      T('opt_model_rotate_a', 'model 轮换：') + mkey + T('opt_model_rotate_b', ' 填了 ') + models.length + T('opt_model_rotate_c', ' 个候选，上面摊的是第一个（') + models[0] + T('opt_model_rotate_d', '）；') +
      T('opt_model_rotate2', '「测试」和真翻译都会从它开始逐个试')
    );
  }
  if (info.missing.length) {
    notes.push(T('opt_t_undef', '未定义的变量（按空串替换）：') + info.missing.map((m) => '{{' + m + '}}').join(' '));
  }
  for (const p of info.problems) notes.push(T('opt_t_problem', '问题：') + p);
  for (const w of info.warnings || []) notes.push(T('opt_t_hintlbl', '提示：') + w);
  for (const n of info.notes) notes.push(T('opt_t_fix', '修正：') + n);

  let out = formatPreview(info.request, notes);

  // 图片请求模板也摊一遍。{{image}} 给一张假图，不然这里看着跟空的一样。
  const imgTpl = b.imageRequest.trim();
  if (imgTpl) {
    const iinfo = previewRequest(imgTpl, ivars, b.path);
    const inotes = [];
    if (iinfo.missing.length) {
      inotes.push(T('opt_t_undef', '未定义的变量（按空串替换）：') + iinfo.missing.map((m) => '{{' + m + '}}').join(' '));
    }
    for (const p of iinfo.problems) inotes.push(T('opt_t_problem', '问题：') + p);
    for (const w of iinfo.warnings || []) inotes.push(T('opt_t_hintlbl', '提示：') + w);
    for (const n of iinfo.notes) inotes.push(T('opt_t_fix', '修正：') + n);
    out += '\n\n' + T('opt_imgtpl_sep', '══════ 图片请求模板（截图直传那一次用它）══════') + '\n\n' + formatPreview(iinfo.request, inotes);
  }
  return out;
}

/** 预览 / 测试结果里的块标题。后备的名字就是它的位置 —— 和 `allRequests` 现算的那个一致 */
function blockTitle(i) {
  return i === 0 ? T('opt_main_req', '主请求') : T('opt_fallback_n', '后备 ') + i;
}

function updatePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => {
    const nodes = [...els.blocks.querySelectorAll('.req-block')];
    if (!nodes.length) {
      els.preview.textContent = T('opt_t_noreq', '(没有请求)');
      return;
    }

    // 两套 vars：文字那次和图片那次的占位符值不一样（{{image}} 只在那一次有值）
    let vars;
    let ivars;
    try {
      vars = buildVars(state, 'Hello, world! 这是一段示例文本。', {
        url: 'https://example.com/page',
        title: T('opt_sample_page', '示例页面')
      });
      ivars = buildVars(state, '', {
        url: 'https://example.com/page',
        title: T('opt_sample_page', '示例页面'),
        image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='
      });
    } catch {
      vars = { text: 'Hello, world!' };
      ivars = { image: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==' };
    }

    const parts = [];
    nodes.forEach((node, i) => {
      const b = readBlock(node);
      parts.push(`━━━━━━ ${blockTitle(i)}${b.enabled ? '' : T('opt_block_off', '（已勾掉，不参与轮换）')} ━━━━━━`);
      parts.push(previewBlock(b, vars, ivars));
    });
    els.preview.textContent = parts.join('\n\n');
  }, 180);
}

/* ---- 测试请求 ---- */

/**
 * 「测试」= 把这次真会跑的那条**链**按顺序跑一遍（面板上真翻译时就是这个顺序）：
 * 主请求先发，拿到译文就停；挂了才试下一条后备。逐条把结果摊出来 ——
 * 「第一条挂了、第二条顶上」这种配置，只看最终结果看不出中间发生过什么。
 *
 * **管模型的变量填了多行时也逐个试**（和面板同一个规矩，见 lib/template.js 的 modelVarFor）。
 * 原来只发第一个 model —— 第一个恰好挂了就报一片红，用户会得出「这条配置是坏的」这种
 * 错误结论（kniph 2026-10-14 报的：他那条配置第一个模型是坏的，面板好好的，测试永远失败）。
 *
 * 徽章的单位：不轮换时数是**条**（链上的请求，老文案没动）；轮换时数是**次发送**
 * （一条请求可能要发好几回），两种都明说数字是什么，别让人自己猜。
 */
async function runTest() {
  /* Enter 路径不经过按钮的 disabled 检查 —— 测试跑着的时候再按 Enter 会并发第二条链，
     两个结果交替往同一块里写。按钮本身就是最现成的重入闸。 */
  if ($('#btn-test').disabled) return;
  collectEditor();
  await persist(false);

  const cfg = currentConfig();
  if (!cfg) return;

  const text = els.testText.value.trim() || 'Hello, world!';
  const chain = requestChain(cfg);
  const btn = $('#btn-test');
  btn.disabled = true;
  btn.textContent = T('opt_sending', '发送中…');

  let vars;
  try {
    vars = buildVars(state, text, { url: location.href, title: T('opt_test_page', 'RequestTranslate 测试') });
  } catch {
    vars = { text };
  }

  /* 先把整条链要发什么排出来：每条请求自己的模板 / 管模型的变量 / 候选列表。
     **在循环外一次算好**，这样徽章里的「一共几次」和实际发出去的次数是同一份数。 */
  const plan = chain.map((item) => {
    const requestText = requestTemplateFor(item, {});
    const mkey = modelVarFor(requestText, vars);
    const models = modelCandidates(requestText, vars);
    return { item, requestText, mkey, attempts: models.length ? models : [null] };
  });
  const total = plan.reduce((n, p) => n + p.attempts.length, 0);
  const rotating = total > plan.length;

  els.testResult.hidden = false;
  els.testResult.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'result-head test-head';
  /* 这枚徽章只交代「这条链上一共有几条」—— 不是「要试几条」。
     写成「按顺序试 2 条」会被读成「两条都会发」，可实际拿到译文就停（kniph 报过这个歧义）。 */
  head.innerHTML =
    `<span class="badge">${T('opt_chain', '链上共 $1$ 条请求', [String(chain.length)])}</span>` +
    (rotating ? `<span class="badge">${T('opt_tryall', 'model 逐个试，最多发 $1$ 次', [String(total)])}</span>` : '');
  els.testResult.appendChild(head);

  let got = false;
  let sent = 0;
  for (let i = 0; i < plan.length && !got; i += 1) {
    const { item, requestText, mkey, attempts } = plan[i];

    for (let j = 0; j < attempts.length; j += 1) {
      const model = attempts[j];
      let result;
      try {
        result = await runRequest({
          requestText,
          adapter: item.adapter,
          // 试第几个就把那个变量换成哪个（和后台同一处规矩：覆盖的是**命中的键名**）
          vars: model == null ? vars : { ...vars, [mkey]: model },
          path: item.path,
          responseMode: item.responseMode
        });
      } catch (err) {
        result = { ok: false, status: 0, ms: 0, text: '', error: String(err && err.message), warnings: [], raw: '' };
      }
      sent += 1;
      els.testResult.insertAdjacentHTML(
        'beforeend',
        testItemHtml(item, result, { model: attempts.length > 1 ? model : '' })
      );

      if (result && result.text) {
        /* 和面板上一样：拿到译文就收工，后面压根不会发 —— 明说「第几条成的、后面多少没跑」，
           别让人以为漏跑了（也别让人以为上面那条「共 N 条」是「发了 N 条」）。 */
        got = true;
        const left = total - sent;
        const at = attempts.length > 1 ? `第 ${i + 1} 条第 ${j + 1} 个 model 拿到译文` : `第 ${i + 1} 条拿到译文`;
        const tail = left ? (rotating ? `，还有 ${left} 次没发` : `，后面 ${left} 条没跑`) : '';
        head.insertAdjacentHTML('beforeend', `<span class="badge ok">${at}${tail}</span>`);
        break;
      }
    }
  }
  if (!got) {
    head.insertAdjacentHTML(
      'beforeend',
      `<span class="badge err">${rotating ? `${total} 次都没拿到译文` : `${chain.length} 条都没拿到译文`}</span>`
    );
  }

  btn.disabled = false;
  btn.textContent = T('opt_send', '发送');
}

/* 测试结果里的「实际请求」那一块。配置栏和 OCR 栏摊的是同一份东西 —— 一处排版，两边共用。
   **打码不在这儿做**：产生 result 的那一层（engine 的 runRequest、lib/ocr.js 的 runOcr /
   runImageTranslate）早就把 Authorization 换成展示版了，这里再打一遍会叠成两层后缀。
   body 截一刀：长提示词会把这块撑爆。 */
function requestBlockHtml(req) {
  if (!req) return '';
  const text =
    `${req.method} ${req.url}\n` +
    Object.entries(req.headers || {}).map(([k, v]) => `${k}: ${v}`).join('\n') +
    (req.body ? '\n\n' + truncateText(req.body, 2000) : '');
  return `<div class="row"><div class="row-title">${T('opt_row_actual', '实际请求')}</div><pre>${escapeHtml(text)}</pre></div>`;
}

/**
 * 块头上那行「为什么挂」。
 *
 * 错误正文长这样：`HTTP 400 · {"code":20015,"message":"max_tokens …"}`，后面**还跟着我们自己
 * 加的一句提示**（「模型上下文装不下这个 max_tokens。…」）—— 所以整体 `JSON.parse` 必然失败。
 * 直接按 `"message"` 把那段捞出来最稳，两种包法都认（`{"error":{"message":…}}` 和
 * `{"code":…,"message":…}`）。捞不到才退回「压平空白截断」——那样至少不会把 `{ "error": {` 摆出来当理由。
 */
function shortError(err) {
  const raw = String(err || '').trim();
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  if (m) {
    try {
      return String(JSON.parse('"' + m[1] + '"')).trim();
    } catch {
      return m[1].replace(/\\(.)/g, '$1').trim();
    }
  }
  return raw.replace(/\s+/g, ' ').slice(0, 120);
}

/**
 * 一块测试结果的外壳 —— **配置栏和 OCR 栏共用这一处**。
 *
 * 规矩只有一条：**拿到结果的那块摊开，没拿到（失败 / 没识别出东西）的折起来**。
 * 一次测试可能挂好几个 model（配置栏）或者连着试几次（OCR 栏），全摊开就是好几屏的
 * 报错正文 + 完整请求体 + 原始响应（kniph 2026-10-14 报的「测试完直接冒出来这么多」）。
 *
 * 折起来时块头挂一行 `why`（为什么挂）—— 不然只剩一串 HTTP 503，还得逐块点开才知道原因。
 *
 * 注意这里**不含 `.result` 那层壳**：配置栏每块自己是一个 `.result.test-item`（调用方套上），
 * OCR 栏那个容器 `#ocr-test-result` 本身就是 `.result`（里面只有这一块）。
 */
function resultBlockHtml({ head = '', body = '', fold, why = '' }) {
  const headHtml = head + (fold && why ? `<span class="why">${escapeHtml(why)}</span>` : '');
  if (!fold) {
    return `<div class="result-head">${headHtml}</div><div class="result-body">${body}</div>`;
  }
  return `<details class="test-fold"><summary class="result-head">${headHtml}</summary>` +
    `<div class="result-body">${body}</div></details>`;
}

/** 链里某一条的测试结果（一块）。多条时逐块堆下去，每块自己带条头。
    `opts.model` 有值 = 这条请求在轮换 model（好几块长得一样，不标出来分不清哪块是哪个）。 */
function testItemHtml(item, r, opts = {}) {
  const rows = [];

  const badges = [
    `<span class="badge ${r.ok ? 'ok' : 'err'}">HTTP ${r.status || '失败'}</span>`,
    `<span class="badge">${r.ms} ms</span>`
  ];
  // 轮换时把「这块试的是哪个 model」摆在最前面 —— 结果好坏都先要看出是哪个
  if (opts.model) badges.unshift(`<span class="badge">${escapeHtml(opts.model)}</span>`);
  if (r.usedPath) badges.push(`<span class="badge">${escapeHtml(r.usedPath)}</span>`);
  for (const w of r.warnings || []) badges.push(`<span class="badge warn">${escapeHtml(w)}</span>`);
  if (r.missingVars && r.missingVars.length) {
    badges.push(`<span class="badge warn">未填变量 ${r.missingVars.map(escapeHtml).join(', ')}</span>`);
  }

  if (r.error) {
    rows.push(
      `<div class="row"><div class="row-title">${T('opt_row_error', '错误')}</div><pre class="err-text">${escapeHtml(r.error)}</pre></div>`
    );
  }

  if (r.text) {
    rows.push(
      `<div class="row"><div class="row-title">${T('opt_row_text', '提取到的译文')}</div><pre class="translated">${escapeHtml(r.text)}</pre></div>`
    );
  }

  if (r.request) rows.push(requestBlockHtml(r.request));

  if (r.raw) {
    const raw = truncateText(r.raw, 8000);
    rows.push(
      `<div class="row"><div class="row-title">${T('opt_row_raw', '原始响应')}</div><pre>${escapeHtml(raw)}</pre></div>`
    );
  }

  const title = item.main ? T('opt_main_req', '主请求') : escapeHtml(item.name);
  return `<div class="result test-item">${resultBlockHtml({
    head: `<span class="badge">${title}</span>${badges.join('')}`,
    body: rows.join(''),
    fold: !r.text,
    why: shortError(r.error)
  })}</div>`;
}

/* ---- 变量 ---- */

/**
 * 把一个值输入框按内容撑高（先归零再按 scrollHeight 长；到上限由 CSS 出滚动条）。
 *
 * **面板藏着的时候不能量**：`display:none` 的元素 `scrollHeight` 是 0，硬写就把高度写成
 * 0px，切到「变量」标签后扁成一条缝（kniph 报过）。所以不可见时直接跳过 ——
 * 等真正显示了再量（切标签时 `growVarValues` 会补一次）。
 */
function growTextarea(el) {
  if (!el.offsetParent) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

/** 把变量栏里所有值输入框重撑一遍（切到「变量」标签时调 —— 存档里的多行值要撑开） */
function growVarValues() {
  els.varsBody.querySelectorAll('textarea[data-kind="value"]').forEach((el) => {
    // 只有展开着的那几块要撑 —— 收着的摘要行里没有 textarea
    if (el.closest('.var-row.editing')) growTextarea(el);
  });
}

function bindVars() {
  $('#btn-add-var').addEventListener('click', () => {
    // 新建的那条**直接进编辑态**（名字还空着，摘要行没东西可显示）
    state.vars.push({ name: '', value: '' });
    editingVarIdx = state.vars.length - 1;
    renderVars();
    persist();
    const input = els.varsBody.querySelector('.var-row.editing input[data-kind="name"]');
    if (input) input.focus();
  });

  /* 拖动排序：和三处左栏**同一个 `bindSortDrag`**（`grid: true` ——
     卡片是一行好几张，按 Y 算落点会分不清落在哪一列，见那个函数的注释）。
     变量在存档里只有 name/value、没有 id，所以 `data-id` 用下标；
     挪完立刻重画，下标也跟着变（每次都是对着当时的列表算的）。 */
  bindSortDrag(
    els.varsBody,
    (id, to) => {
      const from = Number(id);
      const next = moveItem(state.vars, from, to);
      if (next === state.vars) return; // 原地没动（插回自己原来的位置）
      state.vars = next;
      // 正在编辑的那条得跟着挪 —— 下标变了，不修就会跳到别的变量上。
      // `to` 是 moveItem「移除之后」的坐标：往下拖时 (from, to] 区间 -1，
      // 往上拖时 [to, from) 区间 +1（第三分支原来写反了，是个对 from>to 恒空的死条件，
      // 往上拖会把编辑态留在原地跳到别的变量上 —— 通读时子代理抓出来的）。
      if (editingVarIdx === from) editingVarIdx = to;
      else if (editingVarIdx > from && editingVarIdx <= to) editingVarIdx -= 1;
      else if (editingVarIdx >= to && editingVarIdx < from) editingVarIdx += 1;
      renderVars();
      persist();
      updatePreview();
    },
    { itemSel: '.var-row', gripSel: '.var-grip', grid: true }
  );
}

/* 变量编辑态下标（-1 = 没在编辑）。收起 / 展开是**行为**，不进存档 */
let editingVarIdx = -1;

/* 值的摘要：一眼认出这条是干嘛的，但**不摊全文**。
   · 含 key 的 → 圆点打码（不数长度，量长度也算泄露）
   · 多行（model 列表）→ 首行 + 「 +N」
   · 空 → 灰色的「空」 */
function varValueSummary(v) {
  if (isSecretVar(v.name)) return '••••••';
  const lines = String(v.value || '').split('\n').filter((l) => l.trim());
  if (lines.length === 0) return '';
  const first = lines[0].length > 42 ? lines[0].slice(0, 42) + '…' : lines[0];
  return lines.length > 1 ? `${first} +${lines.length - 1}` : first;
}

/* 一条变量 = **一行**：名字 + 值的摘要 + 眼睛 + ✕（华词翻译那种紧凑行）。
   点那一行才摊开编辑（名字框 + 值 textarea + 眼睛挪进去）。
   上一版「名字一行、值一行」把 13 条摊成 26 行 —— 翻着找一条要滚很久
   （kniph：「各个方面上的局促…查找修改的时候需要花费很多时间」）。 */
function renderVars() {
  els.varsBody.innerHTML = '';

  state.vars.forEach((v, idx) => {
    const row = document.createElement('div');
    row.className = 'var-row' + (idx === editingVarIdx ? ' editing' : '');
    /* 拖动排序认这个 id。变量在存档里只有 name/value、没有稳定 id，
       这里用下标 —— 每次挪完 / 落盘后整块重画，下标也跟着变，不会指错。 */
    row.dataset.id = String(idx);

    if (idx !== editingVarIdx) {
      /* ---- 卡片（收起态）：名字一行、值两行，操作按钮贴右上角 ---- */
      row.title = '点开编辑';

      /* 拖动手柄。和三处左栏同一个 `bindSortDrag`（拖它才动，点卡片是编辑）——
         变量一多就只能按创建顺序排，视觉上乱得没法归类（kniph 2026-10-14）。 */
      const grip = document.createElement('span');
      grip.className = 'var-grip';
      grip.innerHTML = GRIP_SVG;
      grip.title = T('opt_drag_hint', '按住拖动，调整顺序');
      grip.setAttribute('aria-hidden', 'true'); // 键盘暂时没有排序路径，别假装支持
      row.appendChild(grip);

      const nameEl = document.createElement('span');
      nameEl.className = 'var-name';
      nameEl.textContent = v.name || T('opt_unnamed', '(未命名)');
      if (isSecretVar(v.name)) nameEl.classList.add('is-key');

      const subEl = document.createElement('span');
      subEl.className = 'var-sub';
      subEl.textContent = varValueSummary(v) || '空';
      // 值可能很长（多行 model 列表、长 key）—— 完整内容挂 title，鼠标停上去看全文
      row.title = (v.name || T('opt_unnamed', '(未命名)')) + '\n' + (varValueSummary(v) || T('opt_var_empty', '空')) + '\n\n' + T('opt_var_click_edit', '点开编辑');

      /* 名字和值竖排在左边一块，操作按钮在右边 —— 卡片宽度只有 230px 起，
         三个子项横排的话值只剩几十像素，一行都显示不全 */
      const main = document.createElement('div');
      main.className = 'var-main';
      main.append(nameEl, subEl);

      const eye = document.createElement('button');
      eye.type = 'button';
      eye.className = 'row-eye' + (isSecretVar(v.name) ? '' : ' off');
      eye.innerHTML = EYE_OFF_SVG;
      eye.title = '点开编辑';
      eye.addEventListener('click', () => {
        editingVarIdx = idx;
        renderVars();
      });

      const del = document.createElement('button');
      del.className = 'row-del';
      del.textContent = '✕';
      del.title = '删除';
      del.addEventListener('click', () => {
        if (editingVarIdx === idx) editingVarIdx = -1;
        else if (editingVarIdx > idx) editingVarIdx -= 1;
        state.vars.splice(idx, 1);
        renderVars();
        persist();
        updatePreview();
      });

      row.append(main);
      const acts = document.createElement('div');
      acts.className = 'var-acts';
      acts.append(eye, del);
      row.appendChild(acts);
      row.addEventListener('click', (e) => {
        // 眼睛 / ✕ / 拖动手柄自己都有活儿，点卡片本身才进编辑
        if (e.target.closest('button, .var-grip')) return;
        editingVarIdx = idx;
        renderVars();
      });
      els.varsBody.appendChild(row);
      return;
    }

    /* ---- 编辑态：名字框 + 值 textarea + 眼睛 + ✕ ---- */
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = v.name;
    nameInput.placeholder = 'apiKey';
    nameInput.dataset.kind = 'name';
    nameInput.spellcheck = false;
    nameInput.addEventListener('input', () => {
      state.vars[idx].name = nameInput.value.replace(/[^\w.-]/g, '');
      if (nameInput.value !== state.vars[idx].name) nameInput.value = state.vars[idx].name;
      /* 名字改了，打码状态跟着重算：这叫 apiKey 就该藏起来，改成 model 就该露出来。
         手动点过眼睛的那种临时状态会被覆盖 —— 名字变了就是另一回事了。 */
      applyMask(isSecretVar(state.vars[idx].name));
      syncEye();
      scheduleSave();
      updatePreview();
    });

    /* 值用 textarea：一**行写一个**时（「换 model 重试」就是这么用的）能一行一个地排开，
       不用挤在一个输入框里。单行的时候靠 growTextarea 压成一行高。 */
    const valueInput = document.createElement('textarea');
    valueInput.rows = 1;
    valueInput.value = v.value;
    valueInput.placeholder = '值（一行一个）';
    valueInput.spellcheck = false;
    valueInput.autocomplete = 'off';
    valueInput.dataset.kind = 'value';
    valueInput.autofocus = v.name && true; // 名字已有 → 焦点给值；名字空 → 给名字框
    const autoGrow = () => growTextarea(valueInput);
    /* 值要不要默认藏起来：**名字里含 key 才算密钥**（不区分大小写）。
       这是**防肩窥**（截图、录屏、旁边有人），不是加密：值仍是明文存的、
       导出的配置文件里也照样有，只是没道理在界面上明晃晃摆着。 */
    const applyMask = (on) => valueInput.classList.toggle('masked', on);
    applyMask(isSecretVar(v.name));
    valueInput.addEventListener('input', () => {
      state.vars[idx].value = valueInput.value;
      autoGrow();
      scheduleSave();
      updatePreview();
    });

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'row-eye';
    /* 眼睛的图标 / 提示跟着**当前**状态走：睁眼 = 点一下显示，划斜杠 = 点一下藏回去 */
    const syncEye = () => {
      const masked = valueInput.classList.contains('masked');
      eye.innerHTML = masked ? EYE_SVG : EYE_OFF_SVG;
      eye.classList.toggle('on', !masked);
      eye.title = masked ? '显示' : '隐藏';
      eye.setAttribute('aria-label', eye.title);
    };
    eye.addEventListener('click', () => {
      valueInput.classList.toggle('masked');
      syncEye();
    });
    syncEye();

    // 编辑态撑高（多行值）。标签可能还藏着（offsetParent 为空），growVarValues 会补
    requestAnimationFrame(autoGrow);

    const del = document.createElement('button');
    del.className = 'row-del';
    del.textContent = '✕';
    del.title = '删除';
    del.addEventListener('click', () => {
      editingVarIdx = -1;
      state.vars.splice(idx, 1);
      renderVars();
      persist();
      updatePreview();
    });

    /* 收起那条：失焦且值没在拖选 → 摘要行（点它重新摊开）。挂在 row 上的 blur
       事件要 focusin/focusout 才冒泡；这里直接查 activeElement 更稳 */
    const foldBtn = document.createElement('button');
    foldBtn.type = 'button';
    foldBtn.className = 'row-fold';
    foldBtn.textContent = '收起';
    foldBtn.title = '收起这一条（点名字再摊开）';
    foldBtn.addEventListener('click', () => {
      editingVarIdx = -1;
      renderVars();
    });

    const nameRow = document.createElement('div');
    nameRow.className = 'var-edit-name';
    nameRow.append(nameInput);
    const valRow = document.createElement('div');
    valRow.className = 'var-edit-val';
    valRow.append(valueInput, eye);
    const bar = document.createElement('div');
    bar.className = 'var-edit-bar';
    bar.append(foldBtn, del);
    row.append(nameRow, valRow, bar);
    els.varsBody.appendChild(row);

    // 名字已有 → 焦点直接给值；否则给名字（新建那条）
    if (v.name) valueInput.focus();
    else nameInput.focus();
  });

  els.builtinBody.innerHTML = Object.entries(BUILTIN_VAR_HINTS)
    .map(([k, hint]) => `<tr><td>{{${escapeHtml(k)}}}</td><td>${escapeHtml(VAR_HINT_KEYS[k] ? T(VAR_HINT_KEYS[k], hint) : hint)}</td></tr>`)
    .join('');
}

/* ---- OCR 供应商 ---- */
/* 结构刻意和配置列表一样（点一条就切过去），少一套心智模型 —— 连排序拖动都是同一套。 */

function currentOcrProvider() {
  return state.ocr.providers.find((p) => p.id === editingOcrId) || null;
}

/** 列表里那行小字：请求模板里第一个 URL，够认人就行 */
function summarizeOcr(p) {
  return summarizeUrl(p.request, '(还没填请求模板)');
}

/* OCR 供应商列表：和「配置」栏**同一套行、同一套操作**（`sortableRow` + 拖动 + ↑↓）——
   三处左栏一个逻辑（kniph 2026-10-14：这三个部分都要复用同一套）。
   挪动落点是 `state.ocr.providers` 的先后；选中项按 id 走，不会指错。 */
function renderOcrList() {
  els.ocrList.innerHTML = '';

  state.ocr.providers.forEach((p, idx) => {
    els.ocrList.appendChild(sortableRow({
      id: p.id,
      name: p.name,
      sub: summarizeOcr(p),
      active: p.id === state.ocr.activeId,
      index: idx,
      total: state.ocr.providers.length,
      listEl: els.ocrList,
      onSelect: () => selectOcr(p.id),
      onMove: moveOcrProvider
    }));
  });
}

/** 把一条供应商挪到新位置（`to` 是完整数组里、移除之后的坐标） */
function moveOcrProvider(id, to) {
  const from = state.ocr.providers.findIndex((p) => p.id === id);
  if (from < 0) return false;
  const next = moveItem(state.ocr.providers, from, to);
  if (next === state.ocr.providers) return false; // 原地没动
  state.ocr.providers = next;
  renderOcrList();
  persist();
  return true;
}

/* ---- 图片配置 ---- */
/* **不是另一份配置**：数据还是 state.configs，这里只是把「填了图片请求模板」
   的那些滤出来，外加一个自己的选中项（state.ocr.imageConfigId）。
   这样翻图前不用先回顶栏把配置切成支持视觉的那条，也不会把图发给纯文字接口。
   **新建 / 删除 / 改名一概回「配置」栏**（那是内容，两处都能编辑迟早打架）；
   但**排序在这儿也能做**，因为顺序本来就只有一个地方存 —— `state.configs` 的先后，
   所以在这儿拖完「配置」栏会跟着变（kniph 要的：逻辑和配置列表一样）。 */

/** 能翻图的配置 = **轮换链里随便哪条**（主请求或后备）填了图片请求模板的那些。
    判据只有 `canTranslateImage` 一处，和面板顶栏那份下拉、`pickRequestConfig` 同口径
    —— 后备上挂了图片模板的配置，在这儿也得看得见。 */
function imageConfigs() {
  return state.configs.filter(canTranslateImage);
}

/* 真正去发图的那一条：链里**第一条填了图片请求模板**的请求条目（主请求或某条后备）。
   图片模板挂在后备上时，主请求那段文字模板根本喂不进图，测试 / 预览要挑的就是这条。
   返回的是条目（`{ id, name, main, imageRequest, path, … }`），不是配置。 */
function imageItem(c) {
  if (!c) return null;
  return requestChain(c).find((r) => String(r.imageRequest || '').trim()) || null;
}

/* 直传模式下左栏「选中的那条」——「测试」和「请求预览」都以它为准。
   选中项失效（那条被删了 / 图片模板被清空了）时和列表一样落回第一条，别让测试悬空。 */
function imageTestConfig() {
  const list = imageConfigs();
  if (!list.length) return null;
  return list.find((c) => c.id === state.ocr.imageConfigId) || list[0];
}

function renderImageConfigList() {
  const list = imageConfigs();
  els.imgcfgList.innerHTML = '';

  // 一条都没有：把引导摊在列表里，别只留个空框
  if (!list.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.innerHTML =
      '还没有任何配置填过「图片请求模板」。<br>' +
      '去<b>「配置」</b>栏挑一条能看图的那个模型，把「图片请求模板」填上，它就会出现在这里。' +
      '<br>（填在主请求上或任意一条后备上都认。）';
    els.imgcfgList.appendChild(empty);
    if (state.ocr.imageConfigId) {
      state.ocr.imageConfigId = '';
      scheduleSave();
    }
    return;
  }

  // 选中的那条被删了 / 图片模板被清空了：挑回第一条，别让选中项悬空
  // （background 那边也有兜底 —— 找不到就退回顶栏那条）
  if (!list.some((c) => c.id === state.ocr.imageConfigId)) {
    state.ocr.imageConfigId = list[0].id;
    scheduleSave();
  }

  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    // 副标题摊的是「真会去发图的那一条」的模板地址 —— 图片模板挂在后备上时，
    // 摊主请求那段文字模板会让人以为配错了
    const it = imageItem(c);
    els.imgcfgList.appendChild(sortableRow({
      id: c.id,
      name: c.name,
      sub: it ? summarizeUrl(it.imageRequest, T('opt_empty', '(空)')) : T('opt_empty', '(空)'),
      active: c.id === state.ocr.imageConfigId,
      inCompare: imgSlotConfigIds().includes(c.id),
      index: i,
      total: list.length,
      listEl: els.imgcfgList,
      onSelect: () => {
        state.ocr.imageConfigId = c.id;
        panelTouched.add('imageConfigId'); // 面板图片模式下也写它
        renderImageConfigList();
        // 换了对象：预览跟着换，上次的测试结果也不再是这条的了 —— 收起来免得看岔
        renderOcrPreview();
        els.ocrTestResult.hidden = true;
        persist(false);
      },
      onMove: moveImageConfig,
      /* 点行 = 加入对比。原来这里没传这两个回调 —— 图片配置永远只能选一条来编辑，
         表现就是「勾了禁用外置 OCR 之后不能多选」（kniph 2026-10-18 报的）。 */
      onAddToCompare: toggleImgSlotConfig,
      onRemoveFromCompare: (cid) => toggleImgSlotConfig(cid, { force: false })
    }));
  }
}

/**
 * 在「图片配置」列表里挪一条。
 *
 * 那份列表是 `state.configs` 的**过滤视图**，排序动的还是 `state.configs` 本身
 * （`moveVisibleItem` 换算下标）—— 另存一份顺序就是第二个真相源。
 * 副作用是「配置」栏的先后跟着一起变，所以两个列表都要重画。
 *
 * `to` 是**过滤视图**里的下标，别和 `moveConfig` 那个完整数组下标混了。
 */
function moveImageConfig(id, to) {
  flushEditor();
  const vis = imageConfigs().map((c) => c.id);
  const from = vis.indexOf(id);
  if (from < 0) return false;
  const next = moveVisibleItem(state.configs, vis, from, to);
  if (next === state.configs) return false; // 原地没动
  state.configs = next;
  // 同上：配置顺序变了，对比名单跟着重排（面板默认顺序 = 设置里的顺序）
  state.settings.slotConfigs = sortByConfigOrder(slotConfigIds());
  renderConfigList();
  renderImageConfigList();
  persist();
  return true;
}

/** 「禁用外置 OCR」是全局开关，不属于任何一条供应商 */
function renderOcrDisabled() {
  const off = !!state.ocr.disabled;
  els.oDisabled.checked = off;

  /* 左栏整个换掉：直传时列「图片配置」（填了图片模板的那些），否则列 OCR 供应商。
     右边供应商那套字段跟着收起来 —— 见 CSS 里的 #ocr-editor.is-imgcfg。
     用不上的字段是**直接藏掉**（不是压暗）：压暗会连「测试」「请求预览」一起染上，
     而那两块在直传模式下还在用，看着像被禁用。 */
  els.ocrList.hidden = off;
  els.imgcfgList.hidden = !off;
  els.ocrListTitle.textContent = off ? '图片配置' : 'OCR 配置';
  // 图片配置不能在 OCR 栏新建 —— 数据只有一份，维护入口也只留一个
  els.btnOcrNew.hidden = off;
  els.imgcfgFoot.hidden = !off;
  els.imgcfgHint.hidden = !off;
  els.ocrEditor.classList.toggle('is-imgcfg', off);
  // 先画列表（里面会把失效的选中项落回第一条），再决定测试按钮的状态
  if (off) renderImageConfigList();

  /* 那块「测试」在直传模式下**不关掉，换个对象**：不测这条 OCR 供应商，
     改测左边选中的那条图片配置的「图片请求模板」—— 不然勾上之后这条路就没法试了
     （右键截一张图才知道对不对，太贵）。一条图片配置都没填时才禁用。 */
  const imgForTest = off ? imageTestConfig() : null;
  els.ocrTestBtn.disabled = off && !imgForTest;
  els.ocrTestBtn.title = off
    ? (imgForTest
        ? T('ocr_test_title_img', '用的是左边选中那条「图片配置」的图片请求模板')
        : T('ocr_test_title_none', '还没有配置填过「图片请求模板」，去「配置」栏给能看图的那条填上'))
    : '';
  els.oTestLabel.textContent = off ? T('ocr_test_label_img', '测试图片配置') : T('opt_set_012', '测试');
  els.ocrTestHint.hidden = off;
  els.imgcfgTestHint.hidden = !off;
  /* 图是从哪一条发出去的 —— 图片模板挂在后备上时摊的是后备那一段，
     不说一句会让人以为预览摊错了（「我主请求里没写这个啊」）。 */
  const imgOn = imgForTest ? imageItem(imgForTest) : null;
  els.oPreviewSummary.textContent = off
    ? T('ocr_preview_summary_img', '这次会发出去的请求（示例图 · Key 已打码）')
    : T('opt_set_011', '这次会发出去的请求（Key 已打码）');
}

function renderOcrEditor() {
  renderOcrDisabled();
  const p = currentOcrProvider();

  /* 一条供应商都没有时才显示那个空态 —— 但「图片直传」模式下右边只剩说明 + 预览，
     和有没有供应商无关，别被空态顶掉（顶掉了 #imgcfg-hint / 预览就没了）。 */
  if (!p && !state.ocr.disabled) {
    els.ocrEditor.hidden = true;
    els.ocrEmpty.hidden = false;
    return;
  }

  els.ocrEditor.hidden = false;
  els.ocrEmpty.hidden = true;
  if (!p) {
    renderOcrPreview(); // 直传模式 + 没有供应商：只留 #imgcfg-hint 和那份预览
    return;
  }

  els.oName.value = p.name || '';
  // 备注只摊一行（多了省略），全文挂在 title 上 —— 让它换行就会把下面的请求块顶下去
  els.oNote.textContent = p.note || '';
  els.oNote.title = p.note || '';
  // 主请求 + 后备，和配置栏同一套块（blockHtml 的 ocr 变体）
  renderOcrBlocks(p);

  // 换了一条供应商，上一次的测试结果就不是这条的了 —— 收起来，免得看岔
  els.ocrTestResult.hidden = true;

  renderOcrPreview();

  // 只剩一条时不让删：删空了功能就没了（内置那条就算删了下次启动也会被补回来）
  els.btnOcrDelete.disabled = state.ocr.providers.length <= 1;
}

/* ---- OCR 的「完整请求」预览 ---- */
/* 和配置栏那个「渲染预览」一个意思：**别让人猜扩展到底发了什么**。
   OCR 也是一段可编辑的模板了 —— 摊出来才看得清。
   图片位置塞一张**假的**小图：真截图是几十万字符的 data URL，摊出来没法读。 */

const OCR_SAMPLE_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';

function renderOcrPreview() {
  /* 直传模式下预览的是**左边那条图片配置的图片请求模板**（用一张示例图），
     不然勾上之后完全看不到扩展会发什么 —— 而预览和真发的是同一处组装。 */
  const off = !!state.ocr.disabled;
  const p = off
    ? (() => {
        // 摊的是「真会去发图的那一条」（见 imageItem）：图片模板挂在后备上时也摊得出来
        const it = imageItem(imageTestConfig());
        return it ? { request: it.imageRequest, responsePath: it.path } : null;
      })()
    : currentOcrProvider();
  if (!p) {
    els.oPreview.textContent = off
      ? '左边还没有能翻图的配置。去「配置」栏给能看图的那条填上「图片请求模板」，这里就会摊出来。'
      : '';
    return;
  }

  // 组装和真发出去的是同一个函数（lib/ocr.js 的 previewOcrRequest）。
  // vars 用真的用户变量 —— {{apiKey}} 解出来的值会在这里被打码，别慌
  let vars;
  try {
    vars = buildVars(state, '', { image: OCR_SAMPLE_IMAGE });
  } catch {
    vars = {};
  }

  /* 有后备就**一条条摊**（和配置栏那个预览一样）：不然挂了主请求之后发的是哪一段，
     在这儿根本看不见。链的取法和 background 里同一处（lib/requests.js 的 requestChain）。 */
  const chain = off
    ? [{ request: p.request, path: p.responsePath }]
    : requestChain({ ...p, path: p.responsePath || '' });

  const parts = chain.map((item) => {
    const req = previewOcrRequest(item, OCR_SAMPLE_IMAGE, vars);
    const notes = [...(req.warnings || [])];
    if (req.style) notes.unshift(T('opt_style_prefix', '写法：') + (req.style === 'raw' ? T('opt_style_raw', '原始 HTTP 报文') : 'curl') + T('opt_style_auto', '（自动识别）'));
    if (/{{image(Base64|UrlEncoded)?}}/.test(String(item.request || ''))) {
      notes.push('上面 {{image}} 的位置是一张假的示例图，真截图是一整段 data URL；「测试」跑完后的「实际请求」里是那一份真的');
    }
    const head = chain.length > 1 ? '—— ' + (item.main ? T('opt_main_req', '主请求') : (item.name || T('opt_fallback_word', '后备'))) + ' ——' : '';
    return head ? head + '\n' + formatPreview(req, notes) : formatPreview(req, notes);
  });

  els.oPreview.textContent = parts.join('\n\n');
}

/** 把编辑框里的东西写回当前那条供应商。切走之前必须调一次。
    块的读写和配置栏**同一套**（`readBlock` + 按 DOM 顺序对回去），差别只是字段少两项。 */
function collectOcrEditor() {
  const p = currentOcrProvider();
  if (!p) return null;
  p.name = els.oName.value.trim() || '未命名供应商';

  for (const node of els.ocrBlocks.querySelectorAll('.req-block')) {
    const isMain = node.dataset.id === p.id;
    const item = isMain ? p : (p.fallbacks || []).find((f) => f.id === node.dataset.id);
    if (!item) continue;
    const b = readBlock(node);
    if (isMain) {
      p.request = b.request;
      p.responsePath = b.path;
      p.mainEnabled = b.enabled;
    } else {
      item.request = b.request;
      item.path = b.path;
      item.enabled = b.enabled;
    }
  }
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
  /* 左栏三处同一套排序：配置列表 / 图片配置 / **OCR 供应商**（顺序也有意义了 ——
     它就是「先试哪条」之外的又一种表达；kniph 2026-10-14：三个部分复用同一套逻辑）。 */
  bindSortDrag(els.ocrList, moveOcrProvider);

  els.oName.addEventListener('input', () => {
    const p = currentOcrProvider();
    if (!p) return;
    p.name = els.oName.value;
    // 名称出现在列表那行
    renderOcrList();
    scheduleSave();
  });

  /* 请求块是动态画的 → 事件挂容器上（委托），和配置栏同一套写法。 */
  /* 和配置栏共用一套输入委托（`bindBlockInputs`）—— 只差收尾刷什么 */
  bindBlockInputs(els.ocrBlocks, () => {
    collectOcrEditor();
    renderOcrList();
    renderOcrPreview();
    scheduleSave();
  });

  // 折叠 / 增删改：和配置栏**同一个处理器体**（抽出来两边共用，别复制）
  bindBlockActions({
    collect: collectOcrEditor,
    render: () => {
      renderOcrBlocks(currentOcrProvider());
      renderOcrList();
      renderOcrPreview();
    }
  }, els.ocrBlocks);

  els.btnOcrAddFallback.addEventListener('click', () => {
    const p = collectOcrEditor();
    if (!p) return;
    p.fallbacks = p.fallbacks || [];
    p.fallbacks.push(normalizeOcrItem({ request: p.request }));
    renderOcrBlocks(p);
    renderOcrList();
    renderOcrPreview();
    persist();
  });

  els.oDisabled.addEventListener('input', () => {
    state.ocr.disabled = els.oDisabled.checked;
    renderOcrDisabled();
    // 预览换对象了（供应商 ↔ 图片配置），上次的测试结果也不再是这一套的了
    renderOcrPreview();
    els.ocrTestResult.hidden = true;
    scheduleSave();
  });

  els.btnOcrNew.addEventListener('click', () => {
    collectOcrEditor();
    // 新供应商的初始模板直接抄内置那条 —— 手抄一份的话，改了内置模板这里会漂。
    // **不预填备注**：原来塞过一句「照着内置那条改：换地址、模型名、提示词，占位符别动」——
    // 那是配置栏已经教过的事（kniph 2026-10-14 要求删），而且备注显示在 pane 最底下，
    // 等看见它时人早就写完了。
    const p = normalizeOcrProvider({
      name: '新供应商',
      note: '',
      request: OCR_PROVIDERS[0].request
    });
    state.ocr.providers.push(p);
    editingOcrId = state.ocr.activeId = p.id;
    renderOcrList();
    renderOcrEditor();
    // 落到名称框上（请求模板默认收起，聚焦它还得先摊块）
    els.oName.focus();
    els.oName.select();
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

/* ---- OCR 测试 ---- */
/* 和配置栏那个「测试」同构：发一次真请求，把结果摊开看。
   区别只在输入 —— 那边是一段文本，这边是一张图片：默认拿**剪切板里的第一张图**
   （就是你平时右键要翻的那张），也可以先挑一张本地图片再点。 */

/**
 * 字节数 → 人能读的大小。
 *
 * ⚠️ **这个函数有两份**：这份是设置页的，`content.js` 里那份是面板的
 * （content script 不能 import，只能手抄 —— 和 TRIGGER_CSS / PANEL_CSS 同一个处境）。
 * 两份**必须逐字一致**：它们显示的是同一个量（截图 / 响应的大小），
 * 各写各的就会出现「设置页说 49 KB、面板说 48.8 KB」（kniph 2026-10-18 通读发现，
 * 原来两份的小数位规则就不一样）。test-lib 有一条断言逐值比对两边的输出。
 */
function formatBytes(n) {
  const b = Math.max(0, Number(n) || 0);
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
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
  /* 两块活儿共用一个按钮：
       * 平时——测当前这条 OCR 供应商（走 runOcr）；
       * 勾了「禁用外置 OCR」——测左边选中的那条**图片配置**的图片请求模板（走 runImageTranslate），
         这条路在右键截图之前没有别的地方能试。 */
  const off = !!state.ocr.disabled;
  let target = null;
  if (off) {
    target = imageTestConfig();
  } else {
    collectOcrEditor();
    await persist(false);
    target = currentOcrProvider();
  }
  if (!target) return;

  /* 直传模式下真正发出去的是**条目**（图片模板挂后备上时就是那条后备，见 imageItem）。
     名字按它显示 —— 不然测成功了你都不知道是主请求成的还是后备成的。 */
  const item = off ? imageItem(target) : null;
  const label = item && !item.main ? `${target.name} · ${item.name}` : target.name;

  const btn = els.ocrTestBtn;
  /* 剪切板读取可能花几百毫秒 —— 拿到图之前就禁用，双击不会并发两轮测试 */
  btn.disabled = true;
  btn.textContent = '测试中…';
  const box = els.ocrTestResult;
  box.hidden = false;

  let shot = null;
  try {
    shot = ocrTestFile ? await fileImage(ocrTestFile) : await clipboardImage();
  } catch (err) {
    btn.disabled = false; // 提前禁用了就得在这儿放开，不然测试按钮永久卡死
    btn.textContent = '测试';
    box.innerHTML =
      '<div class="result-head"><span class="badge err">没拿到图片</span>' +
      `<span class="badge">${escapeHtml(label)}</span></div>` +
      '<div class="result-body"><div class="row"><div class="row-title">原因</div>' +
      `<pre class="err-text">${escapeHtml((err && err.message) || err)}</pre></div></div>`;
    return;
  }

  const srcLabel = shot.source + ' · ' + formatBytes(shot.bytes);
  btn.disabled = true;
  btn.textContent = off ? '翻译中…' : '识别中…';
  box.innerHTML =
    '<div class="result-head"><span class="badge">请求中…</span>' +
    `<span class="badge">${escapeHtml(label)}</span>` +
    `<span class="badge">${escapeHtml(srcLabel)}</span></div>`;

  let r = null;
  let err = null;
  try {
    const vars = buildVars(state, '', { image: shot.dataUrl });
    r = off
      ? await runImageTranslate({ config: item || target, dataUrl: shot.dataUrl, vars })
      : await runOcr({ provider: target, dataUrl: shot.dataUrl, vars });
  } catch (e) {
    err = e;
  }

  btn.disabled = false;
  btn.textContent = '测试';
  renderOcrTestResult({
    // 是后备成的就带上那一跳：不然只看到供应商名，不知道该改哪段
    name: label + (r && r.from && r.from !== '主请求' ? ` · ${r.from}` : ''),
    srcLabel,
    r,
    err,
    textTitle: off ? '译文' : '识别到的文字'
  });
}

function renderOcrTestResult({ name, srcLabel, r, err, textTitle = '识别到的文字' }) {
  const status = err ? (err.status || '失败') : r.status;
  const ms = err ? err.ms : r.ms;

  const badges = [`<span class="badge ${err ? 'err' : 'ok'}">HTTP ${escapeHtml(String(status))}</span>`];
  if (typeof ms === 'number') badges.push(`<span class="badge">${ms} ms</span>`);
  badges.push(`<span class="badge">${escapeHtml(name)}</span>`);
  badges.push(`<span class="badge">${escapeHtml(srcLabel)}</span>`);

  const rows = [];
  if (err) {
    rows.push(
      `<div class="row"><div class="row-title">${T('opt_row_error', '错误')}</div><pre class="err-text">${escapeHtml(
        (err && err.message) || String(err)
      )}</pre></div>`
    );
  }
  if (r && r.text) {
    rows.push(
      `<div class="row"><div class="row-title">${escapeHtml(textTitle)}</div><pre class="translated">${escapeHtml(
        r.text
      )}</pre></div>`
    );
  }

  // 失败时也要把请求和响应摊出来 —— 配错了（模型名、key、提示词）全靠这两块定位
  rows.push(requestBlockHtml((err && err.request) || (r && r.request)));

  const raw = (err && err.raw) || (r && r.raw);
  if (raw) {
    rows.push(
      `<div class="row"><div class="row-title">${T('opt_row_raw', '原始响应')}</div><pre>${escapeHtml(
        truncateText(raw, 8000)
      )}</pre></div>`
    );
  }

  /* 同样的规矩：**没拿到结果的那一块折起来**（和配置栏共用 resultBlockHtml）——
     OCR 这边「失败」= 报错、或者请求通了但一个字都没认出来。 */
  els.ocrTestResult.innerHTML = resultBlockHtml({
    head: badges.join(''),
    body: rows.join(''),
    fold: !(r && r.text),
    why: shortError((err && err.message) || '请求成功但没认出任何文字')
  });
}

/* ---- 设置 ---- */

/* 设置面板的**唯一真相源**：一条设置项 = 表里一行。
   绑定（bindSettings）和回填（renderSettings）都从这张表跑，别在两处各手抄一遍
   —— 加一条设置只改这里 + options.html 里那个控件。

   每行的字段：
     sel   —— 控件的 CSS 选择器（也是取值用的那个）
     key   —— state.settings 里的字段名
     kind  —— 'value' | 'checked' | 'number'，决定怎么读 / 怎么写
     load  —— 存档值 → 控件值。**老存档缺这个字段时在这里兜底**（`??` / `!== false`）
     save  —— 控件值 → 存档值（checked 取布尔、number 取数字）
     after —— 改完之后的副作用（有的设置要立刻刷预览 / 换主题）

   '#s-lang'（目标语言）不在表里 —— 它是「下拉 + 自己填」两个控件合成一个值，
   单独走 renderTargetLang / bindTargetLang。
   '#s-trigstyle'（按钮样式）也不在 —— 它是卡片组，不是原生控件，见 renderTriggerStyles。 */
const SETTING_MAP = [
  {
    sel: '#s-trigger', key: 'trigger', kind: 'value',
    load: (v) => v, save: (el) => el.value
  },
  {
    sel: '#s-ctx', key: 'contextMenu', kind: 'checked',
    load: (v) => !!v, save: (el) => el.checked
  },
  {
    // 缺席按「开」算 —— 这条是新加的，老存档里没有这个字段
    sel: '#s-ocrmenu', key: 'ocrMenu', kind: 'checked',
    load: (v) => v !== false, save: (el) => el.checked
  },
  {
    sel: '#s-shotmenu', key: 'shotMenu', kind: 'checked',
    load: (v) => v !== false, save: (el) => el.checked
  },
  {
    // 清空输入框时退回默认 8000 —— 写 0 是「一个字都不发」，而 popup 那边
    // slice(0, 0) 会把选中的文字整个吞掉（2026-10-18 复查）
    sel: '#s-max', key: 'maxChars', kind: 'number',
    load: (v) => v, save: (el) => Number(el.value) || 8000
  },
  {
    sel: '#s-framebridge', key: 'frameBridge', kind: 'checked',
    load: (v) => v !== false, save: (el) => !!el.checked
  },
  {
    sel: '#s-slots', key: 'panelSlots', kind: 'number',
    load: (v) => String(clampSlots(v)),
    save: (el) => clampSlots(el.value),
    // 条数一变，「新选配置放哪边」的显隐要立刻跟上（不用等整页重渲染）
    after: () => syncSlotInsertRow()
  },
  {
    sel: '#s-slotinsert', key: 'slotInsert', kind: 'value',
    load: (v) => (v === 'head' ? 'head' : 'tail'),
    save: (el) => (el.value === 'head' ? 'head' : 'tail')
  },
  {
    sel: '#s-historymax', key: 'historyMax', kind: 'number',
    load: (v) => v, save: (el) => Math.max(0, Math.round(Number(el.value) || 0))
  },
  {
    sel: '#s-width', key: 'panelWidth', kind: 'number',
    load: (v) => v, save: (el) => Number(el.value) || 0
  },
  {
    sel: '#s-height', key: 'panelHeight', kind: 'number',
    load: (v) => v, save: (el) => Number(el.value) || 0
  },
  {
    // 缺席按 46 算 —— 这条是新加的，老存档里没有这个字段（46 就是原来写死的那个值）
    sel: '#s-maxh', key: 'panelMaxHeight', kind: 'number',
    load: (v) => v ?? 46, save: (el) => Number(el.value) || 0
  },
  {
    sel: '#s-font', key: 'fontSize', kind: 'number',
    load: (v) => v, save: (el) => Number(el.value) || 0
  },
  {
    sel: '#s-theme', key: 'theme', kind: 'value',
    load: (v) => v, save: (el) => el.value,
    after: () => applyTheme()
  },

  {
    sel: '#s-showsrc', key: 'showOriginal', kind: 'checked',
    load: (v) => !!v, save: (el) => el.checked
  },
  {
    sel: '#s-panelcss', key: 'panelCss', kind: 'value',
    load: (v) => String(v == null ? '' : v), save: (el) => el.value
  },
  {
    sel: '#s-trigsize', key: 'triggerSize', kind: 'number',
    load: (v) => clampTriggerSize(v), save: (el) => Number(el.value) || 0,
    // 按钮大小是即时可见的，改一下就刷预览
    after: () => renderPreview()
  },
  {
    // 缺席按 5 算 —— 这条是新加的，老存档里没有（5 就是它的默认值）
    sel: '#s-trigidle', key: 'triggerIdleSec', kind: 'number',
    load: (v) => v ?? 5, save: (el) => Number(el.value) || 0
  },
  {
    // 缺席按 0.5 算 —— 同上
    sel: '#s-trigleave', key: 'triggerLeaveSec', kind: 'number',
    load: (v) => v ?? 0.5, save: (el) => Number(el.value) || 0
  },
  {
    sel: '#s-trigsvg', key: 'triggerSvg', kind: 'value',
    load: (v) => v || '', save: (el) => el.value,
    // 自定义图标一改，检查提示、预览、卡片上的图标都得跟着换
    after: () => {
      updateTriggerSvgMsg();
      renderPreview();
      renderTriggerStyles();
    }
  }
];

/**
 * 「新选配置放哪边」那一行的显隐。
 *
 * 只在「面板显示条数」> 1 时才有意义 —— 显示 1 条时两种放法都是「切换」，
 * 摆在那儿只会让人以为有区别（kniph 2026-10-17）。
 * 设置页初渲染和条数下拉变化时都调它。
 */
/**
 * 给每个折叠分组的标题标上「里面有几项」。
 *
 * 收起时 summary 后面会显示这个数字（CSS 的 ::after 读 data-count）——
 * 不然一屏全是收起的标题，看不出哪个分组是空的、哪个有内容。
 * 渲染完调一次即可（设置行是静态的，不会动态增删）。
 */
function syncGroupCounts() {
  for (const group of document.querySelectorAll('.set-group')) {
    const n = group.querySelectorAll('.set-group-body .setting').length;
    group.querySelector('summary').dataset.count = n ? n + ' 项' : '';
  }
}

/**
 * 面板效果预览：把「字号 / 宽度 / 结果区上限 / 主题」这几个量画成示意图。
 *
 * **刻意不做像素级复刻** —— 真面板的 CSS 在 content.js 的 shadow DOM 里，
 * 复刻一份必然随它漂移而腐坏，那比没有预览更糟（看着像真的、其实不对）。
 * 这里只保证「调大字号它真的变大」这类**一眼可验证**的关系。
 */
/**
 * 设置页的「效果预览」= **一个真的结果面板**。
 *
 * 以前是自己画示意图，比例和真面板对不上（kniph 2026-10-17）。
 * 现在直接复用 lib/panel-styles.js 的样式表 + 和 content.js 一样的 DOM，
 * 并且同样跑在 shadow root 里 —— 渲染路径一致，结果就不可能不一致。
 *
 * 尺寸语义也照抄 content.js：
 *   宽度   → .rt-panel 的 width
 *   字号   → --rt-fs（真面板也是直接写这个变量）
 *   面板高度 → max-height（不是定高），0 = 自适应
 *   结果区 → --rt-max-h（vh），0 = 不限
 */


const PV_SAMPLE_SRC =
  "原文：This is a paragraph of source text that was selected on a web page, used here to show what the source area looks like.";
const PV_SAMPLE_OUT =
  "译文：这是选中的那段原文的译文示例。字号、行距、换行、滚动条都按真面板来 —— " +
  "因为它就是真面板。调整上面的宽度 / 字号 / 高度，这里会跟着变，和网页上的效果一致。" +
  "\n\n第二段：多写几行，好让结果区真的出现滚动条，这样「结果区最大高度」也能看出区别。" +
  "\n\n第三段：如果内容不够长，面板高度设多大都撑不满，看着就像没生效 —— 所以这段故意写长。";

let pvBuilt = false;
/** 页签隐藏时跳过了渲染，等切过去要补一次 */
let pvNeedsRender = false;

function renderPanelPreview() {
  const host = document.getElementById("panel-preview");
  if (!host || !state) return;
  const s = state.settings || {};

  /* 首次：建 shadow root + 样式表 + 和 content.js **完全相同**的 DOM 骨架。
     这里不是"画个示意"，是把真面板搬过来 —— 所以顶栏的两个下拉、眼睛、✕、
     底栏、诊断区全在，data-drag 也照抄，拖动才和网页上一个手感。 */
  if (!pvBuilt) {
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    shadow.appendChild(style);

    const panel = document.createElement("div");
    panel.className = "rt-panel";
    panel.id = "rt-panel";
    panel.innerHTML = RTPanelCore.shellHtml();   // 骨架在 lib/panel-core.js，与网页共用同一份</button>' +
      "</div></div>" +
      '<div class="rt-body"><div class="rt-src"></div><div class="rt-out"></div></div>' +
      '<div class="rt-foot"><span class="rt-msg">HTTP 200 · 0.8s</span></div>' +
      '<div class="rt-diag" hidden></div>';
    shadow.appendChild(panel);

    /* 真面板在网页上是 fixed 弹层；预览也照做 —— 不再塞进框里、不再 transform 缩放。
       位置先给个默认（设置页右侧偏上），之后可以拖。 */
    panel.style.position = "fixed";
    panel.style.left = "auto";
    panel.style.right = "32px";
    panel.style.top = "80px";
    panel.style.display = "flex";
    panel.style.zIndex = "2147483647";

    /* 拖动：和 content.js 的 head mousedown 同一套做法（排除按钮/下拉）。 */
    pvBindDrag(panel);

    /* ✕ 关闭：不是删面板，只是收起来 —— 按钮还在，再点就回来。 */
    panel
      .querySelector('[data-act="close"]')
      .addEventListener("click", () => setPvVisible(false));

    /* 眼睛：切「显示原文」看得见效果，但不写回设置（预览里的操作不该改存档）。 */
    panel.querySelector('[data-act="src"]').addEventListener("click", () => {
      const src = host.shadowRoot.querySelector(".rt-src");
      if (src) src.classList.toggle("hidden");
    });

    pvBuilt = true;
  }

  const panel = host.shadowRoot.querySelector(".rt-panel");
  const srcEl = host.shadowRoot.querySelector(".rt-src");
  const outEl = host.shadowRoot.querySelector(".rt-out");

  /* 自定义面板样式：和真面板同一套 —— 追加到 shadow root 末尾，排在预设之后。 */
  {
    const sh = host.shadowRoot;
    let ucss = sh.querySelector("#rt-user-css");
    const cssText = String(s.panelCss == null ? "" : s.panelCss);
    if (!cssText.trim()) {
      if (ucss) ucss.remove();
    } else {
      if (!ucss) {
        ucss = document.createElement("style");
        ucss.id = "rt-user-css";
        sh.appendChild(ucss);
      }
      ucss.textContent = cssText;
    }
  }

  /* 宽度 / 字号 / 高度 / 主题：语义与 content.js 的 applyPanelSize / applyFontSize 一致。
     **不再有 maxWidth: 100% 和 transform 缩放** —— 真面板不会因为容器窄就缩自己，
     放不下就由用户拖走，这正是"和网页上一样"的含义。 */
  const w = Math.min(1600, Math.max(280, Number(s.panelWidth) || 460));
  const fs = Math.min(48, Math.max(11, Number(s.fontSize) || 20));
  const h = Math.min(2400, Math.max(0, Number(s.panelHeight) || 0));
  const mh = Math.min(100, Math.max(0, Number(s.panelMaxHeight) || 46));

  panel.style.width = w + "px";
  panel.style.maxWidth = "";
  panel.style.transform = "";
  panel.style.setProperty("--rt-fs", fs + "px");
  panel.style.setProperty("--rt-fs-sm", (fs * 0.92).toFixed(2) + "px");
  panel.style.setProperty("--rt-fs-xs", (fs * 0.85).toFixed(2) + "px");

  panel.style.maxHeight = h > 0 ? h + "px" : "";
  panel.classList.toggle("fixed-h", h > 0);
  panel.classList.toggle("no-max-h", mh === 0);
  panel.style.setProperty("--rt-max-h", mh + "vh");

  /* 主题跟**面板的 theme 设置**，不跟设置页自己的外观。 */
  const pvLight = (() => {
    const t = s.theme || "auto";
    if (t === "light") return true;
    if (t === "dark") return false;
    return !(window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
  })();
  panel.classList.toggle("light", pvLight);
  panel.dataset.rtTheme = pvLight ? "light" : "dark";

  /* 补齐「正在显示」这件事本身：真面板显示时是 .rt-panel.show、状态灯带 ok。
     少了这两样，预览的布局和真面板就有差别（show 参与 CSS 的显示规则）。 */
  panel.classList.add("show");
  /* 眼睛按钮的 on 类 = 「原文区正显示着」。真面板靠它切换图标状态，
     预览里原文是可见的，所以也要带上，否则和真面板差一个状态。 */
  {
    const eye = host.shadowRoot.querySelector('[data-act="src"]');
    if (eye) eye.classList.toggle("on", s.showOriginal !== false);
  }

  /* 诊断区填几行示例 —— 用的是与真面板同一份画行代码（RTPanelCore.renderDiag）。
     「⋯」按钮也要放开，不然看不到它。 */
  {
    const diag = host.shadowRoot.querySelector(".rt-diag");
    const more = host.shadowRoot.querySelector(".rt-more");
    if (diag) {
      RTPanelCore.renderDiag(diag, [
        { k: "首字", v: "1.02 s", hint: "第一个译文分片出现的时间" },
        { k: "总耗时", v: "1.15 s" },
        { k: "响应格式", v: "SSE" },
        { k: "分片", v: "4" },
        { k: "响应大小", v: "1.8 KB" },
        { k: "命中路径", v: "choices[0].delta.content" },
        { k: "模型", v: "deepseek-v4-flash-0731" }
      ]);
      diag.hidden = false;
    }
    if (more) more.hidden = false;
  }
  {
    const dot = host.shadowRoot.querySelector(".rt-dot");
    if (dot) dot.classList.add("ok");
  }

  /* 顶栏两个下拉填**真东西**：配置取 state.configs、语言取 targetLang。
     只显示不联动 —— 拨它不该改存档（和眼睛按钮同一个原则）。 */
  {
    const cfgSel = host.shadowRoot.querySelector(".rt-cfg");
    const langSel = host.shadowRoot.querySelector(".rt-lang");
    const cfgs = (state.configs || []).filter((c) => c && c.name);
    if (cfgSel) {
      const list = cfgs.length ? cfgs : [{ id: "", name: "（没有配置）" }];
      cfgSel.textContent = "";
      for (const c of list) {
        const o = document.createElement("option");
        o.value = c.id || "";
        o.textContent = c.name;
        cfgSel.appendChild(o);
      }
      const wantId = s.activeConfigId || (list[0] && list[0].id) || "";
      cfgSel.value = wantId;
      const cur = list.find((c) => c.id === wantId) || list[0];
      cfgSel.title = "翻译接口：" + cur.name;
    }
    if (langSel) {
      /* 候选和真面板同一份（lib/template.js 的 TARGET_PRESETS）——
         只填当前语言的话，预览的下拉是空的，点开看不到东西。 */
      const lang = s.targetLang || "简体中文";
      const cands = TARGET_PRESETS.slice();
      if (!cands.includes(lang)) cands.push(lang);
      langSel.textContent = "";
      for (const v of cands) {
        const o = document.createElement("option");
        o.value = v;
        o.textContent = v;
        langSel.appendChild(o);
      }
      langSel.value = lang;
      langSel.title = "目标语言：" + lang;
    }
  }

  srcEl.textContent = PV_SAMPLE_SRC;
  /* 结果区画成**真面板的槽位结构**，不是一坨纯文本 —— 否则作用在 .rt-slot* 上的
     自定义样式（比如悬停展开）在预览里根本触发不了（kniph 2026-11-01 报的）。
     两个槽位：一条「完成」、一条「失败」，这样 err 态的样式也能看到。 */
  outEl.classList.remove("empty");
  /* 结果区：**和网页上同一份 HTML**（lib/panel-core.js）。两个槽位 ——
     一条「完成」一条「失败」，这样 err 态的样子也能看到。 */
  outEl.innerHTML = RTPanelCore.slotsHtml([
    { configId: "pv-1", name: "配置甲", state: "done", text: PV_SAMPLE_OUT, error: "", statusText: "" },
    { configId: "pv-2", name: "配置乙", state: "fail", text: "", error: "译文：这一条故意标成失败，用来看 err 态的颜色。", statusText: "" }
  ], {});
  srcEl.classList.toggle("hidden", !(s.showOriginal !== false));
}

/** 预览面板的拖动：和 content.js 的 data-drag 逻辑同形（排除按钮与下拉）。 */
function pvBindDrag(panel) {
  const head = panel.querySelector("[data-drag]");
  if (!head) return;
  let dragging = false;
  let sx = 0;
  let sy = 0;
  let px = 0;
  let py = 0;

  head.addEventListener("mousedown", (e) => {
    if (e.target.closest(".rt-btn") || e.target.closest(".rt-cfg") || e.target.closest(".rt-lang")) return;
    /* fixed + right 定位时 left 是 auto，先量出真实 left 再改成显式值，否则算不准。 */
    const r = panel.getBoundingClientRect();
    panel.style.left = r.left + "px";
    panel.style.right = "auto";
    panel.style.top = r.top + "px";
    dragging = true;
    sx = e.clientX;
    sy = e.clientY;
    px = r.left;
    py = r.top;
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const k = 1 / pvZoom();
    const w = panel.offsetWidth * k;
    const h = panel.offsetHeight * k;
    const edge = 12 * k;
    let nx = px + (e.clientX - sx) * k;
    let ny = py + (e.clientY - sy) * k;
    nx = Math.min(Math.max(nx, edge), Math.max(edge, window.innerWidth - w - edge));
    ny = Math.min(Math.max(ny, edge), Math.max(edge, window.innerHeight - h - edge));
    panel.style.left = nx + "px";
    panel.style.top = ny + "px";
  });

  window.addEventListener("mouseup", () => {
    dragging = false;
  });
}

/** 设置页没有被反向缩放（真面板那套 --rt-zs 补偿在 content.js 里），这里恒为 1。 */
function pvZoom() {
  return 1;
}

/** 显示 / 收起预览面板。收起只是隐藏 host，不动 DOM —— 再点回来位置/状态都还在。 */
function setPvVisible(on) {
  const host = document.getElementById("panel-preview");
  const btn = document.getElementById("btn-pv-open");
  if (!host) return;
  host.hidden = !on;
  if (btn) btn.textContent = on ? "收起面板" : "显示面板";
  if (on) renderPanelPreview();
}

function syncSlotInsertRow() {
  const row = $('#row-slotinsert');
  if (!row) return;
  const n = clampSlots(state.settings.panelSlots);
  row.hidden = n <= 1;
}

function renderSettings() {
  for (const row of SETTING_MAP) {
    const el = $(row.sel);
    const v = row.load(state.settings[row.key]);
    if (row.kind === 'checked') el.checked = v;
    else el.value = v;
  }
  syncSlotInsertRow();

  // 这两条不是原生控件驱动的，单独走
  renderTargetLang();
  renderTriggerStyles();
  updateTriggerSvgMsg();
  renderPreview();
  renderHistory();
  applyTheme();
}

/**
 * 设置页底部那份「翻译记录」。
 *
 * 三条能力：复制译文 / 重翻这条原文 / 按关键词过滤。条数上限在「翻译记录条数」里调。
 *
 * 为什么重翻要走 runRequest 而不是「再翻一次网页选区」：记录里存的是**当时那段原文**，
 * 用户想用**当前配置**重试它 —— 和网页上选没选中文字无关。
 */
function renderHistory() {
  const list = $('#history-list');
  if (!list) return;
  const max = Math.max(0, Number(state.settings.historyMax) || 0);
  const all = (Array.isArray(state.history) ? state.history : []).slice(0, max);

  /* 过滤：原文 / 译文 / 配置名 / 语言，任一处命中就算。大小写不敏感。 */
  const q = String($('#history-search')?.value || '').trim().toLowerCase();
  const items = q
    ? all.filter((h) =>
        [h.src, h.dst, h.configName, h.lang]
          .some((v) => String(v || '').toLowerCase().includes(q))
      )
    : all;

  if (!all.length) {
    list.innerHTML = '<p class="hint">' + T('opt_hist_empty', '还没有记录（或上面把条数设成了 0）。') + '</p>';
    return;
  }
  if (!items.length) {
    list.innerHTML = '<p class="hint">' + T('opt_hist_nomatch_a', '没有匹配「') + escapeHtml(q) + T('opt_hist_nomatch_b', '」的记录。') + '</p>';
    return;
  }

  const fmt = (ts) => {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };

  /* 「重翻」用当前选中的配置重发这条记录里的原文（不是当时那条配置 ——
     用户的意图是「换了我现在的配置再试一次」）。 */
  const redoHint = (h) => {
    const now = getConfig(state, state.activeConfigId);
    const was = h.configName || '';
    return now && was && now.name !== was
      ? `用「${now.name}」重翻这条（当时用的是「${was}」）`
      : '用当前配置重翻这条原文';
  };

  list.innerHTML = items
    .map((h, i) => {
      const idx = all.indexOf(h);
      return (
        '<div class="history-item" data-hi="' + idx + '">' +
        `<div class="h-meta">${escapeHtml(fmt(h.ts))} · ${escapeHtml(h.configName || '')} · ${escapeHtml(h.lang || '')}</div>` +
        `<div class="h-src">${escapeHtml(h.src)}</div>` +
        `<div class="h-dst">${escapeHtml(h.dst)}</div>` +
        `<div class="h-acts">` +
        `<button type="button" class="ghost h-act" data-act="copy" title="复制这条译文">复制译文</button>` +
        `<button type="button" class="ghost h-act" data-act="redo" title="${escapeHtml(redoHint(h))}">重翻</button>` +
        `</div>` +
        '</div>'
      );
    })
    .join('');
}

/**
 * 临时把按钮文字换成提示，过一会儿换回来。
 * 为什么不用 toast：设置页里这些动作都是「就地反馈」性质（复制成功、翻译失败），
 * 弹一个浮层反而打断视线，改按钮自己的字最直观。
 */
function flashButton(btn, text, restore, ms = 1400) {
  const old = restore == null ? btn.textContent : restore;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = old;
  }, ms);
}
/** 历史记录里的动作：复制译文 / 重翻。用事件委托，避免每次重渲染都绑定一遍 */
async function onHistoryAction(e) {
  const btn = e.target.closest('.h-act');
  if (!btn) return;
  const item = btn.closest('.history-item');
  if (!item) return;
  const idx = Number(item.dataset.hi);
  const h = (state.history || [])[idx];
  if (!h) return;

  if (btn.dataset.act === 'copy') {
    try {
      await navigator.clipboard.writeText(String(h.dst || ''));
      flashButton(btn, '已复制', '复制译文');
    } catch {
      flashButton(btn, '复制失败', '复制译文');
    }
    return;
  }

  if (btn.dataset.act === 'redo') {
    const cfg = getConfig(state, state.activeConfigId);
    if (!cfg) return;
    const oldText = btn.textContent;
    btn.disabled = true;
    btn.textContent = '翻译中…';
    try {
      const vars = buildVars(state, String(h.src || ''), {});
      const r = await runRequest({
        requestText: requestTemplateFor(cfg, {}),
        adapter: cfg.adapter,
        vars,
        path: cfg.path,
        responseMode: cfg.responseMode,
      });
      if (r && r.text) {
        /* 把新结果写回这条记录，并记下这次用的是哪条配置 */
        h.dst = String(r.text).slice(0, 5000);
        h.configName = cfg.name;
        h.ts = Date.now();
        await saveState(state);
        renderHistory();
        return;
      }
      flashButton(btn, '失败：' + String((r && r.error) || '没有译文').slice(0, 24), oldText, 2600);
    } catch (err) {
      flashButton(btn, '失败：' + String(err && err.message || err).slice(0, 24), oldText, 2600);
    } finally {
      btn.disabled = false;
      if (btn.textContent !== oldText) btn.textContent = oldText;
    }
  }
}
/* ---- 翻译按钮 ---- */

function renderTriggerStyles() {
  // 用 getTriggerStyle 归一过一次：存档里留着已经删掉的预设（比如原来的「笔尖」）时，
  // 直接比 id 会一张卡都点不亮
  const cur = getTriggerStyle(state.settings.triggerStyle).id;
  // 「自定义」那张卡上画的是**你实际会用到的图标** —— 填了就是你的，没填就空着。
  // 别拿示例图标冒充：那样看着像「这个预设就长三条线加箭头」。
  const customSvg = parseTriggerSvg(state.settings.triggerSvg).svg;
  els.trigStyles.innerHTML = TRIGGER_STYLES.map((s) => {
    const icon = s.id === 'custom' ? customSvg : (s.svg || escapeHtml(s.text || ''));
    return (
      '<button type="button" class="trig-card' + (s.id === cur ? ' on' : '') +
      '" data-style="' + s.id + '" title="' + escapeHtml(s.hintKey ? T(s.hintKey, s.hint) : s.hint) + '">' +
      '<span class="trig-prev' + (s.round ? ' round' : '') + (s.bare ? ' bare' : '') + '">' +
      icon + '</span>' +
      '<span>' + escapeHtml(s.key ? T(s.key, s.name) : s.name) + '</span>' +
      '</button>'
    );
  }).join('');
}

/** 自定义 SVG 的检查结果 + 「选了自定义却没填图标」的提醒，都写在这一行里 */
function updateTriggerSvgMsg() {
  if (!els.trigSvgMsg) return;
  const raw = els.trigSvg.value.trim();
  const style = getTriggerStyle(state.settings.triggerStyle);
  if (!raw) {
    // 没填图标本身没什么好说的 —— 除非现在选的是「自定义」，那按钮上顶着的
    // 是个占位图标，得说一声（不做静默回退）
    if (style.id === 'custom') {
      els.trigSvgMsg.hidden = false;
      els.trigSvgMsg.className = 'trig-svg-msg warn';
      els.trigSvgMsg.textContent =
        '「自定义」还没填图标 —— 上面的卡片先空着，页面上的按钮用一个示例图标占位；' +
        '粘一段自己的 SVG 进来，两边都会换成它。';
    } else {
      els.trigSvgMsg.hidden = true;
      els.trigSvgMsg.textContent = '';
    }
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
  // 和 content.js 一样：自己填的 SVG 优先，底座仍按选中的预设。
  // 「自定义」没填图标时页面按钮顶的是示例图标（content.js 那份），预览得跟它一致 ——
  // 预览的意义就是「页面上按钮长什么样」，它不能空着。
  const custom = parseTriggerSvg(state.settings.triggerSvg).svg;
  const fallback = s.id === 'custom' ? TRIGGER_SVG_SAMPLE : escapeHtml(s.text || '');
  root.querySelector('.rt-ico').innerHTML = custom || s.svg || fallback;
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

  /* 快捷键：Chromium 不给扩展改快捷键的 API（只有 getAll / onCommand —— e2e 实证
     chrome.commands.update 根本不存在），所以这里只能「显示当前绑定 + 跳转浏览器设置页」。
     重载扩展不算重新安装，manifest 里新加的 commands 不会自动绑（Alt+T 空绑的根因）——
     全新安装才会带上，否则去浏览器设置页手动设一次。 */
  if (chrome.commands && chrome.commands.getAll) {
    /* 这三条和 manifest 的 commands 描述是同一批文案（cmdTranslateSelection 等），
       共用 key —— 否则设置页和快捷键设置页会显示两种语言的同一个功能。 */
    const NAMES = {
      'translate-selection': T('cmdTranslateSelection', '翻译选中的文字'),
      'shot-translate': T('cmdShotTranslate', '框选截图翻译'),
      'ocr-clipboard': T('cmdOcrClipboard', '翻译剪切板中的截图')
    };
    const render = () => {
      chrome.commands.getAll((list) => {
        const rows = Object.entries(NAMES).map(([name, label]) => {
          const cur = (list.find((c) => c.name === name) || {}).shortcut;
          return label + ' ' + (cur || T('opt_hotkey_unset', '未设置'));
        });
        $('#hotkey-list').textContent = rows.join('　｜　');
      });
    };
    render();
    $('#btn-hotkey-open').addEventListener('click', () => {
      // Edge 和 Chromium 的快捷键设置页路径同名，只有协议头不同
      const url = /^edge/i.test(navigator.userAgent)
        ? 'edge://extensions/shortcuts'
        : 'chrome://extensions/shortcuts';
      chrome.tabs.create({ url });
      // 从设置页回来时刷新一遍绑定显示（用户可能刚设完）
      chrome.windows.getCurrent((w) => {
        if (w && typeof w.id === 'number') {
          chrome.windows.onFocusChanged.addListener(function onFocus(wid) {
            if (wid === w.id) {
              chrome.windows.onFocusChanged.removeListener(onFocus);
              render();
            }
          });
        }
      });
    });
  }

  /* 翻译记录：两个按钮用事件委托（记录会重渲染，逐个绑会漏） */
  const histList = $('#history-list');
  if (histList) histList.addEventListener('click', onHistoryAction);
  /* 搜索框：输入即过滤。不防抖 —— 记录最多 200 条，同步过滤足够快 */
  const histSearch = $('#history-search');
  if (histSearch) histSearch.addEventListener('input', () => renderHistory());
  // 绑定也走同一张表 —— 加设置只改 SETTING_MAP 一行
  for (const row of SETTING_MAP) {
    const el = $(row.sel);
    el.addEventListener('input', () => {
      state.settings[row.key] = row.save(el);
      // 用户亲自动的，保存时以页面为准（别被存档里面板写的那份盖掉）
      if (PANEL_OWNED_SETTING_KEYS.includes(row.key)) panelTouched.add(row.key);
      scheduleSave();
      if (row.after) row.after();
      /* 影响面板外观的那几项，改一下就把预览重画一遍 ——
         比给每条单独挂 after 省事，也不会漏（kniph 2026-10-17 要的实时预览）。 */
      if (PREVIEW_KEYS.has(row.key)) renderPanelPreview();
    });
  }

  /* 「自定义面板样式」的两个按钮。示例直接内置在这儿：
     它本质就是一组 CSS 变量覆盖，所以「预设」和「自定义」用的是同一套机制 ——
     以后想加第四个配色，往这里加一段示例就行，不用再动主题逻辑。 */
  const PANEL_CSS_WARM = [
    '/* 护眼暖色（参照 Gruvbox Dark 的暖褐基调；对比度已验过：正文 11.2、次要 6.7）',
    '   只覆盖颜色变量，不动布局 —— 想微调就改这里的值 */',
    '#rt-panel {',
    '  --rt-bg: #181713;',
    '  --rt-bg-head: #1f1e19;',
    '  --rt-bg-sub: #1b1a16;',
    '  --rt-bg-diag: #151410;',
    '  --rt-border: #332f27;',
    '  --rt-border-soft: #2a2721;',
    '  --rt-slot-line: #453f34;',
    '  --rt-hover: #282520;',
    '  --rt-scroll: #3b372e;',
    '  --rt-accent: #b8863b;',
    '  --rt-accent-soft: #2a2118;',
    '  --rt-accent-text: #d9a95a;',
    '}',
  ].join('\n');

  const setPanelCss = (value) => {
    els.panelCss.value = value;
    els.panelCss.dispatchEvent(new Event('input', { bubbles: true }));
  };
  els.btnPanelCssWarm.addEventListener('click', () => setPanelCss(PANEL_CSS_WARM));

  /* 「显示面板」：把真面板浮出来 / 收回去。收起只是 hidden，位置和状态都留着。 */
  els.btnPvOpen.addEventListener('click', () => {
    setPvVisible(document.getElementById('panel-preview').hidden);
  });
  els.btnPanelCssClear.addEventListener('click', () => setPanelCss(''));

  els.trigStyles.addEventListener('click', (e) => {
    const card = e.target.closest('.trig-card');
    if (!card) return;
    state.settings.triggerStyle = card.dataset.style;
    renderTriggerStyles();
    // 切到「自定义」而图标栏是空的 → 那一行要跳出来提醒（切回去就得消失）
    updateTriggerSvgMsg();
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

  /* 「不再显示」是把**键**存进 `hiddenHints` 的，只清这一项就能全放回来 ——
     不用连带清别的设置。没有藏过任何一句时这个按钮零存在意义，直接藏掉。 */
  const restoreHints = $('#btn-restore-hints');
  restoreHints.addEventListener('click', () => {
    state.settings.hiddenHints = [];
    persist();
    for (const el of document.querySelectorAll('[data-hint]')) el.classList.remove('hint-off');
    syncRestoreHints();
    setSaveStatus('已放回全部说明');
  });

  // 清空翻译记录：只动 history 字段，配置 / 设置 / OCR 一概不碰
  $('#btn-clear-history').addEventListener('click', async () => {
    if (!confirm('清空全部翻译记录？不可恢复。')) return;
    state.history = [];
    await persist();
    renderHistory();
    setSaveStatus('已清空翻译记录');
  });

  $('#btn-reset').addEventListener('click', async () => {
    if (!confirm('会删掉你所有自定义配置，恢复成内置的那几条。确定？')) return;
    await chrome.storage.local.remove('state');
    state = await loadState();
    editingId = state.activeConfigId;
    editingOcrId = state.ocr.activeId;
    /* 编辑态的下标是指向旧列表的 —— 恢复默认后还带着的话，会把新列表同下标那条
       直接摆成编辑态（指向另一条变量），继续打字就改错了。 */
    editingVarIdx = -1;
    blockFold.clear();
    renderConfigList();
    renderEditor();
    renderOcrList();
    renderOcrEditor();
    renderVars();
    renderSettings();
    setSaveStatus('已恢复默认');
  });
}

/* ---- 导入导出 ---- */

/**
 * 导入时挑配置（F2）。
 *
 * 为什么不再用 confirm：`confirm` 只能问「全要还是全不要」，而导入的真实场景是
 * 「别人发我一份 8 条配置，我只要其中 2 条」。原来只能整体替换，等于强迫用户先备份再挑。
 *
 * 返回 null = 用户取消；否则 { configs, merge }。
 * merge 的判据是 name（分享版里的 id 两边都不同，用 id 判断会一条都合并不上）。
 */
function pickImportConfigs(parsed, exportedAt) {
  return new Promise((resolve) => {
    const dlg = $('#import-dialog');
    const list = $('#import-list');
    const allBox = $('#import-all');
    const mergeBox = $('#import-merge');
    const errEl = $('#import-err');
    const noteEl = $('#import-note');
    if (!dlg || !list) { resolve(null); return; }

    const mine = new Set(state.configs.map((c) => c.name));
    const when = exportedAt ? `导出于 ${exportedAt.slice(0, 16).replace('T', ' ')}` : '';
    noteEl.textContent = `文件里有 ${parsed.configs.length} 条配置${when ? '，' + when : ''}。勾选要导入的：`;
    errEl.textContent = '';
    errEl.classList.remove('is-err');
    mergeBox.checked = false;

    /* 默认全勾（原行为是「全都要」，不能因为加了勾选就让老用户多点一次）。
       已存在的同名配置在副标题里标一下，用户能看出「这条会覆盖」 */
    list.innerHTML = parsed.configs.map((c, i) => {
      const dup = mine.has(c.name) ? '<span class="imp-sub">同名，导入后会覆盖现有的这条</span>' : '';
      const host = String((c.request || '').split('\n')[0] || '').trim().slice(0, 60);
      return ('<label class="imp-row">' +
        `<input type="checkbox" data-ci="${i}" checked>` +
        `<span><span class="imp-name">${escapeHtml(c.name || T('opt_unnamed', '(未命名)'))}</span>` +
        (host ? '<span class="imp-sub">' + escapeHtml(host) + '</span>' : '') +
        dup +
        '</span>' +
        '</label>');
    }).join('');
    allBox.checked = true;

    const boxes = () => [...list.querySelectorAll('input[data-ci]')];
    const checkedCount = () => boxes().filter((b) => b.checked).length;

    const onAll = () => {
      const want = allBox.checked;
      for (const b of boxes()) b.checked = want;
    };
    const onOne = () => {
      /* 全选框跟随逐条勾选：全勾 → 勾上，否则不勾（不搞「半选」那个中间态，
         原生 indeterminate 要手动设，值得不偿失） */
      allBox.checked = checkedCount() === boxes().length;
    };
    allBox.addEventListener('change', onAll);
    list.addEventListener('change', onOne);

    const done = (ok) => {
      allBox.removeEventListener('change', onAll);
      list.removeEventListener('change', onOne);
      $('#import-ok').removeEventListener('click', okYes);
      $('#import-cancel').removeEventListener('click', okNo);
      dlg.hidden = true;
      resolve(ok);
    };

    function okYes() {
      const picked = boxes()
        .map((b, i) => (b.checked ? parsed.configs[Number(b.dataset.ci)] : null))
        .filter(Boolean);
      if (!picked.length) {
        errEl.textContent = '至少勾一条';
        errEl.classList.add('is-err');
        return;
      }
      done({ configs: picked, merge: mergeBox.checked });
    }
    function okNo() { done(null); }

    $('#import-ok').addEventListener('click', okYes);
    $('#import-cancel').addEventListener('click', okNo);
    dlg.hidden = false;
  });
}
/* 口令小模态。`twice` = 设置口令（输两遍防手误）；取消返回 null。
   用页面内 DOM 而不是 window.prompt：密码框不回显明文，且一次能收两个输入。 */
function askPassphrase({ title, note, twice }) {
  return new Promise((resolve) => {
    const dlg = els.passDialog;
    const input = $('#pass-input');
    const again = $('#pass-again');
    const noteEl = $('#pass-note');
    const btnOk = $('#pass-ok');
    const btnCancel = $('#pass-cancel');

    $('#pass-title').textContent = title;
    noteEl.textContent = note || '';
    noteEl.classList.remove('is-err');
    input.value = '';
    again.value = '';
    again.hidden = !twice;
    dlg.hidden = false;
    input.focus();

    const done = async () => {
      const a = input.value;
      if (twice && a !== again.value) {
        noteEl.textContent = '两次输入的不一致，再试一次';
        noteEl.classList.add('is-err');
        return;
      }
      if (!a) {
        noteEl.textContent = '口令不能是空的';
        noteEl.classList.add('is-err');
        return;
      }
      cleanup();
      resolve(a);
    };
    const cancel = () => {
      cleanup();
      resolve(null);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') cancel();
      if (e.key === 'Enter') done();
    };
    const cleanup = () => {
      dlg.hidden = true;
      btnOk.removeEventListener('click', done);
      btnCancel.removeEventListener('click', cancel);
      document.removeEventListener('keydown', onKey);
    };
    btnOk.addEventListener('click', done);
    btnCancel.addEventListener('click', cancel);
    document.addEventListener('keydown', onKey);
  });
}

function downloadJson(text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  a.download = `request-translate-config-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ---- 界面语言（即时下载，不打包）----
 *
 * 为什么不打包语言：一个语言约 10~40 KB，打包 n 种就多 n 份 —— 而绝大多数用户只用一种。
 * 现取的好处是零体积、加语言不用发版；代价是要联网一次（约 1 秒）且依赖仓库可用，
 * 所以失败时必须**保持当前语言**，不能把界面切成空白。
 */
function bindImportExport() {
  $('#btn-export').addEventListener('click', async () => {
    // 正在编辑器里改的那条先收进 state，免得导出的还是上一版
    collectEditor();
    const plain = exportState(state);

    if (els.chkEncrypt.checked) {
      const pass = await askPassphrase({
        title: '设置导出口令',
        note: '口令不保存在任何地方 —— 丢了它，这份文件就解不开了。',
        twice: true
      });
      if (!pass) return; // 取消就不导出，勾选框保持原样
      const wrapped = await encryptExport(plain, pass);
      downloadJson(wrapped);
      setSaveStatus('已导出（加密） · ' + state.configs.length + ' 条配置');
      return;
    }

    downloadJson(plain);
    setSaveStatus('已导出 ' + state.configs.length + ' 条配置');
  });

  /* 分享版：把名字里含 key 的变量值清空，发给别人填他自己的。
     只能处理「变量形式」的 Key —— 请求模板正文里手写死的那份识别不出来，
     页面 hint 里已经明说，这里不再弹确认框烦人。 */
  $('#btn-export-share').addEventListener('click', () => {
    collectEditor();
    const shared = structuredClone(state);
    let cleared = 0;
    for (const v of shared.vars || []) {
      if (isSecretVar(v.name) && v.value) {
        v.value = '';
        cleared += 1;
      }
    }
    downloadJson(exportState(shared));
    setSaveStatus(
      cleared
        ? `已导出分享版（清掉了 ${cleared} 个密钥值）`
        : '已导出分享版（没有发现要清的密钥值）'
    );
  });

  $('#btn-import').addEventListener('click', () => els.fileImport.click());

  els.fileImport.addEventListener('change', async () => {
    const file = els.fileImport.files && els.fileImport.files[0];
    els.fileImport.value = '';
    if (!file) return;

    try {
      const text = await file.text();

      /* 加密文件先过口令，解出来的明文走下面同一套确认 + 导入 ——
         两条路在「确认覆盖」这里汇合，后面那段只写一遍。 */
      let plainText = text;
      if (isEncryptedExport(text)) {
        const pass = await askPassphrase({
          title: '输入口令',
          note: '这份配置文件是加密导出的。'
        });
        if (!pass) return;
        try {
          plainText = await decryptExport(text, pass);
        } catch (err) {
          alert('导入失败：' + (err && err.message));
          return;
        }
      }

      // exportedAt 只用来写提示 —— 别让它跟着进 state（否则下次导出会顶着旧日期）
      const { exportedAt, ...parsed } = importState(plainText);
      if (!parsed.configs.length) {
        alert('导入失败：文件里没有配置');
        return;
      }

      /* 先让用户挑要哪几条（F2）。原来这里是 confirm 一句「会全部替换」，
         收到别人分享的配置就只能把自己的一起搭进去。 */
      const picked = await pickImportConfigs(parsed, exportedAt);
      if (!picked) return;   // 取消

      if (picked.merge) {
        /* 合并：勾上的追加 / 同名覆盖，其余（变量、设置、OCR）保持不动。
           同名判据用 name —— 用户认识的是名字，不是 id（分享版里的 id 两边都不同）。 */
        const byName = new Map(state.configs.map((c) => [c.name, c]));
        for (const c of picked.configs) byName.set(c.name, c);
        state.configs = [...byName.values()];
        // 配置数变多时槽位也要有个底，否则新进来的那些「有但没显示」
        if (Array.isArray(state.slotConfigs)) {
          for (const c of picked.configs) {
            if (!state.slotConfigs.includes(c.id) && state.slotConfigs.length < 4) {
              state.slotConfigs.push(c.id);
            }
          }
        }
      } else {
        state = { ...state, ...parsed, configs: picked.configs };
      }

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
      setSaveStatus(`导入完成（${state.configs.length} 条配置）`);
    } catch (err) {
      alert('导入失败：' + (err && err.message));
    }
  });
}

/* ---- 保存 ---- */

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
  /* 面板也会写几个键（`showOriginal` / `targetLang` / `ocr.imageConfigId`），
     而这里是**整份 state 覆盖写**。页面没动过的那几个键先以存档为准，
     否则「面板里关了原文 → 回设置页随手打个字」会把面板的改动顶回去。 */
  try {
    const saved = (await chrome.storage.local.get('state')).state;
    adoptPanelOwned(state, saved, panelTouched);
  } catch {
    /* 读不到就按本地的写，和以前一样 */
  }
  await saveState(state);
  if (showStatus) flashSaved();
}

/** 「把说明都放回来」那个按钮的显隐 —— 跟着 `hiddenHints` 走。
    `applyHintHides` 每次重画完块都会跑一遍，藏过说明的入口由它统一维护。 */
function syncRestoreHints() {
  const b = document.querySelector('#btn-restore-hints');
  if (b) b.hidden = !(state.settings.hiddenHints || []).length;
}

/**
 * 说明文字的「不再显示」——**全页共用这一处**。
 *
 * HTML 里只写 `data-hint="<id>"`，按钮是这儿统一补上去的（十几处各贴一遍按钮既啰嗦、
 * 又迟早漏一处）。点过就记进 `settings.hiddenHints`，**永久收起**。
 *
 * 收起用的是 `.hint-off` 类（`display: none !important`）而**不是 `hidden` 属性**：
 * 有几条说明（OCR / 图片直传的测试说明）的 `hidden` 是**模式逻辑在管**的，
 * 一个属性两个主人迟早打架（踩过：一个开关两处 toggle）。
 *
 * 恢复入口是「把说明都放回来」那个按钮，显隐归 `syncRestoreHints` 管。
 * （这条注释原来挂在 `syncRestoreHints` 上、还写着「恢复入口没做」—— 按钮是后来加的，
 * 注释没跟着改，2026-10-18 通读挪位并订正。）
 */
function applyHintHides() {
  const hidden = new Set(state.settings.hiddenHints || []);

  for (const el of document.querySelectorAll('[data-hint]')) {
    if (!el.querySelector('.hint-hide')) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hint-hide';
      b.textContent = T('opt_hint_dismiss', '不再显示');
      b.addEventListener('click', () => {
        const id = el.dataset.hint;
        state.settings.hiddenHints = [...new Set([...(state.settings.hiddenHints || []), id])];
        el.classList.add('hint-off');
        persist();
        syncRestoreHints();
      });
      el.appendChild(b);
    }
    el.classList.toggle('hint-off', hidden.has(el.dataset.hint));
  }
  syncRestoreHints();
}

/** 「已保存」那行字。**两个编辑器的页脚各有一个**（配置栏 / OCR 栏），一起写 ——
    两栏共用同一个存档，提示也必须同步，不然会看见「这边说已保存、那边还空着」。
    （这条注释原来孤零零悬在 `persist` 后面、下面紧跟着别人的文档注释，2026-10-18 通读归位。） */
function setSaveStatus(text, saved = false) {
  for (const el of document.querySelectorAll('.save-status')) {
    el.textContent = text;
    el.classList.toggle('saved', saved);
  }
}

let savedTimer = null;
function flashSaved() {
  const t = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  setSaveStatus(`已保存 ${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}`, true);
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => setSaveStatus(''), 2500);
}

/* 目标语言：下拉挑预设，「其他」自己填                                   */
/* 候选只有一处真相源（lib/template.js 的 TARGET_PRESETS）                */
/* HTML 里那个 select 是空容器，选项在这儿填 —— 别再去 HTML 手抄一份      */

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
  panelTouched.add('targetLang'); // 面板顶栏那个下拉也写它，页面动过就以页面为准
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
  /* 直接调 persist（不闪状态栏）：它自己会收两个编辑器再落盘。
     这里曾经手抄了一遍 persist 的内部 —— 两处各写各的已经漂移过
     （flushEditor 只收配置编辑器，不收 OCR 那个），改成转调就再也不会漂。 */
  if (saveTimer) persist(false);
});
