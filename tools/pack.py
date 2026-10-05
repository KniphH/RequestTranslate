#!/usr/bin/env python3
"""打包：出 zip（传商店 / 挂 Release）。

用法：
    python tools/pack.py            # 出 dist/request-translate-<版本>.zip
    python tools/pack.py --crx      # 自用：顺便出一个 crx（**不随 Release 发布**）

只收「运行时」文件：manifest 引用的那些 + lib/ + icons/ + _locales/ + 两个说明文件。
tools/ docs/ .git/ 这些开发用的东西一个都不进包。

关于 --crx（备用分支，对外不发）：
  对外只发 zip，装法在 README 里只写「商店 + 加载解压文件夹」—— 跟大多数扩展一样。
  crx 这条路 Edge 是认的（拖进 edge://extensions/ 就能装，实测过），但发出去会多出一个
  和商店版**不同 ID** 的扩展（两个图标、两份配置），对用户是负担，所以不发布。
  留着这段是为了「自己想临时装一个」的场景。
  * 用系统的 Edge 打包（`msedge --pack-extension=…`），不依赖任何第三方工具。
  * 签名私钥在 dist/key.pem（gitignore 里，不进仓库）。换一把钥匙 = 换一个扩展 ID。

为什么不用 tar：Git Bash 自带的 tar 不认 .zip，`tar -a -cf x.zip` 产出的是换了
扩展名的 tar（魔数 mani 而不是 PK），商店会直接拒。所以老老实实用 zipfile 写。
"""

import argparse
import base64
import hashlib
import io
import json
import shutil
import subprocess
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

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


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


def make_zip(files, out):
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name in files:
            z.write(ROOT / name, name)
    if out.read_bytes()[:2] != b"PK":
        sys.exit("写出来的不是 zip（魔数不对）！")


# ------------------------------------------------------------------ crx


def read_len(buf, i):
    b = buf[i]
    i += 1
    if b < 0x80:
        return b, i
    n = b & 0x7F
    return int.from_bytes(buf[i : i + n], "big"), i + n


def tlv(buf, i):
    """读一个 TLV，返回 (tag, value, 下一个位置)。只认简单长度。"""
    tag = buf[i]
    ln, j = read_len(buf, i + 1)
    return tag, buf[j : j + ln], j + ln


def der_len(n):
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, "big")
    return bytes([0x80 | len(b)]) + b


