/**
 * OCR —— 把截图里的文字认出来
 * ------------------------------------------------------------------
 * 走的是 OpenAI 兼容的 chat/completions：图片塞进 messages[0].content 的
 * image_url（data URL），文字提示词是同一个 content 数组里的另一项。
 * 硅基流动的 PaddleOCR-VL 认的是几个短指令，见 OCR_PROMPTS。
 *
 * 为什么单独开一套、不复用 lib/engine.js 的请求模板：
 * OCR 的请求体形状是固定的（图片必须嵌进那个数组里），让用户手写一段
 * 带 data URL 的 curl 不现实。但**供应商是可配的** —— 接口地址、模型名、
 * 提示词、Key 都在设置页里填，所以换成别的视觉模型不用改代码。
 *
 * 这个文件不碰 chrome，纯函数 + 一个 fetch，能在 Node 里单测。
 */

import { NO_IMAGE_MESSAGE } from './clipboard.js';

/** 右键菜单里那一条：id 和文案放这里，background 与测试共用一份，
   免得改文案时漏掉一边。 */
export const OCR_MENU_ID = 'rt-ocr-clipboard';
export const OCR_MENU_TITLE = '翻译剪切板中的截图';

/**
 * 这条菜单项的描述。设置里关掉时返回 null（background 就不建它了）。
 *
 * contexts 用 'all' 而不是 'page'：截图的时候鼠标停在哪都该能点 ——
 * 停在图片上、链接上、输入框里都很正常。
 */
export function ocrMenuItem(settings) {
  if (settings && settings.ocrMenu === false) return null;
  return { id: OCR_MENU_ID, title: OCR_MENU_TITLE, contexts: ['all'] };
}

/** PaddleOCR-VL 认得的那几个短指令 */
export const OCR_PROMPTS = [
  { text: 'OCR:', hint: '通用文字（PaddleOCR-VL 认这个）' },
  { text: 'Table Recognition:', hint: '表格 → Markdown' },
  { text: 'Formula Recognition:', hint: '公式 → LaTeX' },
  { text: 'Seal Recognition:', hint: '印章' }
];

export const DEFAULT_OCR_PROMPT = 'OCR:';

/** 内置供应商。两条：一个免费白嫖的，一个「随便什么 OpenAI 兼容」的兜底 */
export const OCR_PROVIDERS = [
  {
    id: 'builtin-siliconflow',
    name: '硅基流动 · PaddleOCR-VL',
    note: 'PaddleOCR-VL-1.5 在硅基流动上免费。只需要一个 API Key，去 cloud.siliconflow.cn 拿。',
    endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
    model: 'PaddlePaddle/PaddleOCR-VL-1.5',
    prompt: 'OCR:'
  },
  {
    id: 'builtin-openai-vl',
    name: 'OpenAI 兼容（任意视觉模型）',
    note: '任何按 OpenAI 格式收图的接口：填接口地址和模型名就行，图片以 image_url 的 data URL 传过去。',
    endpoint: 'https://api.openai.com/v1/chat/completions',
    model: 'gpt-4o-mini',
    prompt: '请原样输出图片里的文字，不要翻译、不要解释。'
  }
];

/** 内置供应商的 id，删掉之后记进 state.ocr.hidden，免得下次启动又被补回来 */
export const BUILTIN_OCR_IDS = OCR_PROVIDERS.map((p) => p.id);

