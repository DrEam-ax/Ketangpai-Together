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
 * 扫码只有「实时扫」这一条路：点按钮进全屏原生扫码界面（ScanActivity），
 * 不再支持选图 / 上传。
 */
public class MainActivity extends Activity {

  private static final String API = "https://openapiv5.ketangpai.com";
  private static final String UA =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_1 like Mac OS X) AppleWebKit/605.1.15 "
          + "(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.56(0x18003835) NetType/WIFI Language/zh_CN";
  private static final int REQ_SCAN = 1001;

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

    /** 添加账号：先真的登录一次验证，成功才存。 */
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

        JSONObject res = post("/UserApi/login", body, null);
        JSONObject data = res.optJSONObject("data");
        String token = data == null ? null : data.optString("token", null);
        if (token == null || token.isEmpty()) {
          out.put("ok", false);
          out.put("error", res.optString("message", "登录失败"));
          return out.toString();
        }

        JSONObject info = post("/UserApi/getUserInfo", new JSONObject(), token);
        JSONObject d = info.optJSONObject("data");
        String name = d == null ? key : d.optString("username", key);
        String school = d == null ? "" : d.optString("school", "");

        JSONArray arr = new JSONArray(prefs.getString("accounts", "[]"));
        JSONArray next = new JSONArray();
        for (int i = 0; i < arr.length(); i++) {
          JSONObject a = arr.getJSONObject(i);
          if (!key.equals(a.optString("key"))) next.put(a);
        }
        JSONObject acc = new JSONObject();
        acc.put("key", key);
        acc.put("email", email);
        acc.put("password", password);
        acc.put("token", token);
        acc.put("name", name);
        acc.put("school", school);
        next.put(acc);
        prefs.edit().putString("accounts", next.toString()).apply();

        out.put("ok", true);
        out.put("name", name);
        out.put("school", school);
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

    /**
     * 用给定账号列表提交二维码票据。keysJson 形如 ["a","b"]，空数组表示全部。
     * 一张票可以签任意多个账号，所以这里是「扫一次，全部一起签」。
     */
    @JavascriptInterface
    public String submitQr(String keysJson, String ticketid, String expire, String sign) {
      JSONArray results = new JSONArray();
      int okCount = 0;
      try {
        List<JSONObject> all = new ArrayList<>();
        JSONArray arr = new JSONArray(prefs.getString("accounts", "[]"));
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
          try {
            String token = tokenOf(acc);
            JSONObject body = new JSONObject();
            body.put("ticketid", ticketid);
            body.put("expire", expire);
            body.put("sign", sign);
            body.put("reqtimestamp", System.currentTimeMillis());
            JSONObject res = post("/AttenceApi/AttenceResult", body, token);
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
    JSONObject res = post("/UserApi/login", body, null);
    JSONObject data = res.optJSONObject("data");
    if (data == null) throw new Exception(res.optString("message", "重新登录失败"));
    token = data.optString("token");
    acc.put("token", token);
    return token;
  }

  // ================================================================= HTTP

  private JSONObject post(String path, JSONObject body, String token) throws Exception {
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
      conn.setRequestProperty("X-Forwarded-For", fakeIp());
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

  /** 多账号从同一个出口 IP 提交会被判异常，随机伪造一个国内移动网络 IP。 */
  private static final Random RND = new Random();
  private static final String[] PREFIX = {"223.104.", "117.136.", "183.232."};

  private static String fakeIp() {
    return PREFIX[RND.nextInt(PREFIX.length)] + (1 + RND.nextInt(254));
  }
}
