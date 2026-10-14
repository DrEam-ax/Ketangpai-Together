"""
模拟「教室里用手机拍大屏幕」的恶劣条件：透视畸变 + 模糊 + 亮度不均 + JPEG 压缩。
用来验证 jsQR 失败时 OpenCV 兜底是否真的有用。

用法: python tools/make_qr_photo.py <干净二维码图> <输出图>
"""
import sys

import cv2
import numpy as np


def main():
    src_path, dst_path = sys.argv[1], sys.argv[2]
    qr = cv2.imread(src_path, cv2.IMREAD_GRAYSCALE)
    h, w = qr.shape[:2]

    canvas = np.full((900, 1600), 45, np.uint8)
    canvas[300 : 300 + h, 520 : 520 + w] = qr

    src = np.float32([[520, 300], [520 + w, 300], [520 + w, 300 + h], [520, 300 + h]])
    dst = np.float32([[470, 335], [520 + w + 15, 285], [520 + w - 5, 300 + h + 30], [530, 300 + h - 10]])
    matrix = cv2.getPerspectiveTransform(src, dst)
    out = cv2.warpPerspective(canvas, matrix, (1600, 900))

    out = cv2.GaussianBlur(out, (3, 3), 0)

    # 亮度不均（投影仪/闪光灯效果）
    rows, cols = out.shape
    gradient = np.linspace(0.75, 1.15, cols).reshape(1, cols).repeat(rows, axis=0)
    out = np.clip(out.astype(np.float32) * gradient + 18, 0, 255).astype(np.uint8)

    # 噪声
    noise = np.random.normal(0, 7, out.shape).astype(np.float32)
    out = np.clip(out.astype(np.float32) + noise, 0, 255).astype(np.uint8)

    cv2.imwrite(dst_path, out, [int(cv2.IMWRITE_JPEG_QUALITY), 55])
    print(f"已生成 {dst_path} ({out.shape[1]}x{out.shape[0]})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
