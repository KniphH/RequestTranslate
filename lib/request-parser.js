/**
 * 请求模板解析器
 * ------------------------------------------------------------------
 * 把用户写的「请求文本」解析成 { url, method, headers, body }。
 *
 * 支持两种写法：
 *
 * 1) curl（推荐，可以直接从 API 文档里复制）
 *      curl https://example.com/v1/chat/completions \
 *        -H "Content-Type: application/json" \
 *        -H "Authorization: Bearer sk-xxx" \
 *        -d '{"model":"x","messages":[{"role":"user","content":"{{text}}"}]}'
 *
 * 2) 原始 HTTP 报文（类似 VS Code REST Client）
 *      POST https://example.com/v1/chat/completions
 *      Content-Type: application/json
 *      Authorization: Bearer sk-xxx
 *
 *      {"model":"x","messages":[{"role":"user","content":"{{text}}"}]}
 *
 * 词法层面按 POSIX shell 规则处理：单引号内全是字面量、双引号内支持 \ 转义、
 * 行尾 \ 表示续行、token 起始位置的 # 视为注释（引号内的 # 是普通字符，
 * 所以 JSON 里夹一行 # 注释也不会把后面的内容吃掉）。
 */

const CURL_VALUE_FLAGS = new Set([
  'X', 'H', 'd', 'u', 'b', 'A', 'e', 'o', 'w', 'T', 'F', 'x', 'E', 'K', 'm', 'r', 'y', 'z', 'Y', 'c', 'C'
]);

/** 无参数短选项（取到就直接忽略） */
const CURL_BOOL_FLAGS = new Set([
  'G', 'g', 'I', 'i', 's', 'S', 'L', 'k', 'v', 'f', 'q', 'n', 'N', 'J', 'O', 'R', 'Z', '4', '6', '0', '1', '2', '3'
]);

/** 长选项：这些需要吃掉后面的值 */
const CURL_LONG_VALUE = new Set([
  '--request', '--header', '--data', '--data-raw', '--data-binary', '--data-ascii',
  '--data-urlencode', '--url', '--user', '--cookie', '--cookie-jar', '--user-agent',
  '--referer', '--oauth2-bearer', '--proxy', '--cert', '--key', '--cacert', '--output',
  '--form', '--form-string', '--upload-file', '--max-time', '--connect-timeout',
  '--retry', '--write-out', '--resolve', '--interface', '--limit-rate'
]);

/** 长选项：无值 */
const CURL_LONG_BOOL = new Set([
  '--compressed', '--insecure', '--silent', '--show-error', '--verbose', '--location',
  '--no-buffer', '--fail', '--no-progress-meter', '--http1.1', '--http2', '--get', '--globoff'
]);

/* ------------------------------------------------------------------ */
/* 词法分析                                                            */
/* ------------------------------------------------------------------ */

/**
 * 把请求文本切成 token，模拟 POSIX shell 的引号 / 转义 / 续行行为。
 * @param {string} src
 * @returns {string[]}
 */
