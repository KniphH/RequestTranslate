/**
 * 从响应 JSON 里把译文抠出来
 * ------------------------------------------------------------------
 * 各家返回结构千奇百怪，所以规则是：
 *   1. 配置里写了路径 → 按路径取
 *   2. 没写 → 按一组常见路径依次试探，第一个命中就用
 *
 * 路径语法（够用且不烧脑）：
 *   choices[0].message.content
 *   $.choices[0].delta.content
 *   data.translations[0].translatedText
 *   ["weird key"].value
 */

const AUTO_PATHS = [
  // OpenAI / DeepSeek / 各种兼容中转
  'choices[0].message.content',
  'choices[0].delta.content',
  'choices[0].text',
  // Anthropic 流式：{"type":"content_block_delta","delta":{"type":"text_delta","text":"…"}}
  'delta.text',
  'choices[0].message.reasoning_content',
  // Anthropic 非流式
  'content[0].text',
  'completion',
  // Gemini
  'candidates[0].content.parts[0].text',
  // Ollama
  'message.content',
  'response',
  // 通用
  'output_text',
  'output.text',
  'result',
  'translation',
  'translated_text',
  'translatedText',
  'text',
  'data.translations[0].translatedText',
  'data.translation',
  'data.result',
  'data.text',
  'data.choices[0].message.content',
  'data.content[0].text'
];

/**
 * 把路径字符串拆成 token 数组。
 * @param {string} path
 * @returns {(string|number)[]}
 */
export function parsePath(path) {
  const src = String(path || '').trim().replace(/^\$\.?/, '');
  if (!src) return [];

  const tokens = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (c === '.') { i += 1; continue; }

    if (c === '[') {
      const end = src.indexOf(']', i);
      if (end === -1) break;
      const inner = src.slice(i + 1, end).trim();
      if (
        (inner.startsWith('"') && inner.endsWith('"')) ||
        (inner.startsWith("'") && inner.endsWith("'"))
      ) {
        tokens.push(inner.slice(1, -1));
      } else if (/^-?\d+$/.test(inner)) {
        tokens.push(Number(inner));
      } else if (inner !== '') {
        tokens.push(inner);
      }
      i = end + 1;
      continue;
    }

    let j = i;
    while (j < src.length && src[j] !== '.' && src[j] !== '[') j += 1;
    const name = src.slice(i, j).trim();
    if (name) tokens.push(name);
    i = j;
  }

  return tokens;
}

/**
 * @param {any} obj
 * @param {(string|number)[]} tokens
 */
export function getByPath(obj, tokens) {
  let cur = obj;
  for (const t of tokens) {
    if (cur == null) return undefined;
    if (typeof t === 'number') {
      if (!Array.isArray(cur)) return undefined;
      cur = cur[t];
    } else {
      if (typeof cur !== 'object') return undefined;
      cur = cur[t];
    }
  }
  return cur;
}

function stringifyValue(v) {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    // 有些接口返回 parts: [{text:'..'}, ...]
    const joined = v
      .map((item) => (typeof item === 'string' ? item : item && typeof item === 'object' ? item.text : ''))
      .filter(Boolean)
      .join('');
    if (joined) return joined;
  }
  return null;
}

/**
 * 从一段 JSON 数据里提取文本。
 * @param {any} data
 * @param {string} [path] 自定义路径，留空则自动探测
 * @returns {{text:string|null, usedPath:string|null}}
 */
export function extractContent(data, path) {
  if (data == null) return { text: null, usedPath: null };

  if (typeof data === 'string') return { text: data, usedPath: '(string)' };

  if (path && String(path).trim()) {
    const v = getByPath(data, parsePath(path));
    const s = stringifyValue(v);
    if (s !== null) return { text: s, usedPath: path.trim() };
    return { text: null, usedPath: path.trim() };
  }

  for (const p of AUTO_PATHS) {
    const v = getByPath(data, parsePath(p));
    const s = stringifyValue(v);
    if (s !== null && s !== '') return { text: s, usedPath: p };
  }

  return { text: null, usedPath: null };
}

/** 提取失败时给用户看的诊断信息 */
export function describeShape(data, depth = 0, maxDepth = 3) {
  if (data == null) return String(data);
  if (depth >= maxDepth) return Array.isArray(data) ? '[…]' : '{…}';
  if (Array.isArray(data)) {
    if (data.length === 0) return '[]';
    return `[ ${describeShape(data[0], depth + 1, maxDepth)} ]`;
  }
  if (typeof data === 'object') {
    const keys = Object.keys(data).slice(0, 12);
    const inner = keys.map((k) => `${k}: ${describeShape(data[k], depth + 1, maxDepth)}`).join(', ');
    return `{ ${inner} }`;
  }
  if (typeof data === 'string') return `"${data.length > 24 ? data.slice(0, 24) + '…' : data}"`;
  return String(data);
}
