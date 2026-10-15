/**
 * background service worker
 * content script 受页面 CORS 约束，所以真正的请求都在这里发（扩展有 host_permissions，
 * 可以访问用户配置里的任意域名）。
 *
 * 端口协议（端口名 rt-translate）
 *   page → bg：{ type:'translate', text, configId, context }
 *              ｜ { type:'ocr', dataUrl?, reuse? }（dataUrl = 页面裁好的图；reuse = 重试，
 *                 接着用上一次那张，别去读剪切板）｜ { type:'abort' } ｜ { type:'hello' }
 *   bg → page：{ type:'ready', configs, activeConfigId, settings, targetLangs }
 *              ｜ { type:'start', configName, statusText } ｜ { type:'delta', text } ｜ { type:'done', result }
 *              ｜ { type:'fatal', message } ｜ { type:'ocr-status', message }
 *              ｜ { type:'ocr-text', text, provider, ms, bytes } ｜ { type:'ocr-error', message }
 *              ｜ { type:'ocr-image', dataUrl, bytes }（「禁用外置 OCR」时的直传）
 */

import { loadState, pickRequestConfig, canTranslateImage, buildVars } from './lib/store.js';
import { requestTemplateFor, requestChain } from './lib/requests.js';
import { modelCandidates, modelVarFor } from './lib/template.js';
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

/* ---- 右键菜单 ---- */

/* in-flight 复用：安装/更新那次启动，顶层这一句和 onInstalled/onStartup 监听器**同时**跑 ——
   三个 removeAll/create 并发交错，A 的 removeAll 落在 B 的 create 之后会把刚建的菜单清没
   （create 撞重复 id 的报错又被 catch 吞掉），菜单就静默缺失。都等同一个 promise。 */
let menuPending = null;
function ensureMenu() {
  if (menuPending) return menuPending;
  menuPending = (async () => {
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
    } finally {
      menuPending = null;
    }
  })();
  return menuPending;
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

/* ---- 页面缩放 ---- */
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

/* ---- 剪切板里的截图 ---- */
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
 *
 * **串行化**：两次快速右键会前后脚进来 —— A 读完在 finally 关掉 offscreen 文档时
 * B 正处在 ensureOffscreen 与 askOffscreen 之间，消息打到一个已关闭的文档上
 * 重试也救不回来，报「剪切板不可用」而剪切板里明明有图。排队挨个读。
 */
let clipboardRead = Promise.resolve();
function readClipboardImage() {
  const run = async () => {
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
  };
  clipboardRead = clipboardRead.then(run, run);
  return clipboardRead;
}