export function tokenize(src) {
  const tokens = [];
  let cur = '';
  let started = false;
  let i = 0;
  const n = src.length;
  /** @type {'normal'|'single'|'double'} */
  let state = 'normal';

  const flush = () => {
    if (started) {
      tokens.push(cur);
      cur = '';
      started = false;
    }
  };

  while (i < n) {
    const c = src[i];

    if (state === 'normal') {
      // 续行：反斜杠 + 换行
      if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
      if (c === '\\' && src[i + 1] === '\r' && src[i + 2] === '\n') { i += 3; continue; }

      // 转义的单引号。POSIX shell 里 \' 就是字面撇号，也是本扩展
      // escapeShellSingle() 生成的形式（' 变 '\''），两种写法都得认。
      if (c === '\\' && src[i + 1] === "'") { cur += "'"; started = true; i += 2; continue; }

      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        flush();
        i += 1;
        continue;
      }
      // 只在 token 起始处把 # 当注释（foo#bar 不算）
      if (c === '#' && !started) {
        while (i < n && src[i] !== '\n') i += 1;
        continue;
      }
      if (c === "'") { state = 'single'; started = true; i += 1; continue; }
      if (c === '"') { state = 'double'; started = true; i += 1; continue; }

      cur += c;
      started = true;
      i += 1;
      continue;
    }

    if (state === 'single') {
      if (c === "'") { state = 'normal'; i += 1; continue; }
      cur += c;
      i += 1;
      continue;
    }

    // state === 'double'
    if (c === '\\') {
      const nx = src[i + 1];
      if (nx === '"' || nx === '\\' || nx === '$' || nx === '`') { cur += nx; i += 2; continue; }
      if (nx === '\n') { i += 2; continue; }
      if (nx === '\r' && src[i + 2] === '\n') { i += 3; continue; }
      cur += '\\';
      i += 1;
      continue;
    }
    if (c === '"') { state = 'normal'; i += 1; continue; }
    cur += c;
    i += 1;
  }

  flush();
  return tokens;
}

/* ------------------------------------------------------------------ */
/* curl 解析                                                           */
/* ------------------------------------------------------------------ */

function addHeader(headers, rawHeader) {
  const idx = rawHeader.indexOf(':');
  if (idx <= 0) return;
  const name = rawHeader.slice(0, idx).trim();
  const value = rawHeader.slice(idx + 1).trim();
  if (!name) return;
  // 同名 header 后者覆盖前者（curl 的 @ 前缀丢空值语义这里不需要）
  headers[name] = value;
}

function base64(str) {
  if (typeof btoa === 'function') {
    // btoa 只吃 latin1，中文用户名密码先转 UTF-8 字节
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  }
  return Buffer.from(str, 'utf-8').toString('base64');
}

/**
 * 解析 curl 命令。
 * @param {string} src
 */
