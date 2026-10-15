package com.ktp.scanner;

/**
 * 坐标系转换：WGS-84（GPS 原始）↔ GCJ-02（中国「火星坐标」）。
 *
 * 为什么需要它：
 *   手机 LocationManager 给的是 **WGS-84**，而高德/腾讯地图（以及国内绝大多数
 *   App 的定位 SDK）用的是 **GCJ-02**。两者在国内相差 **300~600 米** ——
 *   在大地图上就是"我明明站在这儿，标记却在几条街外"。
 *
 *   课堂派是国内 App，它的定位签到极可能存的是 GCJ-02。
 *   那我们报 WGS-84 就会整体偏几百米，可能直接掉出签到半径（通常 200 米）。
 *
 * 用的是公开的标准算法（与各大地图 SDK 的实现一致）。
 * 单元测试见 tools/coord-test/CoordTest.java。
 */
final class Coord {

  /** 长半轴（克拉索夫斯基椭球） */
  private static final double A = 6378245.0;
  /** 偏心率平方 */
  private static final double EE = 0.00669342162296594323;

  private Coord() {}

  /** 中国大陆粗略范围之外不做偏移（境外地图本来就不偏移）。 */
  static boolean outOfChina(double lat, double lng) {
    return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
  }

  /** WGS-84 → GCJ-02 */
  static double[] wgs2gcj(double lat, double lng) {
    if (outOfChina(lat, lng)) return new double[] {lat, lng};
    double dLat = transformLat(lng - 105.0, lat - 35.0);
    double dLng = transformLng(lng - 105.0, lat - 35.0);
    double radLat = lat / 180.0 * Math.PI;
    double magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    double sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * Math.PI);
    dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * Math.PI);
    return new double[] {lat + dLat, lng + dLng};
  }

  /**
   * GCJ-02 → WGS-84（迭代逼近）。
   * 严格解没有闭式公式，就用「偏移量反过来减」迭代几次，误差可以到厘米级。
   */
  static double[] gcj2wgs(double lat, double lng) {
    if (outOfChina(lat, lng)) return new double[] {lat, lng};
    double wLat = lat;
    double wLng = lng;
    for (int i = 0; i < 8; i++) {
      double[] g = wgs2gcj(wLat, wLng);
      double dLat = g[0] - lat;
      double dLng = g[1] - lng;
      if (Math.abs(dLat) < 1e-9 && Math.abs(dLng) < 1e-9) break;
      wLat -= dLat;
      wLng -= dLng;
    }
    return new double[] {wLat, wLng};
  }

  /** 两点距离（米），球面近似 —— 用来判断"偏了多少"。 */
  static double meters(double lat1, double lng1, double lat2, double lng2) {
    double R = 6371000;
    double dLat = (lat2 - lat1) * Math.PI / 180;
    double dLng = (lng2 - lng1) * Math.PI / 180;
    double la = lat1 * Math.PI / 180;
    double x = dLng * Math.cos(la);
    return Math.sqrt(dLat * dLat + x * x) * R;
  }

  private static double transformLat(double x, double y) {
    double ret =
        -100.0
            + 2.0 * x
            + 3.0 * y
            + 0.2 * y * y
            + 0.1 * x * y
            + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin(y / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * Math.PI) + 320 * Math.sin(y * Math.PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }

  private static double transformLng(double x, double y) {
    double ret =
        300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin(x / 3.0 * Math.PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * Math.PI) + 300.0 * Math.sin(x / 30.0 * Math.PI)) * 2.0 / 3.0;
    return ret;
  }
}
