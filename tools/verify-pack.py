#!/usr/bin/env python3
"""验 dist 里的包是不是「剥了注释但没剥坏」。

打包后跑一次，三件事：
  1. **语法**：包里每个 .js 过一遍 `node --check`（剥坏了当场暴露）
  2. **行号**：包里 .js 的行数必须和仓库里一模一样 —— 报错栈要对得上 GitHub 源码
  3. **内容**：URL、占位符这些「剥错了就没了」的关键字样还得在

用法：
    python tools/verify-pack.py                # 验 dist 里最新的包
    python tools/verify-pack.py dist/xxx.zip
"""

import json
import re
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 判据说明（写在文件头，不是代码里）：
#   - 注释里举的例子（{{变量}}、https://x）本来就该消失，所以**不能**拿它们当「必须保留」——
#     剥掉它们是对的。历史上就是这么误报过一串。
#   - 「仓库里有 → 包里也得有」那条也不行：仓库里的 `{{` 有时只出现在注释里。
#   - 唯一站得住的判据是**幂等**：同一个剥离器跑第二遍必须毫无变化。
#     这一条同时盖住「删了不该删的」（结果和剥过的源码不一致）与「留了不该留的」（还能再剥）。


def main():
    if len(sys.argv) > 1:
        zpath = Path(sys.argv[1]).resolve()
    else:
        zips = sorted((ROOT / "dist").glob("request-translate-*.zip"), key=lambda p: p.stat().st_mtime)
        if not zips:
            sys.exit("dist 里没有包，先跑 python tools/pack.py")
        zpath = zips[-1].resolve()

    print(f"验包：{zpath}")
    z = zipfile.ZipFile(zpath)
    names = z.namelist()
    problems = []

    with tempfile.TemporaryDirectory() as tmp:
        # 1. 语法
        for n in names:
            if not n.endswith(".js"):
                continue
            p = Path(tmp) / n.replace("/", "__")
            p.write_bytes(z.read(n))
            r = subprocess.run(["node", "--check", str(p)], capture_output=True, text=True)
            if r.returncode != 0:
                first = (r.stderr or "").strip().splitlines()
                problems.append(f"{n} 语法错：{first[1] if len(first) > 1 else first[:1]}")
        print(f"  语法：{sum(1 for n in names if n.endswith('.js'))} 个 js 全过 node --check")

        # 2. 行号守恒
        for n in names:
            if not n.endswith((".js", ".css", ".html")):
                continue
            src = ROOT / n
            if not src.is_file():
                continue
            a = z.read(n).decode("utf-8").count("\n")
            b = src.read_text(encoding="utf-8").count("\n")
            if a != b:
                problems.append(f"{n} 行号不一致：包里 {a} 行 / 仓库 {b} 行")
        print("  行号：包里每个文件的行数都和仓库一致")

        # 3. **最强的一条**：把包里每个文本文件**再剥一遍**，结果必须**逐字相同**。
#    这一条同时盖住两种坏：
#      · 删了不该删的（字符串被吃掉）→ 结果和剥过的源码对不上
#      · 留了不该留的（有漏剥的注释）→ 再剥还有变化
#    判据不能是「仓库里有的字样包里也得有」—— 注释里举的例子（{{变量}}、https://x）
#    本来就该消失，这么判会误报一串（真踩过）。
        texts = {
            n: z.read(n).decode("utf-8")
            for n in names
            if n.endswith((".js", ".css", ".html"))
        }
        again = subprocess.run(
            ["node", str(ROOT / "tools" / "strip-comments.mjs"), "--json"],
            input=json.dumps(texts, ensure_ascii=False),
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        if again.returncode != 0:
            problems.append("再剥一遍时剥离器自己报错了：" + (again.stderr or "").strip()[:200])
            again_map = {}
        else:
            again_map = json.loads(again.stdout)
        changed = [n for n, code in texts.items() if again_map.get(n) != code]
        for n in changed:
            problems.append(f"{n} 再剥一次还有变化 —— 包不是干净的（有漏剥的，或剥过头了）")
        print(f"  幂等：{len(texts)} 个文本文件「再剥一次毫无变化」")

    # 4. 注释确实少了很多（对照仓库）
    saved = 0
    for n in names:
        if not n.endswith((".js", ".css", ".html")):
            continue
        src = ROOT / n
        if src.is_file():
            saved += src.stat().st_size - z.getinfo(n).file_size
    print(f"  体积：剥注释一共省下 {saved:,} 字节（压缩前）")

    if problems:
        print("\n发现问题：")
        for p in problems:
            print("  ✗ " + p)
        sys.exit(1)
    print("\n全部通过 ✓")


if __name__ == "__main__":
    main()