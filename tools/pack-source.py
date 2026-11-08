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
    "popup.html", "popup.js", "LICENSE", "PRIVACY.md", "README.md", "package.json",
]
DIRS = ["lib", "_locales", "icons"]
# AMO 要求提供「能执行所有必要技术步骤的构建脚本」
TOOLS = ["pack.py", "minify-sources.mjs", "strip-comments.mjs", "verify-pack.py"]

BUILD_MD = "\n".join([
    "# 如何重建本扩展的 .xpi",
    "",
    "本扩展**零依赖、零构建**。唯一的「构建」步骤是把源码里的注释剥掉。",
    "",
    "## 环境",
    "",
    "- Python 3.9+（只用到标准库，无第三方包）",
    "- Node.js 18+（剥注释与语法校验用）",
    "- 无需 npm install：package.json 里 dependencies 与 devDependencies 都是空的",
    "",
    "## 重建",
    "",
    "```bash",
    "python tools/pack.py --xpi --skip-test",
    "```",
    "",
    "## 这个「构建」到底做了什么",
    "",
    "`tools/minify-sources.mjs` 调用 `tools/strip-comments.mjs`：",
    "",
    "- 词法级扫描（正确处理字符串 / 正则 / 模板字符串里的 `//` 和 `/*`）",
    "- 把注释**内容清空**，但**不删行** —— 所以行号守恒",
    "- 对每个 .js 跑一次 `node --check`，剥坏了当场非零退出",
    "",
    "实测：9 个主要文件（content.js / background.js / options.js / popup.js /",
    "offscreen.js / frame-bridge.js / lib/panel-core.js / lib/store.js / lib/engine.js）",
    "在包内与仓库里的**行数完全一致**。审核时无需执行构建，忽略注释逐行比对即可。",
    "",
    "",
    "## manifest.json 里为什么 background 同时写了两个字段",
    "",
    "源码根目录的 manifest.json 里，background 是：",
    "",
    "```json",
    "\"background\": {",
    "  \"service_worker\": \"background.js\",",
    "  \"scripts\": [\"background.js\"],",
    "  \"type\": \"module\"",
    "}",
    "```",
    "",
    "**两个字段同时在，是有意为之**：",
    "",
    "- Chromium（Edge / Chrome）MV3 只认 service_worker，会忽略 scripts",
    "- Firefox MV3 只认 scripts（事件页），且 **不支持 service_worker**",
    "- 同一份源码因此**两个浏览器都能本地加载**",
    "",
    "**但商店校验器不做这种容忍。**（Edge 实测：提交带 scripts 的包会被整包拒绝，报",
    "The background.scripts field cannot be used with manifest version 3。）",
    "",
    "所以 tools/pack.py **出包时**会按目标裁一次 —— 这是唯一的「构建期差异」：",
    "",
    "| 出包命令 | 产出的 background |",
    "| --- | --- |",
    "| python tools/pack.py（默认 chromium） | {service_worker, type} |",
    "| python tools/pack.py --xpi（火狐） | {scripts} |",
    "",
    "**复现提交的 .xpi 请用上面第二条命令**，产出的是裁剪过的火狐形态。",
    "如果你直接拿仓库根目录的 manifest.json 打包，得到的是双字段版本 ——",
    "它能跑，但和提交的那个 .xpi 的 manifest 不完全一样（差别就这一个字段）。",
    "其余每个文件的正文与行号都和提交的包**逐字一致**。",
    "",
    "## 不想跑构建？",
    "",
    "仓库里的源码**就是完整的扩展**：把 `tools/` 之外的文件挑出来，",
    "`manifest.json` 在根目录，直接加载即可运行。差别只是注释为空。",
    "",
])


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