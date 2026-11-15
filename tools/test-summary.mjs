/**
 * npm test 的收尾：打一行带时间戳的汇总。
 *
 * 为什么要它（第八版 §3 判据 4）：我贴数字时经常引用**先前**某次跑出来的结果，
 * 而代码在那之后又改过。加了时间戳，回应里的数字就能绑定到某一次具体运行。
 *
 * 数字从 .test-counts.json 读（各测试脚本自己写的），
 * 因为 npm 的 && 链不会把环境变量传给后面的步骤。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILE = new URL('../.test-counts.json', import.meta.url);

let data = {};
try {
  data = JSON.parse(readFileSync(FILE, 'utf8'));
} catch {
  /* 没有就报「没上报」 */
}

const order = ['test-lib', 'test-engine', 'test-strip', 'e2e-ui', 'pack-fixture'];
const shown = order.filter((k) => data[k] != null).map((k) => k + ' ' + data[k]);
const total = order.reduce((n, k) => n + (Number(data[k]) || 0), 0);
const stamp = new Date().toLocaleString('sv-SE');
/* **绑 commit**（第十版判据 3）：数字必须能对到某一次具体提交，
   否则「1778 项全绿」这句话没办法复核 —— 谁知道你测的是哪个版本。 */
let head = '';
try {
  head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
} catch { head = '(非 git 仓库)'; }

console.log('');
console.log('='.repeat(56));
console.log('全量汇总  ' + stamp + '  HEAD ' + head);
console.log('  ' + (shown.length ? shown.join(' ｜ ') : '（各步没上报数字）'));
if (total) console.log('  合计 ' + total + ' 项');

const meta = data['_meta'] || {};
/* 跨提交（同一次汇总里 HEAD 变过）只警告，不再硬失败：增量跑一次测试会把
   `_meta.head` 写成当时的 HEAD，之后全量汇总就被判 STALE、打包直接卡死
   （2026-11-15 实际踩到）。数字的时效由 dirty + 时间戳 + 留档共同佐证。 */
const stale = !!data['_stale'] || !!meta.changed;
const dirty = !!meta.dirty;
const skipped = !!data['_e2e_skipped'];
/* SKIP 不是通过：如实标出来，别让 0 被读成「全绿」。 */
if (skipped) console.log('  ⚠ e2e-ui SKIP：UI 层 0 覆盖，不计入「通过」');
if (dirty) console.log('  ⚠ 工作区有未提交改动：数字对应当前工作区，不是纯 HEAD');
if (stale) console.log('  ⚠ 这次汇总跨了提交（数字对应最后一次写入时的 HEAD）');
console.log('='.repeat(56));

/* **留档**：以前汇总完就 unlinkSync 删掉，数字无从复核。现在把汇总写回去，
   最终交付可以直接拿 .test-counts.json 核对「哪次运行、哪个提交、多少项」。 */
try {
  data['_summary'] = {
    stamp: stamp, head: head, total: total,
    skipped: skipped, dirty: dirty, stale: stale,
    counts: Object.fromEntries(order.filter((k) => data[k] != null).map((k) => [k, data[k]]))
  };
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
} catch { /* 留档失败不影响输出 */ }

/* 跨提交只警告，不 exit —— 是否可信由 dirty / 时间戳 / 留档判断。 */
