#!/usr/bin/env python3
"""重新生成文档图片（docs/shots/）。

两类图：
  00-overview.png   手绘图解（三段流程 + 三条卖点）。界面改版不用重画，
                    只有卖点或配色变了才需要。
  01~04             真实截图（Playwright 起 Edge 加载扩展 + 假接口），
                    界面一改就得重拍。

为什么截图用假接口而不是真接口：
  - 不依赖网络，也不烧用户的 API 额度
  - 译文内容可控，不会把别人的数据拍进仓库
  - 页面用本地 HTTP 服务渲染一篇假文章，避免拍到真实网站的版权内容

要求：playwright-core（已有）、Edge（已有）、Pillow（只有图解需要）

用法：  python tools/make-shots.py              # 全做
        python tools/make-shots.py --overview   # 只重画图解
        python tools/make-shots.py --shots      # 只重拍截图
"""

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "shots"
OUT.mkdir(parents=True, exist_ok=True)

BG = (24, 24, 30)
CARD = (32, 33, 40)
BORDER = (52, 54, 64)
FG = (232, 233, 238)
DIM = (150, 153, 166)
ACCENT = (139, 92, 246)
ACCENT2 = (168, 140, 250)
OK = (52, 199, 89)
SUB = (40, 41, 50)

FONT_R = "C:/Windows/Fonts/msyh.ttc"
FONT_B = "C:/Windows/Fonts/msyhbd.ttc"
FONT_M = "C:/Windows/Fonts/consola.ttf"


