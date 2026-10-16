package com.ktp.scanner;

import android.content.SharedPreferences;

/**
 * 「定位方式」这个偏好：读当前位置时按哪套坐标填进输入框。
 *
 * 为什么要有它：同一个点，WGS-84（手机 GPS 原始）和 GCJ-02（高德/腾讯的
 * 「火星坐标」）在国内相差 300~600 米。课堂派报的到底是哪一套，我无法从
 * 电脑上验证 —— 只能由用户在地图上核对后自己定，所以做成一个设置项。
 *
 * 只说「读当前位置」用哪套；**签到时报的是位置库里存的原样数值** ——
 * 用户填什么就报什么，这里不做任何隐式换算（不然没法排查问题）。
 */
final class CoordStore {

  static final String KEY = "coordMode";
  static final String GCJ = "gcj";
  static final String WGS = "wgs";
  /** 默认高德：课堂派是国内 App，用高德/腾讯 SDK 的占绝大多数 */
  static final String DEFAULT = GCJ;

  private CoordStore() {}

  static String mode(SharedPreferences prefs) {
    String m = prefs.getString(KEY, DEFAULT);
    return WGS.equals(m) ? WGS : GCJ;
  }

  static void setMode(SharedPreferences prefs, String mode) {
    prefs.edit().putString(KEY, WGS.equals(mode) ? WGS : GCJ).apply();
  }

  /** 按当前方式，从一次定位结果里取要用的经纬度。 */
  static String[] pick(SharedPreferences prefs, double wgsLat, double wgsLng) {
    if (WGS.equals(mode(prefs))) {
      return new String[] {fmt(wgsLat), fmt(wgsLng)};
    }
    double[] g = Coord.wgs2gcj(wgsLat, wgsLng);
    return new String[] {fmt(g[0]), fmt(g[1])};
  }

  static String fmt(double v) {
    return String.format(java.util.Locale.US, "%.6f", v);
  }
}
