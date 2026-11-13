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
import { readClipboardImage as readClipboardInPage, errText as clipErrText } from './lib/clipboard-read.js';
import { msg, invalidateI18nCache } from './lib/i18n-msg.js';
// 顶栏那个「目标语言」下拉的候选。页面那边 import 不了模块，只能这样捎过去，
// 免得在 content.js 里手抄一份 —— 加了语言两处就对不上了。
import { TARGET_PRESETS, LANG_REGION_VARIANTS } from './lib/template.js';

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
          title: await msg('menuTranslate', '用 RequestTranslate 翻译选中内容'),
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

/* 全局快捷键（可在 edge://extensions/shortcuts 改）：选区在页面那边，后台只转发；
   框选截图要先 captureVisibleTab —— **必须赶在这次按键的手势里截**，
   对没有 <all_urls> 的页面，captureVisibleTab 靠的就是这次手势授予的 activeTab，
   拖完框再截就晚了（和右键菜单那条同一个原因）。 */
chrome.commands.onCommand.addListener(async (command) => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== 'number') return;

    if (command === 'translate-selection') {
      await chrome.tabs.sendMessage(tab.id, { type: 'hotkey-translate' });
      return;
    }
    if (command === 'ocr-clipboard') {
      // via 标记：快捷键没有右键上下文，content 端别用陈旧的 lastRightClick 定面板
      await chrome.tabs.sendMessage(tab.id, { type: 'rt-ocr-clipboard', via: 'hotkey' });
      return;
    }
    if (command === 'shot-translate') {
      try {
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
        await chrome.tabs.sendMessage(tab.id, { type: 'rt-shot-translate', dataUrl });
      } catch (err) {
        await chrome.tabs
          .sendMessage(tab.id, { type: 'rt-shot-translate', error: String((err && err.message) || err) })
          .catch(() => {});
      }
    }
  } catch {
    /* 页面没注入 content script（浏览器内部页等）—— 静默 */
  }
});

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

/**
 * 这台浏览器有没有 offscreen API —— 也就是「后台是不是没有 DOM 的 service worker」。
 * Chromium：有。火狐：没有（它的后台是事件页，自己就有 DOM，不需要 offscreen）。
 */
function hasOffscreen() {
  return !!(chrome.offscreen && chrome.offscreen.createDocument);
}

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
    /* 火狐的 MV3 后台是**事件页**（一个隐藏的 HTML 页面），本身就有 DOM，
       直接读剪切板即可 —— 它没有 chrome.offscreen 这个 API。
       Chromium 的 service worker 没有 DOM，只能借 offscreen 文档。
       两边跑的是同一份读取逻辑（lib/clipboard-read.js）。 */
    if (!hasOffscreen()) {
      try {
        return await readClipboardInPage(document);
      } catch (err) {
        return { ok: false, reason: 'unavailable', error: clipErrText(err) };
      }
    }
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

/* ---- 翻译记录（必须串行写）---- */

/** 写入队列：见 appendHistory 的注释 */
let historyQueue = Promise.resolve();

/**
 * 往翻译记录里插一条，**排队执行**。
 *
 * 为什么必须排队：一次翻译可以并发跑 2~4 条配置（面板的对比槽位，`Promise.all`），
 * 每条跑完都要写记录。而写入是「读最新存档 → 改 history → 写回」，中间隔着 await ——
 * 不排队的话后来者读到的是**别人还没写回去**的那一份，直接把先写的那条覆盖掉。
 * 实测：并发 2 条只留 1 条、并发 4 条也只留 1 条（kniph 2026-10-18 通读发现）。
 *
 * 只改 storage 里**最新**存档的 history 字段 —— 不能拿流程开头 load 的那份全量写回，
 * 翻译几十秒里用户改过的设置会被旧值覆盖回去。
 *
 * （读剪切板那段用的也是同一套「拿 promise 串成队列」的写法，见 clipboardRead。）
 */
function appendHistory(entry, max) {
  const run = async () => {
    try {
      const { state: fresh } = await chrome.storage.local.get('state');
      if (!fresh) return;
      fresh.history = [entry, ...(Array.isArray(fresh.history) ? fresh.history : [])].slice(0, max);
      await chrome.storage.local.set({ state: fresh });
    } catch {
      /* 记不了就不记，别影响出结果 */
    }
  };
  historyQueue = historyQueue.then(run, run);
  return historyQueue;
}

