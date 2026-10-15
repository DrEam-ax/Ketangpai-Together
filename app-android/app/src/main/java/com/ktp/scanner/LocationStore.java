package com.ktp.scanner;

import android.content.SharedPreferences;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 保存的签到位置 —— 像「添加成员」那样：起个名字、存下来、选一个用、不想要就删。
 *
 * 为什么需要它：定位签到要报教室坐标，而一个学生往往有好几门课、
 * 教室不止一个（还有宿舍、实训楼…）。每次手输经纬度不现实。
 *
 * 存储结构（SharedPreferences）：
 *   locations      = [{"name":"二教305","lat":"39.904200","lng":"116.407400"}, ...]
 *   activeLocation = "二教305"    ← 当前生效的那个
 *
 * 签到时报的是**当前生效位置的原样数值**，不做任何坐标转换 ——
 * 用户填什么就是什么（转换只在「读当前位置」那一步提供参考，见 Coord）。
 */
final class LocationStore {

  static final String KEY_LIST = "locations";
  static final String KEY_ACTIVE = "activeLocation";
  static final int MAX_NAME = 20;
  static final int MAX_COUNT = 30;

  private LocationStore() {}

  static JSONArray list(SharedPreferences prefs) {
    try {
      return new JSONArray(prefs.getString(KEY_LIST, "[]"));
    } catch (Exception e) {
      return new JSONArray();
    }
  }

  /** 当前生效的位置；没有就返回 null。 */
  static JSONObject active(SharedPreferences prefs) {
    String name = prefs.getString(KEY_ACTIVE, "");
    if (name == null || name.isEmpty()) return null;
    JSONArray arr = list(prefs);
    for (int i = 0; i < arr.length(); i++) {
      JSONObject o = arr.optJSONObject(i);
      if (o != null && name.equals(o.optString("name"))) return o;
    }
    return null;
  }

  /** 新增或覆盖同名位置，并自动设为生效。 */
  static void add(SharedPreferences prefs, String name, String lat, String lng) throws Exception {
    String n = name == null ? "" : name.trim();
    if (n.isEmpty()) throw new Exception("备注名不能为空");
    if (n.length() > MAX_NAME) throw new Exception("备注名最长 " + MAX_NAME + " 个字");
    if (n.contains("|")) throw new Exception("备注名不能包含 | 符号");

    double la = Double.parseDouble(String.valueOf(lat).trim());
    double ln = Double.parseDouble(String.valueOf(lng).trim());
    if (la < -90 || la > 90 || ln < -180 || ln > 180) throw new Exception("坐标超出范围");

    JSONArray arr = list(prefs);
    JSONArray out = new JSONArray();
    boolean replaced = false;
    for (int i = 0; i < arr.length(); i++) {
      JSONObject o = arr.optJSONObject(i);
      if (o == null) continue;
      if (n.equals(o.optString("name"))) {
        replaced = true;
      } else {
        out.put(o);
      }
    }
    if (!replaced && out.length() >= MAX_COUNT) {
      throw new Exception("最多存 " + MAX_COUNT + " 个位置");
    }

    JSONObject item = new JSONObject();
    item.put("name", n);
    item.put("lat", String.format(java.util.Locale.US, "%.6f", la));
    item.put("lng", String.format(java.util.Locale.US, "%.6f", ln));
    out.put(item);

    prefs.edit().putString(KEY_LIST, out.toString()).putString(KEY_ACTIVE, n).apply();
  }

  static void remove(SharedPreferences prefs, String name) {
    JSONArray arr = list(prefs);
    JSONArray out = new JSONArray();
    for (int i = 0; i < arr.length(); i++) {
      JSONObject o = arr.optJSONObject(i);
      if (o == null) continue;
      if (!name.equals(o.optString("name"))) out.put(o);
    }
    SharedPreferences.Editor ed = prefs.edit().putString(KEY_LIST, out.toString());
    if (name.equals(prefs.getString(KEY_ACTIVE, ""))) ed.putString(KEY_ACTIVE, "");
    ed.apply();
  }

  static void setActive(SharedPreferences prefs, String name) {
    prefs.edit().putString(KEY_ACTIVE, name == null ? "" : name).apply();
  }

  /** 签到时要报的坐标；没有任何位置时返回 null。 */
  static double[] activeCoords(SharedPreferences prefs) {
    JSONObject a = active(prefs);
    if (a != null) {
      try {
        return new double[] {
          Double.parseDouble(a.optString("lat")), Double.parseDouble(a.optString("lng"))
        };
      } catch (Exception ignored) {
      }
    }
    // 兼容 0.5.x 存下来的单组坐标
    String lat = prefs.getString(CheckinHelper.PREF_LAT, "");
    String lng = prefs.getString(CheckinHelper.PREF_LNG, "");
    if (lat != null && !lat.isEmpty() && lng != null && !lng.isEmpty()) {
      try {
        return new double[] {Double.parseDouble(lat), Double.parseDouble(lng)};
      } catch (Exception ignored) {
      }
    }
    return null;
  }
}
