/**
 * OCR —— 把截图里的文字认出来。
 *
 * 两条路：
 *   1. 模板路径（request 非空）：和「配置」栏同一套机制 —— 用户写一段 curl 或原始 HTTP 报文，
 *      占位符（{{image}} / {{imageBase64}} / {{imageUrlEncoded}}）填上截图，parseRequest 解析后
 *      原样发出去，响应按 responsePath 提取。任何协议都能写，不用改代码。
 *   2. 老字段路径（request 留空）：旧的 OpenAI 兼容表单（endpoint / model / prompt / apiKey /
 *      maxTokens）。新存档不会再产生这种供应商，保留是给老存档兜底。
 *
 * 这个文件不碰 chrome，纯函数 + 一个 fetch，能在 Node 里单测。
 */

import { NO_IMAGE_MESSAGE } from './clipboard.js';
import { renderTemplate, stripDataUrl, escapeShellSingle } from './template.js';
import { parseRequest, validateParsedRequest } from './request-parser.js';
import { maskAuthHeaders, readResponseBody } from './engine.js';

/** 右键菜单里那一条：id 和文案放这里，background 与测试共用一份，
   免得改文案时漏掉一边。 */
export const OCR_MENU_ID = 'rt-ocr-clipboard';
export const OCR_MENU_TITLE = '翻译剪切板中的截图';

/** 右键菜单里「框选截图翻译」那条。和剪切板那条分开管开关
   （settings.shotMenu），两条可以同时开 —— 一个翻剪切板里已有的图，
   一个当场框一块区域。 */
export const SHOT_MENU_ID = 'rt-shot-translate';
export const SHOT_MENU_TITLE = '框选截图翻译';

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

/** 「框选截图翻译」那条，规矩同 ocrMenuItem：关掉返回 null，文案 id 只此一份 */
export function shotMenuItem(settings) {
  if (settings && settings.shotMenu === false) return null;
  return { id: SHOT_MENU_ID, title: SHOT_MENU_TITLE, contexts: ['all'] };
}

/**
 * 默认提示词 —— **只用于老字段路径的兜底**（prompt 留空时）。
 * 模板路径下提示词就直接写在模板文本里，和翻译配置一个写法。
 *
 * 内容必须是 **DeepSeek-OCR 官方的那串写法**：`<image>` 标记 + 换行 + `Free OCR.`。
 * 它不是一句随便写的自然语言指令 —— 模型只认训练时那几个固定预设，写成别的
 * （哪怕意思一模一样的中文）就是把它推出训练分布，输出会退化成自由发挥：
 * 实测把提示词换成普通措辞，它会跑去生成 `<table>` 表格，识别率也跟着掉。
 * 想改这句之前，先去翻官方示例。
 */
export const DEFAULT_OCR_PROMPT = '<image>\nFree OCR.';

/**
 * 内置供应商（全部是模板形状）。
 *
 * 百度这条就是「OCR 栏开放模板」的直接收益：form 表单 + token 挂 URL，
 * 这种协议以前得写适配器，现在就是一段模板。
 */
export const OCR_PROVIDERS = [
  {
    id: 'builtin-siliconflow',
    name: '硅基流动',
    note: 'DeepSeek-OCR 在硅基流动上免费。Key 在「变量」页签的 apiKey 里填，和翻译配置共用。',
    responsePath: '',
    request: `# DeepSeek-OCR 在硅基流动上免费；Key 在「变量」页签的 apiKey 里填，和翻译配置共用
# 提示词那串别动：模型只认官方预设，换成别的写法（哪怕意思一样的中文）输出会退化
curl https://api.siliconflow.cn/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {{apiKey}}" \\
  -d '{
  "model": "deepseek-ai/DeepSeek-OCR",
  "messages": [
    {"role": "user", "content": [
      {"type": "image_url", "image_url": {"url": "{{image}}"}},
      {"type": "text", "text": "<image>\\nFree OCR."}
    ]}
  ],
  "temperature": 0.01
}'`
  },
  {
    id: 'builtin-baidu-ocr',
    name: '百度 OCR（高精度版）',
    note: '个人认证每月 1000 次免费。access_token 用 API Key + Secret Key 去官方鉴权接口换，30 天过期，过期重换一个再粘进 URL。',
    responsePath: '',
    request: `# 百度高精度版：个人认证每月 1000 次免费，QPS 2/秒
# access_token = API Key + Secret Key 换来的（30 天过期）：
#   https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials&client_id=你的AK&client_secret=你的SK
# 换到后把 token 粘进下面 URL，过期了重换一次
#
# language_type 不给就是 CHN_ENG（中英混合）—— 日文的假名会被当成中文读，所以要显式指定。
# 想钉死一种语言就把 auto_detect 换掉：CHN_ENG 中英 / ENG 英 / JAP 日 / KOR 韩 / FRE 法 /
# GER 德 / SPA 西 / POR 葡 / RUS 俄 / ITA 意 / THA 泰 / VIE 越 / ARA 阿（其余见百度文档）
POST https://aip.baidubce.com/rest/2.0/ocr/v1/accurate_basic?access_token=把access_token粘到这里
Content-Type: application/x-www-form-urlencoded

image={{imageUrlEncoded}}&language_type=auto_detect`
  },
  {
    id: 'builtin-openai-vl',
    name: 'OpenAI 兼容（任意视觉模型）',
    note: '任何按 OpenAI 格式收图的接口：改地址和模型名就行，Key 在「变量」页签的 apiKey 里填。',
    responsePath: '',
    request: `# 任何按 OpenAI 格式收图的接口：改地址、模型名，Key 在「变量」页签的 apiKey 里填
curl https://api.openai.com/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer {{apiKey}}" \\
  -d '{
  "model": "gpt-4o-mini",
  "messages": [
    {"role": "user", "content": [
      {"type": "image_url", "image_url": {"url": "{{image}}"}},
      {"type": "text", "text": "请原样输出图片里的文字，不要翻译、不要解释。"}
    ]}
  ]
}'`
  }
];