export function parseCurl(src) {
  const tokens = tokenize(src);
  const result = {
    url: '',
    method: '',
    headers: /** @type {Record<string,string>} */ ({}),
    body: /** @type {string|null} */ (null),
    warnings: /** @type {string[]} */ ([])
  };

  const dataParts = [];
  let useGet = false;

  // 跳过开头的 curl 本身
  let i = 0;
  if (tokens.length && /^curl(\.exe)?$/i.test(tokens[0])) i = 1;

  const next = () => tokens[i++];

  for (; i < tokens.length; ) {
    let tok = tokens[i];

    // 长选项
    if (tok.startsWith('--')) {
      i += 1;
      let name = tok;
      let inlineValue = null;
      const eq = tok.indexOf('=');
      if (eq !== -1) {
        name = tok.slice(0, eq);
        inlineValue = tok.slice(eq + 1);
      }

      if (CURL_LONG_VALUE.has(name)) {
        const value = inlineValue !== null ? inlineValue : (next() ?? '');
        switch (name) {
          case '--request': result.method = value.toUpperCase(); break;
          case '--header': addHeader(result.headers, value); break;
          case '--data':
          case '--data-raw':
          case '--data-binary':
          case '--data-ascii':
          case '--data-urlencode':
            dataParts.push(value);
            break;
          case '--url': result.url = value; break;
          case '--user': result.headers['Authorization'] = 'Basic ' + base64(value); break;
          case '--cookie': result.headers['Cookie'] = value; break;
          case '--user-agent': result.headers['User-Agent'] = value; break;
          case '--referer': result.headers['Referer'] = value; break;
          case '--oauth2-bearer': result.headers['Authorization'] = 'Bearer ' + value; break;
          default: break;
        }
        continue;
      }

      if (CURL_LONG_BOOL.has(name)) {
        if (name === '--get') useGet = true;
        continue;
      }

      // 不认识的长选项：带 = 的已经拿到值，不带的就放过去，不能瞎吃下一个 token
      continue;
    }

    // 短选项（含 -d'xxx' 这种黏在一起写的）
    if (tok.length > 1 && tok[0] === '-' && tok !== '-') {
      i += 1;
      const flag = tok[1];
      let inlineValue = tok.length > 2 ? tok.slice(2) : null;

      if (CURL_VALUE_FLAGS.has(flag)) {
        const value = inlineValue !== null && inlineValue !== '' ? inlineValue : (next() ?? '');
        switch (flag) {
          case 'X': result.method = value.toUpperCase(); break;
          case 'H': addHeader(result.headers, value); break;
          case 'd': dataParts.push(value); break;
          case 'u': result.headers['Authorization'] = 'Basic ' + base64(value); break;
          case 'b': result.headers['Cookie'] = value; break;
          case 'A': result.headers['User-Agent'] = value; break;
          case 'e': result.headers['Referer'] = value; break;
          default: break;
        }
        continue;
      }

      if (flag === 'G') useGet = true;
      // 组合短选项（-sSL 之类）：逐个查，只认其中有值的
      if (inlineValue === null && tok.length > 2) {
        for (const ch of tok.slice(1)) {
          if (CURL_VALUE_FLAGS.has(ch)) {
            const value = next() ?? '';
            if (ch === 'H') addHeader(result.headers, value);
            else if (ch === 'd') dataParts.push(value);
            else if (ch === 'X') result.method = value.toUpperCase();
          } else if (ch === 'G') {
            useGet = true;
          }
        }
      }
      continue;
    }

    // 裸参数：第一个当作 URL
    i += 1;
    if (!result.url) result.url = tok;
    else if (CURL_BOOL_FLAGS.has(tok)) { /* 忽略 */ }
  }

  if (dataParts.length) {
    result.body = dataParts.join('&');
    if (useGet) {
      // -G：把数据拼到 query
      const qs = result.body;
      result.url += (result.url.includes('?') ? '&' : '?') + qs;
      result.body = null;
    }
  }

  if (!result.method) result.method = result.body !== null ? 'POST' : 'GET';

  return result;
}

/* ------------------------------------------------------------------ */
/* 原始 HTTP 报文解析                                                  */
/* ------------------------------------------------------------------ */

/**
 * 解析 `POST https://x HTTP/1.1` 这种原始报文。
 * @param {string} src
 * @returns {object|null}
 */
export function parseRawHttp(src) {
  const normalized = src.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  // 允许开头有空行 / 注释行
  let start = 0;
  while (start < lines.length) {
    const t = lines[start].trim();
    if (t === '' || t.startsWith('#')) start += 1;
    else break;
  }
  if (start >= lines.length) return null;

  const first = lines[start].trim();
  const m = first.match(/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+(\S+)(?:\s+HTTP\/[\d.]+)?$/i);
  if (!m) return null;

  const result = {
    url: m[2],
    method: m[1].toUpperCase(),
    headers: /** @type {Record<string,string>} */ ({}),
    body: /** @type {string|null} */ (null),
    warnings: /** @type {string[]} */ ([])
  };

  let i = start + 1;
  for (; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === '') { i += 1; break; }
    // header 续行（以空格开头）——极少见，简单拼接
    addHeader(result.headers, line);
  }

  const rest = lines.slice(i).join('\n');
  if (rest.trim() !== '') result.body = rest.replace(/^\n+/, '');

  return result;
}

/* ------------------------------------------------------------------ */
/* 入口                                                               */
/* ------------------------------------------------------------------ */

/**
 * 自动判断是 curl 还是原始报文，并解析。
 * @param {string} src 已经完成变量替换的请求文本
 * @returns {{url:string, method:string, headers:Record<string,string>, body:string|null, warnings:string[], style:'curl'|'raw'}}
 */
