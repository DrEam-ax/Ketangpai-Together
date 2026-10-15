package com.ktp.scanner;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 课堂派签到 —— 独立客户端。
 *
 * 网络为什么必须走原生（而不是网页里的 fetch）：
 *   1) WebView 里 fetch 受 CORS 限制（openapiv5 不会给我们发 CORS 头）
 *   2) Fetch 规范把 Origin / Referer / Sec-* 列为禁止头，JS 设置了也会被静默丢弃，
 *      而课堂派恰好校验它们
 * 所以请求全部由 Java 侧 HttpURLConnection 发出，JS 只通过 bridge 调用。
 *
 * 扫码只有「实时扫」这一条路：点按钮进全屏原生扫码界面（ScanActivity）。
 *
 * ── 关于 IP 伪造（实测结论）────────────────────────────────────────────
 * 课堂派把 X-Forwarded-For 逐字记录，但**格式非法就记成 0.0.0.0**：
 *     203.0.113.77       -> 203.0.113.77
 *     223.104.137         -> 0.0.0.0   （只有 3 段，非法）
 *     203.0.113.77:1234  -> 0.0.0.0   （带端口，非法）
 *     192.168.1.5         -> 192.168.1.5（它不校验是否公网）
 *     X-Real-IP           -> 被忽略
 * 所以：必须补齐 4 段；并且给每个账号分配一个**固定**的假 IP，
 * 而不是每次签到都换（同一学生每次从不同省份签到，反而更可疑）。
 */
public class MainActivity extends Activity {