def run_overview():
    from PIL import Image, ImageDraw, ImageFont

    def f(sz, bold=False):
        return ImageFont.truetype(FONT_B if bold else FONT_R, sz)

    def mono(sz):
        return ImageFont.truetype(FONT_M, sz)

    W, H = 1600, 900
    im = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(im)

    d.text((80, 50), "RequestTranslate", font=f(30, True), fill=ACCENT2)
    d.text((80, 96), "划词翻译，但配置是你自己的 HTTP 请求", font=f(44, True), fill=FG)
    d.text((80, 158),
           "粘贴一段 curl 或原始报文 · 除 {{占位符}} 外一个字节都不改写 · 零依赖零构建",
           font=f(22), fill=DIM)

    SY = 236
    X0 = 80
    BW, BH = 396, 372

    # ---- 卡片 1：选词 ----
    d.rounded_rectangle([X0, SY, X0 + BW, SY + BH], 14, fill=CARD, outline=BORDER)
    d.text((X0 + 24, SY + 20), "1", font=f(26, True), fill=ACCENT)
    d.text((X0 + 58, SY + 24), "在网页上选中文字", font=f(21, True), fill=FG)
    d.line([(X0 + 20, SY + 66), (X0 + BW - 20, SY + 66)], fill=BORDER)

    ty = SY + 96
    rows = [("This is a paragraph", False, 0),
            ("of source text", True, 190),
            ("you can translate.", False, 0)]
    for i, (txt, hl, tw) in enumerate(rows):
        yy = ty + i * 40
        if hl:
            d.rectangle([X0 + 28, yy - 4, X0 + 28 + tw, yy + 30], fill=(70, 55, 130))
            d.text((X0 + 32, yy), txt, font=f(19), fill=(242, 238, 255))
        else:
            d.text((X0 + 32, yy), txt, font=f(19), fill=DIM)

    cx, cy = X0 + 268, ty + 52
    glow = Image.new("RGBA", (130, 130), (0, 0, 0, 0))
    ImageDraw.Draw(glow).rounded_rectangle([24, 24, 106, 106], 26, fill=(139, 92, 246, 65))
    im.paste(glow, (cx - 65, cy - 65), glow)
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([cx - 23, cy - 23, cx + 23, cy + 23], 12, fill=ACCENT)
    d.text((cx - 10, cy - 15), "译", font=f(24, True), fill=(255, 255, 255))
    d.line([(X0 + 20, SY + BH - 56), (X0 + BW - 20, SY + BH - 56)], fill=BORDER)
    d.text((X0 + 24, SY + BH - 42), "选中就出现，位置贴手边", font=f(17), fill=DIM)

    ay = SY + BH // 2
    for i in range(3):
        ax = X0 + BW + 26 + i * 18
        d.polygon([(ax, ay - 7), (ax + 12, ay), (ax, ay + 7)], fill=(92, 94, 108))

    # ---- 卡片 2：面板 ----
    X1 = X0 + BW + 104
    PW = 452
    d.rounded_rectangle([X1, SY, X1 + PW, SY + BH], 14, fill=CARD, outline=BORDER)
    d.text((X1 + 24, SY + 20), "2", font=f(26, True), fill=ACCENT)
    d.text((X1 + 58, SY + 24), "点它，面板弹出", font=f(21, True), fill=FG)
    d.line([(X1 + 20, SY + 66), (X1 + PW - 20, SY + 66)], fill=BORDER)

    PX, PY, PDW, PDH = X1 + 22, SY + 82, PW - 44, 226
    d.rounded_rectangle([PX, PY, PX + PDW, PY + PDH], 10, fill=(21, 22, 27), outline=BORDER)
    d.ellipse([PX + 16, PY + 15, PX + 27, PY + 26], fill=OK)
    d.text((PX + 36, PY + 10), "我的模型网关", font=f(16), fill=FG)
    d.text((PX + PDW - 96, PY + 10), "简体中文", font=f(15), fill=DIM)
    d.text((PX + PDW - 26, PY + 10), "X", font=f(15), fill=DIM)
    d.line([(PX, PY + 40), (PX + PDW, PY + 40)], fill=BORDER)
    d.text((PX + 14, PY + 52), "原文：of source text you can translate.",
           font=f(14), fill=(112, 114, 126))
    d.line([(PX, PY + 78), (PX + PDW, PY + 78)], fill=BORDER)
    d.text((PX + 14, PY + 90), "我的模型网关", font=f(15, True), fill=FG)
    d.text((PX + PDW - 44, PY + 90), "完成", font=f(14), fill=DIM)
    d.text((PX + 14, PY + 118), "选中网页上的文字，就会出现一个", font=f(16), fill=FG)
    d.text((PX + 14, PY + 146), "小圆点。点一下，就把你配置的那段", font=f(16), fill=FG)
    d.text((PX + 14, PY + 174), "请求发出去 —— 不经过任何中转。", font=f(16), fill=FG)
    d.line([(PX, PY + PDH - 32), (PX + PDW, PY + PDH - 32)], fill=BORDER)
    d.text((PX + 14, PY + PDH - 24), "HTTP 200 · 1.8s", font=f(13), fill=DIM)
    d.line([(X1 + 20, SY + BH - 56), (X1 + PW - 20, SY + BH - 56)], fill=BORDER)
    d.text((X1 + 24, SY + BH - 42), "多条配置可并排对比", font=f(17), fill=DIM)

    for i in range(3):
        ax = X1 + PW + 26 + i * 18
        d.polygon([(ax, ay - 7), (ax + 12, ay), (ax, ay + 7)], fill=(92, 94, 108))

    # ---- 卡片 3：配置 = 请求文本 ----
    X2 = X1 + PW + 100
    CW = W - X2 - 80
    d.rounded_rectangle([X2, SY, X2 + CW, SY + BH], 14, fill=CARD, outline=BORDER)
    d.text((X2 + 24, SY + 20), "3", font=f(26, True), fill=ACCENT)
    d.text((X2 + 58, SY + 24), "配置就是这段文本", font=f(21, True), fill=FG)
    d.line([(X2 + 20, SY + 66), (X2 + CW - 20, SY + 66)], fill=BORDER)

    CY = SY + 82
    d.rounded_rectangle([X2 + 20, CY, X2 + CW - 20, CY + 176], 8, fill=SUB, outline=BORDER)
    code = [
        ("POST /v1/chat/completions", DIM),
        ("Authorization: Bearer ...", DIM),
        ("Content-Type: application/json", DIM),
        ("", DIM),
        ('{"model": "{{model}}", "stream": true,', ACCENT2),
        (' "messages": [{"role": "user",', ACCENT2),
        ('   "content": "...{{text}}"}]}', ACCENT2),
    ]
    for i, (ln, col) in enumerate(code):
        d.text((X2 + 38, CY + 12 + i * 22), ln, font=mono(14), fill=col)
    d.text((X2 + 24, CY + 196), "{{text}}  {{apiKey}}  {{model}}  {{target}}",
           font=mono(14), fill=DIM)
    d.text((X2 + 24, CY + 220), "自定义变量随便加", font=f(15), fill=DIM)
    d.line([(X2 + 20, SY + BH - 56), (X2 + CW - 20, SY + BH - 56)], fill=BORDER)
    d.text((X2 + 24, SY + BH - 42), "任何 OpenAI 兼容接口都能接", font=f(17), fill=DIM)

    # ---- 底部三条卖点 ----
    by = 668
    items = [
        ("零依赖 · 零构建", "源码直接可读，加载解压文件夹就能用"),
        ("任意接口", "OpenAI 兼容 / DeepL / Bing / 自建服务"),
        ("不收集数据", "文字只发往你自己填写的地址"),
    ]
    for i, (t1, t2) in enumerate(items):
        bx = 80 + i * 505
        d.rounded_rectangle([bx, by, bx + 4, by + 54], 2, fill=ACCENT)
        d.text((bx + 18, by), t1, font=f(22, True), fill=FG)
        d.text((bx + 18, by + 32), t2, font=f(16), fill=DIM)

    out = OUT / "00-overview.png"
    im.save(out)
    print("  00-overview.png  %dx%d  %s" % (im.size[0], im.size[1],
          format(out.stat().st_size, ",")))


def run_shots():
    script = ROOT / "tools" / "shots-impl.mjs"
    if not script.is_file():
        sys.exit("缺 " + str(script))
    r = subprocess.run(["node", str(script)], cwd=str(ROOT),
                       capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    print((r.stdout or "").strip())
    if r.returncode != 0:
        print((r.stderr or "")[-1500:])
        sys.exit("截图失败")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--overview", action="store_true")
    ap.add_argument("--shots", action="store_true")
    a = ap.parse_args()
    both = not a.overview and not a.shots
    if both or a.overview:
        print("画图解 …")
        run_overview()
    if both or a.shots:
        print("拍截图 …")
        run_shots()


if __name__ == "__main__":
    main()
