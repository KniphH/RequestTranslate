"""生成扩展图标（纯标准库手写 PNG，不需要 Pillow）。

图形：紫色渐变圆角方块 + 白色双向箭头（表示「翻译 / 转换」）。
用 4x 超采样抗锯齿。
"""

import math
import os
import struct
import zlib

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "icons")
SS = 4  # 超采样倍数

# 渐变两端颜色
C_TOP = (109, 92, 240)     # #6d5cf0
C_BOTTOM = (168, 85, 247)  # #a855f7
WHITE = (255, 255, 255)


def write_png(path, width, height, pixels):
    """pixels: bytearray，长度 width*height*4（RGBA）"""
    raw = bytearray()
    stride = width * 4
    for y in range(height):
        raw.append(0)  # filter type 0
        raw += pixels[y * stride:(y + 1) * stride]

    def chunk(tag, data):
        return (
            struct.pack(">I", len(data))
            + tag
            + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")

    with open(path, "wb") as f:
        f.write(png)


def seg_dist(px, py, x1, y1, x2, y2):
    dx, dy = x2 - x1, y2 - y1
    l2 = dx * dx + dy * dy
    if l2 == 0:
        return math.hypot(px - x1, py - y1)
    t = max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / l2))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def tri_inside(px, py, a, b, c):
    def side(p, q, r):
        return (p[0] - r[0]) * (q[1] - r[1]) - (q[0] - r[0]) * (p[1] - r[1])

    d1 = side((px, py), a, b)
    d2 = side((px, py), b, c)
    d3 = side((px, py), c, a)
    has_neg = d1 < 0 or d2 < 0 or d3 < 0
    has_pos = d1 > 0 or d2 > 0 or d3 > 0
    return not (has_neg and has_pos)


def arrow_coverage(nx, ny):
    """归一化坐标下，白色箭头的覆盖率（硬边，靠超采样抗锯齿）"""
    half = 0.042          # 主干半宽
    head_half = 0.108     # 箭头头部半高
    y_top = 0.360
    y_bot = 0.640

    # 上箭头：向右
    if seg_dist(nx, ny, 0.245, y_top, 0.615, y_top) <= half:
        return 1.0
    if tri_inside(nx, ny, (0.760, y_top), (0.600, y_top - head_half), (0.600, y_top + head_half)):
        return 1.0

    # 下箭头：向左
    if seg_dist(nx, ny, 0.755, y_bot, 0.385, y_bot) <= half:
        return 1.0
    if tri_inside(nx, ny, (0.240, y_bot), (0.400, y_bot - head_half), (0.400, y_bot + head_half)):
        return 1.0

    return 0.0


def rounded_rect_alpha(nx, ny, radius):
    """圆角矩形覆盖率，用标准 SDF；边缘平滑交给超采样。

    坐标已归一化到 0..1，半径也是归一化值。
    """
    dx = abs(nx - 0.5) - (0.5 - radius)
    dy = abs(ny - 0.5) - (0.5 - radius)
    outside = math.hypot(max(dx, 0.0), max(dy, 0.0))
    inside = min(max(dx, dy), 0.0)
    sd = outside + inside - radius
    return 1.0 if sd <= 0.0 else 0.0


def make_icon(size):
    s = size * SS
    acc = [[[0.0, 0.0, 0.0, 0.0] for _ in range(s)] for _ in range(s)]

    radius = 0.21  # 归一化圆角半径

    for y in range(s):
        for x in range(s):
            nx = (x + 0.5) / s
            ny = (y + 0.5) / s

            t = (nx * 0.25 + ny * 0.75)  # 斜向渐变
            base = tuple(C_TOP[i] + (C_BOTTOM[i] - C_TOP[i]) * t for i in range(3))

            cov = arrow_coverage(nx, ny)
            rgb = tuple(base[i] + (WHITE[i] - base[i]) * cov for i in range(3))
            alpha = rounded_rect_alpha(nx, ny, radius)

            acc[y][x] = [rgb[0], rgb[1], rgb[2], alpha]

    # 降采样
    out = bytearray()
    for y in range(size):
        for x in range(size):
            r = g = b = a = 0.0
            for dy in range(SS):
                for dx in range(SS):
                    p = acc[y * SS + dy][x * SS + dx]
                    r += p[0]
                    g += p[1]
                    b += p[2]
                    a += p[3]
            n = SS * SS
            out += bytes((
                int(round(r / n)),
                int(round(g / n)),
                int(round(b / n)),
                int(round(a / n * 255)),
            ))
    return out


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in (16, 32, 48, 128):
        path = os.path.join(OUT_DIR, "icon%d.png" % size)
        write_png(path, size, size, make_icon(size))
        print("wrote %s (%d bytes)" % (path, os.path.getsize(path)))


if __name__ == "__main__":
    main()
