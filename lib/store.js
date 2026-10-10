/**
 * 配置存储
 * 一条配置 = 一个名字 + 一段请求文本。没有别的表单。
 * 所有配置存在 chrome.storage.local，可导出 / 导入 JSON。
 */

import { OCR_PROVIDERS, defaultOcrState, normalizeOcrState } from './ocr.js';
import { imageContentPart, stripDataUrl, targetCodeOf } from './template.js';
import { TRIGGER_STYLE_IDS, DEFAULT_TRIGGER_STYLE } from './trigger-styles.js';

export const DEFAULT_VARS = [
  { name: 'apiKey', value: '' }
];

/** 存储结构版本。加了新的内置配置或改了默认值时 +1，老用户会走上面对应的迁移。 */
export const STORAGE_VERSION = 8;

/** 导出文件的格式版本。跟 STORAGE_VERSION 是两回事 —— 改文件长什么样时 +1。 */
export const EXPORT_FORMAT_VERSION = 1;

/**
 * 默认提示词。
 * 注意这里是「请求文本里」的写法，所以换行写成 \n、双引号写成 \"，
 * 渲染之后进到 JSON 里才会变成真正的换行和三引号，模型看到的是：
 *
 *   仅输出中文译文：
 *   """
 *   原文
 *   """
 *   输出示例：
 *   The translated text itself
 */
const DEFAULT_PROMPT =
  '仅输出{{target}}译文：\\n\\"\\"\\"\\n{{text}}\\n\\"\\"\\"\\n输出示例：\\nThe translated text itself';

export const DEFAULT_CONFIGS = [
  {
    id: 'builtin-bing',
    name: 'Bing 翻译（免费 · 无需 Key）',
    note:
      '白嫖通道，什么都不用填，装上就能用。' +
      '它不是普通请求：先 GET bing.com/translator 抠出 token，再 POST 翻译（约 0.5 秒），' +
      'token 缓存一小时。嫌慢或要保质量再换下面那些填 Key 的。',
    adapter: 'bing',
    request: '',
    path: '',
    responseMode: 'auto'
  },
  {
    id: 'builtin-openai',
    name: 'OpenAI 兼容（通用）',
    note: '任何 OpenAI 格式的服务都能用，改 base url 和 model 即可。',
    request: `# OpenAI 兼容接口 —— 中转站 / 自建 gateway 大多都是这个格式
# 提示词里的 \\n 是 JSON 的换行、\\" 是 JSON 的双引号，渲染后会变成真正的换行和三引号
curl https://api.openai.com/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {{apiKey}}" \\
  -d '{
  "model": "gpt-4o-mini",
  "messages": [
    {"role": "user", "content": "${DEFAULT_PROMPT}"}
  ],
  "temperature": 0.3,
  "stream": true
}'`,
    path: '',
    responseMode: 'auto'
  },
  {
    id: 'builtin-deepseek',
    name: 'DeepSeek',
    note: '注意 deepseek-reasoner 会额外返回 reasoning_content，本插件按 content 取值。',
    request: `curl https://api.deepseek.com/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {{apiKey}}" \\
  -d '{
  "model": "deepseek-chat",
  "messages": [
    {"role": "user", "content": "${DEFAULT_PROMPT}"}
  ],
  "stream": true
}'`,
    path: '',
    responseMode: 'auto'
  },
  {
    id: 'builtin-deepl',
    name: 'DeepL 官方 API',
    note: 'DeepL 的正规接口。免费版 key（以 :fx 结尾）走 api-free.deepl.com，每月 50 万字符；' +
      'Pro 的 key 把域名里的 -free 删掉。目标语言跟着设置页走，会自动变成 ZH-HANS 这种代码。',
    request: `# DeepL 官方 API：key 以 :fx 结尾的是免费版（api-free.deepl.com），Pro 的 key 把域名里的 -free 删掉
# 这里的 targetCode 是设置页「目标语言」映射出来的接口代码：简体中文 → ZH-HANS，日语 → JA（DeepL 只认代码）
curl https://api-free.deepl.com/v2/translate \\
  -H "Content-Type: application/json" \\
  -H "Authorization: DeepL-Auth-Key {{apiKey}}" \\
  -d '{
  "text": ["{{text}}"],
  "target_lang": "{{targetCode}}"
}'`,
    path: 'translations[0].text',
    responseMode: 'auto'
  },
  {
    id: 'builtin-ling',
    name: 'Ling / ant-ling',
    note: 'Ling 是混合推理模型，默认会先思考再作答。reasoning_effort 必须写成顶层字段，' +
      '写成 "reasoning": {"effort": "none"} 会被接口静默忽略（实测首字 7.3s vs 0.5s）。翻译这种任务关掉思考即可。',
    request: `curl https://api.ant-ling.com/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {{apiKey}}" \\
  -d '{
  "model": "Ling-3.1-flash",
  "messages": [
    {"role": "user", "content": "${DEFAULT_PROMPT}"}
  ],
  "stream": true,
  "reasoning_effort": "none"
}'`,
    path: '',
    responseMode: 'auto'
  },
  {
    id: 'builtin-ollama',
    name: 'Ollama 本地',
    note: '本地跑模型，不需要 apiKey。响应结构是 message.content。',
    request: `curl http://127.0.0.1:11434/api/chat \\
  -H "Content-Type: application/json" \\
  -d '{
  "model": "qwen2.5:7b",
  "stream": true,
  "messages": [
    {"role": "user", "content": "${DEFAULT_PROMPT}"}
  ]
}'`,
    path: '',
    responseMode: 'auto'
  },
  {
    id: 'builtin-rawhttp',
    name: 'Anthropic（原始报文写法）',
    note: '不想写 curl 的话，可以直接写 HTTP 报文：第一行「方法 URL」，然后 header，空行后是 body。',
    request: `POST https://api.anthropic.com/v1/messages
x-api-key: {{apiKey}}
anthropic-version: 2023-06-01
content-type: application/json

{
  "model": "claude-3-5-haiku-latest",
  "max_tokens": 2048,
  "system": "You are a translation engine. Output only the translation, no explanation.",
  "messages": [{"role": "user", "content": "${DEFAULT_PROMPT}"}],
  "stream": true
}`,
    path: '',
    responseMode: 'auto'
  }
];

