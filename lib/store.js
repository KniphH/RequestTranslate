/**
 * 配置存储
 * ------------------------------------------------------------------
 * 一条配置 = 一个名字 + 一段请求文本。没有别的表单。
 * 所有配置存在 chrome.storage.local，可导出 / 导入 JSON。
 */

import { defaultOcrState, normalizeOcrState } from './ocr.js';
import { imageContentPart } from './template.js';

export const DEFAULT_VARS = [
  { name: 'apiKey', value: '' }
];

/** 存储结构版本。加了新的内置配置或改了默认值时 +1，老用户会走上面对应的迁移。 */
export const STORAGE_VERSION = 3;

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
  fontSize: 20,             // 面板正文字号（px）
  theme: 'auto',            // 'auto' 跟随系统 | 'dark' | 'light'
  showOriginal: true,
  contextMenu: true,
  ocrMenu: true,            // 右键菜单里那条「翻译剪切板中的截图」
  directAdapter: false      // 内置适配器（Bing）请求时临时直连，绕过系统代理。默认关：
                            // 代理客户端自己就能按规则给 bing.com 放行，插件再插一脚只是多一层变数
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
    responseMode: ['auto', 'sse', 'json', 'text'].includes(c && c.responseMode) ? c.responseMode : 'auto',
    direct: !!(c && c.direct) // 这条配置的请求临时绕过系统代理
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
  if (from < 3) {
    // v2 → v3：临时直连改成默认关。
    // v2 存档里的这个值只可能是「从没动过的默认值 true」（这个开关刚加，还没有人真去关它），
    // 所以直接归位成新默认值，免得老存档一直顶着个开着的开关。
    settings.directAdapter = false;
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
    // 所以老存档不需要写迁移（新增字段走合并那一套）。
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

/**
 * 这条配置的请求要不要临时绕开系统代理。
 * 两条来路：配置自己勾了「强制直连」，或者是内置适配器而且**手动**开着总开关。
 * 默认关 —— 代理客户端按规则分流（DOMAIN-SUFFIX,bing.com,DIRECT）比插件临时改浏览器代理更干净。
 */
export function wantDirect(settings, config) {
  if (!config) return false;
  if (config.direct) return true;
  return !!config.adapter && !!settings && settings.directAdapter === true;
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
    target: targetLang,
    targetLang,
    url: context.url || '',
    title: context.title || '',
    date: `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
  });
}

/** 导出为可读 JSON */
export function exportState(state) {
  return JSON.stringify(
    { kind: 'request-translate', version: 1, exportedAt: new Date().toISOString(), ...state },
    null,
    2
  );
}

export function importState(jsonText) {
  const data = JSON.parse(jsonText);
  if (!data || typeof data !== 'object') throw new Error('不是合法的配置 JSON');
  if (!Array.isArray(data.configs) || data.configs.length === 0) throw new Error('JSON 里没有 configs 数组');

  const configs = data.configs.map(normalizeConfig);
  const vars = Array.isArray(data.vars)
    ? data.vars.map((v) => ({ name: String(v.name || ''), value: String(v.value ?? '') }))
    : [];

  return {
    configs,
    vars,
    settings: { ...DEFAULT_SETTINGS, ...(data.settings || {}) },
    ocr: normalizeOcrState(data.ocr)
  };
}
