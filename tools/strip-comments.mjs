import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// 打包时剥掉注释（源码里保留 —— 注释是给克隆仓库的人看的，装着扩展的人不会打开源文件）。
//
// 为什么要「词法地」剥而不是正则：JS 里 `//` 和 `/* */` 会大量出现在字符串、正则、模板串里
//   · "https://example.com"  ← 正则会把 // 到行尾全吃掉，这个字符串就没了
//   · /abc\/\//               ← 正则字面量里的转义斜杠
//   · `${x} // 这是注释`     ← 模板串里的 // 是字面文本
// `check-globals.mjs` 里已经有一个正确的词法器，但它把**字符串内容也抹了**（那是它要的
// —— 它只想看代码结构），打包不能用。这里另写一个：只删注释，字符串原样保留。
//
// 换行一律留着（只删注释那一段里的换行会被抹平，那样行号全乱，报错栈对不上源码）。
//
// JSDoc 里的 `@param {string} why` 这类注解也一起删：类型信息对
// 「扩展出错了、用户报 issue、我去查 stack trace」没帮助，对「改这个文件」才有帮助。

/**
 * 剥掉 JS 里的注释。字符串 / 正则 / 模板串里的内容一律原样保留。
 * @param {string} src
 * @returns {string}
 */
export function stripJsComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  /** 上一个有效字符 —— 用来判断 `/` 是「除号」还是「正则的开头」 */
  let lastSig = '';

  const nl = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) if (src[k] === '\n') out += '\n';
  };

  /** 跳过一个字符串（引号已经吃掉了）。`\` 一律跳过：下一个引号是转义，不是边界。 */
  const skipString = (quote) => {
    let j = i + 1;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === quote) { j += 1; break; }
      j += 1;
    }
    out += src.slice(i, j);
    i = j;
  };

  /** 跳过一个正则字面量（`/` 已经看见了）。`[ ]` 里的 `/` 不算结束。 */
  const skipRegex = () => {
    let j = i + 1;
    let inClass = false;
    while (j < n) {
      const c = src[j];
      if (c === '\\') { j += 2; continue; }
      if (c === '[') inClass = true;
      else if (c === ']') inClass = false;
      else if (c === '/' && !inClass) { j += 1; break; }
      else if (c === '\n') break; // 正则不该跨行 —— 当没识别出来，交给外层当除号
      j += 1;
    }
    while (j < n && /[dgimsuvy]/.test(src[j])) j += 1;
    out += src.slice(i, j);
    i = j;
  };

  /** 模板串：`${…}` 内部可能嵌一整段代码（里面可以有注释）。逐段跳。 */
  const skipTemplate = () => {
    out += '`';
    i += 1;
    while (i < n) {
      const c = src[i];
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
      if (c === '`') { out += '`'; i += 1; return; }
      if (c === '$' && src[i + 1] === '{') {
        out += '${';
        i += 2;
        // 递归处理插值内部：借一份子串单独走一遍 stripJsComments
        const start = i;
        let depth = 1;
        while (i < n && depth > 0) {
          if (src[i] === '{') depth += 1;
          else if (src[i] === '}') { depth -= 1; if (!depth) break; }
          i += 1;
        }
        const inner = src.slice(start, i);
        out += stripJsComments(inner).replace(/\n+$/, '');
        if (src[i] === '}') { out += '}'; i += 1; }
        continue;
      }
      out += c;
      i += 1;
    }
  };

  /** 哪些字符之后出现的 `/` 是正则的开头（不是除号）。 */
  const REGEX_OK = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^', '\n']);
  const KEYWORDS_BEFORE_REGEX = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else',
    'case', 'yield', 'await', 'throw'
  ]);

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (c === '/' && c2 === '/') {
      const end = src.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      i = stop;
      continue;
    }
    if (c === '/' && c2 === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      nl(i, stop); // 保留换行（行号要对得上）
      i = stop;
      // 整块删掉之后，把紧跟的空白也吃掉一行 —— 后面 trimEachLine 会收拾
      continue;
    }
    if (c === '"' || c === "'") {
      skipString(c);
      lastSig = 'x';
      continue;
    }
    if (c === '`') {
      skipTemplate();
      lastSig = 'x';
      continue;
    }
    if (c === '/' && (lastSig === '' || REGEX_OK.has(lastSig))) {
      skipRegex();
      lastSig = 'x';
      continue;
    }

    out += c;
    if (!/\s/.test(c)) {
      // 记下「标识符的完整拼写」：regex 判断要区分 `return /re/` 和 `a / b`
      if (/[A-Za-z0-9_$]/.test(c)) {
        let j = i;
        while (j < n && /[A-Za-z0-9_$]/.test(src[j])) j += 1;
        const word = src.slice(i, j);
        out += src.slice(i + 1, j);
        i = j;
        lastSig = KEYWORDS_BEFORE_REGEX.has(word) ? ' ' : 'x';
        continue;
      }
      lastSig = c;
    }
    i += 1;
  }
  return out;
}