export const DEFAULT_SETTINGS = {
  trigger: 'button',        // 'button' 选中后出现小圆点 | 'auto' 选中即翻 | 'off' 只走右键菜单
  triggerStyle: 'badge',    // 按钮长什么样，见 lib/trigger-styles.js
  triggerSize: 45,          // 按钮边长（px，100% 网页缩放下的像素）
  triggerSvg: '',           // 用户自定义图标：一段 <svg>…</svg>，替换预设里的图标 /「译」字
  targetLang: '简体中文',
  maxChars: 8000,
  panelWidth: 460,
  panelHeight: 0,           // 0 = 交给 CSS 自适应
  panelMaxHeight: 46,       // 自适应时正文区的高度上限（vh，0 = 不限）
  fontSize: 20,             // 面板正文字号（px）
  theme: 'auto',            // 'auto' 跟随系统 | 'dark' | 'light'
  showOriginal: true,
  contextMenu: true,
  ocrMenu: true,            // 右键菜单里那条「翻译剪切板中的截图」
  shotMenu: true,           // 右键菜单里那条「框选截图翻译」（当场框一块区域）
  ocrHintHidden: false      // OCR 栏顶部那句「右键 → 转文字 → 翻译」说明是否已点「不再显示」
};

export const DEFAULT_STATE = {
  version: STORAGE_VERSION,
  configs: DEFAULT_CONFIGS,
  activeConfigId: 'builtin-bing',
  vars: DEFAULT_VARS,
  settings: DEFAULT_SETTINGS,
  ocr: defaultOcrState()
};

export function uid() {
  return 'cfg-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function normalizeConfig(c) {
  return {
    id: c && c.id ? String(c.id) : uid(),
    name: c && c.name ? String(c.name) : '未命名配置',
    note: c && c.note ? String(c.note) : '',
    adapter: c && c.adapter ? String(c.adapter) : '',
    request: c && typeof c.request === 'string' ? c.request : '',
    // 截图直传（多模态）那一次用的模板。留空 = 用上面那段（那时可以自己拼 {{image}}）
    imageRequest: c && typeof c.imageRequest === 'string' ? c.imageRequest : '',
    path: c && typeof c.path === 'string' ? c.path : '',
    responseMode: ['auto', 'sse', 'json', 'text'].includes(c && c.responseMode) ? c.responseMode : 'auto'
  };
}

/** 全新的内置配置。过一遍 normalize，保证后加的字段（例：imageRequest）也有默认值 */
export function freshConfigs() {
  return clone(DEFAULT_CONFIGS).map(normalizeConfig);
}

