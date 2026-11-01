/**
 * 请求模板解析器 —— 把用户写的「请求文本」解析成 { url, method, headers, body }。
 *
 * 两种写法：curl（推荐，能从 API 文档直接复制）和原始 HTTP 报文（类似 VS Code REST Client）。
 *
 * 词法按 POSIX shell 规则：单引号内全是字面量、双引号内支持 \ 转义、行尾 \ 续行、
 * token 起始处的 # 视为注释（引号内的 # 是普通字符，所以 JSON 里夹一行 # 注释也不吃后面的内容）。
 */

const CURL_VALUE_FLAGS = new Set([
  'X', 'H', 'd', 'u', 'b', 'A', 'e', 'o', 'w', 'T', 'F', 'x', 'E', 'K', 'm', 'r', 'y', 'z', 'Y', 'c', 'C'
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

/* ---- 词法分析 ---- */

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

/* ---- curl 解析 ---- */

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

  /* 这些 curl 参数要读**本地文件**，扩展读不了 —— 但**不能静默**（kniph 2026-10-18 通读）：
     README 把它们列成「限制」，可实际行为是「`-d @body.json` 把 @body.json 这一串**当请求体发出去**」、
     「-F / -T 直接丢掉」。用户从 API 文档抄一段带 @ 的 curl 过来，只会收到看不懂的服务端报错。
     这里的 warnings 会被 result.warnings 带到面板的「…」和设置页的 warn badge 上。 */
  const note = (msg) => {
    if (!result.warnings.includes(msg)) result.warnings.push(msg);
  };
  const NOTE_AT_FILE =
    '请求体写的是 @文件 —— curl 会去读本地文件，扩展读不了，会把这段 @… 原样当请求体发出去';
  const NOTE_UPLOAD =
    '-F / --form / -T 这类上传文件的参数要读本地文件，扩展不支持，这一段已忽略';
  const NOTE_URLENCODE =
    '--data-urlencode 的值没有做 URL 编码（curl 会编，扩展按原样发）—— 需要编码请自己在模板里写好';

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
            if (String(value).startsWith('@')) note(NOTE_AT_FILE);
            if (name === '--data-urlencode') note(NOTE_URLENCODE);
            dataParts.push(value);
            break;
          case '--form':
          case '--form-string':
          case '--upload-file':
            note(NOTE_UPLOAD);
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
          case 'd':
            if (String(value).startsWith('@')) note(NOTE_AT_FILE);
            dataParts.push(value);
            break;
          case 'F':
          case 'T':
            note(NOTE_UPLOAD);
            break;
          case 'u': result.headers['Authorization'] = 'Basic ' + base64(value); break;
          case 'b': result.headers['Cookie'] = value; break;
          case 'A': result.headers['User-Agent'] = value; break;
          case 'e': result.headers['Referer'] = value; break;
          default: break;
        }
        continue;
      }

      if (flag === 'G') useGet = true;
      /* 组合短选项：`-sSL`（全是无值旗标）、`-sd 'a=1'`（后面跟有值旗标）都算。
         首个字符（`flag`）上面已经处理过，这里从**余下部分**继续逐个看。

         ⚠️ 这里的守卫原来写的是 `inlineValue === null && tok.length > 2` ——
         **恒为假**（tok.length > 2 时 inlineValue 必不为 null），整段是死代码
         （kniph 2026-10-18 用覆盖率扫出来的）。后果不是「少个优化」而是**解析错**：
         `curl -sd 'a=1' https://x` 里 `d` 被当成无意义的字符丢掉，于是 `a=1`
         变成了 URL、body 为空、方法 GET —— 而 curl 的语义是 `-s` + `-d a=1`。

         有值旗标按 curl 的规矩吃掉**余下的字符**当参数，余下为空才吃下一个 token。 */
      if (inlineValue) {
        let rest = inlineValue;
        while (rest) {
          const ch = rest[0];
          rest = rest.slice(1);
          if (CURL_VALUE_FLAGS.has(ch)) {
            const value = rest || (next() ?? '');
            if (ch === 'H') addHeader(result.headers, value);
            else if (ch === 'd') dataParts.push(value);
            else if (ch === 'X') result.method = value.toUpperCase();
            else if (ch === 'u') result.headers['Authorization'] = 'Basic ' + base64(value);
            else if (ch === 'b') result.headers['Cookie'] = value;
            else if (ch === 'A') result.headers['User-Agent'] = value;
            else if (ch === 'e') result.headers['Referer'] = value;
            else if (ch === 'F' || ch === 'T') note(NOTE_UPLOAD);
            break; // 有值旗标把后面的字符都当参数了
          }
          if (ch === 'G') useGet = true;
        }
      }
      continue;
    }

    /* 裸参数：第一个当作 URL，其余忽略。
       **不用在这里判「它是不是某个 flag」** —— 带 `-` 的选项（长短都在内）
       在上面两个分支里就被接走了，能落到这一行的必然不带 `-`。
       （这里原本还有一个 else-if 去判 `CURL_BOOL_FLAGS`，但那个分支体是空的、
       而 else 本来也什么都不做 —— 命中与否行为完全一样，2026-10-18 通读删掉。） */
    i += 1;
    if (!result.url) result.url = tok;
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

/* ---- 原始 HTTP 报文解析 ---- */

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
    // header 续行（以空格开头）—— 极罕见。addHeader 认不出「没有冒号」会静默丢弃：
    // 与其留个假装拼接的注释，不如把值拼到上一个 header 后面（RFC 5322 的折行语义）
    if (/^[ \t]/.test(line) && Object.keys(result.headers).length) {
      const last = Object.keys(result.headers).pop();
      result.headers[last] += ' ' + line.trim();
    } else {
      addHeader(result.headers, line);
    }
  }

  const rest = lines.slice(i).join('\n');
  if (rest.trim() !== '') result.body = rest.replace(/^\n+/, '');

  return result;
}

/* ---- 入口 ---- */

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
