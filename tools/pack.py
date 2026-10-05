#!/usr/bin/env python3
"""把扩展打包成能传商店 / 挂 GitHub Release 的 zip。

只收「运行时」文件：manifest 引用的那些 + lib/ + icons/ + _locales/ + 两个说明文件。
tools/ docs/ .git/ 这些开发用的东西一个都不进包。

用法：
    python tools/pack.py                # 输出 dist/request-translate-<版本>.zip
    python tools/pack.py --out X.zip    # 指定输出路径

为什么不用 tar：Git Bash 自带的 tar 不认 .zip，`tar -a -cf x.zip` 产出的是换了
扩展名的 tar（魔数 mani 而不是 PK），商店会直接拒。所以老老实实用 zipfile 写。
"""

import argparse
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 根目录要收的文件。新增页面 / 脚本记得加进来 —— 下面 collect() 会盯着这件事
ROOT_FILES = [
    "manifest.json",
    "background.js",
    "content.js",
    "offscreen.html",
    "offscreen.js",
    "options.html",
    "options.js",
    "options.css",
    "popup.html",
    "popup.js",
    "LICENSE",
    "PRIVACY.md",
]

DIRS = ["lib", "_locales", "icons"]


def collect():
    files = []
    for name in ROOT_FILES:
        if not (ROOT / name).is_file():
            sys.exit(f"少了个文件：{name}")

    # 兜底：根目录冒出没登记的页面 / 脚本，多半是加了文件忘了加进清单
    known = set(ROOT_FILES)
    for p in sorted(ROOT.iterdir()):
        if p.is_file() and p.suffix in {".js", ".html", ".css"} and p.name not in known:
            sys.exit(f"根目录这个文件没登记进 ROOT_FILES：{p.name}")

    files.extend(ROOT_FILES)
    for d in DIRS:
        base = ROOT / d
        if not base.is_dir():
            sys.exit(f"少了个目录：{d}")
        for p in sorted(base.rglob("*")):
            if p.is_file() and not p.name.startswith("."):
                files.append(p.relative_to(ROOT).as_posix())
    return files


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None, help="输出路径，默认 dist/request-translate-<版本>.zip")
    args = ap.parse_args()

    version = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
    out = Path(args.out) if args.out else ROOT / "dist" / f"request-translate-{version}.zip"
    out.parent.mkdir(parents=True, exist_ok=True)

    files = collect()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name in files:
            z.write(ROOT / name, name)

    size = out.stat().st_size
    print(f"版本 {version} → {out}")
    print(f"{len(files)} 个文件，{size:,} 字节（{size / 1024:.1f} KB）")
    if out.read_bytes()[:2] != b"PK":
        sys.exit("写出来的不是 zip（魔数不对）！")
    print("魔数 PK ✓")


if __name__ == "__main__":
    main()
