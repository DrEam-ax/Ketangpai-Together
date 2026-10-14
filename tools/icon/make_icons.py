"""
从一张「成品 App 图标」图里生成 Android 图标资源。

源图特点：深色圆角方块 + 四周白底 + 右下角有"豆包AI生成"水印（在白底上，裁掉即可）。

生成内容：
  1. 自适应图标（API 26+）：
     - mipmap-anydpi-v26/ic_launcher.xml / ic_launcher_round.xml
     - mipmap-*/ic_launcher_foreground.png  （作品缩到 66% 安全区，四周用同色填充）
     - values/colors.xml 里的 ic_launcher_background
  2. 老系统（API 24/25）的传统图标：
     - mipmap-*/ic_launcher.png        （保留圆角，方角外部透明）
     - mipmap-*/ic_launcher_round.png  （圆形裁剪）

用法: python tools/icon/make_icons.py
"""
import os
import sys

import cv2
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SRC = os.path.join(ROOT, "tools", "icon", "source.jpg")
RES = os.path.join(ROOT, "app-android", "app", "src", "main", "res")

# 传统图标各密度尺寸
LEGACY = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
# 自适应图标前景（108dp）在各密度的像素尺寸
FOREGROUND = {"xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}


def load_square():
    """裁出图标本体，并返回 (方形作品, 外部区域掩码)。"""
    img = cv2.imread(SRC)
    if img is None:
        sys.exit(f"读不到 {SRC}")
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    dark = (gray < 150).astype(np.uint8) * 255
    contours, _ = cv2.findContours(dark, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        sys.exit("没找到图标区域")
    x, y, w, h = cv2.boundingRect(max(contours, key=cv2.contourArea))

    # 取正方形（含阴影会略高），以中心为准
    size = max(w, h)
    cx, cy = x + w // 2, y + h // 2
    half = size // 2
    top = max(0, cy - half)
    left = max(0, cx - half)
    sq = img[top : top + size, left : left + size].copy()
    if sq.shape[0] != size or sq.shape[1] != size:
        sq = cv2.resize(sq, (size, size), interpolation=cv2.INTER_CUBIC)

    # 用 flood fill 找出「与图像边缘相连的白区」——
    # 不能用 gray>235 直接当掩码，那样作品内部的白（手机机身、二维码底、对勾）也会被误填。
    #
    # 注意必须加 FLOODFILL_FIXED_RANGE：默认模式是「和相邻像素比」，
    # 会顺着白→灰→蓝的渐变一路蔓延，把整张图都判成外部（踩过，97% 像素被误判）。
    # 固定范围模式是「和种子像素比」，就只会吃掉真正的白底。
    s = sq.shape[0]
    fill_mask = np.zeros((s + 2, s + 2), np.uint8)
    work = cv2.cvtColor(sq, cv2.COLOR_BGR2GRAY).copy()
    for seed in [(0, 0), (s - 1, 0), (0, s - 1), (s - 1, s - 1)]:
        cv2.floodFill(
            work,
            fill_mask,
            seed,
            0,
            loDiff=40,
            upDiff=40,
            flags=8 | (255 << 8) | cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE,
        )
    outside = fill_mask[1:-1, 1:-1]
    ratio = float((outside > 0).sum()) / (s * s)
    print(f"外部区域占比 {ratio:.1%}（应该只有百分之几，接近 100% 说明 flood fill 蔓延了）")
    if ratio > 0.35:
        sys.exit("flood fill 蔓延过度，掩码不可信，已中止")

    # 圆角外那块直接用「边缘背景色」填平（比 inpaint 可控：
    # inpaint 会跟白底混合出偏灰的颜色，铺到自适应图标上会有四块亮斑）。
    bg = edge_color(sq, outside)
    squared = sq.copy()
    squared[outside > 0] = bg
    return sq, squared, outside, bg


def edge_color(sq, outside):
    """取「圆角矩形内、紧贴边缘」一圈的中位色，作为背景色 / 圆角填充色。
    只统计 inside 区域，避免把白底算进去；边缘可能有一圈高光，所以用中位数。"""
    s = sq.shape[0]
    lo, hi = int(s * 0.03), int(s * 0.075)
    inside = outside == 0
    strips = [
        (sq[lo:hi, lo : s - lo], inside[lo:hi, lo : s - lo]),
        (sq[s - hi : s - lo, lo : s - lo], inside[s - hi : s - lo, lo : s - lo]),
        (sq[lo : s - lo, lo:hi], inside[lo : s - lo, lo:hi]),
        (sq[lo : s - lo, s - hi : s - lo], inside[lo : s - lo, s - hi : s - lo]),
    ]
    pixels = [img[mask] for img, mask in strips if mask.any()]
    ring = np.concatenate(pixels)
    return np.median(ring, axis=0)  # BGR


def resized(img, size):
    return cv2.resize(img, (size, size), interpolation=cv2.INTER_AREA if img.shape[0] > size else cv2.INTER_CUBIC)


def write_png(path, img):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    cv2.imwrite(path, img)


def main():
    sq, squared, outside, bg = load_square()
    bg_hex = "#FF%02X%02X%02X" % (int(bg[2]), int(bg[1]), int(bg[0]))
    print(f"作品尺寸 {sq.shape[0]}px   背景色 {bg_hex}")

    # ---- 传统图标：保留圆角，外部透明 ----
    bgra = cv2.cvtColor(sq, cv2.COLOR_BGR2BGRA)
    bgra[:, :, 3] = np.where(outside > 0, 0, 255).astype(np.uint8)
    for dens, px in LEGACY.items():
        write_png(os.path.join(RES, f"mipmap-{dens}", "ic_launcher.png"), resized(bgra, px))

    # ---- 圆形传统图标：裁成圆 ----
    s = squared.shape[0]
    yy, xx = np.mgrid[0:s, 0:s]
    r = s / 2.0
    circle = ((xx - r + 0.5) ** 2 + (yy - r + 0.5) ** 2) <= (r - 1) ** 2
    round_img = cv2.cvtColor(squared, cv2.COLOR_BGR2BGRA)
    round_img[:, :, 3] = np.where(circle, 255, 0).astype(np.uint8)
    for dens, px in LEGACY.items():
        write_png(os.path.join(RES, f"mipmap-{dens}", "ic_launcher_round.png"), resized(round_img, px))

    # ---- 自适应图标前景 ----
    # 比例选 76% 是有讲究的，不是随便填的：
    #   作品的边缘有一圈亮光，落在画布 12%~88% 的位置；
    #   而启动器的遮罩（圆/圆角方）只显示中间约 17%~83%。
    #   → 亮边正好被裁掉，不会出现"方框套方框"；
    #   作品里那圈人像在 18%~82%，刚好完整保留。
    # 四周用背景色填平（作品四角也已填成同色，所以即使被露出来也看不出来）。
    bg_bgr = np.array([bg[0], bg[1], bg[2]], dtype=np.uint8)
    for dens, px in FOREGROUND.items():
        canvas = np.zeros((px, px, 3), np.uint8)
        canvas[:, :] = bg_bgr
        inner = int(px * 0.76)
        art = resized(squared, inner)
        off = (px - inner) // 2
        canvas[off : off + inner, off : off + inner] = art
        write_png(os.path.join(RES, f"mipmap-{dens}", "ic_launcher_foreground.png"), canvas)

    # ---- 自适应图标描述文件 + 背景色 ----
    adaptive = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
  <background android:drawable="@color/ic_launcher_background" />
  <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""
    for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
        p = os.path.join(RES, "mipmap-anydpi-v26", name)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        with open(p, "w", encoding="utf-8") as f:
            f.write(adaptive)

    colors = os.path.join(RES, "values", "colors.xml")
    os.makedirs(os.path.dirname(colors), exist_ok=True)
    with open(colors, "w", encoding="utf-8") as f:
        f.write(
            '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n'
            f'  <color name="ic_launcher_background">{bg_hex}</color>\n</resources>\n'
        )

    print("已生成：")
    for dens, px in sorted(LEGACY.items(), key=lambda kv: kv[1]):
        print(f"  mipmap-{dens}/ic_launcher.png ({px})  ic_launcher_round.png")
    for dens, px in sorted(FOREGROUND.items(), key=lambda kv: kv[1]):
        print(f"  mipmap-{dens}/ic_launcher_foreground.png ({px})")
    print("  mipmap-anydpi-v26/ic_launcher(.round).xml")
    print("  values/colors.xml")


if __name__ == "__main__":
    main()