/**
 * 剥掉 CSS 注释。CSS 里没有字符串里带 `/*` 的情况（本项目也没有 url() 指向的奇怪值），
 * 但仍然按字符串跳过 —— 少一处风险。
 */
export function stripCssComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') j += 1;
        j += 1;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      for (let k = i; k < stop; k += 1) if (src[k] === '\n') out += '\n';
      i = stop;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * 剥掉 HTML 注释。**条件注释 / 脚本里的字符串不管** —— 本项目没用那些。
 * 注意 `<pre>` 里的内容不动（设置页没有<pre>，但文案里可能有示例 JSON）。
 */
export function stripHtmlComments(src) {
  return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ''));
}

/**
 * 收尾：**不做任何事**（留着源码里的空行和行号）。
 *
 * 曾经想「删掉空行让包更小」，但那会让报错栈里的行号对不上仓库源码 ——
 * 万一扩展在用户那儿炸了、用户把报错贴过来，行号错位就等于没法定位。
 * 空行在 DEFLATE 之后几乎不占体积（重复的空字节压得极狠），留着不亏。
 * 函数留着是为了给「将来真要压」留个地方，配套单测盯着它现在的行为。
 */
export function tidyBlankLines(src) {
  return src;
}

/**
 * 剥完之后必须验一遍语法 —— 剥错了要当场炸，不能等装上才发现面板打不开。
 *
 * 用 `node --check` 而不是 `node:vm`：`vm.Script` 编译不了 ESM（顶层 import/export 直接报
 * 语法错，分不清是「剥坏了」还是「本来是模块」），而 `--check` 原生认 ESM。
 * 靠传文件路径调用（子进程）而不是 import，这里是打包脚本、能起子进程。
 */
export function assertStillParses(code, label, tmpPath) {
  writeFileSync(tmpPath, code);
  const r = spawnSync(process.execPath, ['--check', tmpPath], { encoding: 'utf8' });
  if (r.status !== 0) {
    const msg = String(r.stderr || r.stdout || '').trim().split('\n').slice(0, 4).join(' ');
    throw new Error(`剥注释把 ${label} 剥坏了（语法错误）：${msg}`);
  }
}
/* ---- 当脚本用 ----
   `verify-pack.py` 靠它做「幂等」检查（把包里那份再剥一次，结果必须一模一样）。
   **一批文件走一次进程** —— 一个文件起一个 node 就是 28 × 100ms，验个包比打包还慢。

   用法：
     node strip-comments.mjs - <文件名>   stdin → stdout 剥一遍
     node strip-comments.mjs --json        stdin 一个 {文件: 内容}，stdout 同形状的剥后结果 */
function stripByExt(code, name) {
  if (name.endsWith('.css')) return stripCssComments(code);
  if (name.endsWith('.html')) return stripHtmlComments(code);
  return stripJsComments(code);
}

if (process.argv[2] === '--json') {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const out = {};
  for (const [name, code] of Object.entries(input)) out[name] = stripByExt(code, name);
  process.stdout.write(JSON.stringify(out));
} else if (process.argv[2] === '-') {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const src = Buffer.concat(chunks).toString('utf8');
  process.stdout.write(stripByExt(src, process.argv[3] || ''));
}
