/**
 * 请求执行引擎
 * 干的事只有四步：
 *   1. 用变量把请求模板里的 {{...}} 替换掉
 *   2. 把替换后的文本解析成 { url, method, headers, body }
 *   3. fetch 出去
 *   4. 按响应格式把译文流式抠出来
 *
 * 用户的请求文本除了占位符之外，一个字节都不会被改写。
 */

import { parseRequest, validateParsedRequest, repairJsonBody } from './request-parser.js';
import { renderTemplate } from './template.js';
import { extractContent, describeShape } from './extract.js';
import { runAdapter } from './adapters.js';

const RAW_LIMIT = 400000;

/**
 * 分片拼接：自动判断接口给的是「增量」还是「全量」。
 * - 增量：把新分片追加到已累计文本后面
 * - 全量：新分片以已累计文本开头且更长 → 直接替换
 */
function makeAccumulator() {
  let acc = '';
  return {
    push(piece) {
      if (!piece) return acc;
      if (!acc) {
        acc = piece;
      } else if (piece.startsWith(acc) && piece.length > acc.length) {
        acc = piece;
      } else if (piece === acc) {
        // 重复帧，忽略
      } else {
        acc += piece;
      }
      return acc;
    },
    get() {
      return acc;
    }
  };
}

/**
 * 从响应里挑出「思考内容」。
 * 只认 reasoning_content 这个名字（DeepSeek / Ling 等都用它），
 * 返回空串代表这一帧没有思考内容。
 */
function pickReasoning(data) {
  if (!data || typeof data !== 'object') return '';
  const c0 = Array.isArray(data.choices) ? data.choices[0] : null;
  const tries = [
    c0 && c0.delta && c0.delta.reasoning_content,
    c0 && c0.message && c0.message.reasoning_content,
    data.delta && data.delta.reasoning_content,
    data.reasoning_content
  ];
  for (const v of tries) {
    if (typeof v === 'string' && v) return v;
  }
  return '';
}

function looksLikeFullJson(text) {
  const t = text.trim();
  if (!t.startsWith('{') && !t.startsWith('[')) return false;
  try {
    return typeof JSON.parse(t) === 'object';
  } catch {
    return false;
  }
}

/**
 * 没有 Content-Type 可依据时，看开头猜响应格式。
 * `probe` 是**已经去掉 BOM、去过前导空白**的那一段。
 * peek 分支和「没有流、整体读一次」那条路共用 —— 判断口径必须一样，
 * 不然同一个响应在有流 / 没流时会被认成两种格式。
 */
function classifyPayload(probe) {
  if (/^data\s*:/i.test(probe)) return 'sse';
  if (looksLikeFullJson(probe)) return 'ndjson';
  if (probe.startsWith('{') || probe.startsWith('[')) return 'json';
  return 'text';
}

/**
 * 读一个响应，把里面的文本抠出来。
 *   * `runRequest`（翻译）—— 要增量回调，边收边吐；
 *   * 设置页那两个「测试」（OCR 供应商 / 一条配置的图片模板）—— 一次性拿结果。
 *
 * 「整体 JSON / SSE / NDJSON / 纯文本」的识别与拼装规则**只有这一份**。实机踩过：图片模板里写了
 * `"stream": true`（Ling 那种）时接口回的是 SSE，谁自己再写一个 `JSON.parse(res.text())` 就当场
 * 报「返回的不是 JSON」。
 *
 * 返回纯数据，不碰调用方的 result。传输途中的 AbortError **不当错误往外抛** —— 返回
 * `aborted: true` 和已经攒到的文本，怎么措辞交给调用方。
 *
 * opts: { path, joiner, responseMode, onDelta, started }
 * 返回: { mode, text, raw, finalData, usedPath, warnings, aborted, error,
 *        ttfbMs, firstDeltaMs, chunks, bytes, reasoningChars }
 */
