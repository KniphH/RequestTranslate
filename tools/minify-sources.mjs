// 打包前把源码剥成「无注释版」，给 pack.py 用。
//
// 为什么单独一个进程：剥注释是词法活（字符串/正则/模板串里都有 // 和 /*），
// `tools/strip-comments.mjs` 已经写好了，还配了自测（tools/test-strip.mjs）。
// 在 Python 里重写一遍等于两份实现两份 bug。
//
// 用法：node tools/minify-sources.mjs <输出目录>
//   —— 读仓库里的 .js/.css/.html，剥掉注释，写到 <输出目录>/<原相对路径>
//   —— 同时对每个 .js 跑一次 `node --check`，剥坏了当场退出非零
//   —— 最后一行输出 JSON：{"<相对路径>": <剥后字节数>, ...}

import { mkdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { stripJsComments, stripCssComments, stripHtmlComments, assertStillParses } from './strip-comments.mjs';

/* `import.meta.url` 是**百分号编码**的（中文目录会变成 %E7%BF%BB…），
   直接 pathname 会拿到一个不存在的路径 —— 必须 fileURLToPath 解码。 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 包里要剥的文件 = 运行时文件（与 pack.py 的 ROOT_FILES / DIRS 同一批，它传进来） */
function stripOne(name, code) {
  if (name.endsWith('.js')) return stripJsComments(code);
  if (name.endsWith('.css')) return stripCssComments(code);
  if (name.endsWith('.html')) return stripHtmlComments(code);
  return code;
}

const outDir = process.argv[2];
if (!outDir) {
  console.error('用法：node tools/minify-sources.mjs <输出目录> <文件…>');
  process.exit(2);
}
const names = process.argv.slice(3);
if (!names.length) {
  console.error('没给文件列表');
  process.exit(2);
}

const tmp = mkdtempSync(join(tmpdir(), 'rt-strip-'));
const sizes = {};
let before = 0;
let after = 0;

for (const name of names) {
  const src = readFileSync(join(ROOT, name), 'utf8');
  const out = stripOne(name, src);
  // 剥坏了吗？当场炸 —— 装上才发现面板打不开就晚了
  if (name.endsWith('.js')) {
    assertStillParses(out, name, join(tmp, name.replace(/[\\/]/g, '__')));
  }
  const dest = join(outDir, name);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, out, 'utf8');
  sizes[name] = Buffer.byteLength(out, 'utf8');
  before += Buffer.byteLength(src, 'utf8');
  after += sizes[name];
}

console.error(
  `剥注释：${before.toLocaleString()} → ${after.toLocaleString()} 字节` +
    `（省下 ${((1 - after / before) * 100).toFixed(1)}%，压缩前）`
);
console.log(JSON.stringify(sizes));