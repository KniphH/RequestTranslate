/**
 * npm test 的收尾：打一行带时间戳的汇总。
 *
 * 为什么要它（第八版 §3 判据 4）：我贴数字时经常引用**先前**某次跑出来的结果，
 * 而代码在那之后又改过。加了时间戳，回应里的数字就能绑定到某一次具体运行。
 *
 * 数字从 .test-counts.json 读（各测试脚本自己写的），
 * 因为 npm 的 && 链不会把环境变量传给后面的步骤。
 */
import { readFileSync, existsSync, unlinkSync } from 'node:fs';

const FILE = new URL('../.test-counts.json', import.meta.url);

let data = {};
try {
  data = JSON.parse(readFileSync(FILE, 'utf8'));
} catch {
  /* 没有就报「没上报」 */
}

const order = ['静态', 'test-lib', 'test-engine', 'test-strip', 'e2e-ui'];
const shown = order.filter((k) => data[k] != null).map((k) => k + ' ' + data[k]);
const total = order.reduce((n, k) => n + (Number(data[k]) || 0), 0);
const stamp = new Date().toLocaleString('sv-SE');

console.log('');
console.log('='.repeat(56));
console.log('全量汇总  ' + stamp);
console.log('  ' + (shown.length ? shown.join(' ｜ ') : '（各步没上报数字）'));
if (total) console.log('  合计 ' + total + ' 项');
console.log('='.repeat(56));

if (existsSync(FILE)) {
  try { unlinkSync(FILE); } catch { /* 删不掉无所谓 */ }
}