export async function readResponseBody(res, opts = {}) {
  const path = String(opts.path || '');
  const joiner = String(opts.joiner || '');
  const onDelta = opts.onDelta || null;
  const started = typeof opts.started === 'number' ? opts.started : Date.now();

  let mode = opts.responseMode || 'auto';
  let buffer = '';
  let tail = null;   // peek 模式用：先读出来的第一块
  let raw = '';
  let finalData = null;
  let usedPath = null;
  let ttfbMs = null;
  let firstDeltaMs = null;
  let chunks = 0;
  let bytes = 0;
  let aborted = false;
  let error = null;
  const warnings = [];
  const acc = makeAccumulator();  // 译文
  const racc = makeAccumulator(); // 思考内容，用来判断 reasoning 有没有真的关掉

  const pack = () => ({
    mode,
    text: acc.get(),
    raw,
    finalData,
    usedPath,
    warnings,
    aborted,
    error,
    ttfbMs,
    firstDeltaMs,
    chunks,
    bytes,
    reasoningChars: racc.get().length
  });

  const appendRaw = (chunk) => {
    if (!chunk) return;
    chunks += 1;
    bytes += chunk.length;
    if (ttfbMs === null) ttfbMs = Date.now() - started;
    if (raw.length < RAW_LIMIT) raw += chunk;
  };

  const emit = (piece) => {
    if (!piece) return;
    if (firstDeltaMs === null) firstDeltaMs = Date.now() - started;
    const current = acc.push(piece);
    if (onDelta) onDelta(current, piece);
  };

  const handleJsonPayload = (payloadText) => {
    const t = payloadText.trim();
    if (!t) return;
    if (t === '[DONE]' || t === 'data: [DONE]') return;
    let data;
    try {
      data = JSON.parse(t);
    } catch {
      emit(t); // 不是 JSON，当纯文本片段
      return;
    }
    finalData = data;
    // 顺手看看模型有没有在「思考」（reasoning_effort 没生效时的典型症状）
    const reasoning = pickReasoning(data);
    if (reasoning) racc.push(reasoning);
    const { text, usedPath: p } = extractContent(data, path, joiner);
    if (text) {
      if (p) usedPath = p;
      emit(text);
    }
  };

  let reader;
  try {
    reader = res.body ? res.body.getReader() : null;
  } catch {
    reader = null;
  }

  // 没有流（打桩的 Response、或者环境不给 body）就整体读一次，当成一段 payload 处理。
  // 形状照样认一下 —— 设置页那两个「测试」靠 mode 分辨「回的根本不是 JSON」。
  if (!reader) {
    const text = await res.text();
    appendRaw(text);
    if (mode === 'auto') mode = classifyPayload(String(text || '').replace(/^\uFEFF/, '').trimStart());
    handleJsonPayload(text);
    return pack();
  }

  const ctype = String((res.headers && res.headers.get && res.headers.get('content-type')) || '').toLowerCase();

  /* 先确定解析方式（mode / buffer / tail 已在函数顶部声明） */
  if (mode === 'auto') {
    if (ctype.includes('event-stream')) mode = 'sse';
    else if (ctype.includes('ndjson') || ctype.includes('jsonl')) mode = 'ndjson';
    else if (ctype.includes('json')) mode = 'json';
    else mode = 'peek';
  }

  const decoder = new TextDecoder('utf-8');

  /** 流式读取，允许先看一眼第一块再决定怎么解析 */
  const iterate = async function* () {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      if (chunk) yield chunk;
    }
  };

  const it = iterate();

  if (mode === 'peek') {
    const first = await it.next();
    if (first.done) {
      tail = '';
      mode = 'text';
    } else {
      tail = first.value;
      appendRaw(tail);
      mode = classifyPayload(tail.replace(/^\uFEFF/, '').trimStart());
    }
  }

  try {
    if (mode === 'json') {
      // 整体 JSON：读完了再解析
      let all = tail === null ? '' : tail;
      for await (const chunk of it) {
        appendRaw(chunk);
        all += chunk;
      }
      const trimmed = all.replace(/^\uFEFF/, '').trim();
      if (/^data\s*:/im.test(trimmed)) {
        // 有些中转把 SSE 塞在 application/json 里
        for (const line of trimmed.split('\n')) {
          if (/^\s*data\s*:/i.test(line)) handleJsonPayload(line.replace(/^\s*data\s*:\s*/i, ''));
        }
      } else if (trimmed) {
        handleJsonPayload(trimmed);
        if (!acc.get()) {
          warnings.push('响应里没找到内容，返回结构是：' + describeShape(finalData));
        }
      }
    } else if (mode === 'sse') {
      const consumeEvents = () => {
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLines = [];
          for (const line of block.split('\n')) {
            const m = line.match(/^\s*data\s*:\s?(.*)$/i);
            if (m) dataLines.push(m[1]);
          }
          if (dataLines.length) {
            const payload = dataLines.join('\n');
            if (payload.trim() === '[DONE]') continue;
            handleJsonPayload(payload);
          }
        }
      };

      if (tail) {
        buffer += tail.replace(/\r\n/g, '\n');
        consumeEvents();
      }
      for await (const chunk of it) {
        appendRaw(chunk);
        buffer += chunk.replace(/\r\n/g, '\n');
        consumeEvents();
      }
      if (buffer.trim()) {
        const dataLines = [];
        for (const line of buffer.split('\n')) {
          const m = line.match(/^\s*data\s*:\s?(.*)$/i);
          if (m) dataLines.push(m[1]);
        }
        if (dataLines.length) handleJsonPayload(dataLines.join('\n'));
        else if (!acc.get() && buffer.trim()) handleJsonPayload(buffer);
      }
    } else if (mode === 'ndjson') {
      const consumeLines = () => {
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (line) handleJsonPayload(line);
        }
      };

      if (tail) {
        buffer += tail.replace(/\r\n/g, '\n');
        consumeLines();
      }
      for await (const chunk of it) {
        appendRaw(chunk);
        buffer += chunk.replace(/\r\n/g, '\n');
        consumeLines();
      }
      if (buffer.trim()) handleJsonPayload(buffer);
    } else {
      // text / 纯文本流
      if (tail !== null) {
        appendRaw(tail);
        emit(tail);
      }
      for await (const chunk of it) {
        appendRaw(chunk);
        emit(chunk);
      }
    }
  } catch (err) {
    if (err && err.name === 'AbortError') {
      aborted = true;
      return pack();
    }
    error = '读响应出错：' + (err && err.message ? err.message : String(err));
    return pack();
  }

  return pack();
}

