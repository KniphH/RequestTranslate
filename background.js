/**
 * background service worker
 * ------------------------------------------------------------------
 * content script 受页面 CORS 约束，所以真正的请求都在这里发
 * （扩展有 host_permissions，可以访问用户配置里的任意域名）。
 *
 * 端口协议（端口名 rt-translate）：
 *   page → bg : { type:'translate', text, configId, context }
 *               { type:'ocr' }
 *               { type:'abort' }
 *               { type:'hello' }
 *   bg → page : { type:'ready', configs, activeConfigId, settings, targetLangs }
 *               { type:'start', configName }
 *               { type:'delta', text }
 *               { type:'done', result }
 *               { type:'fatal', message }
 *               { type:'ocr-status', message }
 *               { type:'ocr-text', text, provider, ms, bytes }
 *               { type:'ocr-image', dataUrl, bytes }   ← 「禁用外置 OCR」时的直传
 *               { type:'ocr-error', message }
 */

import { loadState, getConfig, buildVars, requestTemplateFor } from './lib/store.js';
import { runRequest } from './lib/engine.js';
import {
  OCR_MENU_ID,
  ocrMenuItem,
  SHOT_MENU_ID,
  shotMenuItem,
  activeOcrProvider,
  runOcr
} from './lib/ocr.js';
import { NO_IMAGE_MESSAGE, CLIPBOARD_UNAVAILABLE_MESSAGE } from './lib/clipboard.js';
// 顶栏那个「目标语言」下拉的候选。页面那边 import 不了模块，只能这样捎过去，
// 免得在 content.js 里手抄一份 —— 加了语言两处就对不上了。
import { TARGET_PRESETS } from './lib/template.js';

const PORT_NAME = 'rt-translate';
const MENU_ID = 'rt-translate-selection';

/* ------------------------------------------------------------------ */
/* 右键菜单                                                            */
/* ------------------------------------------------------------------ */

async function ensureMenu() {
  try {
    await chrome.contextMenus.removeAll();
    const state = await loadState();

    if (state.settings.contextMenu) {
      chrome.contextMenus.create({
        id: MENU_ID,
        title: '用 RequestTranslate 翻译选中内容',
        contexts: ['selection']
      });
    }

    // 截图那条和「翻译选中内容」分开管：选中翻译想关、截图翻译想留，是很正常的组合。
    // 描述由 lib/ocr.js 出（那条文案和 id 只有一份，测试也照它断言）。
    const ocrItem = ocrMenuItem(state.settings);
    if (ocrItem) chrome.contextMenus.create(ocrItem);

    // 「框选截图翻译」同样独立开关（settings.shotMenu），和剪切板那条可以同时开。
    const shotItem = shotMenuItem(state.settings);
    if (shotItem) chrome.contextMenus.create(shotItem);
  } catch {
    /* 忽略 */
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureMenu();
});
chrome.runtime.onStartup.addListener(() => {
  ensureMenu();
});
ensureMenu();

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || tab.id == null) return;

  if (info.menuItemId === MENU_ID) {
    const text = (info.selectionText || '').trim();
    if (!text) return;
    chrome.tabs.sendMessage(tab.id, { type: 'rt-translate-selection', text }).catch(() => {
      /* 页面没有 content script（chrome:// 之类），忽略 */
    });
    return;
  }

  // 「翻译剪切板中的截图」：剪切板在 content script 那边读不到，
  // 所以只让页面开个面板等着，读取和识别都由这里做，结果再回传过去。
  if (info.menuItemId === OCR_MENU_ID) {
    chrome.tabs.sendMessage(tab.id, { type: 'rt-ocr-clipboard' }).catch(() => {
      /* 同上 */
    });
    return;
  }

  // 「框选截图翻译」：先把当前视口截下来发给页面，框选和裁剪都在页面那边做。
  // 截图必须赶在这次点击里做 —— 对没有 <all_urls> 的页面，captureVisibleTab
  // 靠的是这次手势授予的 activeTab，拖完框再截就晚了。
  if (info.menuItemId === SHOT_MENU_ID) {
    chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
      .then((dataUrl) => chrome.tabs.sendMessage(tab.id, { type: 'rt-shot-translate', dataUrl }))
      .catch((err) => {
        // chrome://、商店页这类截不了；页面多半也没有 content script，报得过就报
        chrome.tabs
          .sendMessage(tab.id, { type: 'rt-shot-translate', error: String((err && err.message) || err) })
          .catch(() => {});
      });
  }
});

