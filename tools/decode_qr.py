"""
从图片里识别二维码内容。

三个引擎叠加，按「先快后准」的顺序：
  1. zxing-cpp  —— 最鲁棒（对拍屏幕/斜角/低对比度最好）
  2. OpenCV QRCodeDetector —— 内置，无需额外依赖
并配合多种预处理（缩放、Otsu、自适应二值化、中值滤波去摩尔纹）。

用法:
  python tools/decode_qr.py <图片路径> [...]     从文件识别
  python tools/decode_qr.py -                   从 stdin 读图片字节（摄像头逐帧扫描用）
  python tools/decode_qr.py <路径> --fast        只试最快的一两种，用于逐帧扫描
  python tools/decode_qr.py <路径> --verbose     把命中的方案打到 stderr
输出:
  JSON 数组（识别到的字符串，通常 0 或 1 个）
"""
import json
import sys

import cv2
import numpy as np

try:
    import zxingcpp
except ImportError:  # 没装也不影响，OpenCV 顶上
    zxingcpp = None


# ----------------------------------------------------------------- 引擎

def _try_zxing(image):
    if zxingcpp is None:
        return None
    try:
        results = zxingcpp.read_barcodes(image)
    except Exception:
        return None
    for r in results:
        if getattr(r, "text", None):
            return r.text
    return None


_DETECTOR = cv2.QRCodeDetector()


def _try_opencv(image):
    try:
        ok, decoded, _points, _ = _DETECTOR.detectAndDecodeMulti(image)
        if ok and decoded:
            for d in decoded:
                if d:
                    return d
    except Exception:
        pass
    try:
        text, _points, _ = _DETECTOR.detectAndDecode(image)
        if text:
            return text
    except Exception:
        pass
    return None


# ----------------------------------------------------------------- 预处理

def _variants(gray, fast=False):
    """产出 (名字, 灰度图)。顺序 = 从最可能成功且最便宜的排起。"""
    yield "原图", gray

    # 很多二维码识别失败是因为没有留白（quiet zone）。
    # 反过来主动补一圈白边，往往比裁剪更能救回紧贴边缘的图。
    pad = max(16, int(min(gray.shape[:2]) * 0.06))
    yield "加白边", cv2.copyMakeBorder(gray, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=255)

    height, width = gray.shape[:2]

    if width > 1600:
        scale = 1600 / width
        yield "缩小1600", cv2.resize(
            gray, (1600, max(1, int(height * scale))), interpolation=cv2.INTER_AREA
        )

    if not fast and width < 1200:
        yield "放大2x", cv2.resize(gray, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC)

    yield "Otsu", cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]

    # 拍屏幕的图经常亮度渐变，需要「大窗口」自适应二值化才切得干净
    # （用户发来的两张课堂派截图就是只有 block>=51 才解得出来）
    yield "自适应51", cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 51, 8
    )

    if fast:
        return

    yield "自适应31", cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 8
    )
    yield "自适应71", cv2.adaptiveThreshold(
        gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 71, 8
    )

    # 拍屏幕常见的摩尔纹：先中值滤波再去噪二值化
    denoised = cv2.medianBlur(gray, 3)
    yield "中值+Otsu", cv2.threshold(denoised, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)[1]

    # 对比度拉伸
    yield "CLAHE", cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(gray)


# ----------------------------------------------------------------- 主流程

def decode_image(image, fast=False, verbose=False):
    if image is None:
        return []

    if image.ndim == 3:
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        gray = image

    for name, variant in _variants(gray, fast=fast):
        bgr = cv2.cvtColor(variant, cv2.COLOR_GRAY2BGR)

        for engine, fn in (("zxing", _try_zxing), ("opencv", _try_opencv)):
            text = fn(bgr)
            if text:
                if verbose:
                    print(f"命中: {name} / {engine}", file=sys.stderr)
                return [text]

    return []


def load_image(src):
    if src == "-":
        raw = sys.stdin.buffer.read()
        if not raw:
            return None
        return cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    return cv2.imread(src)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    fast = "--fast" in sys.argv
    verbose = "--verbose" in sys.argv

    if not args:
        print("用法: python tools/decode_qr.py <图片路径> [...] | - [--fast] [--verbose]", file=sys.stderr)
        return 2

    results = []
    for src in args:
        results.extend(decode_image(load_image(src), fast=fast, verbose=verbose))

    print(json.dumps(results, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