/**
 * 这次请求调的是哪个模型 —— 面板「…」里要显示它。
 *
 * 只认两种**确定**的来源，都取不到就返回 ''（不猜、不编）：
 *   1. 请求体是 JSON 且有 `model` 字段（OpenAI / Anthropic / 硅基流动那一类）；
 *   2. URL 路径里带 `/models/<名字>`（Gemini 那种把模型写进地址的）。
 * 适配器（Bing）压根没有可编辑的请求文本，`request` 是 null —— 那时也返回 ''，
 * 让面板干脆不显示这一行（而不是显示个「未知」占地方）。
 */
export function extractModelName(requestInfo) {
  if (!requestInfo) return '';
  if (requestInfo.body) {
    try {
      const m = JSON.parse(requestInfo.body)?.model;
      if (typeof m === 'string' && m.trim()) return m.trim();
    } catch { /* 表单 / 纯文本 body：没有模型名可读 */ }
  }
  const hit = /\/models\/([^/?#:]+)/.exec(String(requestInfo.url || ''));
  if (hit) {
    try { return decodeURIComponent(hit[1]); } catch { return hit[1]; }
  }
  return '';
}

/** 响应里那个 model 字段（不少接口会在每一帧里回显）。拿不到就 '' */
function pickDataModel(data) {
  const m = data && data.model;
  return (typeof m === 'string' && m.trim()) ? m.trim() : '';
}

/**
 * @typedef {Object} RunOptions
 * @property {string} [requestText]     已完成或未完成变量替换的请求模板
 * @property {string} [adapter]         内置适配器 id（如 'bing'）。给了这个就忽略 requestText
 * @property {Record<string,string>} [vars]
 * @property {string} [path]           响应提取路径，留空自动
 * @property {string} [joiner]         数组元素拼接符。译文用 ''（连成一段），
 *                                     OCR 的行数组用 '\n'（一行一行来）
 * @property {'auto'|'sse'|'json'|'text'} [responseMode]
 * @property {(text:string, piece:string)=>void} [onDelta] 每收到一段就回调
 * @property {AbortSignal} [signal]
 */

/**
 * @param {RunOptions} options
 */
export async function runRequest(options) {
  const {
    requestText = '',
    adapter = '',
    vars = {},
    path = '',
    joiner = '',
    responseMode = 'auto',
    onDelta = null,
    signal = null
  } = options;

  // 内置适配器走专用通道：Bing 这类服务是「先抓 token 再翻译」两步流程，
  // 没法用一段请求文本表达。适配器返回的 result 结构和下面完全一致。
  if (adapter) {
    return await runAdapter(adapter, {
      text: vars.text || vars.selection || '',
      vars,
      onDelta,
      signal
    });
  }

  const started = Date.now();
  let mode = responseMode;

  const result = {
    ok: false,
    status: 0,
    statusText: '',
    ms: 0,
    text: '',
    error: null,
    warnings: [],
    missingVars: [],
    usedPath: null,
    request: null,
    model: '',
    raw: '',
    /* 诊断信息，前端面板的「…」里展示 */
    ttfbMs: null,
    firstDeltaMs: null,
    reasoningChars: 0,
    mode: responseMode,
    chunks: 0,
    bytes: 0
  };

  /** 收尾：写入耗时。响应那几项统计由 readResponseBody 那边补进来 */
  const finalize = () => {
    result.ms = Date.now() - started;
    result.mode = mode;
    return result;
  };

  /* ---------- 1. 替换变量 ---------- */
  const rendered = renderTemplate(requestText, vars);
  result.missingVars = rendered.missing;

  /* ---------- 2. 解析请求 ---------- */
  const parsed = parseRequest(rendered.text);
  const problems = validateParsedRequest(parsed);
  if (problems.length) {
    result.error = problems.join('；');
    return finalize();
  }

  /* ---------- 3. 修一下看起来像 JSON 但写错的 body ---------- */
  let body = parsed.body;
  if (body !== null && /^\s*[[{]/.test(body)) {
    try {
      JSON.parse(body);
    } catch {
      const fixed = repairJsonBody(body);
      if (fixed) {
        body = fixed.text;
        result.warnings.push(...fixed.notes);
      } else {
        result.warnings.push(describeBadJsonBody(body));
      }
    }
  }

  const requestInfo = {
    url: parsed.url,
    method: parsed.method,
    headers: parsed.headers,
    body,
    style: parsed.style
  };
  result.request = requestInfo;
  // 「…」里要交代这次调的是哪个模型。先看请求里写的（用户写了什么就是什么），
  // 没有的话等响应回来再看有没有回显 —— 见下面读响应之后那一句。
  result.model = extractModelName(requestInfo);

  /* ---------- 4. 发出去 ---------- */
  let res;
  try {
    const init = { method: parsed.method, headers: parsed.headers, signal };
    if (body !== null && parsed.method !== 'GET' && parsed.method !== 'HEAD') init.body = body;
    res = await fetch(parsed.url, init);
  } catch (err) {
    if (err && err.name === 'AbortError') {
      result.error = '已取消';
    } else {
      result.error =
        '请求发送失败：' + (err && err.message ? err.message : String(err)) +
        '（检查 URL、是否被代理拦了、或者目标站点是否允许扩展访问）';
    }
    return finalize();
  }

  result.status = res.status;
  result.statusText = res.statusText;
  result.ok = res.ok;

  /* ---------- 5. 读响应 ---------- */
  /* 「整体 JSON / SSE / NDJSON / 纯文本」的识别与拼装只有一处实现
     （readResponseBody，见文件上面）—— 设置页那两个「测试」也用同一份。
     别在这儿再抄一遍，也别在别处再写一个 JSON.parse。 */
  const info = await readResponseBody(res, {
    path,
    joiner,
    responseMode: mode,
    onDelta,
    started
  });
  mode = info.mode;
  result.raw = info.raw;
  result.text = info.text;
  result.usedPath = info.usedPath;
  result.ttfbMs = info.ttfbMs;
  result.firstDeltaMs = info.firstDeltaMs;
  result.chunks = info.chunks;
  result.bytes = info.bytes;
  result.reasoningChars = info.reasoningChars;
  result.warnings.push(...info.warnings);
  // 请求里没写 model（或者 body 不是 JSON）时，退一步认响应回显的那一个
  if (!result.model) result.model = pickDataModel(info.finalData);

  if (info.aborted) {
    // 中断不是失败：已经收到的那半截照给，用户看得见自己按停之前翻到了哪
    result.error = info.text ? null : '已取消';
    result.warnings.push('已手动中断，以下是已收到的部分');
    return finalize();
  }
  if (info.error) {
    result.error = info.error;
    return finalize();
  }

  if (!result.ok && !result.text) {
    const hint = String(info.raw || '').trim().slice(0, 300);
    result.error = `HTTP ${res.status} ${res.statusText}${hint ? ' —— ' + hint : ''}`;
  } else if (result.ok && !result.text) {
    result.error = '请求成功但没提取到译文。返回结构：' + describeShape(info.finalData);
  }

  return finalize();
}

/**
 * 请求体像 JSON 但修不回来时，给用户的提示。
 *
 * 光说「不是合法 JSON」用户没法下手 —— `JSON.parse` 的错误信息里带位置，
 * 顺手把那一段摘出来（换行显示成字面的 \n），一眼就能看出是哪里的引号/换行坏了。
 */
export function describeBadJsonBody(body) {
  const base = '请求体不是合法 JSON。JSON 字符串里不能直接换行（要写 \\n），双引号要写成 \\"';
  const text = String(body ?? '');

  let at = -1;
  try {
    JSON.parse(text);
    return base;
  } catch (err) {
    const m = /position (\d+)/.exec(String((err && err.message) || ''));
    if (m) at = Number(m[1]);
  }
  if (!(at >= 0)) return base;

  const from = Math.max(0, at - 30);
  const snippet = text.slice(from, at + 30).replace(/\n/g, '\\n').replace(/\r/g, '\\r');
  return base + `。大概是这里（第 ${at} 个字符附近）：…${snippet}…`;
}

/**
 * 展示用的 Authorization 打码。key 只留前几位，剩下的藏起来 ——
 * 设置页会把请求头摊开显示，别让它悄悄带走整把 key。
 * 空的说明是「还没填」——预览会照原样打出来，别留个孤零零的 `Bearer `。
 */
export function maskApiKey(apiKey) {
  const k = String(apiKey || '').trim();
  if (!k) return 'Bearer （还没填）';
  if (k.length <= 8) return 'Bearer ***';
  return 'Bearer ' + k.slice(0, 6) + '…（已隐藏）';
}

function maskAuthValue(value) {
  const s = String(value || '');
  const m = /^(Bearer\s*)(.*)$/i.exec(s.trim());
  if (!m) return s.trim() ? s.slice(0, 6) + '…（已隐藏）' : s;
  return maskApiKey(m[2]);
}

/** 复制一份 headers，Authorization 打码 —— 只给人看，别拿打码这份重发 */
export function maskAuthHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = /^authorization$/i.test(k) ? maskAuthValue(v) : v;
  }
  return out;
}

/** 只解析渲染结果，不发请求（给 UI 做预览用）。headers 是**打码的**展示版 */
export function previewRequest(requestText, vars, path = '') {
  const rendered = renderTemplate(requestText, vars);
  const parsed = parseRequest(rendered.text);
  let body = parsed.body;
  const notes = [];
  if (body !== null && /^\s*[[{]/.test(body)) {
    try {
      JSON.parse(body);
    } catch {
      const fixed = repairJsonBody(body);
      if (fixed) {
        body = fixed.text;
        notes.push(...fixed.notes);
      } else {
        notes.push(describeBadJsonBody(body));
      }
    }
  }
  return {
    rendered: rendered.text,
    missing: rendered.missing,
    request: { ...parsed, headers: maskAuthHeaders(parsed.headers), body },
    problems: validateParsedRequest(parsed),
    notes
  };
}
