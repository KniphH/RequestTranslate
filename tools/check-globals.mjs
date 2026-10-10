/**
 * 静态检查：找出「调用了但没定义」的函数。
 *
 * node --check 只查语法，抓不到 bindConfigList() 这种运行时才会炸的问题。
 * 这个脚本把注释、字符串、正则字面量剥掉，再逐个比对标识符调用与文件内声明。
 *
 *   node tools/check-globals.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULT_TARGETS = [
  'content.js',
  'background.js',
  'offscreen.js',
  'popup.js',
  'options.js',
  'lib/request-parser.js',
  'lib/template.js',
  'lib/extract.js',
  'lib/store.js',
  'lib/engine.js',
  'lib/adapters.js',
  'lib/trigger-styles.js',
  'lib/clipboard.js',
  'lib/ocr.js'
];

// 也可以指定文件：node tools/check-globals.mjs a.js b/c.js
const cliArgs = process.argv.slice(2);
const TARGETS = cliArgs.length ? cliArgs : DEFAULT_TARGETS;

/** 浏览器 / Node 自带的全局，不算「没定义」 */
const GLOBALS = new Set([
  'document', 'window', 'console', 'navigator', 'location', 'history', 'screen',
  'localStorage', 'sessionStorage', 'getComputedStyle', 'matchMedia',
  'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Promise', 'Symbol', 'BigInt',
  'Set', 'Map', 'WeakSet', 'WeakMap', 'Math', 'Date', 'Error', 'TypeError', 'RangeError',
  'SyntaxError', 'RegExp', 'ArrayBuffer', 'Uint8Array', 'Int8Array', 'DataView',
  'TextDecoder', 'TextEncoder', 'URL', 'URLSearchParams', 'Blob', 'File', 'FileReader',
  'FormData', 'Headers', 'Request', 'Response', 'AbortController', 'AbortSignal',
  'fetch', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask', 'structuredClone',
  'alert', 'confirm', 'prompt',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'btoa', 'atob',
  'chrome', 'browser', 'globalThis', 'require', 'process', 'Buffer', '__dirname', '__filename',
  'CustomEvent', 'Event', 'EventTarget', 'MutationObserver', 'IntersectionObserver',
  'ResizeObserver', 'HTMLElement', 'Element', 'Node', 'Image', 'Audio', 'DOMRect',
  'module', 'exports'
]);

/** 关键字，别当成函数调用 */
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'delete', 'void',
  'in', 'of', 'do', 'else', 'case', 'throw', 'await', 'yield', 'function', 'class',
  'try', 'finally', 'instanceof', 'with', 'super', 'this', 'import', 'export',
  'default', 'const', 'let', 'var', 'extends', 'static', 'get', 'set', 'async'
]);

/** 正则字面量前面允许出现的字符 */
const REGEX_PRECEDERS = '=:([,!&|?{};+-*%~^<>';

/**
 * 跳过一段正则字面量，返回结束位置（不含 flags）。
 */
function skipRegex(src, start) {
  let j = start + 1; // src[start] === '/'
  let inClass = false;

  while (j < src.length) {
    const c = src[j];
    if (c === '\\') { j += 2; continue; }
    if (c === '\n') break; // 正则不跨行
    if (c === '[') { inClass = true; j += 1; continue; }
    if (c === ']') { inClass = false; j += 1; continue; }
    if (c === '/' && !inClass) { j += 1; break; }
    j += 1;
  }
  while (j < src.length && /[dgimsuvy]/.test(src[j])) j += 1;
  return j;
}

/**
 * 剥掉注释、字符串内容、正则字面量。
 * 换行一律保留，保证剥离后的行号和原文件一致。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  let state = 'code';
  let lastSig = '';

  const pushNewlines = (from, to) => {
    for (let k = from; k < to && k < n; k += 1) {
      if (src[k] === '\n') out += '\n';
    }
  };

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];

    if (state === 'code') {
      if (c === '/' && c2 === '/') {
        const end = src.indexOf('\n', i);
        const stop = end === -1 ? n : end;
        pushNewlines(i, stop);
        i = stop;
        continue;
      }
      if (c === '/' && c2 === '*') {
        const end = src.indexOf('*/', i + 2);
        const stop = end === -1 ? n : end + 2;
        pushNewlines(i, stop);
        i = stop;
        continue;
      }
      // 正则字面量 vs 除号
      if (c === '/' && (lastSig === '' || REGEX_PRECEDERS.includes(lastSig))) {
        const stop = skipRegex(src, i);
        pushNewlines(i, stop);
        out += ' ';
        i = stop;
        lastSig = '/';
        continue;
      }
      if (c === "'") { state = 'sq'; out += c; i += 1; continue; }
      if (c === '"') { state = 'dq'; out += c; i += 1; continue; }
      if (c === '`') { state = 'tpl'; out += c; i += 1; continue; }

      out += c;
      if (!/\s/.test(c)) lastSig = c;
      i += 1;
      continue;
    }

    // 字符串内部：内容丢掉，但换行留着
    if (c === '\\') {
      if (c2 === '\n') out += '\n';
      i += 2;
      continue;
    }
    if (c === '\n') { out += '\n'; i += 1; continue; }

    if (state === 'sq' && c === "'") { state = 'code'; out += "'"; lastSig = "'"; i += 1; continue; }
    if (state === 'dq' && c === '"') { state = 'code'; out += '"'; lastSig = '"'; i += 1; continue; }
    if (state === 'tpl' && c === '`') { state = 'code'; out += '`'; lastSig = '`'; i += 1; continue; }

    i += 1;
  }

  return out;
}