/* ---- 翻译端口 ---- */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  /** @type {AbortController|null} */
  let controller = null;
  // OCR 识别用的是自己那个 —— 翻译和识别是前后脚两件事，抢同一个会让「先到的那个 abort
  // 把后到的那个一起杀掉」（面板关掉时两条都得停，所以 abort 消息两个都发）
  let ocrController = null;
  let seq = 0;
  // OCR 单独计数：识别和翻译是前后脚两件事，共用一个计数器会互相把结果丢掉
  let ocrSeq = 0;
  /* 上一次真正用过的截图（{ ok:true, dataUrl, bytes }）。「重试」要的是**重发刚才那张**，
     不是再翻一遍剪切板 —— 用户在那之后可能又复制了别的东西。放在端口作用域里：
     一个页面一份，不跟别的标签页串。SW 被回收 / 端口重建后这里会空，那时退回读剪切板。 */
  let lastShot = null;

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
      if (ocrController) ocrController.abort();
      return;
    }

    if (msg.type === 'hello') {
      const state = await loadState();
      safePost({
        type: 'ready',
        /* img = 这条配置能不能翻图（图片请求模板非空）—— 面板顶栏在「图片直传」那一屏
           只列这些。判据收在 lib/store.js 的 canTranslateImage 一处，别在这手写一遍。 */
        configs: state.configs.map((c) => ({ id: c.id, name: c.name, img: canTranslateImage(c) })),
        activeConfigId: state.activeConfigId,
        // 图片模式下顶栏下拉显示 / 改的就是它（和设置页 OCR 栏那份列表同一个选中项）
        imageConfigId: state.ocr.imageConfigId,
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
      /* loadState 有 IO —— 期间又来了一条 ocr 的话这条已经作废了，
         到下面才判会白发一句 ocr-status、白开关一次 offscreen 文档。 */
      if (mySeq !== ocrSeq) return;
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
      } else if (msg.reuse && lastShot) {
        shot = lastShot;
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
      lastShot = shot;

      if (toModel) {
        safePost({ type: 'ocr-image', dataUrl: shot.dataUrl, bytes: shot.bytes });
        return;
      }

      safePost({ type: 'ocr-status', message: `正在识别截图（${provider.name}）…` });

      let out;
      try {
        if (ocrController) ocrController.abort();
        ocrController = new AbortController();
        // vars 里带用户变量（{{apiKey}} 这类）。image / imageBase64 / imageUrlEncoded
        // 由 fillOcrTemplate 用真截图覆盖，这里的空串不起作用
        out = await runOcr({
          provider,
          dataUrl: shot.dataUrl,
          vars: buildVars(state, '', {}),
          signal: ocrController.signal
        });
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
      // 图片直传（勾了「禁用外置 OCR」）时用的是 OCR 栏里选定的那条**图片配置**，
      // 和顶栏那条（翻文字用的）互不干扰 —— 规则和兜底都在 pickRequestConfig 里
      const config = pickRequestConfig(state, msg.configId, !!(msg.context && msg.context.image));
      if (!config) {
        safePost({ type: 'fatal', message: '没有任何可用配置，请先到设置页新建一条' });
        return;
      }

      // Math.max 兜负数 —— 手改存档/导入文件塞进 -5 的话，slice(0,-5) 会从尾部倒砍
      const text = String(msg.text || '').slice(0, Math.max(1, Number(state.settings.maxChars) || 8000));
      const vars = buildVars(state, text, msg.context || {});

      /* ---- 两层「换一个再试」 ----
         外层：一条配置里可以挂几条**后备请求**，主请求挂了就按顺序试下一条
               （勾是唯一的开关，一条都没勾时退回主请求 —— 见 lib/store.js 的 requestChain）。
         内层：管模型的那个变量填了多行时，这条请求自己还会换一个 model 再试。
               「哪个变量管模型」由**这条请求的模板**决定（模板里名字含 model 的占位符，
               见 lib/template.js 的 modelVarFor）—— 一个人可以同时存着 GEMINI_MODEL 和
               DEEPSEEK_MODEL，看变量表挑不出该轮换哪一个，看模板才挑得准。

         两条都只跑一轮时**和以前完全一样**（没有后备 + 只有单值 model = 老行为）。
         循环放这儿而不是 runRequest 里：runRequest 是「一次调用 = 一次请求」，
         它的返回值面板 / 诊断 / 设置页测试四处共用，不能改成内部循环。 */
      const chain = requestChain(config);

      /* 图片直传只试**填了图片模板**的那些条目。
         `requestTemplateFor` 对没填的会回退到普通那段（老配置靠这个保行为），但截图这条路
         回退出来的模板里没有 {{image}} —— 发出去必然失败，白跑一次还报错给人看。
         判据和 `canTranslateImage` / 设置页的 `imageItem` 同一句：那一段非空。 */
      const hasImage = !!(msg.context && msg.context.image);
      const runnable = hasImage
        ? chain.filter((it) => String(it.imageRequest || '').trim())
        : chain;
      // 一条都没填 → 报错说清是哪一条，别让 for 一次都不进、最后报一句「没有结果」
      if (hasImage && !runnable.length) {
        safePost({ type: 'fatal', message: `「${config.name}」里没有任何一条填了「图片请求模板」` });
        return;
      }

      let result = null;
      for (let r = 0; r < runnable.length; r += 1) {
        const item = runnable[r];
        // 这次带图就用「图片请求模板」，否则用普通那段（图片模板留空时也回退到它）
        const requestText = requestTemplateFor(item, msg.context || {});
        // 状态行：主请求只报 model（老样子）；切到后备才带上它的名字，
        // 不然用户不知道「现在跑的是别人」。拼不出东西就是空串。
        const label = item.main ? '' : (item.name || '');

        /* 候选**在链循环里**算：每条后备有自己的模板，管模型的变量可能不是同一个。
           覆盖时用的是**命中的那个键名**（`mkey`），不是写死的 `model` ——
           覆盖错了键，模板里的 {{GEMINI_MODEL}} 根本没被换掉，看起来就是「轮换没生效」。 */
        const mkey = modelVarFor(requestText, vars);
        const models = modelCandidates(requestText, vars);
        const attempts = models.length ? models : [null];

        for (let i = 0; i < attempts.length; i += 1) {
          const model = attempts[i];
          // 试第几个就把那个变量换成哪个（只覆盖这一次的组装，不动 state）
          const runVars = model == null ? vars : { ...vars, [mkey]: model };
          const bits = [label, model].filter(Boolean).join(' · ');
          const statusText = bits ? `（${bits}）` : '';

          safePost({
            type: 'start',
            configName: config.name,
            text,
            statusText
          });

          try {
            result = await runRequest({
              requestText,
              adapter: item.adapter,
              vars: runVars,
              path: item.path,
              responseMode: item.responseMode,
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

          // 这期间用户切了配置 / 又触发了一次 → 本次已作废，别再往下试（否则白发几次请求）
          if (mySeq !== seq) return;
          // 作废（abort）不是失败：它来自「后台收到新的 translate 时中止上一次」，
          // 继续试下一个 model 没有任何意义（结果会被 seq 判丢弃）。立刻收手。
          if (result && result.error === '已取消') return;

          // 拿到译文就是成功，收工 —— 注意判据**只在「有没有 text」这一处**：
          // HTTP 错误 / 空结果 / 解析失败都让 result.text 为空，自然落进「继续试」。
          if (result && result.text) break;
        }

        // 这条请求（它自己的所有 model 都试过了）拿到译文 → 整条链收工；否则换下一条后备
        if (result && result.text) break;
      }

      if (mySeq !== seq) return;

      safePost({ type: 'done', result: { ...result, raw: undefined } });
    }
  });

  port.onDisconnect.addListener(() => {
    if (controller) controller.abort();
    controller = null;
    /* OCR 也在跑的话同样得停 —— 它能跑几十秒，端口都断了还白跑到底，
       最后 safePost 全落进死端口。注释里说的「面板关掉时两条都得停」在
       断开这条路上也得兑现。 */
    if (ocrController) ocrController.abort();
    ocrController = null;
  });
});

/* ---- 配置变化时通知所有页面 ---- */

let menuTimer = null;

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.state) return;
  // 设置页是边打字边自动保存的，别每敲一下就重建一次右键菜单
  clearTimeout(menuTimer);
  menuTimer = setTimeout(ensureMenu, 1500);
});