/** 内置供应商的 id，删掉之后记进 state.ocr.hidden，免得下次启动又被补回来 */
export const BUILTIN_OCR_IDS = OCR_PROVIDERS.map((p) => p.id);

function localId() {
  return 'ocr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7);
}

/**
 * 老字段 → 等价模板。
 *
 * 生成出的模板**渲染之后**和旧 buildOcrBody + previewOcrRequest 发出的请求
 * 逐字节一致：键序一致（model → messages → max_tokens? → temperature）、
 * prompt 的 JSON 转义由 JSON.stringify 完成、整段再过一遍 shell 单引号转义。
 * {{image}} 占位符渲染时落在「shell 单引号 + JSON 双引号」两层里，
 * data URL 没有引号和控制字符，两层转义都是恒等 —— 所以字节不漂。
 *
 * 老用户（Key 填在原来的 Key 字段里）靠这个函数无损搬家：Key 原样进模板。
 */
export function ocrProviderToTemplate(old) {
  const p = old || {};
  const prompt = String(p.prompt || '').trim() || DEFAULT_OCR_PROMPT;
  const body = {
    model: String(p.model || '').trim(),
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: '{{image}}' } },
          { type: 'text', text: prompt }
        ]
      }
    ]
  };
  const maxTokens = normalizeMaxTokens(p.maxTokens);
  if (maxTokens > 0) body.max_tokens = maxTokens;
  body.temperature = 0.01;
  const json = JSON.stringify(body);
  const endpoint = escapeShellSingle(String(p.endpoint || ''));
  const key = escapeShellSingle(String(p.apiKey || ''));
  return (
    `curl -X POST '${endpoint}' \\\n` +
    `  -H 'Content-Type: application/json' \\\n` +
    `  -H 'Authorization: Bearer ${key}' \\\n` +
    `  --data '${escapeShellSingle(json)}'`
  );
}