/* ---- 翻译端口 ---- */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== PORT_NAME) return;

  /* 翻译的「一笔」= 一次触发可以同时跑几条配置（面板的对比槽位）。
     runBatch 是批次号：新一次翻译 +1，旧批次的回包全丢（老 seq 的单值逻辑
     撑不住并发 —— 每条配置得能各跑各的）。
     runCtrls 里每条配置一个 controller：面板关掉 / 新一次翻译 / 端口断开，全都要停。 */
  let runBatch = 0;
  /** @type {Map<string, AbortController>} */
  const runCtrls = new Map();
  // OCR 识别用的是自己那个 —— 翻译和识别是前后脚两件事，抢同一个会让「先到的那个 abort
  // 把后到的那个一起杀掉」（面板关掉时两条都得停，所以 abort 消息两个都发）
  let ocrController = null;
  // OCR 单独计数：识别是前后脚另一件事，和翻译的批次号互不干扰
  let ocrSeq = 0;
  /* 上一次真正用过的截图（{ ok:true, dataUrl, bytes }）。「重试」要的是**重发刚才那张**，
     不是再翻一遍剪切板 —— 用户在那之后可能又复制了别的东西。放在端口作用域里：
     一个页面一份，不跟别的标签页串。SW 被回收 / 端口重建后这里会空，那时退回读剪切板。 */
  let lastShot = null;

  /** 这次请求带图吗（图片直传 / 截图直传同一判据） */
  const hasImageInContext = (m) => !!(m.context && m.context.image);

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
      /* **两道都要**（和 translate 那边 ++runBatch 同一个道理）：
         abort() 只是让请求早点停，它有个窄窗口 —— 请求刚好在 abort 之前收完，
         runRequest / runOcr 会正常返回成功。光靠 signal 拦不住那一帧，
         必须让「批次号 / 序号」也过期，回包才会被判废。 */
      runBatch += 1;
      for (const c of runCtrls.values()) c.abort();
      runCtrls.clear();
      ocrSeq += 1;
      if (ocrController) ocrController.abort();
      ocrController = null;
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
        targetLangs: TARGET_PRESETS.concat(LANG_REGION_VARIANTS)
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
      /* 一次翻译可以同时跑几条配置（面板的对比槽位）：configIds 有值就用它；
         没有就退回单条 configId —— 老路径就是一个元素的数组，行为一个字节不变。 */
      const ids = Array.isArray(msg.configIds) && msg.configIds.length
        ? msg.configIds.map((x) => String(x || ''))
        : [String(msg.configId || '')];

      // 新批次开跑：旧批次连它正在飞的请求一起作废（abort + 批次号判废，两道都要 ——
      // abort 是让请求早点停，批次号是保证极窄窗口里漏回来的包也进不来）
      const myBatch = ++runBatch;
      for (const c of runCtrls.values()) c.abort();
      runCtrls.clear();

      const state = await loadState();
      // Math.max 兜负数 —— 手改存档/导入文件塞进 -5 的话，slice(0,-5) 会从尾部倒砍
      const text = String(msg.text || '').slice(0, Math.max(1, Number(state.settings.maxChars) || 8000));
      const vars = buildVars(state, text, msg.context || {});

      /* 每条配置各跑各的：互不等待、互不影响（某条挂了其余照常出结果）。
         回包统统带 configId —— 面板按它把结果放进对应的槽位；
         没有 configId 的老回包按「第一条」处理（面板端兼容）。 */
      const runOne = async (wantId) => {
        // 图片直传（勾了「禁用外置 OCR」）时用的是 OCR 栏里选定的那条**图片配置**，
        // 和顶栏那条（翻文字用的）互不干扰 —— 规则和兜底都在 pickRequestConfig 里
        const config = pickRequestConfig(state, wantId, !!(msg.context && msg.context.image));
        if (!config) {
          safePost({ type: 'fatal', configId: wantId, message: '没有任何可用配置，请先到设置页新建一条' });
          return;
        }
        /* 注意：这条路径还没 set 进 runCtrls，不需要清理（见下面 set 的位置）。 */
        const cid = config.id;
        const ctrl = new AbortController();
        runCtrls.set(cid, ctrl);
        // 本次作废的判据：批次过期（用户又触发了一次）或这条被 abort
        const alive = () => myBatch === runBatch && !ctrl.signal.aborted;

        /* ---- 两层「换一个再试」 ----
           外层：一条配置里可以挂几条**后备请求**，主请求挂了就按顺序试下一条
                 （勾是唯一的开关，一条都没勾时退回主请求 —— 见 lib/store.js 的 requestChain）。
           内层：管模型的那个变量填了多行时，这条请求自己还会换一个 model 再试。
                 「哪个变量管模型」由**这条请求的模板**决定（模板里名字含 model 的占位符，
                 见 lib/template.js 的 modelVarFor）—— 一个人可以同时存着 GEMINI_MODEL 和
                 DEEPSEEK_MODEL，看变量表挑不出该轮换哪一个，看模板才挑得准。

           两条都只跑一轮时**和以前完全一样**（没有后备 + 只有单值 model = 老行为）。
           循环放这儿而不是 runRequest 里：runRequest 是「一次调用 = 一次请求」，
           把重试塞进去会让「请求预览」「测试」那些只想发一次的地方跟着重试。 */
        const hasImage = hasImageInContext(msg);
        const runnable = hasImage
          ? requestChain(config).filter((it) => String(it.imageRequest || '').trim())
          : requestChain(config);
        if (hasImage && !runnable.length) {
          safePost({ type: 'fatal', configId: cid, message: '这条配置没填「图片请求模板」，没法带图翻译' });
          runCtrls.delete(cid);
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
              configId: cid,
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
                signal: ctrl.signal,
                onDelta: (current) => {
                  if (!alive()) return;
                  safePost({ type: 'delta', configId: cid, text: current });
                }
              });
            } catch (err) {
              if (!alive()) return;
              safePost({ type: 'fatal', configId: cid, message: err && err.message ? err.message : String(err) });
              runCtrls.delete(cid);
              return;
            }

            // 这期间用户又触发了一次 → 本批次已作废，别再往下试（否则白发几次请求）
            if (!alive()) return;
            // 作废（abort）不是失败：它来自「新一次翻译中止上一次」，
            // 继续试下一个 model 没有任何意义（结果会被批次号判丢弃）。立刻收手。
            if (result && result.error === '已取消') return;

            // 拿到译文就是成功，收工 —— 注意判据**只在「有没有 text」这一处**：
            // HTTP 错误 / 空结果 / 解析失败都让 result.text 为空，自然落进「继续试」。
            if (result && result.text) break;
          }

          // 这条请求（它自己的所有 model 都试过了）拿到译文 → 整条链收工；否则换下一条后备
          if (result && result.text) break;
        }

        if (!alive()) return;

        /* 翻译记录（settings.historyMax 条数上限，0 = 不记）。
           **必须走 appendHistory 排队**（原因见那个函数的注释）：一次对比会并发跑
           2~4 条配置，而写入是「读 → 改 → 写」的读改写，不排队就会互相覆盖。 */
        if (result && result.text) {
          const max = Math.max(0, Number(state.settings.historyMax) || 0);
          if (max > 0) {
            await appendHistory({
              src: text.slice(0, 2000),
              dst: String(result.text).slice(0, 5000),
              configName: config.name,
              lang: state.settings.targetLang || '',
              ts: Date.now()
            }, max);
          }
        }

        runCtrls.delete(cid);
        safePost({ type: 'done', configId: cid, result: { ...result, raw: undefined } });
      };

      // 并发跑（不串行）：总耗时取决于最慢的那条，不是加起来
      await Promise.all(ids.map((id) => runOne(id)));
    }
  });

  port.onDisconnect.addListener(() => {
    for (const c of runCtrls.values()) c.abort();
    runCtrls.clear();
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
  // 语言包换了，右键菜单要重建（标题得跟着变）
  if (changes.rt_i18n) { invalidateI18nCache(); ensureMenu(); }
  if (area !== 'local' || !changes.state) return;
  // 设置页是边打字边自动保存的，别每敲一下就重建一次右键菜单
  clearTimeout(menuTimer);
  menuTimer = setTimeout(ensureMenu, 1500);
});
