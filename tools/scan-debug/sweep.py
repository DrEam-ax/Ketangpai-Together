"""
对「真机扫不上的那一帧」做预处理扫描，找出哪种处理能把它救活。

背景：用户实测，某个距离上微信能扫、我们的 App（ZXing + ML Kit 两套检测器）都扫不上。
把 App 存的原始帧拿下来后，zxing-cpp 和 OpenCV 也解不出 —— 说明不是 App 代码问题，
是这一帧本身处在解码极限。这个脚本要回答的是：**到底缺什么**。

跑法: python tools/scan-debug/sweep.py
"""
import itertools
import os

import cv2
import numpy as np
import zxingcpp

HERE = os.path.dirname(os.path.abspath(__file__))
FRAME = os.path.join(HERE, "frame.jpg")


def try_decode(img, label, results):
    """用 zxing-cpp 试解；成功就记下来。"""
    try:
        found = zxingcpp.read_barcodes(img)
    except Exception as e:  # noqa: BLE001
        results.append((label, "ERR " + str(e)[:40]))
        return False
    for r in found:
        if r.text:
            results.append((label, "OK  " + r.text[:60]))
            return True
    return False


def unsharp(gray, amount=1.0, radius=3):
    blur = cv2.GaussianBlur(gray, (0, 0), radius)
    return cv2.addWeighted(gray, 1 + amount, blur, -amount, 0)


def normalize_background(gray, win_frac=0.5):
    """平场校正：像素除以大窗口局部均值，消除光照/反光不均（借鉴 food-reminder 的做法）。"""
    h, w = gray.shape
    win = max(9, int(min(w, h) * win_frac) | 1)
    bg = cv2.blur(gray.astype(np.float32), (win, win))
    bg = np.maximum(bg, 1.0)
    return np.clip(gray.astype(np.float32) / bg * 128.0, 0, 255).astype(np.uint8)


def main():
    img = cv2.imread(FRAME)
    if img is None:
        raise SystemExit("读不到 " + FRAME)
    print(f"原始帧 {img.shape[1]}x{img.shape[0]}")

    # 二维码大致位置（按 864x1920 估的），多留点边
    x0, y0, x1, y1 = 220, 500, 590, 885
    region = img[y0:y1, x0:x1]
    gray0 = cv2.cvtColor(region, cv2.COLOR_BGR2GRAY)

    srcs = {
        "原帧": cv2.cvtColor(img, cv2.COLOR_BGR2GRAY),
        "裁剪": gray0,
    }

    results = []

    # 1) 先看基础情况
    for name, g in srcs.items():
        for sc in (1, 2, 3, 4, 6):
            if sc == 1:
                up = g
            else:
                up = cv2.resize(g, None, fx=sc, fy=sc, interpolation=cv2.INTER_CUBIC)
            if try_decode(up, f"{name} 放大{sc}x", results):
                pass

    print("\n=== 基础放大 ===")
    for lbl, res in results:
        print(f"  {lbl:28} {res}")

    results2 = []
    # 2) 各种预处理 x 放大倍数
    for name, g in srcs.items():
        variants = {
            "unsharp": unsharp(g, 1.2, 2.0),
            "CLAHE": cv2.createCLAHE(3.0, (8, 8)).apply(g),
            "平场校正": normalize_background(g),
            "平场+unsharp": unsharp(normalize_background(g), 1.2, 2.0),
            "Otsu": cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1],
            "自适应51": cv2.adaptiveThreshold(
                g, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 51, 10
            ),
            "自适应31": cv2.adaptiveThreshold(
                g, 255, cv2.ADAPTIVE_THRESH_MEAN_C, cv2.THRESH_BINARY, 31, 10
            ),
            "中值+Otsu": cv2.threshold(
                cv2.medianBlur(g, 3), 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU
            )[1],
        }
        for vname, v in variants.items():
            for sc in (1, 2, 3, 4):
                up = v if sc == 1 else cv2.resize(v, None, fx=sc, fy=sc, interpolation=cv2.INTER_CUBIC)
                try_decode(up, f"{name} {vname} {sc}x", results2)

    print("\n=== 预处理组合 ===")
    if not results2:
        print("  全部失败")
    for lbl, res in results2:
        print(f"  {lbl:30} {res}")

    # 3) 估算模块数：用定位图案的宽度反推
    g = gray0
    _, bw = cv2.threshold(g, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # 沿穿过左上定位图案的行扫描 1:1:3:1:1
    h, w = bw.shape
    best = None
    for y in range(int(h * 0.03), int(h * 0.2)):
        row = bw[y] // 255
        runs = []
        cur, cnt = row[0], 0
        for v in row:
            if v == cur:
                cnt += 1
            else:
                runs.append((cur, cnt))
                cur, cnt = v, 1
        runs.append((cur, cnt))
        # 找 5 段黑-白-黑-白-黑 且比例接近 1:1:3:1:1
        for i in range(len(runs) - 4):
            seg = runs[i : i + 5]
            if [s[0] for s in seg] != [0, 1, 0, 1, 0]:
                continue
            c = [s[1] for s in seg]
            m = sum(c) / 7.0
            if m < 1:
                continue
            if all(abs(c[k] - m * r) < m * 0.6 for k, r in enumerate([1, 1, 3, 1, 1])):
                qr_w = sum(c) * 0  # 占位
                if best is None or m > best[0]:
                    best = (m, c, y)
    if best:
        m, c, y = best
        print(f"\n=== 模块尺寸估算 ===\n  定位图案 runs={c}  模块≈{m:.2f}px  行 y={y}")
        print(f"  二维码宽约 {gray0.shape[1]}px -> 约 {gray0.shape[1]/m:.0f} 个模块")
    else:
        print("\n=== 模块尺寸估算 === 没找到定位图案（这本身就说明对比度/清晰度不够）")


if __name__ == "__main__":
    main()
