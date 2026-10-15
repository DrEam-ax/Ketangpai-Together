package com.ktp.scanner;

import android.content.Context;
import android.content.SharedPreferences;
import org.json.JSONObject;

/**
 * 定位签到（type=2）的提交逻辑，App 内的按钮和通知上的按钮共用。
 *
 * 关键事实（实验在 tools/exp-gps-now.ts / exp-gps-real.ts）：
 *   **定位签到的坐标就是请求体里的普通参数，服务端直接接受** ——
 *   不需要手机 GPS、不需要影梭改定位、也不需要把微信塞进虚拟机。
 *   那些手段是为了骗**官方客户端**（它读系统定位，微信还额外做了防模拟位置检测），
 *   而我们是自己发请求，坐标想填什么就填什么。
 *
 * ⚠️ 但有一点**我在电脑上无法确认**，必须真机实测：
 *   真实场景里老师建定位签到时，目标位置是老师端 GPS 自动带上的
 *   （接口层设不上 —— 试了 6 种建参写法 getLocation 都返回 centerPoint=null）。
 *   所以我造不出「有目标位置」的签到，也就无法证明服务器到底按不按距离校验。
 *   我的 8 次提交（含 0,0 和北京坐标）全部成功，但那可能是因为签到里没有目标位置。
 *   结论：**先拿去真实课堂试一次**（真失败的话，说明它确实校验距离，
 *   那就必须填教室的真实坐标；实在不行还可以让在教室的同学帮扫）。
 */
final class CheckinHelper {

  static final String PREF_LAT = "roomLat";
  static final String PREF_LNG = "roomLng";

  private CheckinHelper() {}

  /** 用已保存的位置，给指定的定位签到提交一次。 */
  static JSONObject signLocation(Context ctx, String attenceId) {
    try {
      SharedPreferences prefs = ctx.getSharedPreferences(MonitorService.PREFS, Context.MODE_PRIVATE);
      double[] coords = LocationStore.activeCoords(prefs);
      if (coords == null) {
        return err("还没有可用的位置 —— 在「签到位置」里存一个，或点「读当前位置」");
      }
      String lat = String.format(java.util.Locale.US, "%.6f", coords[0]);
      String lng = String.format(java.util.Locale.US, "%.6f", coords[1]);

      JSONObject acc = KtpApi.primaryAccount(prefs);
      if (acc == null) return err("还没选主成员");
      String ip = KtpApi.ipForAccount(prefs, acc);
      String token = KtpApi.ensureToken(prefs, acc, ip);

      JSONObject body = new JSONObject();
      body.put("id", attenceId);
      body.put("code", "");
      body.put("unusual", "");
      body.put("latitude", lat);
      body.put("longitude", lng);
      body.put("accuracy", "30");
      body.put("clienttype", 1);

      JSONObject res = KtpApi.call("/AttenceApi/checkin", body, token, ip);
      JSONObject data = res.optJSONObject("data");
      int state = data == null ? -1 : data.optInt("state", -1);
      boolean ok = state == 1;

      JSONObject out = new JSONObject();
      out.put("ok", ok);
      out.put("state", state);
      out.put("message", res.optString("message", ok ? "签到成功" : "签到失败"));
      out.put("lat", lat);
      out.put("lng", lng);
      JSONObject a = LocationStore.active(prefs);
      out.put("place", a == null ? "" : a.optString("name", ""));
      return out;
    } catch (Exception e) {
      return err(String.valueOf(e.getMessage()));
    }
  }

  private static JSONObject err(String message) {
    JSONObject o = new JSONObject();
    try {
      o.put("ok", false);
      o.put("message", message);
    } catch (Exception ignored) {
    }
    return o;
  }
}
