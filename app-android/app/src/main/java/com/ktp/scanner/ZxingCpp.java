package com.ktp.scanner;

/**
 * zxing-cpp 的 JNI 入口。
 *
 * 为什么专门编一个原生解码库进来（详见 tools/scan-debug/ 的实验）：
 * 课堂派投在屏幕上的二维码是「高密度 + 屏幕摩尔纹 + 反光」的组合。
 * 在同一张真实失败帧上实测：
 *   - ZXing Java 3.5.3（原方案）：放大 1~5 倍 × 平场校正/锐化/Otsu/中值 × 白边，
 *     共 120 种组合**全部解不出**，连 PURE_BARCODE 通路也不行
 *   - zxing-cpp：**原分辨率就能解**（用固定阈值二值化时）
 * 所以这不是调参问题，是解码库的代差。
 *
 * 二值化模式（实测这张帧只有固定阈值能解，局部自适应会把模块毁掉）：
 *   0 = FixedThreshold   1 = LocalAverage   2 = GlobalHistogram
 *
 * 加载失败时所有方法都返回 null，不影响其它解码路径 —— 原生库永远不该让 App 崩。
 */
final class ZxingCpp {

  private static volatile boolean loadTried = false;
  private static volatile boolean loaded = false;

  private ZxingCpp() {}

  static synchronized boolean available() {
    if (!loadTried) {
      loadTried = true;
      try {
        System.loadLibrary("ktpzxing");
        loaded = true;
      } catch (Throwable t) {
        loaded = false;
      }
    }
    return loaded;
  }

  /** @param lum 单通道亮度（长度至少 width*height） @return 解出的文本，失败返回 null */
  static String decode(byte[] lum, int width, int height, int binarizerMode) {
    if (!available() || lum == null || width <= 0 || height <= 0) return null;
    try {
      if (lum.length < width * height) return null;
      return decodeLum(lum, width, height, binarizerMode);
    } catch (Throwable t) {
      return null;
    }
  }

  private static native String decodeLum(byte[] lum, int width, int height, int binarizerMode);
}