/**
 * 这次请求该用哪一段模板。
 *
 * 一条配置带两段模板：普通那段翻文字，`imageRequest` 那段翻图
 * （右键「翻译剪切板中的截图」+ 勾了「禁用外置 OCR」时走它）。
 * 图片模板**留空就回退到普通那段** —— 老配置（没这个字段）行为完全不变，
 * 想一段模板两用的也照样能用 {{image}} / {{imagePart}} 自己拼。
 */
export function requestTemplateFor(config, context = {}) {
  if (!config) return '';
  const hasImage = !!(context && context.image);
  const img = typeof config.imageRequest === 'string' ? config.imageRequest : '';
  if (hasImage && img.trim()) return img;
  return config.request || '';
}

/**
 * 一条配置能不能翻图 —— **判据只有一个**：图片请求模板非空。
 *
 * 三处在用同一句：设置页那份「图片配置」列表、面板顶栏下拉在图片模式下列的那份、
 * `pickRequestConfig` 的入围条件。（content script 不能 import，那边 `imageCapable()` 是同一句。）
 */
export function canTranslateImage(config) {
  return !!String((config && config.imageRequest) || '').trim();
}

/**
 * 这次请求该用哪条**配置**（`requestTemplateFor` 管的是「用哪段模板」，这里管「用哪条」）。
 *
 * - 普通划词：顶栏那条（页面带上来的 configId，没有就 activeConfigId）。
 * - **图片直传**：优先 OCR 栏选定的那条「图片配置」，和顶栏那条互不干扰。
 * - 没选 / 那条被删了 / 图片模板被清空了，一律退回顶栏那条（**老行为**）。
 *
 * 注意：图片模式下 `msg.configId` **会被忽略** —— 面板顶栏那个下拉在图片模式下改的是
 * `state.ocr.imageConfigId`，所以只有它也挑不出东西时才轮到 `configId`。
 */
export function pickRequestConfig(state, configId, hasImage) {
  if (!state) return null;
  const wantId = hasImage && state.ocr ? state.ocr.imageConfigId : '';
  if (wantId) {
    const want = state.configs.find((c) => c.id === wantId);
    if (want && canTranslateImage(want)) return want;
  }
  return getConfig(state, configId || state.activeConfigId);
}

