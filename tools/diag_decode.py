"""诊断：对一张图尝试多种预处理，看哪种能解出二维码。用法: python tools/diag_decode.py <图片>"""
import sys

import cv2
import numpy as np

img = cv2.imread(sys.argv[1])
print(f"图像 {img.shape[1]}x{img.shape[0]}")
print(f"opencv {cv2.__version__}, 有 wechat_qrcode: {hasattr(cv2, 'wechat_qrcode_WeChatQRCode')}")

det = cv2.QRCodeDetector()
wechat = None
try:
    wechat = cv2.wechat_qrcode_WeChatQRCode()
except Exception as exc:
    print(f"wechat 检测器不可用: {exc}")


def attempt(name, image):
    if image is None:
        return False
    if image.ndim == 2:
        image = cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    text = None
    try:
        ok, decoded, _p, _ = det.detectAndDecodeMulti(image)
        if ok and decoded:
            text = next((d for d in decoded if d), None)
    except Exception:
        pass
    if not text:
        try:
            t, _p, _ = det.detectAndDecode(image)
            text = t or None
        except Exception:
            pass
    if not text and wechat is not None:
        try:
            texts, _p = wechat.detectAndDecode(image)
            text = next((t for t in texts if t), None)
        except Exception:
            pass
    print(f"  {'OK  ' if text else 'FAIL'} {name}" + (f"  -> {text[:90]}" if text else ""))
    return bool(text)


gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
found = False

print("\n--- 原图 ---")
found |= attempt("原图", img)
found |= attempt("灰度", gray)

print("\n--- Otsu 二值化 ---")
_, otsu = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
found |= attempt("Otsu", otsu)

print("\n--- 自适应二值化（不同窗口）---")
for block in (11, 21, 31, 51, 71):
    for cval in (3, 8):
        th = cv2.adaptiveThreshold(gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, block, cval)
        found |= attempt(f"adaptive block={block} C={cval}", th)

print("\n--- 放大后再二值化 ---")
for fx in (2, 3):
    big = cv2.resize(gray, None, fx=fx, fy=fx, interpolation=cv2.INTER_CUBIC)
    found |= attempt(f"resize x{fx}", big)
    _, o = cv2.threshold(big, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    found |= attempt(f"resize x{fx} + Otsu", o)

print("\n--- 对比度增强 / 锐化 ---")
clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(gray)
found |= attempt("CLAHE", clahe)
blur = cv2.GaussianBlur(gray, (0, 0), 3)
sharp = cv2.addWeighted(gray, 1.6, blur, -0.6, 0)
found |= attempt("锐化", sharp)

print(f"\n结论: {'有可行方案' if found else '全部失败'}")
