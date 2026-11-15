/** 测试计数的一处真相源。
 *  各脚本把通过数写进 .test-counts.json，并附「写数字时的 HEAD / 工作区是否干净」。
 *  test-summary 复核：跨提交（同一次汇总里 HEAD 变过）只警告；数字的时效由
 *  dirty + 时间戳 + 留档共同佐证。
 *  留档（不再删），最终交付要能拿这个文件复核「哪次运行、哪个提交、多少项」。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILE = new URL('../.test-counts.json', import.meta.url);

function git(args) {
  try { return execFileSync('git', args, { encoding: 'utf8' }).trim(); } catch { return ''; }
}

export function writeCount(name, passed, extra) {
  try {
    let d = {};
    try { d = JSON.parse(readFileSync(FILE, 'utf8')); } catch { /* 首次 */ }
    const head = git(['rev-parse', '--short', 'HEAD']);
    const dirty = git(['status', '--short']).length > 0;
    d[name] = passed;
    /* `_summary` 存在 = 上一轮已经收尾；这是新一轮，快照要清掉。 */
    if (d['_summary']) {
      delete d['_summary'];
      delete d['_stale'];
    }
    const meta = d['_meta'] || {};
    /* **以最后一次写入为准**：增量跑单个脚本也会写这里，若只在第一次记基准，
       之后 HEAD 变了就永久 STALE（实测把打包卡住）。跨提交只记 changed 作警告。 */
    const prev = meta.head || "";
    meta.head = head;
    if (prev && prev !== head) meta.changed = true;
    meta.dirty = dirty;
    meta.time = new Date().toISOString();
    d['_meta'] = meta;
    if (extra) Object.assign(d, extra);
    writeFileSync(FILE, JSON.stringify(d, null, 2) + '\n');
  } catch { /* 计数失败不影响测试结论 */ }
}