export async function loadState() {
  let stored = null;
  try {
    const raw = await chrome.storage.local.get('state');
    stored = raw && raw.state;
  } catch {
    stored = null;
  }

  if (!stored || typeof stored !== 'object') {
    const fresh = clone(DEFAULT_STATE);
    fresh.configs = freshConfigs();
    await chrome.storage.local.set({ state: fresh });
    return fresh;
  }

  const configs = Array.isArray(stored.configs) && stored.configs.length
    ? stored.configs.map(normalizeConfig)
    : freshConfigs();

  const settings = { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };

  /* ---- 版本迁移 ---- */
  const from = Number(stored.version) || 1;
  let migrated = false;

  if (from < 2) {
    // v1 → v2：新增了内置的免费 Bing 通道，给老用户补上
    if (!configs.some((c) => c.id === 'builtin-bing')) {
      const bing = DEFAULT_CONFIGS.find((d) => d.id === 'builtin-bing');
      if (bing) configs.unshift(clone(bing));
    }
    migrated = true;
  }
  if (from < 4) {
    // v3 → v4：新增 DeepL 官方 API 预设，给老用户补上。
    // 插在内置 DeepSeek 那条后面（内置那几条的相对顺序不变）；找不到锚点就挂到末尾。
    // 用户自己排好的顺序一概不动，已有的配置也不会被动位置。
    if (!configs.some((c) => c.id === 'builtin-deepl')) {
      const deepl = DEFAULT_CONFIGS.find((d) => d.id === 'builtin-deepl');
      if (deepl) {
        const anchor = configs.findIndex((c) => c.id === 'builtin-deepseek');
        if (anchor >= 0) configs.splice(anchor + 1, 0, clone(deepl));
        else configs.push(clone(deepl));
      }
    }
    migrated = true;
  }
  if (from < 5) {
    /* v4 → v5：原本是把「还停在老默认值」的硅基流动条目强制归位成 DeepSeek-OCR。
       v7 起 OCR 供应商模板化 —— 老字段（模型/提示词/Key）会被 normalizeOcrProvider
       **无损转换成等价的请求模板**，用户手里的 PaddleOCR 原样保留成一段可编辑的
       模板，想换 DeepSeek 自己改模板就行。这里不再动任何字段，只标迁移。 */
    migrated = true;
  }
  if (from < 6) {
    /* v5 → v6：删掉「临时直连」（不再改浏览器代理设置，见 README「代理与 Bing」）。

       字段本身已经从 DEFAULT_SETTINGS 里去掉了，但 settings 是 spread 合并出来的
       （`{ ...DEFAULT_SETTINGS, ...stored.settings }`），老存档里那个键会**原样残留**，
       所以这里显式删一次。configs 那边走 normalizeConfig 白名单构造，天然进不来，不用管。 */
    delete settings.directAdapter;
    migrated = true;
  }
  if (from < 7) {
    /* v6 → v7：OCR 供应商模板化（request / responsePath 字段）。
       老供应商（只有 endpoint / model / apiKey / prompt 那几个字段）在这里被打成
       等价的 curl 模板。转换逻辑只有一处：normalizeOcrProvider，见 lib/ocr.js 的
       ocrProviderToTemplate —— 所以迁移本身什么都不用改，标个「动过了」就行。
       normalizeOcrState 每次都会跑，新装的用户不走迁移也照样得到模板形。 */
    migrated = true;
  }
  if (from < 8) {
    /* v7 → v8：两条内置供应商的默认模板改了 ——
         · 硅基流动：提示词补上 `<image>\n` 前缀（不带它会退化，2026-10-09 实测）
         · 百度：body 补上 `language_type=auto_detect`（不写就是 CHN_ENG，日文假名会被当成中文）

       供应商存在存档里，normalizeOcrState 的 `{...默认, ...stored}` 救不了 —— 用户自己改过的
       模板绝不能被冲掉。判据是**逐字还等于老默认值**，是才写上新默认。

       这两条老值必须是**冻死的字面量**：不能从 OCR_PROVIDERS 反推，那个早就被改过了。

       这里也**不能像 configs 那样 `delete` 字段**：request 一没，normalizeOcrState 会把它当成
       「老形状」走 ocrProviderToTemplate，拿空 endpoint 重新拼一段废模板出来。
       note 不归位 —— 纯文案、进的不是请求体，多留一条判据就多一处会写错。 */
    const OLD_DEFAULT_REQUEST = {
      'builtin-siliconflow': `# DeepSeek-OCR 在硅基流动上免费；Key 在「变量」页签的 apiKey 里填，和翻译配置共用
curl https://api.siliconflow.cn/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {{apiKey}}" \\
  -d '{
  "model": "deepseek-ai/DeepSeek-OCR",
  "messages": [
    {"role": "user", "content": [
      {"type": "image_url", "image_url": {"url": "{{image}}"}},
      {"type": "text", "text": "Free OCR."}
    ]}
  ],
  "temperature": 0.01
}'`,
      'builtin-baidu-ocr': `# 百度高精度版：个人认证每月 1000 次免费，QPS 2/秒
# access_token = API Key + Secret Key 换来的（30 天过期）：
#   https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=你的AK&client_secret=你的SK
# 换到后把 token 粘进下面 URL，过期了重换一次
POST https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic?access_token=把access_token粘到这里
Content-Type: application/x-www-form-urlencoded

image={{imageUrlEncoded}}`
    };
    const saved8 = stored.ocr && Array.isArray(stored.ocr.providers) ? stored.ocr.providers : [];
    for (const p of saved8) {
      const old = p && OLD_DEFAULT_REQUEST[p.id];
      if (!old || p.request !== old) continue;
      const d = OCR_PROVIDERS.find((x) => x.id === p.id);
      if (d) p.request = d.request;
    }
    migrated = true;
  }

  /* 已经删掉的按钮预设会在老存档里留一个不存在的 id（1.1.0 去掉了「笔尖」）。
     这里顺手写正成默认那个 —— content.js 和设置页各自也兜着底（认不出的 id 回退
     到第一个预设），但存档里挂着一个不存在的值终究是个坑，能写正就写正。 */
  if (!TRIGGER_STYLE_IDS.includes(settings.triggerStyle)) {
    settings.triggerStyle = DEFAULT_TRIGGER_STYLE;
    migrated = true;
  }

  const state = {
    version: STORAGE_VERSION,
    configs,
    activeConfigId: configs.some((c) => c.id === stored.activeConfigId)
      ? stored.activeConfigId
      : configs[0].id,
    vars: Array.isArray(stored.vars) ? stored.vars.map((v) => ({ name: String(v.name || ''), value: String(v.value ?? '') })) : clone(DEFAULT_VARS),
    settings,
    // OCR 是后加的一整块。这里每次都过一遍 normalizeOcrState，内置供应商会被补齐，
    // 所以**新增**字段 / 新增内置供应商不用写迁移。
    // 但改的是**已有内置供应商的默认值**（v4→v5 把硅基流动换成 DeepSeek-OCR）就得写 ——
    // 老存档里那个字段已经存了旧值，合并救不了，只能显式归位。
    ocr: normalizeOcrState(stored.ocr)
  };

  if (migrated) {
    try {
      await chrome.storage.local.set({ state });
    } catch {
      /* 存不下也无所谓，下次再迁 */
    }
  }

  return state;
}

