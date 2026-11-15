/** 测试计数的一处真相源。
 *  各脚本把通过数写进 .test-counts.json，并附「写数字时的 HEAD / 工作区是否干净」。
 *  test-summary 复核：若汇总时的 HEAD 与写数字时不同 -> STALE，数字不能算数。
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
    /* `_summary` 存在 = 上一轮已经收尾；这是新一轮，基准要重置。
       否则一次 STALE 会永久 STALE（head 永远停在旧值），数字再也没法转绿。 */
    const newRound = !!d['_summary'];
    if (newRound) {
      delete d['_summary'];
      delete d['_stale'];
      delete d['_meta'];
    }
    const meta = d['_meta'] || {};
    /* 第一次写数的 HEAD 作为本次运行的基准；后续脚本若在不同 HEAD 上写就标 STALE。 */
    if (!meta.head) meta.head = head;
    meta.dirty = meta.dirty || dirty;
    meta.time = new Date().toISOString();
    d['_meta'] = meta;
    if (meta.head !== head) d['_stale'] = true;
    if (extra) Object.assign(d, extra);
    writeFileSync(FILE, JSON.stringify(d, null, 2) + '\n');
  } catch { /* 计数失败不影响测试结论 */ }
}