export function parseRequest(src) {
  const text = (src || '').trim();
  const out = (r, style) => ({ ...r, style });

  if (text === '') {
    return out({ url: '', method: 'GET', headers: {}, body: null, warnings: ['请求模板为空'] }, 'curl');
  }

  // 去掉前导注释行后再看首行长什么样
  const probe = text.replace(/^(?:\s*#.*\n)+/, '').trim();

  const looksCurl = /^curl(\s|\.exe|$)/i.test(probe);
  const looksFlags = /^-{1,2}[A-Za-z]/.test(probe);
  const looksRaw = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|TRACE)\s+\S+/i.test(probe);

  if (looksCurl || (looksFlags && !looksRaw)) return out(parseCurl(src), 'curl');

  if (looksRaw) {
    const raw = parseRawHttp(src);
    if (raw) return out(raw, 'raw');
  }

  // 兜底：按 curl 解析，尽量救回来
  return out(parseCurl(src), 'curl');
}

/**
 * 判断请求体是不是 JSON，如果是但里面有 `#` 注释行，就剥掉注释。
 * 只在解析失败时调用，成功时保持用户原文。
 * @param {string} body
 * @returns {{text:string, changed:boolean}|null}
 */
export function repairJsonComments(body) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < body.length; i += 1) {
    const c = body[i];
    if (inString) {
      out += c;
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    if (c === '#') {
      while (i < body.length && body[i] !== '\n') i += 1;
      continue;
    }
    out += c;
  }

  if (out === body) return null;
  return { text: out, changed: true };
}

/**
 * 尝试把「长得像 JSON 但不合法」的请求体救回来。
 * 依次尝试：
 *   1. 剥掉字符串外的 # 注释行
 *   2. 把字符串内的裸换行转义成 \n
 * 只在原始文本解析失败时调用，成功时绝不改动用户原文。
 *
 * @param {string} body
 * @returns {{text:string, notes:string[]}|null}
 */
export function repairJsonBody(body) {
  const notes = [];

  if (!/^\s*[[{]/.test(body)) return null;

  try {
    JSON.parse(body);
    return null; // 本来就是合法 JSON
  } catch {
    /* 继续尝试修复 */
  }

  let candidate = body;

  const deComment = repairJsonComments(candidate);
  if (deComment) {
    candidate = deComment.text;
    notes.push('已忽略请求体里的 # 注释行');
    try {
      JSON.parse(candidate);
      return { text: candidate, notes };
    } catch {
      /* 继续 */
    }
  }

  const unnewlined = escapeBareNewlinesInStrings(candidate);
  if (unnewlined !== candidate) {
    candidate = unnewlined;
    notes.push('已把字符串里的裸换行转义为 \\n');
    try {
      JSON.parse(candidate);
      return { text: candidate, notes };
    } catch {
      /* 救不回来 */
    }
  }

  return null;
}

/** 把 JSON 字符串内部的裸换行 / 回车 / 制表符转义 */
function escapeBareNewlinesInStrings(text) {
  let out = '';
  let inString = false;
  let escaped = false;

  for (const c of text) {
    if (inString) {
      if (escaped) { out += c; escaped = false; continue; }
      if (c === '\\') { out += c; escaped = true; continue; }
      if (c === '"') { out += c; inString = false; continue; }
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') { out += '\\r'; continue; }
      if (c === '\t') { out += '\\t'; continue; }
      out += c;
      continue;
    }
    if (c === '"') { inString = true; out += c; continue; }
    out += c;
  }

  return out;
}

/**
 * 校验解析结果，返回人类可读的问题列表。
 */
export function validateParsedRequest(req) {
  const problems = [];
  if (!req.url) problems.push('没有解析出 URL：请确认请求里包含完整的 https:// 地址');
  else if (!/^https?:\/\//i.test(req.url)) problems.push(`URL 看起来不是绝对地址："${req.url}"`);
  if (req.body !== null && req.method === 'GET') problems.push('GET 请求带了 body，浏览器会丢掉它');
  return problems;
}
