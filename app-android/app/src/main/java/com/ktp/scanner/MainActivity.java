package com.ktp.scanner;

import android.app.Activity;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

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
import java.util.Random;

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

    web.setWebViewClient(new WebViewClient());
    web.addJavascriptInterface(new Bridge(), "Android");
    web.loadUrl("file:///android_asset/www/index.html");
    setContentView(web);
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode == REQ_SCAN) {
      if (resultCode == RESULT_OK && data != null) {
        String text = data.getStringExtra(ScanActivity.EXTRA_TEXT);
        if (text != null && !text.isEmpty()) {
          callJs("window.onScanResult(" + JSONObject.quote(text) + ")");
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

  private static final Random RND = new Random();
  /** 国内三大运营商常见网段（前三段固定，末段随机） */
  private static final String[] IP_PREFIX = {
    "223.104.", "117.136.", "183.232.", "120.196.", "111.24.", // 移动
    "112.17.", "27.184.", "221.192.", "60.28.", // 联通
    "106.6.", "171.8.", "218.75.", "58.100.", "180.137.", // 电信
  };

  /** 生成合法的四段 IPv4（末段 2~253，避开 .0/.1/.255 这类边界） */
  static String randomIp() {
    return IP_PREFIX[RND.nextInt(IP_PREFIX.length)] + (2 + RND.nextInt(252));
  }

  private String ipMode() {
    return prefs.getString("ipMode", MODE_PER_ACCOUNT);
  }

  /** 给这次请求挑一个 IP；返回 null 表示不发送 X-Forwarded-For。 */
  private String ipForAccount(JSONObject acc) {
    String mode = ipMode();
    if (MODE_REAL.equals(mode)) return null;

    if (MODE_SAME.equals(mode)) {
      String shared = prefs.getString("sharedIp", "");
      if (shared == null || shared.isEmpty() || !isValidIpv4(shared)) {
        shared = randomIp();
        prefs.edit().putString("sharedIp", shared).apply();
      }
      return shared;
    }

    String ip = acc == null ? null : acc.optString("ip", "");
    if (ip == null || !isValidIpv4(ip)) {
      ip = randomIp();
      if (acc != null) {
        try {
          acc.put("ip", ip);
        } catch (Exception ignored) {
        }
      }
    }
    return ip;
  }

  /** 必须是严格的四段点分十进制 —— 三段或带端口会被课堂派记成 0.0.0.0。 */
  static boolean isValidIpv4(String s) {
    if (s == null) return false;
    String[] parts = s.split("\\.", -1);
    if (parts.length != 4) return false;
    for (String p : parts) {
      if (p.isEmpty() || p.length() > 3) return false;
      for (int i = 0; i < p.length(); i++) {
        if (p.charAt(i) < '0' || p.charAt(i) > '9') return false;
      }
      int v = Integer.parseInt(p);
      if (v < 0 || v > 255) return false;
    }
    return true;
  }

  // ================================================================= 桥

  public class Bridge {

    @JavascriptInterface
    public String listAccounts() {
      return prefs.getString("accounts", "[]");
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
        acc.put("ip", isValidIpv4(keptIp) ? keptIp : randomIp());
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
        if (!isValidIpv4(shared)) ed.putString("sharedIp", randomIp());
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
          arr.getJSONObject(i).put("ip", randomIp());
        }
        prefs.edit()
            .putString("accounts", arr.toString())
            .putString("sharedIp", randomIp())
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
      if (ip != null && isValidIpv4(ip)) conn.setRequestProperty("X-Forwarded-For", ip);
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
