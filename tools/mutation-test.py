#!/usr/bin/env python3
"""变异测试：往代码里逐个塞 bug，看断言能不能抓住。

每个变异：改一个文件一处 → 跑对应测试 → 记录是否报红 → `git checkout --` 还原。
不改变任何提交内容；工作区必须干净（脚本会先检查）。
"""
import subprocess
import sys
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent


def sh(cmd, cwd=ROOT):
    r = subprocess.run(cmd, cwd=str(cwd), capture_output=True, text=True,
                       encoding="utf-8", errors="replace", shell=isinstance(cmd, str))
    return r.returncode, (r.stdout or "") + (r.stderr or "")


MUTS = [
    # (说明, 文件, 原文, 改成, 测试命令)
    ("i18n：下载包不再优先（英文界面回中文）", "lib/i18n.js",
     '    if (pack && pack.strings && typeof pack.strings[key] === "string") {',
     '    if (false) {', ["node", "tools/test-lib.mjs"]),

    ("i18n：onlyMissing 不再打标（第二次覆盖已填节点）", "lib/i18n.js",
     "        el.dataset.i18nHtmlDone = \"1\";",
     "        // mutated", ["node", "tools/test-lib.mjs"]),

    ("i18n：html 通道不再过滤只补未填", "lib/i18n.js",
     "      if (onlyMissing && el.dataset.i18nHtmlDone) continue;",
     "      if (false) continue;", ["node", "tools/test-lib.mjs"]),

    ("engine：错误不再带 code（全部回落中文）", "lib/engine.js",
     "    result.errorCode = code;",
     "    result.errorCode = '';", ["node", "tools/test-engine.mjs"]),

    ("engine：problems 不再逐条取 text", "lib/engine.js",
     "    result.error = problems.map((p) => p.text).join('；');",
     "    result.error = problems.join('；');", ["node", "tools/test-engine.mjs"]),

    ("engine：取消不再设 code", "lib/engine.js",
     "      setErr('err_cancelled', '已取消');",
     "      result.error = '已取消';", ["node", "tools/test-lib.mjs"]),

    ("parser：同一条参数不再去重（会刷屏）", "lib/request-parser.js",
     "    if (!result.warnings.some((w) => w && w.text === item.text)) result.warnings.push(item);",
     "    result.warnings.push(item);", ["node", "tools/test-lib.mjs"]),

    ("parser：GET 带 body 不再报问题", "lib/request-parser.js",
     "  if (req.body !== null && req.method === 'GET') problems.push({ code: 'parse_get_body', text: 'GET 请求带了 body，浏览器会丢掉它' });",
     "  if (false) problems.push({ code: 'parse_get_body', text: 'GET 请求带了 body，浏览器会丢掉它' });",
     ["node", "tools/test-lib.mjs"]),

    ("parser：@文件 不再给提示", "lib/request-parser.js",
     "            if (String(value).startsWith('@')) note(NOTE_AT_FILE);\n            if (name === '--data-urlencode') note(NOTE_URLENCODE);",
     "            if (name === '--data-urlencode') note(NOTE_URLENCODE);", ["node", "tools/test-lib.mjs"]),

    ("模板：荷兰语映射删掉（挑得到却映射不出）", "lib/template.js",
     "  '荷兰语': 'NL', 'dutch': 'NL',",
     "  'dutch': 'NL',", ["node", "tools/test-lib.mjs"]),

    ("i18n：参数取值 off-by-one（$1$ 取错位）", "lib/i18n-msg.js",
     "const v = params[Number(n) - 1];",
     "const v = params[Number(n)];", ["node", "tools/test-lib.mjs"]),

    ("面板：重试按钮用错 key", "lib/panel-core.js",
     "panel_retry",
     "panel_retry_xx", ["node", "tools/test-lib.mjs"]),

    ("面板：槽位 class 改名（DOM 引用失效）", "lib/panel-core.js",
     "rt-slot-h",
     "rt-slot-head", ["node", "tools/test-lib.mjs"]),

    ("后台：runCtrls 改回用解析后的 config.id", "background.js",
     "        runCtrls.set(wantId, ctrl);",
     "        runCtrls.set(config.id, ctrl);", ["node", "tools/test-lib.mjs"]),

    ("后台：回包不再带 wantId", "background.js",
     "        safePost({ type: 'done', configId: wantId,",
     "        safePost({ type: 'done', configId: config.id,", ["node", "tools/test-lib.mjs"]),

    ("后台：localizeResult 不再翻译 warnings", "background.js",
     "    r.warnings = await Promise.all((r.warnings || []).map((w) =>",
     "    r.warnings = (r.warnings || []).map((w) => (w", ["node", "tools/test-lib.mjs"]),

    ("内容脚本：诊断行的 key 拼错", "content.js",
     "T('diag_err', '错误')",
     "T('diag_error_xx', '错误')", ["node", "tools/test-lib.mjs"]),

    ("打包目录混进 docs（体积/白名单）", "tools/pack.py",
     'DIRS = ["lib", "_locales", "icons"]',
     'DIRS = ["lib", "_locales", "icons", "docs"]', ["node", "tools/test-lib.mjs"]),

    ("验包：同源检查整段跳过", "tools/verify-pack.py",
     "        # a) 从 git HEAD 取每个 .js",
     "        return\n        # a) 从 git HEAD 取每个 .js", ["node", "tools/test-pack-fixture.mjs"]),

    ("验包：.json/.md 不再参与同源比对", "tools/verify-pack.py",
     '        raw_names = [n for n in names if n.endswith((".json", ".md")) and n != "manifest.json"]',
     "        raw_names = []", ["node", "tools/test-lib.mjs"]),
]


def main():
    code, out = sh(["git", "status", "--porcelain"])
    if out.strip():
        sys.exit("工作区不干净，先提交再跑变异测试")

    caught = 0
    rows = []
    for i, (desc, path, old, new, cmd) in enumerate(MUTS, 1):
        p = ROOT / path
        src = p.read_text(encoding="utf-8")
        if old not in src:
            rows.append((i, desc, "MISS", "原文没找到，跳过"))
            continue
        try:
            p.write_text(src.replace(old, new, 1), encoding="utf-8", newline="\n")
            rc, output = sh(cmd)
            fails = [l.strip() for l in output.splitlines() if "FAIL" in l]
            ok = rc != 0 or bool(fails)
            if ok:
                caught += 1
            detail = (fails[0][:64] if fails else f"exit {rc}")
            rows.append((i, desc, "抓住" if ok else "漏掉", detail))
        finally:
            sh(["git", "checkout", "--", path])

    print(f"\n{'#':>2} {'变异':<44} {'结果':<6} 证据")
    print("-" * 96)
    for i, desc, res, detail in rows:
        print(f"{i:>2} {desc:<44} {res:<6} {detail}")
    print("-" * 96)
    print(f"抓住 {caught} / {len([r for r in rows if r[2] != 'MISS'])}")


if __name__ == "__main__":
    main()