/* ------------------------------------------------------------------ */
/* 页面缩放                                                            */
/* ------------------------------------------------------------------ */
/* 网页缩放（Ctrl + 加减号）会把页面里所有 fixed 定位的东西一起放大，
   内容脚本自己看不到缩放比，只能由这里查出来告诉它，那边再做反向补偿。
   zoom 相关的 tabs 方法不需要额外的权限声明。 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'rt-get-zoom') return false;

  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (typeof tabId !== 'number') {
    sendResponse(1);
    return false;
  }

  chrome.tabs
    .getZoom(tabId)
    .then((z) => sendResponse(typeof z === 'number' && z > 0 ? z : 1))
    .catch(() => sendResponse(1));
  return true; // 异步回复，保持通道打开
});

chrome.tabs.onZoomChange.addListener((info) => {
  if (!info || typeof info.tabId !== 'number') return;
  chrome.tabs.sendMessage(info.tabId, { type: 'rt-zoom', zoom: info.newZoomFactor }).catch(() => {
    /* 页面没有内容脚本（chrome:// 之类），忽略 */
  });
});

/* ------------------------------------------------------------------ */
/* 剪切板里的截图                                                      */
/* ------------------------------------------------------------------ */
/* service worker 里没有 navigator.clipboard（也没有 DOM），读剪切板只能借
   offscreen 文档。它是**用完就关**的：这台机器内存本来就紧，
   常驻一个隐藏页面不划算（创建一次几十毫秒，能接受）。 */

const OFFSCREEN_PATH = 'offscreen.html';

/** 同一时刻只允许一次创建 —— createDocument 是异步的，前后脚来两次会撞车 */
let offscreenPending = null;

async function ensureOffscreen() {
  if (offscreenPending) {
    await offscreenPending;
    return;
  }
  offscreenPending = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        reasons: ['CLIPBOARD'],
        justification: '读取剪切板里的截图，交给 OCR 模型识别成文字'
      });
    } catch (err) {
      // 已经有一个开着了（正常情况下不会走到这儿，就当复用）
      if (!/single offscreen/i.test(String((err && err.message) || err))) throw err;
    }
  })();
  try {
    await offscreenPending;
  } finally {
    offscreenPending = null;
  }
}

/**
 * 跟 offscreen 说句话。
 * 文档刚创建好、里面的脚本可能还没挂上监听，第一次会连不上 —— 等一下再试一次。
 */
async function askOffscreen(msg) {
  const payload = { ...msg, target: 'rt-offscreen' };
  try {
    return await chrome.runtime.sendMessage(payload);
  } catch {
    await new Promise((r) => setTimeout(r, 200));
    return await chrome.runtime.sendMessage(payload);
  }
}

/**
 * 读一张剪切板里的图。
 * 返回 { ok:true, dataUrl, bytes } 或 { ok:false, reason:'no-image'|'unavailable' }。
 */
async function readClipboardImage() {
  await ensureOffscreen();
  try {
    const r = await askOffscreen({ type: 'read-image' });
    if (!r) return { ok: false, reason: 'unavailable' };
    return r;
  } catch (err) {
    return { ok: false, reason: 'unavailable', error: String((err && err.message) || err) };
  } finally {
    try {
      await chrome.offscreen.closeDocument();
    } catch {
      /* 已经关了 */
    }
  }
}

