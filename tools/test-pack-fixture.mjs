/**
 * 同源检查的**夹具测试**（第九版判据 2）。
 *
 * 「它能抓旧包」不能只是声称 —— 必须有一个**真旧包**让检查变红，
 * 而且这条要跑在 npm test 里，不是手跑一次就算。
 *
 * 做法：
 *   1. 拿 tools/fixtures/old-pack-1.3.1.zip（**进 git 的夹具**，干净 clone 也有）当夹具
 *   2. 跑 tools/verify-pack.py 指向它
 *   3. **断言它必须非零退出**（说明检查真的在抓）
 *
 * **为什么放 tools/fixtures/ 而不是 dist/**：dist/ 被 gitignore，干净 clone 上没有，
 * 夹具就 SKIP → 那 2 项等于不存在（第十版 §1 指出）。放进 git 才是真的「随仓库走」。
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const FIXTURE = join(HERE, 'fixtures', 'old-pack-1.3.1.zip');   // 进 git，干净 clone 也有
const VERIFY = join(HERE, 'verify-pack.py');

let pass = 0;
let fail = 0;

function check(name, ok, detail) {
  if (ok) {
    pass += 1;
    console.log('  ok   ' + name + (detail ? '  ' + detail : ''));
  } else {
    fail += 1;
    console.log('  FAIL ' + name + (detail ? '  ' + detail : ''));
  }
}

if (!existsSync(FIXTURE)) {
  console.log('  SKIP 没找到 tools/fixtures/old-pack-1.3.1.zip，跳过同源夹具测试');
  console.log('       （clone 里通常不带 dist/，CI 上可用 tools/pack.py 生成旧版本）');
} else {
  let out = '';
  let code = 0;
  try {
    out = execFileSync(process.env.PYTHON || 'python', [VERIFY, FIXTURE], {
      cwd: ROOT, encoding: 'utf8'
    });
  } catch (e) {
    code = e.status || 1;
    out = String(e.stdout || '') + String(e.stderr || '');
  }

  check('拿 1.3.1 旧包跑同源检查，必须非零退出（证明它真能抓旧包）', code !== 0,
    'exit=' + code);
  check('报错里点名「与 git HEAD 源码重跑变换不同」（或文件差异）',
    /重跑变换.{0,4}的结果不同|与等价形式哈希不同|文件列表不该差/.test(out),
    (out.split('\n').filter((x) => x.indexOf('✗') >= 0)[0] || '(没有 ✗ 行)').trim().slice(0, 120));
}

try {
  const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
  const p = new URL('../.test-counts.json', import.meta.url);
  let d = {};
  try { d = JSON.parse(rf(p, 'utf8')); } catch { /* 首次 */ }
  d['pack-fixture'] = pass;
  wf(p, JSON.stringify(d));
} catch { /* 汇总失败不影响结论 */ }

console.log('\n通过 ' + pass + ' 项，失败 ' + fail + ' 项');
process.exit(fail === 0 ? 0 : 1);