def der_int(v):
    b = v.to_bytes((v.bit_length() + 7) // 8 or 1, "big")
    if b[0] & 0x80:
        b = b"\x00" + b
    return b"\x02" + der_len(len(b)) + b


def ext_id_from_pem(pem_path):
    """从 PKCS#8 私钥反推扩展 ID —— 就是公钥 SHA256 的前 16 字节，0-15 映射成 a-p。

    跟 Chromium 的算法一致；首次打包时也用它确认「这把钥匙还在，ID 没变」。
    """
    text = pem_path.read_text(encoding="ascii")
    der = base64.b64decode("".join(l for l in text.splitlines() if "-----" not in l))

    _, seq, _ = tlv(der, 0)  # PrivateKeyInfo
    _, _ver, idx = tlv(seq, 0)  # version（别跳过它，否则后面全错位）
    _, _algo, idx = tlv(seq, idx)  # AlgorithmIdentifier
    _, octets, _ = tlv(seq, idx)  # privateKey OCTET STRING
    _, rsa, _ = tlv(octets, 0)  # RSAPrivateKey

    pos = 0
    _, _ver, pos = tlv(rsa, pos)
    _, n, pos = tlv(rsa, pos)
    _, e, pos = tlv(rsa, pos)
    n = int.from_bytes(n, "big")
    e = int.from_bytes(e, "big")

    pub = der_int(n) + der_int(e)
    pub = b"\x30" + der_len(len(pub)) + pub
    alg = bytes.fromhex("300d06092a864886f70d0101010500")
    bits = b"\x03" + der_len(len(pub) + 1) + b"\x00" + pub
    spki = b"\x30" + der_len(len(alg) + len(bits)) + alg + bits

    digest = hashlib.sha256(spki).digest()[:16]
    return "".join(chr(97 + (b >> 4)) + chr(97 + (b & 0x0F)) for b in digest)


def crx_inner_zip(crx_path):
    data = crx_path.read_bytes()
    if data[:4] != b"Cr24":
        sys.exit("打出来的不是 crx（魔数不对）！")
    ver = int.from_bytes(data[4:8], "little")
    if ver == 3:
        hdr = int.from_bytes(data[8:12], "little")
        return data[12 + hdr :]
    pk = int.from_bytes(data[8:12], "little")
    sig = int.from_bytes(data[12:16], "little")
    return data[16 + pk + sig :]


def make_crx(files, version, out_dir):
    edge = next((p for p in EDGE_CANDIDATES if Path(p).is_file()), None)
    if not edge:
        sys.exit("没找到 Edge，没法打 crx（zip 已经出好了）")

    staging = out_dir / "staging"
    profile = out_dir / ".pack-profile"
    key = out_dir / "key.pem"

    shutil.rmtree(staging, ignore_errors=True)
    for name in files:
        dst = staging / name
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / name, dst)

    cmd = [edge, f"--pack-extension={staging}", "--no-message-box", f"--user-data-dir={profile}"]
    if key.is_file():
        cmd.append(f"--pack-extension-key={key}")
    subprocess.run(cmd, check=True, timeout=300)

    produced = staging.with_suffix(".crx")  # Edge 按目录名命名
    if not produced.is_file():
        sys.exit("Edge 没吐出 crx，看看上面有没有报错")
    out = out_dir / f"request-translate-{version}.crx"
    produced.replace(out)

    fresh_pem = staging.with_suffix(".pem")
    if fresh_pem.is_file() and not key.is_file():
        fresh_pem.replace(key)
        print(f"新生成签名私钥 → {key}（**别删别丢**，换钥匙就等于换一个扩展）")
    fresh_pem.unlink(missing_ok=True)

    shutil.rmtree(staging, ignore_errors=True)
    shutil.rmtree(profile, ignore_errors=True)

    # 拆开验一遍：内嵌 zip 的 CRC 全过才算真的好
    inner = zipfile.ZipFile(io.BytesIO(crx_inner_zip(out)))
    bad = inner.testzip()
    print(f"crx 版本 3，内嵌 {len(inner.infolist())} 个条目，CRC {'全通过' if bad is None else '有坏文件 ' + str(bad)}")
    if bad is not None:
        sys.exit("crx 内容坏了")

    eid = ext_id_from_pem(key)
    print(f"crx 版扩展 ID：{eid}")
    print("（和商店版的 ID 不一样，这是正常的 —— 商店的私钥在微软手里。两条路选一条走。）")
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None, help="zip 输出路径，默认 dist/request-translate-<版本>.zip")
    ap.add_argument("--crx", action="store_true", help="顺便打一个 crx")
    args = ap.parse_args()

    version = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))["version"]
    # 一定要 resolve 成绝对路径 —— Edge 的 --pack-extension 不认相对路径（直接退 22）
    out = Path(args.out) if args.out else ROOT / "dist" / f"request-translate-{version}.zip"
    out = out.resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    files = collect()
    make_zip(files, out)
    size = out.stat().st_size
    print(f"版本 {version} → {out}")
    print(f"zip：{len(files)} 个文件，{size:,} 字节（{size / 1024:.1f} KB），魔数 PK ✓")

    if args.crx:
        crx = make_crx(files, version, out.parent)
        csize = crx.stat().st_size
        print(f"crx：{crx}，{csize:,} 字节（{csize / 1024:.1f} KB）")


if __name__ == "__main__":
    main()