function localId() {
  return 'ocr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

export function normalizeOcrProvider(p) {
  const src = p || {};
  return {
    id: String(src.id || localId()),
    name: String(src.name || '未命名供应商'),
    note: String(src.note || ''),
    endpoint: String(src.endpoint || ''),
    model: String(src.model || ''),
    // 0 / 空 = **不发送 max_tokens**，交给服务端用模型自己的默认值。
    // 见 buildOcrBody 里那段说明：写死一个数会在上下文窄的模型上直接 400。
    maxTokens: normalizeMaxTokens(src.maxTokens),
    prompt: String(src.prompt || DEFAULT_OCR_PROMPT),
    apiKey: String(src.apiKey || ''),
    direct: !!src.direct
  };
}

/** 最大输出长度：只认正整数，其它（空串 / null / 负数 / 乱七八糟）一律归零 = 不发送 */
export function normalizeMaxTokens(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function defaultOcrState() {
  return normalizeOcrState(null);
}

/**
 * 存档 → 可用的 OCR 状态。
 *
 * 内置的那两条**每次都会补齐**（改了内置的 endpoint 也保得住用户填的字段），
 * 用户被删掉的内置条目记在 hidden 里跳过，自己新建的排在后面。
 * 这样以后加新的内置供应商，老存档不用写迁移就能拿到。
 *
 * `disabled` 是「禁用外置 OCR」：勾上之后不走任何 OCR 供应商，
 * 截图直接塞进翻译请求交给多模态模型 —— 只在模型自己会看图时才有意义。
 */
export function normalizeOcrState(raw) {
  const saved = raw && Array.isArray(raw.providers) ? raw.providers : [];
  const byId = new Map();
  for (const p of saved) {
    const id = String((p && p.id) || '');
    if (id) byId.set(id, p);
  }
  const hidden = new Set(Array.isArray(raw && raw.hidden) ? raw.hidden.map(String) : []);

  const providers = OCR_PROVIDERS
    .filter((d) => !hidden.has(d.id))
    .map((d) => normalizeOcrProvider({ ...d, ...(byId.get(d.id) || {}) }));

  for (const p of saved) {
    const id = String((p && p.id) || '');
    if (!id || BUILTIN_OCR_IDS.includes(id) || hidden.has(id)) continue;
    providers.push(normalizeOcrProvider(p));
  }

  // 用户把内置的删光了，就退回到内置默认（不然列表是空的，功能直接没了）
  if (!providers.length) providers.push(normalizeOcrProvider(OCR_PROVIDERS[0]));

  const activeId = providers.some((p) => p.id === (raw && raw.activeId))
    ? raw.activeId
    : providers[0].id;

  return { activeId, providers, hidden: [...hidden], disabled: !!(raw && raw.disabled) };
}

/** 当前选中的那条。找不到就退回第一条 —— 调用方不用自己判空 */
export function activeOcrProvider(ocr) {
  const list = (ocr && ocr.providers) || [];
  if (!list.length) return null;
  return list.find((p) => p.id === (ocr && ocr.activeId)) || list[0];
}

/** 接口地址里的主机名，喂给「临时直连」用的 */
export function endpointHost(endpoint) {
  try {
    return new URL(String(endpoint || '')).hostname;
  } catch {
    return '';
  }
}

/**
 * 请求体。
 * 图片在前、提示词在后 —— PaddleOCR-VL 官方的调用例子就是这个顺序。
 *
 * max_tokens **默认不发**：各家模型的上下文上限差得很远（PaddleOCR-VL 很宽，
 * DeepSeek-OCR 的 max_seq_len 只有 8192），而且这个上限是
 * 「提示词 + max_tokens」一起算的 —— 写死一个等于把宽上下文的模型迁就到窄的，
 * 一旦超过就直接 400（`max_tokens (8192) have exceeded max_seq_len (8192) limit`）。
 * 不发，服务端按模型自己的默认值来最稳；确实需要限长的再在设置页里填。
 */
export function buildOcrBody(provider, dataUrl) {
  const p = provider || {};
  const prompt = String(p.prompt || '').trim() || DEFAULT_OCR_PROMPT;
  const body = {
    model: String(p.model || '').trim(),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: String(dataUrl || '') } },
          { type: 'text', text: prompt }
        ]
      }
    ]
  };
  const maxTokens = normalizeMaxTokens(p.maxTokens);
  if (maxTokens > 0) body.max_tokens = maxTokens;
  body.temperature = 0.01;
  return body;
}

/**
 * 从响应里取文字。`content` 有的模型给字符串、有的给分段数组，两种都认。
 */
