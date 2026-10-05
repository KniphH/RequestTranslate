/**
 * 静态检查：页面脚本引用的 DOM 元素是否真实存在。
 *
 * options.js 里写 $('#f-name')、popup.js 里写 $('#txt')，
 * 如果 HTML 里没有对应元素，启动时就会炸在 null 上。
 *
 *   node tools/check-dom.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PAIRS = [
  { js: 'options.js', html: 'options.html' },
  { js: 'popup.js', html: 'popup.html' }
];

let problems = 0;

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

/**
 * HTML 里写死的 class。
 *
 * 注意是 `class="..."`（属性），不是 `className` —— 后者是 JS 赋的。
 */
function collectHtmlClasses(htmlSrc) {
  const out = new Set();
  for (const m of htmlSrc.matchAll(/\bclass="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) out.add(c);
  }
  return out;
}

/**
 * JS 里拼出来的 class。
 *
 * 页面脚本经常动态建节点（`row.className = 'cfg-row'`、
 * `'<div class="rt-trigger">'`、`classList.add('dragging')`），
 * 这些类名在 HTML 里找不到，但用得完全正确 —— 只查 HTML 会误报一片。
 * 反过来也成立：这里收进来的名字和 querySelector 里写的对得上，才算真的对得上。
 */
function collectJsClasses(src) {
  const out = new Set();
  const add = (raw) => {
    for (const c of String(raw).split(/\s+/)) {
      if (/^[A-Za-z][\w-]*$/.test(c)) out.add(c);
    }
  };
  // 注意 `[^"']*` 而不是 `[^"]*`：拼字符串时经常是 `class="trig-card' + ...`，
  // 属性值根本没闭合，只认双引号会一路吃到下一个引号，把整段当成类名。
  for (const m of src.matchAll(/\bclass="([^"']*)/g)) add(m[1]);
  for (const m of src.matchAll(/\bclass='([^"']*)/g)) add(m[1]);
  for (const m of src.matchAll(/\bclassName\s*=\s*'([^']*)'/g)) add(m[1]);
  for (const m of src.matchAll(/\bclassName\s*=\s*"([^"]*)"/g)) add(m[1]);
  for (const m of src.matchAll(/\.classList\.(?:add|remove|toggle)\(\s*'([^']*)'/g)) add(m[1]);
  return out;
}

/**
 * 取源码里所有「按类名找元素」的写法。
 *
 * `querySelector(?:All)?` —— 别写成 `querySelectorAll?`，那个 `?` 只管最后一个 `l`，
 * 结果所有 `querySelector('.x')` 一个都扫不到（这个坑真踩过）。
 */
function usedClassSelectors(src) {
  const out = [];
  for (const m of src.matchAll(/querySelector(?:All)?\('\.([A-Za-z0-9_-]+)'\)/g)) out.push(m[1]);
  for (const m of src.matchAll(/\.closest\('\.([A-Za-z0-9_-]+)'\)/g)) out.push(m[1]);
  return [...new Set(out)];
}

for (const { js, html } of PAIRS) {
  if (!fs.existsSync(path.join(ROOT, js)) || !fs.existsSync(path.join(ROOT, html))) {
    console.log(`  SKIP ${js} / ${html}（文件不存在）`);
    continue;
  }

  const jsSrc = read(js);
  const htmlSrc = read(html);

  // HTML 里定义的所有 id
  const ids = new Set([...htmlSrc.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  // 写死的 + 脚本拼出来的，都算「有定义」
  const classes = collectHtmlClasses(htmlSrc);
  for (const c of collectJsClasses(jsSrc)) classes.add(c);

  const issues = [];

  // $('#xxx')
  const usedIds = [...new Set([...jsSrc.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
  for (const id of usedIds) {
    if (!ids.has(id)) issues.push(`$('#${id}') —— HTML 里没有 id="${id}"`);
  }

  // document.getElementById('xxx')
  for (const m of jsSrc.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) {
    if (!ids.has(m[1])) issues.push(`getElementById('${m[1]}') —— HTML 里没有这个 id`);
  }

  // querySelector('.xxx') / querySelectorAll('.xxx') / closest('.xxx')
  for (const cls of usedClassSelectors(jsSrc)) {
    if (!classes.has(cls)) issues.push(`'.${cls}' —— HTML 里没有、脚本里也没拼出这个类`);
  }

  if (issues.length === 0) {
    console.log(`  ok   ${js}：${usedIds.length} 个 id、${usedClassSelectors(jsSrc).length} 个类选择器都对得上 ${html}`);
  } else {
    problems += issues.length;
    console.log(`  FAIL ${js} 对 ${html}：`);
    for (const s of issues) console.log(`         ${s}`);
  }
}

// content.js 的面板是拼在字符串里的，单独看一遍类名有没有用在 querySelector 上
{
  const src = read('content.js');
  const defined = new Set();
  for (const m of src.matchAll(/class="([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) defined.add(c);
  }
  for (const m of src.matchAll(/className\s*=\s*'rt-[^']*'/g)) {
    for (const c of m[0].match(/rt-[\w-]+/g) || []) defined.add(c);
  }

  const issues = [];
  for (const m of src.matchAll(/querySelector(?:All)?\('\.([A-Za-z0-9_-]+)'\)/g)) {
    if (!defined.has(m[1])) issues.push(`.${m[1]}`);
  }

  if (issues.length === 0) {
    console.log(`  ok   content.js：面板里的类选择器都能找到对应定义`);
  } else {
    problems += issues.length;
    console.log(`  FAIL content.js：这些类没有定义 -> ${issues.join(', ')}`);
  }
}

console.log('');
if (problems === 0) {
  console.log('DOM 引用检查通过。');
  process.exit(0);
} else {
  console.log(`发现 ${problems} 处 DOM 引用问题。`);
  process.exit(1);
}