function collectDeclared(src) {
  const names = new Set();

  const addList = (raw) => {
    for (const part of String(raw).split(',')) {
      const p = part.trim();
      if (!p) continue;
      if (p.includes(':')) {
        const right = p.split(':').pop().trim();
        if (/^[A-Za-z_$][\w$]*$/.test(right)) names.add(right);
        continue;
      }
      if (/^[A-Za-z_$][\w$]*$/.test(p)) names.add(p);
    }
  };

  for (const m of src.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) addList(m[1]);
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\[([^\]]*)\]/g)) addList(m[1]);

  for (const m of src.matchAll(/\bimport\s*\{([^}]*)\}\s*from/g)) {
    for (const part of m[1].split(',')) {
      const p = part.trim();
      if (!p) continue;
      const as = p.split(/\s+as\s+/);
      const name = (as[1] || as[0]).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  for (const m of src.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1]);

  // 函数参数 / 回调参数（保守：括号里所有裸标识符都算有定义）
  for (const m of src.matchAll(/\(([^()]*)\)/g)) {
    const inner = m[1].trim();
    if (!inner) continue;
    for (const part of inner.split(',')) {
      const t = part.trim().replace(/^\.\.\./, '').replace(/\s*=.*$/, '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(t)) names.add(t);
    }
  }

  /* 解构出来的**对象参数**：`function f({ a, b }) { … }`。
     上面那条正则只吃「括号里没有花括号」的情况，`{ a, b }` 会整块留下来，
     拆开后每片都带着花括号 → 一个都认不出来，里面的 a / b 反倒被报成「没定义」。
     用法见 moveButton({ … onMove }) / sortableRow({ … }) —— 两个列表共用的那一套。 */
  for (const m of src.matchAll(/\(\s*\{([^}]*)\}/g)) addList(m[1]);

  return names;
}

/** 是不是对象/类里的方法简写定义：`foo(a) {`，且前面是 { 或 , */
function isMethodShorthand(src, match) {
  // match[0] 只到左括号，得自己配对到右括号
  let depth = 1;
  let j = match.index + match[0].length;
  while (j < src.length && depth > 0) {
    const c = src[j];
    if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    j += 1;
  }
  if (depth !== 0) return false;

  if (!/^\s*\{/.test(src.slice(j))) return false;

  const prev = src.slice(0, match.index).replace(/\s+$/, '').slice(-1);
  return prev === '{' || prev === ',';
}

let problems = 0;
let checked = 0;

for (const rel of TARGETS) {
  const full = path.isAbsolute(rel) ? rel : path.join(ROOT, rel);
  const label = path.isAbsolute(rel) ? path.relative(ROOT, rel) || rel : rel;
  if (!fs.existsSync(full)) {
    console.log(`  SKIP ${label}（不存在）`);
    continue;
  }

  const raw = fs.readFileSync(full, 'utf8');
  const src = stripComments(raw);
  const declared = collectDeclared(src);

  const missing = new Map();

  for (const m of src.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g)) {
    const name = m[1];
    if (KEYWORDS.has(name) || GLOBALS.has(name) || declared.has(name)) continue;
    if (isMethodShorthand(src, m)) continue;
    if (!missing.has(name)) {
      missing.set(name, src.slice(0, m.index).split('\n').length);
    }
  }

  checked += 1;
  if (missing.size === 0) {
    console.log(`  ok   ${label}`);
  } else {
    problems += missing.size;
    console.log(`  FAIL ${label}`);
    for (const [name, line] of missing) {
      console.log(`         第 ${line} 行：${name}() 没有定义`);
    }
  }
}

console.log('');
if (problems === 0) {
  console.log(`检查了 ${checked} 个文件，没有发现未定义的函数调用。`);
  process.exit(0);
} else {
  console.log(`检查了 ${checked} 个文件，发现 ${problems} 处可疑调用。`);
  process.exit(1);
}