export async function saveState(state) {
  await chrome.storage.local.set({ state });
  return state;
}

export function getConfig(state, id) {
  return state.configs.find((c) => c.id === id) || state.configs[0] || null;
}

/**
 * 把 arr[from] 挪到位置 to，返回新数组（不改原数组）。
 *
 * `to` 是**移除之后**的坐标。上下移和拖动算出来的都是这个口径 ——
 * 换成「移除之前」的坐标，往下挪时就会差一位（经典 off-by-one）。
 * 下标会被夹进 `[0, n-1]`；算下来还在原位就把原数组原样返回，
 * 调用方用 `next === arr` 就能判断「没动，不用重渲染」。
 */
export function moveItem(arr, from, to) {
  const list = Array.isArray(arr) ? arr : [];
  const n = list.length;
  if (n < 2) return list;
  const a = Math.min(Math.max(Number(from) || 0, 0), n - 1);
  const b = Math.min(Math.max(Number(to) || 0, 0), n - 1);
  if (a === b) return list;
  const out = list.slice();
  const [item] = out.splice(a, 1);
  out.splice(b, 0, item);
  return out;
}

/**
 * **过滤视图**里的「挪一位」，落到完整数组上（返回新数组，不改原数组）。
 *
 * 「图片配置」是 `state.configs` 的过滤视图，排序只能去动 `state.configs` 本身 ——
 * 另存一份顺序就是第二个真相源。副作用是「配置」栏的先后跟着变，同一份数据，预期内的。
 *
 * `all` 完整数组；`visibleIds` 屏幕上看得见的那些（顺序和屏幕一致）；
 * `from` / `to` 都是**过滤视图里的下标**，`to` 按 `moveItem` 的口径（「移除之后」的坐标）。
 *
 * 落点：插在「挪完之后占住 `to` 那个位子的可见项」前面；挪到末尾时插最后一条可见项的后面。
 * **看不见的那些一条都不动**。
 */
export function moveVisibleItem(all, visibleIds, from, to) {
  const list = Array.isArray(all) ? all : [];
  const ids = list.map((c) => c && c.id);
  const vis = (Array.isArray(visibleIds) ? visibleIds : []).filter((id) => ids.includes(id));
  const n = vis.length;
  if (n < 2) return list;

  const a = Math.min(Math.max(Number(from) || 0, 0), n - 1);
  const b = Math.min(Math.max(Number(to) || 0, 0), n - 1);
  if (a === b) return list;   // 原地没动

  const moving = list[ids.indexOf(vis[a])];
  const rest = vis.slice();
  rest.splice(a, 1);
  // 移完之后 b 这个位子上坐着谁；b 越过末尾就是「插到最后一条后面」
  const tail = b >= rest.length;
  const anchorId = rest[Math.min(b, rest.length - 1)];

  const out = list.filter((c) => c !== moving);
  const at = out.findIndex((c) => c && c.id === anchorId);
  if (at < 0) return list;
  out.splice(tail ? at + 1 : at, 0, moving);
  return out;
}

/**
 * 拖动落点 → 目标下标（喂给 `moveItem` 的那个 `to`）。
 *
 * `ids` 是当前列表里的 id，顺序和屏幕上一致；`dragId` 是正在拖的那条；
 * `overId` 是指针压住的那条；`after` 表示压在它下半区（要插到它后面）。
 *
 * 被拖走的那一行在计算时已经从名单里剔掉了，所以「往下拖」和「往上拖」
 * 差一位 —— 就是这里补的。id 认不出来时返回 -1，调用方直接放弃。
 */
