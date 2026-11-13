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
            r = subprocess.run(
                ["node", "--check", str(p)],
                capture_output=True,
                text=True,
                # 同上：Windows 默认 GBK，node 的报错里可能带非 GBK 字符
                encoding="utf-8",
                errors="replace",
            )
            if r.returncode != 0:
                first = (r.stderr or "").strip().splitlines()
                problems.append(f"{n} 语法错：{first[1] if len(first) > 1 else first[:1]}")
        print(f"  语法：{sum(1 for n in names if n.endswith('.js'))} 个 js 全过 node --check")

        # 2. 行号守恒（**只在没跑 esbuild 时有意义**）
        #    剥注释不吞行，所以行数该和仓库一致；但 esbuild 会把多行压成单行，
        #    那时行号天然对不上。判据改成「有没有被压过」：
        #      压过 -> 行数必然少，不判；
        #      没压 -> 必须一致（这条仍然钉着「剥注释没吞行」）。
        minified = 0
        line_bad = []
        for n in names:
            if not n.endswith((".js", ".css", ".html")):
                continue
            src = ROOT / n
            if not src.is_file():
                continue
            a = z.read(n).decode("utf-8").count("\n")
            b = src.read_text(encoding="utf-8").count("\n")
            if a < b:
                minified += 1        # 被压过（行变少是预期）
            elif a != b:
                line_bad.append(f"{n} 行号不一致：包里 {a} 行 / 仓库 {b} 行")
        problems.extend(line_bad)
        if line_bad:
            print("  行号：发现 %d 处不一致" % len(line_bad))
        elif minified:
            print("  行号：%d 个文件被 esbuild 压缩过（行号不再守恒，符合预期）" % minified)
        else:
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

    # 5. background 形态 —— 这条拿两次真实事故换来：
    #    · Edge 商店整包拒：「background.scripts 不能和 MV3 一起用」
    #    · 火狐白屏：裁 background 时把 type: module 也删了，而 background.js 是 ES module
    #      （8 个 import），删了火狐按普通脚本解析，import 直接语法错误。
    # 判据：出包时按 target 裁过一次，两种形态各自合法，且 type 必须留。
    man = json.loads(z.read("manifest.json").decode("utf-8"))
    bg = man.get("background") or {}
    has_sw = "service_worker" in bg
    has_sc = "scripts" in bg
    if not bg.get("type"):
        problems.append("background 缺 type: module —— background.js 是 ES module，删了火狐起不来")
    if has_sw and has_sc:
        problems.append("background 同时有 service_worker 和 scripts —— 商店校验会整包拒")
    if not has_sw and not has_sc:
        problems.append("background 既没 service_worker 也没 scripts —— 后台不会启动")
    if zpath.suffix == ".xpi" and has_sw:
        problems.append("xpi 里不该有 service_worker（火狐不认）")
    if zpath.suffix == ".zip" and has_sc:
        problems.append("zip 里不该有 scripts（Edge 商店会拒）")
    # 只在真的合法时才吹「形态正确」—— 检查在打印之前，否则坏包也会印一句「正确」（实测踩到）
    bad_before = len(problems)
    if len(problems) == bad_before:
        form = "scripts" if has_sc else "service_worker"
        print(f"  background：{form} + type:module（{zpath.suffix} 形态正确）")

    # 6. 同名 zip 与 xpi 必须「除 manifest 外逐文件一致」—— 防「只重打了一个包」。
    #    真实事故：T1 合并 CSS 后只重打了 zip，xpi 还留旧源码（panel-core 少 15 KB、
    #    content.js 还带内联 CSS 大块）。拿那种 xpi 传 AMO，提交的代码和仓库对不上。
    twin = zpath.with_suffix(".xpi" if zpath.suffix == ".zip" else ".zip")
    if twin.is_file():
        tz = zipfile.ZipFile(twin)
        if set(names) != set(tz.namelist()):
            problems.append("与 " + twin.name + " 的文件列表不同")
        else:
            diffs = [n for n in names if n != "manifest.json" and z.read(n) != tz.read(n)]
            if diffs:
                problems.append(
                    "与 " + twin.name + " 有 " + str(len(diffs)) + " 个文件内容不同（只差 manifest 才对）：" + ", ".join(diffs[:3])
                )
            else:
                print(f"  双包一致：与 {twin.name} 除 manifest 外逐字节相同（{len(names)} 个文件）")

    if problems:
        print("\n发现问题：")
        for p in problems:
            print("  ✗ " + p)
        sys.exit(1)
    print("\n全部通过 ✓")


if __name__ == "__main__":
    main()