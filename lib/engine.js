/**
 * 请求执行引擎
 * ------------------------------------------------------------------
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
 * @typedef {Object} RunOptions
 * @property {string} [requestText]     已完成或未完成变量替换的请求模板
 * @property {string} [adapter]         内置适配器 id（如 'bing'）。给了这个就忽略 requestText
 * @property {Record<string,string>} [vars]
 * @property {string} [path]           响应提取路径，留空自动
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

  /* 纯观测用的统计量，不参与请求构造 */
  let ttfbMs = null;       // 收到第一个数据分片的时刻
  let firstDeltaMs = null; // 第一个「译文」分片的时刻 —— 用户真正等的就是它
  let chunks = 0;
  let bytes = 0;
  let mode = responseMode;
  let buffer = '';
  let tail = null;   // peek 模式用：先读出来的第一块
  let raw = '';
  let finalData = null;
  const acc = makeAccumulator();  // 译文
  const racc = makeAccumulator(); // 思考内容，用来判断 reasoning 有没有真的关掉

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
    raw: '',
    /* 诊断信息，前端面板的「…」里展示 */
    ttfbMs: null,
    firstDeltaMs: null,
    reasoningChars: 0,
    mode: responseMode,
    chunks: 0,
    bytes: 0
  };

  /** 收尾：写入诊断统计后返回 result */
  const finalize = () => {
    result.ms = Date.now() - started;
    result.mode = mode;
    result.ttfbMs = ttfbMs;
    result.firstDeltaMs = firstDeltaMs;
    result.reasoningChars = racc.get().length;
    result.chunks = chunks;
    result.bytes = bytes;
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

  const ctype = (res.headers.get('content-type') || '').toLowerCase();

  /* ---------- 5. 读响应 ---------- */
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
    const { text, usedPath } = extractContent(data, path);
    if (text) {
      if (usedPath) result.usedPath = usedPath;
      emit(text);
    }
  };

  let reader;
  try {
    reader = res.body ? res.body.getReader() : null;
  } catch {
    reader = null;
  }

  if (!reader) {
    const text = await res.text();
    appendRaw(text);
    handleJsonPayload(text);
    result.raw = raw;
    result.text = acc.get();
    if (!result.text && !result.ok) {
      result.error = `HTTP ${res.status} ${res.statusText}`;
    }
    return finalize();
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

  // 先确定解析方式（mode / buffer / tail 已在函数顶部声明）
  if (mode === 'auto') {
    if (ctype.includes('event-stream')) mode = 'sse';
    else if (ctype.includes('ndjson') || ctype.includes('jsonl')) mode = 'ndjson';
    else if (ctype.includes('json')) mode = 'json';
    else mode = 'peek';
  }

  if (mode === 'peek') {
    const first = await it.next();
    if (first.done) {
      tail = '';
      mode = 'text';
    } else {
      tail = first.value;
      appendRaw(tail);
      const probe = tail.replace(/^\uFEFF/, '').trimStart();
      if (/^data\s*:/i.test(probe)) {
        mode = 'sse';
      } else if (looksLikeFullJson(tail)) {
        mode = 'ndjson';
      } else if (probe.startsWith('{') || probe.startsWith('[')) {
        mode = 'json';
      } else {
        mode = 'text';
      }
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
          result.warnings.push('响应里没找到译文，返回结构是：' + describeShape(finalData));
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
      if (tail === null) {
        // 已经是完整文本（peek 时流就结束）
        if (tail === '') { /* 空响应 */ }
      } else {
        appendRaw(tail);
        emit(tail);
      }
      for await (const chunk of it) {
        appendRaw(chunk);
        emit(chunk);
      }
    }
  } catch (err) {
    result.raw = raw;
    result.text = acc.get();
    if (err && err.name === 'AbortError') {
      result.error = acc.get() ? null : '已取消';
      result.warnings.push('已手动中断，以下是已收到的部分');
      return finalize();
    }
    result.error = '读响应出错：' + (err && err.message ? err.message : String(err));
    return finalize();
  }

  result.raw = raw;
  result.text = acc.get();

  if (!result.ok && !result.text) {
    const hint = raw.trim().slice(0, 300);
    result.error = `HTTP ${res.status} ${res.statusText}${hint ? ' —— ' + hint : ''}`;
  } else if (result.ok && !result.text) {
    result.error = '请求成功但没提取到译文。返回结构：' + describeShape(finalData);
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

/** 只解析渲染结果，不发请求（给 UI 做预览用） */
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
    request: { ...parsed, body },
    problems: validateParsedRequest(parsed),
    notes
  };
}