export function dropIndex(ids, dragId, overId, after) {
  const list = Array.isArray(ids) ? ids : [];
  const from = list.indexOf(dragId);
  const over = list.indexOf(overId);
  if (from < 0 || over < 0) return -1;
  let to = over + (after ? 1 : 0);
  if (to > from) to -= 1;
  return to;
}

/** 变量表 → 对象（同时把用户误加的 {{ }} 剥掉，省得填重复） */
export function varsToObject(vars, extra = {}) {
  const out = {};
  for (const v of vars || []) {
    if (!v || !v.name) continue;
    const key = String(v.name).replace(/^\{\{\s*|\s*\}\}$/g, '').trim();
    if (key) out[key] = v.value ?? '';
  }
  return { ...out, ...extra };
}

export function buildVars(state, text, context = {}) {
  const today = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const targetLang = state.settings.targetLang || '简体中文';
  const image = context.image || '';
  return varsToObject(state.vars, {
    text,
    selection: text,
    // 截图翻译「直传」模式：图片以 data URL 塞进请求模板，普通翻译时是空串
    image,
    // 同一个东西的「整段 content」版本：有图时是 `,{"type":"image_url",…}`，没图时是空串。
    // 让一段模板既能翻文字、又能翻图（图片那一段可选地出现）。
    imagePart: imageContentPart(image),
    imageBase64: stripDataUrl(image),
    // base64 里的 + 不转 %2B 会被服务端当空格（百度 OCR 的 image 参数要这种）
    imageUrlEncoded: encodeURIComponent(stripDataUrl(image)),
    target: targetLang,
    // 同一个意思的「接口写法」：聊天模型看得懂「简体中文」，DeepL 只认 ZH-HANS。
    // 映射表在 lib/template.js 的 TARGET_LANG_CODES，Bing 适配器也吃那一张。
    targetCode: targetCodeOf(targetLang),
    targetLang,
    url: context.url || '',
    title: context.title || '',
    date: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  });
}

/**
 * 导出为可读 JSON。
 *
 * 导的是**整份存档**（配置 + 顺序 + 变量 + 设置 + OCR），里面有明文 API Key —— 分享前先清掉。
 *
 * 三个元字段必须写在 `...state` **后面**：`version` 是**文件格式**版本，不是 `STORAGE_VERSION`。
 * 顺序反过来，导进来的 `exportedAt` 会顶掉这次新写的那个时间 —— 踩过一次。
 */
export function exportState(state) {
  return JSON.stringify(
    {
      ...(state || {}),
      kind: 'request-translate',
      version: EXPORT_FORMAT_VERSION,
      exportedAt: new Date().toISOString()
    },
    null,
    2
  );
}

export function importState(jsonText) {
  let data;
  try {
    data = JSON.parse(jsonText);
  } catch {
    // 别把引擎那句英文原文抛给用户（"Expected property name or '}' at position 2 …"）
    throw new Error('这不是一段合法的 JSON —— 文件可能坏了，或者选错了文件');
  }
  if (!data || typeof data !== 'object') throw new Error('不是合法的配置 JSON');
  // kind 是导出时写的标记。老版本（1.0.0 起就带这个字段）和手写的文件都可能没有，
  // 所以只在「有、但不是我们的」时候拦一下 —— 拿别的软件的 JSON 进来只会更乱。
  if (data.kind && data.kind !== 'request-translate') {
    throw new Error('这不是 RequestTranslate 导出的配置文件（kind = ' + data.kind + '）');
  }
  if (!Array.isArray(data.configs) || data.configs.length === 0) throw new Error('JSON 里没有 configs 数组');

  const configs = data.configs.map(normalizeConfig);
  const vars = Array.isArray(data.vars)
    ? data.vars.map((v) => ({ name: String(v.name || ''), value: String(v.value ?? '') }))
    : [];

  // 老导出文件里可能带着已经删掉的设置项（例：临时直连的 directAdapter），
  // spread 合并会把它一起带进来 —— 显式抹掉。
  const settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
  delete settings.directAdapter;

  return {
    configs,
    vars,
    settings,
    ocr: normalizeOcrState(data.ocr),
    // 导出时间给导入的确认框用（告诉用户「这份是什么时候导的」）
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : ''
  };
}
