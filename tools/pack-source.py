#!/usr/bin/env python3
"""打包 AMO 源码提交包。

AMO 问「是否用过二次处理工具」时我们答「是」（打包剥注释），因此每次提交都要
同时上传源码包。这个脚本生成它，完整流程见 firefox/AMO-源码提交.md。

用法：  python tools/pack-source.py
输出：  dist/request-translate-<版本>-SOURCE.zip
"""

import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# 与 tools/pack.py 的 ROOT_FILES 同步，另加 README 和 package.json
RUNTIME = [
    "manifest.json", "background.js", "content.js", "frame-bridge.js",
    "offscreen.html", "offscreen.js", "options.html", "options.js", "options.css",
    "popup.html", "popup.js", "LICENSE", "PRIVACY.md", "README.md", "package.json", "package-lock.json",
]
DIRS = ["lib", "_locales", "icons"]
# AMO 要求提供「能执行所有必要技术步骤的构建脚本」
TOOLS = ["pack.py", "pack-source.py", "minify-sources.mjs", "esbuild-minify.mjs", "strip-comments.mjs", "verify-pack.py", "generate-m3-palettes.mjs"]

BUILD_MD = """# 重建扩展

需要 Python 3.9+ 和 Node.js 18+。在源码目录运行 `npm ci` 安装构建依赖，
然后运行 `python tools/pack.py --xpi --skip-test` 生成 Chromium ZIP 和 Firefox XPI。

`lib/m3-palettes.json` 与 `lib/m3-palettes.js` 是预生成的运行时色板；
修改种子色或算法后运行 `npm run colors` 重新生成，再执行测试。
扩展运行时不依赖 npm 或远程 CDN。打包时会剥离注释并使用 esbuild 压缩 JavaScript。
根目录 Manifest 面向 Chromium；XPI 的 Manifest 由打包脚本转换为 Firefox 后台格式。
"""

def main():
    ver = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
    out = ROOT / "dist" / f"request-translate-{ver}-SOURCE.zip"
    out.parent.mkdir(parents=True, exist_ok=True)

    missing = [n for n in RUNTIME if not (ROOT / n).is_file()]
    if missing:
        sys.exit("少了文件：" + ", ".join(missing))
    files = list(RUNTIME)

    for d in DIRS:
        for p in sorted((ROOT / d).rglob("*")):
            if p.is_file() and not p.name.startswith("."):
                files.append(p.relative_to(ROOT).as_posix())

    for t in TOOLS:
        p = ROOT / "tools" / t
        if p.is_file():
            files.append("tools/" + t)
        else:
            print("  提示：tools/" + t + " 不存在，跳过")

    files = sorted(set(files))
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for f in files:
            z.write(ROOT / f, f)
        z.writestr("BUILD.md", BUILD_MD)

    if out.read_bytes()[:2] != b"PK":
        sys.exit("写出来的不是 zip！")

    size = out.stat().st_size
    z2 = zipfile.ZipFile(out)
    bad = z2.testzip()
    crc = "全通过" if bad is None else ("坏: " + str(bad))
    print("源码包 -> " + str(out))
    print("  " + str(len(z2.namelist())) + " 个条目，" + format(size, ",") +
          " 字节（" + format(size / 1024, ".1f") + " KB），CRC " + crc)


if __name__ == "__main__":
    main()