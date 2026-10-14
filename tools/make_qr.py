"""生成测试用二维码图片（用于验证解码链路）。用法: python tools/make_qr.py <内容> <输出路径>"""
import sys

import cv2
import numpy as np


def main():
    text = sys.argv[1]
    out = sys.argv[2]

    encoder = cv2.QRCodeEncoder_create()
    result = encoder.encode(text)
    qr = result[1] if isinstance(result, (tuple, list)) and len(result) > 1 else result
    if qr is None or getattr(qr, "size", 0) == 0:
        print(f"encode 失败: {result}", file=sys.stderr)
        return 1

    # OpenCV 输出是单通道（白底黑块或黑底白块），统一成白底黑块
    if qr.mean() < 127:
        qr = 255 - qr

    qr = np.pad(qr, 4, constant_values=255)
    qr = cv2.resize(qr, None, fx=8, fy=8, interpolation=cv2.INTER_NEAREST)
    cv2.imwrite(out, qr)
    print(f"已生成 {out}  ({qr.shape[1]}x{qr.shape[0]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