/* ------------------------------------------------------------------ */
/* 翻译端口                                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  /** @type {AbortController|null} */
  let controller = null;
  let seq = 0;
  // OCR 单独计数：识别和翻译是前后脚两件事，共用一个计数器会互相把结果丢掉
  let ocrSeq = 0;

  const safePost = (msg) => {
    try {
      port.postMessage(msg);
    } catch {
      /* 端口已断开 */
    }
  };

  port.onMessage.addListener(async (msg) => {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'abort') {
      if (controller) controller.abort();
      return;
    }

    if (msg.type === 'hello') {
      const state = await loadState();
      safePost({
        type: 'ready',
        configs: state.configs.map((c) => ({ id: c.id, name: c.name })),
        activeConfigId: state.activeConfigId,
        settings: state.settings,
        targetLangs: TARGET_PRESETS
      });
      return;
    }

    /* 截图转文字。图片有两个来源：框选截图（页面裁好了把 dataUrl 带过来）、
       剪切板（这里借 offscreen 文档读）。识别/直传的后半段两条路共用。
       设置里勾了「禁用外置 OCR」时改成「直传」：不做识别，
       把图片原样送回去，由页面塞进当前那条翻译请求（模型自己会看图）。 */
    if (msg.type === 'ocr') {
      const mySeq = ++ocrSeq;

      const state = await loadState();
      const toModel = state.ocr.disabled === true;
      const provider = toModel ? null : activeOcrProvider(state.ocr);
      if (!toModel && !provider) {
        safePost({ type: 'ocr-error', message: '还没有配置 OCR 供应商，去设置页的「OCR」里加一条' });
        return;
      }

      // 框选来的图：页面已经裁好，直接用。bytes 按 base64 比例估算，够诊断用
      const passed = typeof msg.dataUrl === 'string' && msg.dataUrl.startsWith('data:image/');
      let shot;
      if (passed) {
        shot = { ok: true, dataUrl: msg.dataUrl, bytes: Math.round(msg.dataUrl.length * 3 / 4) };
      } else {
        safePost({ type: 'ocr-status', message: '正在读取剪切板…' });
        try {
          shot = await readClipboardImage();
        } catch (err) {
          shot = { ok: false, reason: 'unavailable', error: String((err && err.message) || err) };
        }
      }
      if (mySeq !== ocrSeq) return;

      if (!shot || !shot.ok) {
        const reason = (shot && shot.reason) || 'unavailable';
        safePost({
          type: 'ocr-error',
          message: reason === 'no-image'
            ? NO_IMAGE_MESSAGE
            : CLIPBOARD_UNAVAILABLE_MESSAGE + ((shot && shot.error) ? '（' + shot.error + '）' : '')
        });
        return;
      }

      if (toModel) {
        safePost({ type: 'ocr-image', dataUrl: shot.dataUrl, bytes: shot.bytes });
        return;
      }

      safePost({ type: 'ocr-status', message: `正在识别截图（${provider.name}）…` });

      let out;
      try {
        out = await runOcr({ provider, dataUrl: shot.dataUrl });
      } catch (err) {
        if (mySeq === ocrSeq) {
          safePost({ type: 'ocr-error', message: (err && err.message) || String(err) });
        }
        return;
      }

      if (mySeq !== ocrSeq) return;
      safePost({
        type: 'ocr-text',
        text: out.text,
        provider: provider.name,
        ms: out.ms,
        bytes: shot.bytes
      });
      return;
    }

    if (msg.type === 'translate') {
      const mySeq = ++seq;
      if (controller) controller.abort();
      controller = new AbortController();

      const state = await loadState();
      const config = getConfig(state, msg.configId || state.activeConfigId);
      if (!config) {
        safePost({ type: 'fatal', message: '没有任何可用配置，请先到设置页新建一条' });
        return;
      }

      const text = String(msg.text || '').slice(0, state.settings.maxChars);
      const vars = buildVars(state, text, msg.context || {});

      // 这次带图就用「图片请求模板」，否则用普通那段（图片模板留空时也回退到它）
      const requestText = requestTemplateFor(config, msg.context || {});

      safePost({ type: 'start', configName: config.name, text });

      let result;
      try {
        result = await runRequest({
          requestText,
          adapter: config.adapter,
          vars,
          path: config.path,
          responseMode: config.responseMode,
          signal: controller.signal,
          onDelta: (current) => {
            if (mySeq !== seq) return;
            safePost({ type: 'delta', text: current });
          }
        });
      } catch (err) {
        if (mySeq !== seq) return;
        safePost({ type: 'fatal', message: err && err.message ? err.message : String(err) });
        return;
      }

      if (mySeq !== seq) return;

      safePost({ type: 'done', result: { ...result, raw: undefined } });
    }
  });

  port.onDisconnect.addListener(() => {
    if (controller) controller.abort();
    controller = null;
  });
});

/* ------------------------------------------------------------------ */
/* 配置变化时通知所有页面                                              */
/* ------------------------------------------------------------------ */

let menuTimer = null;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.state) return;
  // 设置页是边打字边自动保存的，别每敲一下就重建一次右键菜单
  clearTimeout(menuTimer);
  menuTimer = setTimeout(ensureMenu, 1500);
});