export function pickOcrText(json) {
  const choice = json && Array.isArray(json.choices) ? json.choices[0] : null;
  const msg = choice && choice.message;
  if (!msg) return '';
  const c = msg.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c
      .map((part) => (typeof part === 'string' ? part : (part && part.text) || ''))
      .join('')
      .trim();
  }
  return '';
}

/**
 * 几个撞过的报错，翻译成「接下来改哪儿」。
 * 认不出来就返回空串，原样把响应体给用户看。
 */
export function ocrErrorHint(bodyText) {
  const body = String(bodyText || '').replace(/\s+/g, ' ');
  if (/max_seq_len/i.test(body) && /max_tokens/i.test(body)) {
    return '模型上下文装不下这个 max_tokens。把「最大输出长度」清空（不发送这个字段）就行。';
  }
  if (/model.{0,24}(not exist|does not exist|not found|invalid|unknown)|invalid model/i.test(body)) {
    return '模型名没对上。去服务商的模型列表里复制全名，注意大小写和斜杠。';
  }
  if (/base64|decode image|image.{0,40}(invalid|too large|exceed)/i.test(body)) {
    return '图片本身被拒了。换张小一点的图，或者确认这个模型真收图。';
  }
  return '';
}

/** HTTP 不 OK 时把状态码和响应体一起说出来（响应体截一刀，别把整个 HTML 糊到面板上） */
export function describeOcrError(status, bodyText) {
  const body = String(bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const hint = ocrErrorHint(bodyText);
  return `HTTP ${status}` + (body ? ' · ' + body : '') + (hint ? '\n' + hint : '');
}

/**
 * 展示用的 Authorization。key 只留前几位，剩下的打码 ——
 * 设置页那次「测试」会把请求头摊开显示，别让它悄悄带走整把 key。
 */
export function maskApiKey(apiKey) {
  const k = String(apiKey || '').trim();
  if (!k) return 'Bearer ';
  if (k.length <= 8) return 'Bearer ***';
  return 'Bearer ' + k.slice(0, 6) + '…（已隐藏）';
}

/** 把诊断信息挂到 Error 上。设置页的「测试」靠它显示 HTTP 状态和原始响应 */
function withDetail(err, detail) {
  Object.assign(err, detail);
  return err;
}

/**
 * 发一次 OCR 请求。
 *
 * 成功时返回 { text, ms, status, raw, request }；失败时 throw 一个 Error，
 * 并把同样的诊断字段（status / ms / raw / request）挂在 Error 上。
 * `request` 是**展示用**的那份（Authorization 打码），别拿它重发。
 */
export async function runOcr({ provider, dataUrl, signal }) {
  const p = provider || {};
  const endpoint = String(p.endpoint || '').trim();
  if (!endpoint) throw new Error('这条 OCR 供应商还没填接口地址');
  const model = String(p.model || '').trim();
  if (!model) throw new Error('这条 OCR 供应商还没填模型名');
  const apiKey = String(p.apiKey || '').trim();
  if (!apiKey) throw new Error('这条 OCR 供应商还没填 API Key');

  const body = JSON.stringify(buildOcrBody(p, dataUrl));
  const request = {
    method: 'POST',
    url: endpoint,
    headers: { 'Content-Type': 'application/json', Authorization: maskApiKey(apiKey) },
    body
  };

  const started = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey
    },
    body,
    signal
  });

  const raw = await res.text();
  const ms = Date.now() - started;
  const detail = { status: res.status, ms, raw, request };
  if (!res.ok) throw withDetail(new Error(describeOcrError(res.status, raw)), detail);

  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    throw withDetail(new Error('OCR 返回的不是 JSON：' + raw.slice(0, 120)), detail);
  }

  const text = pickOcrText(json);
  if (!text) throw withDetail(new Error('OCR 没识别出文字（图片是空的？换个提示词试试）'), detail);

  return { text, ms, status: res.status, raw, request };
}

/** 面板里那句「剪切板里没有图片」从这里取，别再手写一遍 */
export const OCR_NO_IMAGE = NO_IMAGE_MESSAGE;