  private static final String API = "https://openapiv5.ketangpai.com";
  private static final String UA =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_1 like Mac OS X) AppleWebKit/605.1.15 "
          + "(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.56(0x18003835) NetType/WIFI Language/zh_CN";
  private static final int REQ_SCAN = 1001;
  private static final int REQ_NOTIF = 1002;
  private static final int REQ_LOCATION = 1003;
  private static final String NOTIFICATION_PERMISSION = "android.permission.POST_NOTIFICATIONS";
  /** 与 style.css 里的 --bg 保持一致，用于状态栏/导航栏区域 */
  private static final int PAGE_BG = 0xFF0F1116;

  /** IP 策略 */
  private static final String MODE_PER_ACCOUNT = "perAccount"; // 每账号固定一个假 IP（默认）
  private static final String MODE_SAME = "same"; // 所有账号共用一个假 IP
  private static final String MODE_REAL = "real"; // 不伪造，用真实出口 IP

  private WebView web;
  private SharedPreferences prefs;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    prefs = getSharedPreferences("ktp", MODE_PRIVATE);

    web = new WebView(this);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setAllowFileAccess(true);
    s.setLoadWithOverviewMode(true);
    s.setUseWideViewPort(true);
    web.setBackgroundColor(PAGE_BG);
    web.setWebViewClient(new WebViewClient());
    web.addJavascriptInterface(new Bridge(), "Android");
    web.loadUrl("file:///android_asset/www/index.html");

    // 必须套一层容器再把系统栏内边距加在容器上：
    // WebView 的内容由原生 AwContents 按 view 边界渲染，直接 setPadding 到 WebView 上是**无效**的
    // （这就是上一次改了却还遮挡的原因）。
    FrameLayout root = new FrameLayout(this);
    root.setBackgroundColor(PAGE_BG);
    root.addView(
        web,
        new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    setContentView(root);

    applyEdgeToEdge(root);
  }

  /**
   * 处理系统栏遮挡。
   *
   * targetSdk 35 (Android 15) 起边到边显示是强制的，内容会画到状态栏底下，
   * 所以必须自己把系统栏高度作为内边距让出来。
   */
  private void applyEdgeToEdge(final View root) {
    Window window = getWindow();

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      window.setDecorFitsSystemWindows(false);
      window.setStatusBarColor(Color.TRANSPARENT);
      window.setNavigationBarColor(Color.TRANSPARENT);
      WindowInsetsController c = window.getInsetsController();
      if (c != null) {
        // 深色背景 → 要浅色图标，所以把 LIGHT_*（深色图标）标志位清掉
        c.setSystemBarsAppearance(
            0,
            WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS);
      }
    } else {
      window.setStatusBarColor(Color.TRANSPARENT);
      window.setNavigationBarColor(Color.TRANSPARENT);
      window
          .getDecorView()
          .setSystemUiVisibility(
              View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                  | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                  | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    root.setOnApplyWindowInsetsListener(
        new View.OnApplyWindowInsetsListener() {
          @Override
          public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
            int left;
            int top;
            int right;
            int bottom;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
              android.graphics.Insets bars =
                  insets.getInsets(
                      WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
              left = bars.left;
              top = bars.top;
              right = bars.right;
              bottom = bars.bottom;
            } else {
              left = insets.getSystemWindowInsetLeft();
              top = insets.getSystemWindowInsetTop();
              right = insets.getSystemWindowInsetRight();
              bottom = insets.getSystemWindowInsetBottom();
            }

            // 兜底：我们上面已经显式要求边到边了，若某些 ROM 仍上报 0，
            // 就直接取系统资源里的状态栏高度，避免又被压住。
            if (top <= 0 && isStatusBarShown()) {
              int resId = getResources().getIdentifier("status_bar_height", "dimen", "android");
              if (resId > 0) top = getResources().getDimensionPixelSize(resId);
            }
            if (bottom <= 0) {
              int resId =
                  getResources().getIdentifier("navigation_bar_height", "dimen", "android");
              if (resId > 0 && hasNavBar()) bottom = getResources().getDimensionPixelSize(resId);
            }

            v.setPadding(left, top, right, bottom);
            return insets;
          }
        });
    root.requestApplyInsets();
  }

  private boolean isStatusBarShown() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      WindowInsets insets = getWindow().getDecorView().getRootWindowInsets();
      if (insets != null) {
        return insets.isVisible(WindowInsets.Type.statusBars());
      }
    }
    return true;
  }

  private boolean hasNavBar() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      WindowInsets insets = getWindow().getDecorView().getRootWindowInsets();
      if (insets != null) {
        return insets.isVisible(WindowInsets.Type.navigationBars());
      }
    }
    return false;
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode == REQ_SCAN) {
      if (resultCode == RESULT_OK && data != null) {
        String text = data.getStringExtra(ScanActivity.EXTRA_TEXT);
        if (text != null && !text.isEmpty()) {
          // 把"是谁认出来的"一起交给页面，方便排查"小二维码扫不上"卡在哪一环
          String source = data.getStringExtra(ScanActivity.EXTRA_SOURCE);
          if (source == null) source = "未知";
          callJs(
              "window.onScanResult("
                  + JSONObject.quote(text)
                  + ", "
                  + JSONObject.quote(source)
                  + ")");
          return;
        }
      }
      String error = data == null ? null : data.getStringExtra(ScanActivity.EXTRA_ERROR);
      if (error != null) callJs("window.onScanError(" + JSONObject.quote(error) + ")");
      else callJs("window.onScanCancelled()");
      return;
    }
    super.onActivityResult(requestCode, resultCode, data);
  }

  private void callJs(final String script) {
    new Handler(Looper.getMainLooper())
        .post(
            new Runnable() {
              @Override
              public void run() {
                web.evaluateJavascript(script, null);
              }
            });
  }

  @Override
  public void onBackPressed() {
    if (web.canGoBack()) web.goBack();
    else super.onBackPressed();
  }

  // ================================================================= IP 伪造
  // 生成/校验都在 IpUtil 里（纯 Java，可用 javac 单测：tools/ip-test/）

  private String ipMode() {
    return prefs.getString("ipMode", MODE_PER_ACCOUNT);
  }

  /** 通知权限是否已给（Android 13 以下默认给）。 */
  private boolean notificationsAllowed() {
    if (Build.VERSION.SDK_INT < 33) return true;
    return checkSelfPermission(NOTIFICATION_PERMISSION) == PackageManager.PERMISSION_GRANTED;
  }

  /** 定位权限是否已给（只用来「读当前位置填教室坐标」，签到本身不需要）。 */
  private boolean locationAllowed() {
    return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED
        || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
            == PackageManager.PERMISSION_GRANTED;
  }

  /** 给这次请求挑一个 IP；返回 null 表示不发送 X-Forwarded-For。 */
  private String ipForAccount(JSONObject acc) {
    String mode = ipMode();
    if (MODE_REAL.equals(mode)) return null;

    if (MODE_SAME.equals(mode)) {
      String shared = prefs.getString("sharedIp", "");
      if (shared == null || shared.isEmpty() || !IpUtil.isValidIpv4(shared)) {
        shared = IpUtil.randomIp();
        prefs.edit().putString("sharedIp", shared).apply();
      }
      return shared;
    }

    String ip = acc == null ? null : acc.optString("ip", "");
    if (ip == null || !IpUtil.isValidIpv4(ip)) {
      ip = IpUtil.randomIp();
      if (acc != null) {
        try {
          acc.put("ip", ip);
        } catch (Exception ignored) {
        }
      }
    }
    return ip;
  }

  // ================================================================= 桥

  public class Bridge {

    @JavascriptInterface
    public String listAccounts() {
      // 顺手修复历史数据：早期版本存下来的 IP 只有三段（非法），
      // 那会导致提交时这个头根本不发出去、服务端记下手机真实 IP。
      try {
        JSONArray arr = new JSONArray(prefs.getString("accounts", "[]"));
        boolean changed = false;
        for (int i = 0; i < arr.length(); i++) {
          JSONObject a = arr.getJSONObject(i);
          if (!IpUtil.isValidIpv4(a.optString("ip", ""))) {
            a.put("ip", IpUtil.randomIp());
            changed = true;
          }
        }
        if (changed) prefs.edit().putString("accounts", arr.toString()).apply();
        return arr.toString();
      } catch (Exception e) {
        return "[]";
      }
    }

    /** 打开全屏实时扫码界面。 */
    @JavascriptInterface
    public void startScan() {
      new Handler(Looper.getMainLooper())
          .post(
              new Runnable() {
                @Override
                public void run() {
                  startActivityForResult(
                      new Intent(MainActivity.this, ScanActivity.class), REQ_SCAN);
                }
              });
    }

    /** 添加账号：先真的登录一次验证，成功才存；同时分配一个固定的假 IP。 */
    @JavascriptInterface
    public String addAccount(String key, String email, String password) {
      JSONObject out = new JSONObject();
      try {
        JSONObject body = new JSONObject();
        body.put("email", email);
        body.put("password", password);
        body.put("remember", "1");
        body.put("source_type", 1);
        body.put("reqtimestamp", System.currentTimeMillis());

        JSONObject res = post("/UserApi/login", body, null, null);
        JSONObject data = res.optJSONObject("data");
        String token = data == null ? null : data.optString("token", null);
        if (token == null || token.isEmpty()) {
          out.put("ok", false);
          out.put("error", res.optString("message", "登录失败"));
          return out.toString();
        }

        JSONObject info = post("/UserApi/getUserInfo", new JSONObject(), token, null);
        JSONObject d = info.optJSONObject("data");
        String name = d == null ? key : d.optString("username", key);
        String school = d == null ? "" : d.optString("school", "");

        JSONArray arr = new JSONArray(prefs.getString("accounts", "[]"));
        JSONArray next = new JSONArray();
        String keptIp = null;
        for (int i = 0; i < arr.length(); i++) {
          JSONObject a = arr.getJSONObject(i);
          if (key.equals(a.optString("key"))) keptIp = a.optString("ip", null);
          else next.put(a);
        }
        JSONObject acc = new JSONObject();
        acc.put("key", key);
        acc.put("email", email);
        acc.put("password", password);
        acc.put("token", token);
        acc.put("name", name);
        acc.put("school", school);
        acc.put("ip", IpUtil.ensureValid(keptIp));
        next.put(acc);
        prefs.edit().putString("accounts", next.toString()).apply();

        out.put("ok", true);
        out.put("name", name);
        out.put("school", school);
        out.put("ip", acc.optString("ip"));
      } catch (Exception e) {
        try {
          out.put("ok", false);
          out.put("error", String.valueOf(e.getMessage()));
        } catch (Exception ignored) {
        }
      }
      return out.toString();
    }

    @JavascriptInterface
    public String removeAccount(String key) {
      try {
        JSONArray arr = new JSONArray(prefs.getString("accounts", "[]"));
        JSONArray next = new JSONArray();
        for (int i = 0; i < arr.length(); i++) {
          JSONObject a = arr.getJSONObject(i);
          if (!key.equals(a.optString("key"))) next.put(a);
        }
        prefs.edit().putString("accounts", next.toString()).apply();
        return "{\"ok\":true}";
      } catch (Exception e) {
        return "{\"ok\":false}";
      }
    }

    // ---------------------------------------------------------- 成员导入导出

    /**
     * 导出全部账号为一个可复制的字符串。
     *
     * 编码方式是 JSON -> URL-safe Base64，前面加 "KTP1:" 前缀，
     * 好处：单行、换行和空格都不会破坏它，方便走微信/剪贴板。
     *
     * @param withSecrets 是否包含密码和 token（完整迁移用；不含则导入后要重新填密码）
     */
    @JavascriptInterface
    public String exportAccounts(boolean withSecrets) {
      JSONObject out = new JSONObject();
      try {
        JSONArray arr = new JSONArray(prefs.getString("accounts", "[]"));
        JSONArray list = new JSONArray();
        for (int i = 0; i < arr.length(); i++) {
          JSONObject a = arr.getJSONObject(i);
          JSONObject row = new JSONObject();
          row.put("key", a.optString("key"));
          row.put("email", a.optString("email"));
          row.put("name", a.optString("name", ""));
          row.put("school", a.optString("school", ""));
          row.put("ip", a.optString("ip", ""));
          if (withSecrets) {
            row.put("password", a.optString("password", ""));
            row.put("token", a.optString("token", ""));
          }
          list.put(row);
        }
        JSONObject payload = new JSONObject();
        payload.put("v", 1);
        payload.put("app", "ktp");
        payload.put("ts", System.currentTimeMillis() / 1000);
        payload.put("withSecrets", withSecrets);
        payload.put("accounts", list);

        String code =
            Base64.encodeToString(
                payload.toString().getBytes(StandardCharsets.UTF_8),
                Base64.URL_SAFE | Base64.NO_WRAP);
        out.put("ok", true);
        out.put("count", list.length());
        out.put("payload", "KTP1:" + code);
      } catch (Exception e) {
        return errJson(String.valueOf(e.getMessage()));
      }
      return out.toString();
    }

    /**
     * 导入账号。accepts 原始 JSON 或 "KTP1:" 开头的那串 Base64。
     *
     * @param replace true=覆盖（清空现有账号），false=合并（同 key 覆盖，其余保留）
     */
    @JavascriptInterface
    public String importAccounts(String payload, boolean replace) {
      JSONObject out = new JSONObject();
      try {
        String raw = payload == null ? "" : payload.trim();
        if (raw.isEmpty()) throw new Exception("内容是空的");

        String json;
        if (raw.startsWith("{")) {
          // 直接是 JSON：**不要**去空白，名字/密码/学校名里可能本来就有空格
          json = raw;
        } else {
          // Base64：可以放心去掉换行和空格（复制过来常带换行）
          String text = raw.replaceAll("\\s+", "");
          if (text.startsWith("KTP1:")) text = text.substring(5);
          else if (text.startsWith("KTP1")) text = text.substring(4);
          byte[] bytes;
          try {
            bytes = Base64.decode(text, Base64.URL_SAFE | Base64.NO_WRAP);
          } catch (Exception e) {
            bytes = Base64.decode(text, Base64.DEFAULT);
          }
          json = new String(bytes, StandardCharsets.UTF_8);
        }

        JSONObject obj = new JSONObject(json);
        if (!"ktp".equals(obj.optString("app"))) {
          throw new Exception("这不是本 App 导出的成员数据");
        }
        JSONArray incoming = obj.optJSONArray("accounts");
        if (incoming == null) throw new Exception("数据里没有账号列表");

        JSONArray cur =
            replace ? new JSONArray() : new JSONArray(prefs.getString("accounts", "[]"));
        int added = 0;
        int updated = 0;
        for (int i = 0; i < incoming.length(); i++) {
          JSONObject in = incoming.getJSONObject(i);
          String key = in.optString("key", "");
          if (key.isEmpty()) continue;
          JSONObject acc = new JSONObject();
          acc.put("key", key);
          acc.put("email", in.optString("email", ""));
          acc.put("password", in.optString("password", ""));
          acc.put("token", in.optString("token", ""));
          acc.put("name", in.optString("name", key));
          acc.put("school", in.optString("school", ""));
          acc.put("ip", IpUtil.ensureValid(in.optString("ip", "")));

          int found = -1;
          for (int j = 0; j < cur.length(); j++) {
            if (key.equals(cur.getJSONObject(j).optString("key"))) {
              found = j;
              break;
            }
          }
          if (found >= 0) {
            cur.put(found, acc);
            updated++;
          } else {
            cur.put(acc);
            added++;
          }
        }
        prefs.edit().putString("accounts", cur.toString()).apply();

        out.put("ok", true);
        out.put("added", added);
        out.put("updated", updated);
        out.put("total", cur.length());
        out.put("withSecrets", obj.optBoolean("withSecrets", false));
      } catch (Exception e) {
        return errJson(String.valueOf(e.getMessage()));
      }
      return out.toString();
    }

    @JavascriptInterface
    public String copyToClipboard(String text) {
      try {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        if (cm == null) throw new Exception("剪贴板不可用");
        cm.setPrimaryClip(ClipData.newPlainText("ktp-members", text));
        return "{\"ok\":true}";
      } catch (Exception e) {
        return "{\"ok\":false,\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
      }
    }

    /** 读剪贴板。Android 10+ 只在 App 处于前台时允许读，正好符合我们的用法。 */
    @JavascriptInterface
    public String readClipboard() {
      JSONObject out = new JSONObject();
      try {
        ClipboardManager cm = (ClipboardManager) getSystemService(Context.CLIPBOARD_SERVICE);
        String text = "";
        if (cm != null && cm.getPrimaryClip() != null && cm.getPrimaryClip().getItemCount() > 0) {
          // 注意用 MainActivity.this：这里在内部类 Bridge 里，直接写 this 是 Bridge 实例，类型不对
          CharSequence cs = cm.getPrimaryClip().getItemAt(0).coerceToText(MainActivity.this);
          if (cs != null) text = cs.toString();
        }
        out.put("ok", true);
        out.put("text", text);
      } catch (Exception e) {
        return errJson(String.valueOf(e.getMessage()));
      }
      return out.toString();
    }

    /** 调起系统分享（微信/文件等），方便直接发到另一台手机。 */
    @JavascriptInterface
    public String shareText(final String text) {
      try {
        new Handler(Looper.getMainLooper())
            .post(
                new Runnable() {
                  @Override
                  public void run() {
                    Intent send = new Intent(Intent.ACTION_SEND);
                    send.setType("text/plain");
                    send.putExtra(Intent.EXTRA_TEXT, text);
                    Intent chooser = Intent.createChooser(send, "分享成员数据");
                    chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(chooser);
                  }
                });
        return "{\"ok\":true}";
      } catch (Exception e) {
        return "{\"ok\":false,\"error\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
      }
    }

    // ------------------------------------------------------------ 签到提醒

    /**
     * 读监控状态：主成员是谁、服务在不在跑、上次检查说了什么。
     *
     * 判断「有没有课正在签到」的依据见 MonitorService 的注释 ——
     * 用的是 getNotFinishAttenceStudent，实测它只返回进行中的签到。
     */
    @JavascriptInterface
    public String getMonitor() {
      JSONObject out = new JSONObject();
      try {
        out.put("ok", true);
        out.put("primary", prefs.getString("primaryKey", ""));
        out.put("running", MonitorService.running);
        out.put("status", MonitorService.lastStatus);
        out.put("lastCheckAt", MonitorService.lastCheckAt);
        out.put("notifGranted", notificationsAllowed());
        out.put("pollMs", prefs.getLong("pollIntervalMs", 10000L));
        out.put("roomLat", prefs.getString(CheckinHelper.PREF_LAT, ""));
        out.put("roomLng", prefs.getString(CheckinHelper.PREF_LNG, ""));
        out.put("pending", new JSONArray(MonitorService.pendingJson));
        out.put("locationGranted", locationAllowed());
      } catch (Exception e) {
        return errJson(String.valueOf(e.getMessage()));
      }
      return out.toString();
    }

    @JavascriptInterface
    public String setPrimary(String key) {
      prefs.edit().putString("primaryKey", key == null ? "" : key).apply();
      return "{\"ok\":true}";
    }

    /** 调轮询间隔（秒）。服务里还有下限保护，避免被填成 0 把服务打死。 */
    @JavascriptInterface
    public String setPollSeconds(int seconds) {
      long ms = Math.max(5, Math.min(120, seconds)) * 1000L;
      prefs.edit().putLong("pollIntervalMs", ms).apply();
      return "{\"ok\":true}";
    }

    // ---------------------------------------------------------- 定位签到

    /**
     * 保存教室坐标。定位签到报的就是这个 ——
     * 坐标是请求体里的普通参数，不需要手机真的在教室（见 CheckinHelper 的说明）。
     */
    @JavascriptInterface
    public String setRoomLocation(String lat, String lng) {
      try {
        double la = Double.parseDouble(lat.trim());
        double ln = Double.parseDouble(lng.trim());
        if (la < -90 || la > 90 || ln < -180 || ln > 180) {
          return "{\"ok\":false,\"error\":\"坐标超出范围\"}";
        }
        prefs
            .edit()
            .putString(CheckinHelper.PREF_LAT, String.format(Locale.US, "%.6f", la))
            .putString(CheckinHelper.PREF_LNG, String.format(Locale.US, "%.6f", ln))
            .apply();
        return "{\"ok\":true}";
      } catch (Exception e) {
        return errJson("坐标格式不对：" + e.getMessage());
      }
    }

    /**
     * 读手机当前位置 —— 用来「站在教室里点一下」把教室坐标填上。
     *
     * 优先用系统缓存的最后位置（同步、即时）；缓存为空就发一次单次定位请求，
     * 让用户过两秒再点一次。这样不必为一个填表动作写一整套异步回调。
     */
    @JavascriptInterface
    public String readCurrentLocation() {
      JSONObject out = new JSONObject();
      try {
        if (!locationAllowed()) {
          requestPermissions(
              new String[] {
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION
              },
              REQ_LOCATION);
          return "{\"ok\":false,\"error\":\"正在申请定位权限，同意后再点一次\"}";
        }

        LocationManager lm = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) return "{\"ok\":false,\"error\":\"定位服务不可用\"}";

        Location best = null;
        for (String p :
            new String[] {LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
          try {
            Location l = lm.getLastKnownLocation(p);
            if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
          } catch (Exception ignored) {
          }
        }

        if (best == null) {
          try {
            lm.requestSingleUpdate(
                LocationManager.NETWORK_PROVIDER,
                new LocationListener() {
                  @Override
                  public void onLocationChanged(Location location) {}

                  @Override
                  public void onStatusChanged(String provider, int status, Bundle extras) {}

                  @Override
                  public void onProviderEnabled(String provider) {}

                  @Override
                  public void onProviderDisabled(String provider) {}
                },
                Looper.getMainLooper());
          } catch (Exception ignored) {
          }
          return "{\"ok\":false,\"error\":\"系统还没缓存位置，等 2 秒再点一次；或照抄高德里显示的坐标\"}";
        }

        out.put("ok", true);
        out.put("lat", String.format(Locale.US, "%.6f", best.getLatitude()));
        out.put("lng", String.format(Locale.US, "%.6f", best.getLongitude()));
        out.put("ageSec", (System.currentTimeMillis() - best.getTime()) / 1000);
      } catch (Exception e) {
        return errJson(String.valueOf(e.getMessage()));
      }
      return out.toString();
    }

    /** 用已保存的教室坐标给某个定位签到提交（界面上的「立即签到」按钮）。 */
    @JavascriptInterface
    public String signLocationNow(String attenceId) {
      // 注意 MainActivity.this：这里在内部类 Bridge 里，直接写 this 是 Bridge 实例
      return CheckinHelper.signLocation(MainActivity.this, attenceId).toString();
    }

    @JavascriptInterface
    public String startMonitor() {
      try {
        String primary = prefs.getString("primaryKey", "");
        if (primary == null || primary.isEmpty()) {
          return "{\"ok\":false,\"error\":\"请先选择主成员\"}";
        }
        if (!notificationsAllowed()) {
          // Android 13+ 需要运行时授权，否则通知会被静默丢掉
          requestPermissions(new String[] {NOTIFICATION_PERMISSION}, REQ_NOTIF);
        }
        MonitorService.start(MainActivity.this);
        return "{\"ok\":true}";
      } catch (Exception e) {
        return errJson(String.valueOf(e.getMessage()));
      }
    }

    @JavascriptInterface
    public String stopMonitor() {
      try {
        MonitorService.stop(MainActivity.this);
        return "{\"ok\":true}";
      } catch (Exception e) {
        return errJson(String.valueOf(e.getMessage()));
      }
    }

    /** 读 IP 策略 + 每个账号的假 IP（界面上展示用）。 */
    @JavascriptInterface
    public String getSettings() {
      JSONObject out = new JSONObject();
      try {
        JSONArray arr = new JSONArray(prefs.getString("accounts", "[]"));
        JSONArray list = new JSONArray();
        for (int i = 0; i < arr.length(); i++) {
          JSONObject a = arr.getJSONObject(i);
          JSONObject row = new JSONObject();
          row.put("key", a.optString("key"));
          row.put("name", a.optString("name", a.optString("key")));
          row.put("ip", a.optString("ip"));
          list.put(row);
        }
        out.put("mode", ipMode());
        out.put("sharedIp", prefs.getString("sharedIp", ""));
        out.put("accounts", list);
      } catch (Exception ignored) {
      }
      return out.toString();
    }

    @JavascriptInterface
    public String setIpMode(String mode) {
      if (!MODE_SAME.equals(mode) && !MODE_REAL.equals(mode)) mode = MODE_PER_ACCOUNT;
      SharedPreferences.Editor ed = prefs.edit().putString("ipMode", mode);
      if (MODE_SAME.equals(mode)) {
        String shared = prefs.getString("sharedIp", "");
        if (!IpUtil.isValidIpv4(shared)) ed.putString("sharedIp", IpUtil.randomIp());
      }
      ed.apply();
      return "{\"ok\":true}";
    }

    /** 把所有账号的假 IP 重新随机一遍（换一批"住处"）。 */
    @JavascriptInterface
    public String rerollIps() {
      try {
        JSONArray arr = new JSONArray(prefs.getString("accounts", "[]"));
        for (int i = 0; i < arr.length(); i++) {
          arr.getJSONObject(i).put("ip", IpUtil.randomIp());
        }
        prefs.edit()
            .putString("accounts", arr.toString())
            .putString("sharedIp", IpUtil.randomIp())
            .apply();
        return "{\"ok\":true}";
      } catch (Exception e) {
        return "{\"ok\":false}";
      }
    }

    /**
     * 用给定账号列表提交二维码票据。keysJson 形如 ["a","b"]，空数组表示全部。
     * 一张票可以签任意多个账号，所以这里是「扫一次，全部一起签」。
     */
    @JavascriptInterface
    public String submitQr(String keysJson, String ticketid, String expire, String sign) {
      JSONArray results = new JSONArray();
      int okCount = 0;
      try {
        JSONArray arr = new JSONArray(prefs.getString("accounts", "[]"));
        List<JSONObject> all = new ArrayList<>();
        for (int i = 0; i < arr.length(); i++) all.add(arr.getJSONObject(i));

        JSONArray wanted = new JSONArray(keysJson);
        List<JSONObject> targets = new ArrayList<>();
        for (JSONObject a : all) {
          if (wanted.length() == 0) {
            targets.add(a);
            continue;
          }
          for (int i = 0; i < wanted.length(); i++) {
            if (wanted.getString(i).equals(a.optString("key"))) {
              targets.add(a);
              break;
            }
          }
        }

        for (JSONObject acc : targets) {
          JSONObject row = new JSONObject();
          row.put("key", acc.optString("key"));
          row.put("label", acc.optString("name", acc.optString("key")));
          String usedIp = ipForAccount(acc);
          row.put("ip", usedIp == null ? "真实 IP" : usedIp);
          try {
            String token = tokenOf(acc);
            JSONObject body = new JSONObject();
            body.put("ticketid", ticketid);
            body.put("expire", expire);
            body.put("sign", sign);
            body.put("reqtimestamp", System.currentTimeMillis());
            JSONObject res = post("/AttenceApi/AttenceResult", body, token, usedIp);
            JSONObject data = res.optJSONObject("data");
            boolean ok = data != null && data.optInt("state", -1) == 8;
            row.put("ok", ok);
            row.put(
                "message",
                ok
                    ? strip(data.optString("info", "签到成功"))
                    : strip(res.optString("message", "签到失败")));
            if (ok) okCount++;
          } catch (Exception e) {
            row.put("ok", false);
            row.put("message", String.valueOf(e.getMessage()));
          }
          results.put(row);
        }

        // 把可能新分配的 IP 落盘
        prefs.edit().putString("accounts", arr.toString()).apply();
      } catch (Exception e) {
        // 整体失败也要把已有结果带回去
      }
      JSONObject out = new JSONObject();
      try {
        out.put("okCount", okCount);
        out.put("results", results);
      } catch (Exception ignored) {
      }
      return out.toString();
    }
  }

  private static String strip(String s) {
    return s == null ? "" : s.replaceAll("<br\\s*/?>", " ");
  }

  /**
   * 拼一个错误返回串。
   *
   * 不用 JSONObject.put —— 它声明抛 JSONException，写在 catch 块里还得再套一层 try，
   * 很容易漏（这里就漏了三个方法，编译才发现）。手写转义更省事。
   */
  private static String errJson(String message) {
    String s = message == null ? "" : message;
    s = s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", " ").replace("\r", "");
    return "{\"ok\":false,\"error\":\"" + s + "\"}";
  }

  /** token 失效时自动重新登录一次。 */
  private String tokenOf(JSONObject acc) throws Exception {
    String token = acc.optString("token", "");
    if (token != null && !token.isEmpty()) return token;

    JSONObject body = new JSONObject();
    body.put("email", acc.optString("email"));
    body.put("password", acc.optString("password"));
    body.put("remember", "1");
    body.put("source_type", 1);
    body.put("reqtimestamp", System.currentTimeMillis());
    JSONObject res = post("/UserApi/login", body, null, null);
    JSONObject data = res.optJSONObject("data");
    if (data == null) throw new Exception(res.optString("message", "重新登录失败"));
    token = data.optString("token");
    acc.put("token", token);
    return token;
  }

  // ================================================================= HTTP

  private JSONObject post(String path, JSONObject body, String token, String ip) throws Exception {
    return KtpApi.call(path, body, token, ip);
  }

  private JSONObject postLegacy(String path, JSONObject body, String token, String ip) throws Exception {
    HttpURLConnection conn = (HttpURLConnection) new URL(API + path).openConnection();
    try {
      conn.setRequestMethod("POST");
      conn.setConnectTimeout(15000);
      conn.setReadTimeout(25000);
      conn.setDoOutput(true);
      conn.setRequestProperty("Accept", "application/json, text/plain, */*");
      conn.setRequestProperty("Accept-Language", "zh-CN,zh-Hans;q=0.9");
      conn.setRequestProperty("Content-Type", "application/json");
      conn.setRequestProperty("User-Agent", UA);
      conn.setRequestProperty("Origin", "https://w.ketangpai.com");
      conn.setRequestProperty("Referer", "https://w.ketangpai.com/");
      conn.setRequestProperty("Sec-Fetch-Site", "same-site");
      conn.setRequestProperty("Sec-Fetch-Mode", "cors");
      conn.setRequestProperty("Sec-Fetch-Dest", "empty");
      // ip == null 表示「这次故意不伪造」（真实 IP 模式）；
      // 非 null 时宁可重新生成一个合法 IP，也绝不静默地不发这个头 ——
      // 不发的话服务端会记录手机真实 IP，还会让所有账号看起来一模一样。
      if (ip != null) conn.setRequestProperty("X-Forwarded-For", IpUtil.ensureValid(ip));
      if (token != null) conn.setRequestProperty("token", token);

      byte[] payload = body.toString().getBytes(StandardCharsets.UTF_8);
      conn.setFixedLengthStreamingMode(payload.length);
      try (OutputStream os = conn.getOutputStream()) {
        os.write(payload);
      }

      int code = conn.getResponseCode();
      InputStream is = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
      String text = readAll(is);
      try {
        return new JSONObject(text);
      } catch (Exception e) {
        JSONObject fallback = new JSONObject();
        fallback.put("status", 0);
        fallback.put("message", "HTTP " + code + " 非 JSON 响应");
        return fallback;
      }
    } finally {
      conn.disconnect();
    }
  }

  private static String readAll(InputStream is) throws Exception {
    if (is == null) return "";
    ByteArrayOutputStream bos = new ByteArrayOutputStream();
    byte[] buf = new byte[8192];
    int n;
    while ((n = is.read(buf)) > 0) bos.write(buf, 0, n);
    return new String(bos.toByteArray(), StandardCharsets.UTF_8);
  }
}
