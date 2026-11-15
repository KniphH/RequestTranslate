#!/usr/bin/env python3
"""验 dist 里的包是不是「剥了注释但没剥坏」。

打包后跑一次，三件事：
  1. **语法**：包里每个 .js 过一遍 `node --check`（剥坏了当场暴露）
  2. **行号**：**只对被剥注释、未压缩的文件**成立（剥注释保留换行）。
   经 esbuild 压缩过的那 20 个文件行数会塌成几行，报错栈行号**对不上**源码 ——
   线上排查请按函数名 / 字符串定位（第八版 §1 指出这句话以前是错的）。
  3. **内容**：URL、占位符这些「剥错了就没了」的关键字样还得在

用法：
    python tools/verify-pack.py                # 验 dist 里最新的包
    python tools/verify-pack.py dist/xxx.zip
"""

import hashlib
import re
import json
import subprocess
import sys
import shutil
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
    # 形态检查的结论**并进 problems**（以前 `bad_before == len(problems)` 是恒真自比较，
    # 坏包也照样印「形态正确」—— 通读 §3D 抓到的）。
    if not problems:
        form = "scripts" if has_sc else "service_worker"
        print(f"  background：{form} + type:module（{zpath.suffix} 形态正确）")
    # 6. 同名 zip 与 xpi 必须「除 manifest 外逐文件一致」—— 防「只重打了一个包」。
    #    真实事故：T1 合并 CSS 后只重打了 zip，xpi 还留旧源码（panel-core 少 15 KB、
    #    content.js 还带内联 CSS 大块）。拿那种 xpi 传 AMO，提交的代码和仓库对不上。
    twin = zpath.with_suffix(".xpi" if zpath.suffix == ".zip" else ".zip")
    if twin.is_file():
        tz = zipfile.ZipFile(twin)
        # 火狐包会比 Chromium 包少 3 个文件（offscreen.html/js、ua-rules.json）——
        # 那是刻意丢的（火狐没有 offscreen API，也没装 DNR）。
        CHROME_ONLY = {"offscreen.html", "offscreen.js", "lib/ua-rules.json"}
        common = set(names) & set(tz.namelist())
        only_here = set(names) - set(tz.namelist())
        only_there = set(tz.namelist()) - set(names)
        # 允许的差异：只允许「Chrome 侧多出这 3 个」
        bad_extra = only_here - CHROME_ONLY
        bad_extra.update(only_there - CHROME_ONLY)
        if bad_extra:
            problems.append(
                "与 " + twin.name + " 的文件列表不该差这些：" + ", ".join(sorted(bad_extra))
            )
        else:
            diffs = [
                n for n in sorted(common)
                if n != "manifest.json" and z.read(n) != tz.read(n)
            ]
            if diffs:
                problems.append(
                    "与 " + twin.name + " 有 " + str(len(diffs)) + " 个共同文件内容不同（只差 manifest 才对）："
                    + ", ".join(diffs[:6])
                )
            else:
                skipped = len(CHROME_ONLY & (only_here | only_there))
                note = f"（火狐包少 {skipped} 个 Chromium 专有文件）" if skipped else ""
                print(
                    f"  双包一致：{len(common)} 个共同文件除 manifest 外逐字节相同{note}"
                )

    # 7. **包必须与仓库源码同源** —— 从 git HEAD 取源码，重跑一遍变换再比。
    #
    #    四次失败尝试（第十版总结得很准）：
    #      字面量 → 总长 → 函数计数 → **比 dist/.stripped**
    #    最后那个最像真的，其实最彻底的假：pack.py 正是从 .stripped 写进 zip，
    #    同一份字节复制两处，md5 恒等是同义反复。
    #
    #    真做法：
    #      a) git show HEAD:<path> 取仓库里的源码（不是工作区，避免未提交改动干扰）
    #      b) 用一个临时目录重跑「剥注释 + esbuild」这同一套变换
    #      c) 与包内同名文件比 md5
    #    仓库改了但没重新打包 → 变换结果不同 → 必然红。
    repo_root = Path(__file__).resolve().parent.parent
    tmp = repo_root / "dist" / ".verify-src"
    stale = []
    compared = 0
    try:
        if tmp.exists():
            shutil.rmtree(tmp)
        tmp.mkdir(parents=True, exist_ok=True)
        # a) 从 git HEAD 取每个 .js（不是工作区 —— 未提交改动不该让检查变绿）
        src_names_js = [n for n in names if n.endswith((".js", ".css", ".html"))]
        # 剥注释只做 .js/.css/.html，json 原样复制 —— 这几类都要走同一套变换再比。
        src_names = [n for n in names if n.endswith((".js", ".css", ".html"))]
        same_names = [n for n in names if n.endswith((".json", ".md")) and n != "manifest.json"]
        got = []
        for n in src_names_js:
            try:
                data = subprocess.run(
                    ["git", "show", "HEAD:" + n],
                    cwd=str(repo_root), capture_output=True, check=True
                ).stdout
            except subprocess.CalledProcessError:
                stale.append(f"{n} 在包里但 git HEAD 里没有")
                continue
            # **行尾要统一成工作区的形状**：`git show` 给的是仓库里的 LF，
            # 而打包读的是工作区（Windows 上 core.autocrlf 让它是 CRLF）。
            # 不统一的话，剥注释后的字节数必然不同 → 天天报假红。
            # 判据是「仓库源码经同一套变换后是否等于包内字节」，
            # 行尾属于检出细节，不该参与这个比较。
            # 做法：按 \n 切成行、去掉尾部 \r、再按工作区的形状重新拼。
            dst = tmp / n
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(data)
            got.append(n)
        # b) 重跑同一套变换（minify-sources 剥注释 → esbuild 压缩）
        if got:
            args = ["node", str(repo_root / "tools" / "minify-sources.mjs"), str(tmp), *got]
            r1 = subprocess.run(args, cwd=str(repo_root), capture_output=True, text=True, encoding="utf-8")
            if r1.returncode != 0:
                problems.append("同源检查：重跑剥注释失败\n" + (r1.stderr or "")[:400])
            else:
                r2 = subprocess.run(
                    ["node", str(repo_root / "tools" / "esbuild-minify.mjs"), str(tmp)],
                    cwd=str(repo_root), capture_output=True, text=True, encoding="utf-8"
                )
                if r2.returncode != 0:
                    problems.append("同源检查：重跑 esbuild 失败\n" + (r2.stderr or "")[:400])
        # c) 比 md5
        for n in got:
            rebuilt = tmp / n
            if not rebuilt.is_file():
                stale.append(f"{n} 重跑变换后没有产物")
                continue
            compared += 1
            norm = lambda b: b.replace(b"\r\n", b"\n")   # 行尾是检出细节，不参与比较
            if hashlib.md5(norm(z.read(n))).hexdigest() != hashlib.md5(norm(rebuilt.read_bytes())).hexdigest():
                stale.append(
                    f"{n} 与「git HEAD 源码重跑变换」的结果不同"
                    " → 源码改过但没重新打包（或包来自别的提交）"
                )
    except Exception as exc:  # noqa: BLE001
        problems.append("同源检查跑挂了：" + str(exc)[:200])
    finally:
        if tmp.exists():
            shutil.rmtree(tmp, ignore_errors=True)

    if stale:
        problems.extend(stale[:12])
    elif compared:
        print(f"  与源码同源：{compared} 个 .js/.css/.html 与「git HEAD 源码重跑变换」逐文件 md5 一致")

    if problems:
        print("\n发现问题：")
        for p in problems:
            print("  ✗ " + p)
        sys.exit(1)
    print("\n全部通过 ✓")


if __name__ == "__main__":
    main()