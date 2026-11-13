// 打包第二步：用 esbuild 压 JS（第一步是 minify-sources.mjs 剥注释）。
//
// 用法：node tools/esbuild-minify.mjs <目录>
//   —— 就地压 <目录> 里的 .js（不碰 CSS/HTML，那些剥注释就够了）
//   —— 压完每个文件再跑一次语法检查，压坏了当场非零退出
//   —— 最后输出一行 JSON：{ skipped, before, after, files }
//
// **为什么排除 lib/panel-core.js**：它里面有约 20 KB 内嵌 CSS 字符串。
// deflate 吃 CSS 里 .rt-slot / var(--rt- / margin-top: 这些高重复模式吃得很好，
// 而 esbuild 把 JS 变量名压成 t/n/r/e 之后反而破坏了那个模式 —— 实测
// 5254 → 8751 字节，**反向膨胀 67%**（terser 也一样，-63%）。
//
// 依赖是可选的：装了就压，没装就跳过（pack.py 会提示一句）。

import { readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, execSync } from 'node:child_process';
import { assertStillParses } from './strip-comments.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 压了反而更大的那个，见文件头 */
const SKIP = new Set(['lib/panel-core.js']);

const dir = process.argv[2];
if (!dir) {
  console.error('用法：node tools/esbuild-minify.mjs <目录>');
  process.exit(2);
}
const OUT = resolve(ROOT, dir);

/** 递归找 .js */
function walk(d, acc = []) {
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (name.endsWith('.js')) acc.push(p);
  }
  return acc;
}

/** 找 esbuild：只认项目内装的那份（避免用 npx 每次联网解析） */
function findEsbuild() {
  const bin = process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild';
  const local = join(ROOT, 'node_modules', '.bin', bin);
  try {
    statSync(local);
    return local;
  } catch {
    return null;
  }
}

const exe = findEsbuild();
if (!exe) {
  console.log(JSON.stringify({ skipped: true, reason: 'esbuild 没装' }));
  process.exit(0);
}

const result = {};
let before = 0;
let after = 0;

for (const abs of walk(OUT)) {
  const rel = relative(OUT, abs).split(dirname('/')).join('/').split('\\').join('/');
  if (SKIP.has(rel)) continue;

  const src = readFileSync(abs, 'utf8');
  /* Windows 上 .cmd 不能用 stdin 管道（EINVAL），所以走临时文件进出。 */
  const tmpIn = join(OUT, '.esbuild-in.js');
  const tmpOut = join(OUT, '.esbuild-out.js');
  writeFileSync(tmpIn, src);
  let min;
  try {
    /* Windows 上 .cmd 必须过 shell；execFileSync 直接调会 EINVAL。 */
    execSync('"' + exe + '" "' + tmpIn + '" --minify --target=chrome100 --outfile="' + tmpOut + '"', {
      stdio: 'pipe',
      maxBuffer: 32 * 1024 * 1024,
    });
    min = readFileSync(tmpOut, 'utf8');
  } catch (err) {
    console.error('esbuild 压 ' + rel + ' 失败：' + (err.stderr ? err.stderr.toString() : err.message));
    process.exit(1);
  } finally {
    try { rmSync(tmpIn, { force: true }); } catch {}
    try { rmSync(tmpOut, { force: true }); } catch {}
  }

  /* 压完必须还能过语法检查 —— 装到浏览器里才发现打不开就晚了 */
  const checkPath = join(OUT, '.esbuild-check.js');
  try {
    assertStillParses(min, rel, checkPath);
  } finally {
    try { rmSync(checkPath, { force: true }); } catch {}
  }
  writeFileSync(abs, min, 'utf8');
  result[rel] = { before: Buffer.byteLength(src), after: Buffer.byteLength(min) };
  before += result[rel].before;
  after += result[rel].after;
}

console.log(JSON.stringify({ skipped: false, before, after, files: result }));