export function normalizeOcrProvider(p) {
  const src = p || {};
  return {
    id: String(src.id || localId()),
    name: String(src.name || '未命名供应商'),
    note: String(src.note || ''),
    // 老字段：模板留空时兜底用（新存档不会走到，见 runOcr 的两条路）
    endpoint: String(src.endpoint || ''),
    model: String(src.model || ''),
    // 0 / 空 = **不发送 max_tokens**，交给服务端用模型自己的默认值。
    maxTokens: normalizeMaxTokens(src.maxTokens),
    prompt: String(src.prompt || DEFAULT_OCR_PROMPT),
    apiKey: String(src.apiKey || ''),
    // 模板路径的字段。老存档只有字段没有模板 —— 在这里就地转换成等价模板，
    // 用户的 Key 原样进模板（老导出文件走 importState 时同样被这一步接住）。
    request: String(src.request || (src.endpoint ? ocrProviderToTemplate(src) : '')),
    responsePath: String(src.responsePath || '')
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
 * 内置的那几条**每次都会补齐**（改了内置的模板也保得住用户填的字段），
 * 用户被删掉的内置条目记在 hidden 里跳过，自己新建的排在后面。
 *
 * 合并有个坑：老存档里的内置条目只有字段（endpoint/key/…）、没有模板，
 * 如果让内置默认的 request 漏进去，模板里的 `{{apiKey}}` 就和用户存在
 * 字段里的真 Key 对不上号 —— 所以**老形状的存档整体优先**，转换交给
 * normalizeOcrProvider（Key 原样内联进模板）。
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
    .map((d) => {
      const old = byId.get(d.id);
      // 老形状（没有 request 字段）整体优先；新形状（用户改过模板）才让存档逐字段覆盖
      return old && old.request === undefined
        ? normalizeOcrProvider(old)
        : normalizeOcrProvider({ ...d, ...(old || {}) });
    });

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

  return {
    activeId,
    providers,
    hidden: [...hidden],
    disabled: !!(raw && raw.disabled),
    // 图片直传时用哪条「配置」（存的是 config 的 id）—— 和顶栏那条（翻文字用的）
    // **互不干扰**：翻图前不用先想起来把顶栏切到支持视觉的那条。
    // 空 / 那条被删了 / 那条的图片模板被清空了，都退回老行为（用顶栏当前那条），
    // 这个判断在 background 里做（ocr 模块不认识 configs）。
    imageConfigId: String((raw && raw.imageConfigId) || '')
  };
}

/** 当前选中的那条。找不到就退回第一条 —— 调用方不用自己判空 */
export function activeOcrProvider(ocr) {
  const list = (ocr && ocr.providers) || [];
  if (!list.length) return null;
  return list.find((p) => p.id === (ocr && ocr.activeId)) || list[0];
}

/**
 * 请求体（老字段路径用）。图片在前、提示词在后 —— DeepSeek-OCR 官方的
 * 调用例子就是这个顺序。
 *
 * max_tokens **默认不发**：各家模型的上下文上限差得很远，而且这个上限是
 * 「提示词 + max_tokens」一起算的 —— 写死一个等于把宽上下文的模型迁就到窄的，
 * 一旦超过就直接 400（`max_tokens (8192) have exceeded max_seq_len (8192) limit`，
 * 就是 DeepSeek-OCR 撞出来的）。
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
 * 从响应里取文字（老字段路径用）。`content` 有的模型给字符串、有的给分段数组。
 * 模板路径走 lib/extract.js 的 extractContent（支持自定义提取路径 + 自动探测）。
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
    return '模型上下文装不下这个 max_tokens。把请求模板里 max_tokens 那一行删掉就行。';
  }
  if (/model.{0,24}(not exist|does not exist|not found|invalid|unknown)|invalid model/i.test(body)) {
    return '模型名没对上。去服务商的模型列表里复制全名，注意大小写和斜杠。';
  }
  if (/base64|decode image|image.{0,40}(invalid|too large|exceed)/i.test(body)) {
    return '图片本身被拒了。换张小一点的图，或者确认这个模型真收图。';
  }
  if (/access_token/i.test(body) && /(expired|invalid|110|111)/i.test(body)) {
    return '百度的 access_token 过期或不对（30 天有效）。去官方鉴权接口重换一个，粘进模板 URL。';
  }
  return '';
}

/** HTTP 不 OK 时把状态码和响应体一起说出来（响应体截一刀，别把整个 HTML 糊到面板上） */
export function describeOcrError(status, bodyText) {
  const body = String(bodyText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const hint = ocrErrorHint(bodyText);
  return `HTTP ${status}` + (body ? ' · ' + body : '') + (hint ? '\n' + hint : '');
}

/** 把诊断信息挂到 Error 上。设置页的「测试」靠它显示 HTTP 状态和原始响应 */
function withDetail(err, detail) {
  Object.assign(err, detail);
  return err;
}

/**
 * 展示用的 Authorization 打码（maskApiKey / maskAuthHeaders）在 lib/engine.js ——
 * 翻译配置的预览和 OCR 的预览用同一套，别再造一份。
 */

/**
 * 组装请求的**一处真相源**：设置页的预览（previewOcrRequest）、runOcr 里
 * 记下来的 `request`、以及真正 fetch 出去的那一份，全都从这里来 ——
 * 预览里看到的字节就是真发出去的那一份。分开组装的话两边迟早漂。
 *
 * 模板路径：填占位符 → parseRequest。老字段路径：buildOcrBody。
 * 返回的 headers 是**没打码**的真请求；打码在展示层（previewOcrRequest / runOcr 的
 * request 字段）做。
 */
function buildOcrRequest(p, dataUrl, vars = {}) {
  const template = String(p.request || '').trim();
  if (template) {
    const filled = fillOcrTemplate(template, dataUrl, vars);
    const req = parseRequest(filled.text);
    return {
      style: req.style,
      method: req.method,
      url: req.url,
      headers: { ...req.headers },
      body: req.body,
      warnings: [
        ...filled.missing.map((n) => `未定义的占位符 {{${n}}}（按空串替换了）`),
        ...validateParsedRequest(req)
      ]
    };
  }
  // 老字段兜底：request 留空时（normalize 之后再不会产生这种状态，
  // 但老测试和异常存档还能落到这里）
  return {
    method: 'POST',
    url: String(p.endpoint || '').trim(),
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + String(p.apiKey || '').trim()
    },
    body: JSON.stringify(buildOcrBody(p, dataUrl)),
    warnings: []
  };
}

/**
 * 展示用的完整请求（Authorization 打码）。
 * `runOcr` 发出去的 body 就是这里那一份，别再自己拼一遍。
 */
export function previewOcrRequest(provider, dataUrl, vars = {}) {
  const req = buildOcrRequest(provider || {}, dataUrl, vars);
  return { ...req, headers: maskAuthHeaders(req.headers) };
}

/**
 * 模板路径：把三个图片占位符填进用户写的请求文本。
 *
 *   {{image}}             data URL —— OpenAI 兼容接口用
 *   {{imageBase64}}       裸 base64（不带 data: 前缀）
 *   {{imageUrlEncoded}}   urlencode 之后的 base64 —— 百度这类表单接口用
 *                         （base64 里的 + 不转成 %2B 的话，服务端会当空格，图就坏了）
 *
 * vars 是用户变量（{{apiKey}} 这类）。提示词**不是**占位符，直接写在模板文本里。
 */
export function fillOcrTemplate(template, dataUrl, vars = {}) {
  const url = String(dataUrl || '');
  const base64 = stripDataUrl(url);
  return renderTemplate(template, {
    ...vars,
    image: url,
    imageBase64: base64,
    imageUrlEncoded: encodeURIComponent(base64)
  });
}

/**
 * 发一份**已经组装好的**请求，把响应读成文字。
 *
 * `runOcr`（OCR 供应商）和 `runImageTranslate`（图片模板）共用。
 * 「整体 JSON 还是 `"stream": true` 的 SSE」的识别规则**只有 `engine.js` 的 readResponseBody
 * 那一份** —— 这里别再写 `JSON.parse(res.text())`。实机踩过：图片模板带 `"stream": true`
 * 的接口回的是 SSE，设置页那个「测试」当场报「返回的不是 JSON」，而面板走引擎明明是好的。
 *
 * joiner 给 `'\n'`：OCR 的行数组（百度 `words_result`）要一行一行拼成一段。
 */
async function sendOcrRequest(real, { path = '', signal } = {}) {
  const started = Date.now();
  let res;
  try {
    res = await fetch(real.url, {
      method: real.method,
      headers: real.headers,
      body: real.body,
      signal
    });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw new Error(
      '请求发送失败：' + ((err && err.message) || String(err)) +
      '（检查 URL、是否被代理拦了、或者目标站点是否允许扩展访问）'
    );
  }
  const info = await readResponseBody(res, { path, joiner: '\n', responseMode: 'auto', started });
  return { ok: res.ok, status: res.status, ms: Date.now() - started, info };
}

/**
 * 「回的根本不是 JSON」这句。是就返回文案，不是返回空串。
 *
 * mode 是 text 说明整段响应里没有一处 JSON 的形状（HTML 报错页、网关的纯文本
 * 提示都是这种）；mode 是 json 但没解析出对象，说明那段 JSON 是坏的。
 * 两种都不该硬着头皮当文字用 —— 用户看到的是「网关返回的 HTML」被当成译文。
 */
function notJsonMessage(send) {
  const mode = send.info.mode;
  const broken = mode === 'text' || (mode === 'json' && !send.info.finalData);
  if (!broken) return '';
  return '返回的不是 JSON：' + String(send.info.raw || '').slice(0, 120);
}

/**
 * 发一次 OCR 请求。
 *
 * 成功时返回 { text, ms, status, raw, request }；失败时 throw 一个 Error，
 * 并把同样的诊断字段（status / ms / raw / request）挂在 Error 上。
 */
export async function runOcr({ provider, dataUrl, vars, signal }) {
  const p = provider || {};

  /* 老字段路径的缺字段校验（模板路径没有「字段」——空的模板由
     parseRequest / validateParsedRequest 的 warning 表达，别拦着发） */
  if (!String(p.request || '').trim()) {
    if (!String(p.endpoint || '').trim()) throw new Error('这条 OCR 供应商还没填接口地址');
    if (!String(p.model || '').trim()) throw new Error('这条 OCR 供应商还没填模型名');
    if (!String(p.apiKey || '').trim()) throw new Error('这条 OCR 供应商还没填 API Key');
  }

  // 发出去的就是预览里那一份（同一处真相源），request 记打码的那份给人看
  const real = buildOcrRequest(p, dataUrl, vars);
  const request = { method: real.method, url: real.url, headers: maskAuthHeaders(real.headers), body: real.body };
  const warnings = real.warnings || [];

  let send;
  try {
    send = await sendOcrRequest(real, { path: p.responsePath, signal });
  } catch (err) {
    throw withDetail(err, { status: 0, ms: 0, raw: '', request, warnings });
  }

  const detail = {
    status: send.status,
    ms: send.ms,
    raw: send.info.raw,
    request,
    warnings: [...warnings, ...send.info.warnings]
  };
  if (!send.ok) throw withDetail(new Error(describeOcrError(send.status, send.info.raw)), detail);

  const notJson = notJsonMessage(send);
  if (notJson) throw withDetail(new Error('OCR ' + notJson), detail);

  /* 模板路径直接用引擎读出来的文本；老字段路径固定吃 OpenAI 形状（pickOcrText）。
     —— 两条路的提取口径和加模板之前一模一样，只是现在也认流式响应了。 */
  const text = String(p.request || '').trim() ? String(send.info.text || '') : pickOcrText(send.info.finalData);
  if (!text) {
    throw withDetail(
      new Error(
        String(p.request || '').trim()
          ? 'OCR 没识别出文字（提取路径对不上？留空会自动探测常见结构，或在设置页填一个）'
          : 'OCR 没识别出文字（图片是空的？换个提示词试试）'
      ),
      detail
    );
  }

  return { text, ms: send.ms, status: send.status, raw: send.info.raw, request, warnings: detail.warnings };
}

/** 面板里那句「剪切板里没有图片」从这里取，别再手写一遍 */
export const OCR_NO_IMAGE = NO_IMAGE_MESSAGE;

/* ---- 图片直传：设置页的「测试」发这份 ---- */

/**
 * 一根**翻译配置**的「图片请求模板」到底通不通、能不能翻出东西。
 *
 * 勾了「禁用外置 OCR」之后，截图是直接塞进某条配置的图片模板里发的 ——
 * 那条路在右键截图之前没有任何地方能试。这个就是那个「测试」。
 *
 * 和 `runOcr` 同一个形状（装配 → fetch → 提取，成功失败都把请求 / 原始响应带上），
 * 装配也共用 `buildOcrRequest` 那套图片占位符 —— 差别只在：模板取自
 * `config.imageRequest`，措辞按「译文」而不是「识别到的文字」。
 */
export async function runImageTranslate({ config, dataUrl, vars, signal }) {
  const c = config || {};
  const template = String(c.imageRequest || '').trim();
  if (!template) {
    throw new Error('这条配置还没填「图片请求模板」—— 去「配置」栏把它填上，它才会出现在「图片配置」列表里');
  }

  // 发出去的和预览里看到的是同一处组装（buildOcrRequest）
  const real = buildOcrRequest({ request: template, responsePath: c.responsePath }, dataUrl, vars);
  const request = { method: real.method, url: real.url, headers: maskAuthHeaders(real.headers), body: real.body };
  const warnings = real.warnings || [];

  let send;
  try {
    send = await sendOcrRequest(real, { path: c.responsePath, signal });
  } catch (err) {
    throw withDetail(err, { status: 0, ms: 0, raw: '', request, warnings });
  }

  const detail = {
    status: send.status,
    ms: send.ms,
    raw: send.info.raw,
    request,
    warnings: [...warnings, ...send.info.warnings]
  };
  if (!send.ok) {
    const body = String(send.info.raw || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    throw withDetail(new Error(`HTTP ${send.status}` + (body ? ' · ' + body : '')), detail);
  }

  // 响应可能是整体 JSON，也可能是 stream=true 的 SSE —— 规则和引擎共用一份
  const notJson = notJsonMessage(send);
  if (notJson) throw withDetail(new Error(notJson), detail);

  const text = String(send.info.text || '');
  if (!text) {
    throw withDetail(
      new Error('没提取到内容 —— 提取路径对不上？留空会自动探测常见结构，也可以手填一个'),
      detail
    );
  }

  return { text, ms: send.ms, status: send.status, raw: send.info.raw, request, warnings: detail.warnings };
}
