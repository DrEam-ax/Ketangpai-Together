package com.ktp.scanner;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

/**
 * 课堂派的 HTTP 调用（原生实现）。
 *
 * 为什么必须原生：课堂派要求 <code>Origin</code>/<code>Referer</code>/<code>Sec-Fetch-*</code> 这些头，
 * 而浏览器的 fetch 规范**禁止** JS 设置它们；WebView 里还会被 CORS 拦掉。所以只能用
 * HttpURLConnection 自己发。
 *
 * 这个类从 MainActivity 里抽出来，是为了让后台监控服务（MonitorService）也能用同一套逻辑。
 */
final class KtpApi {

  static final String API = "https://openapiv5.ketangpai.com";

  /** 微信的 UA —— 课堂派按这个识别客户端，换别的可能被风控。 */
  static final String UA =
      "Mozilla/5.0 (Linux; Android 14; zh-cn) AppleWebKit/537.36 (KHTML, like Gecko) "
          + "Version/4.0 Chrome/122.0.0.0 Mobile Safari/537.36 MicroMessenger/8.0.49.2600";

  private KtpApi() {}

  /**
   * @param token 课堂派登录 token；null 表示不带（登录接口用）
   * @param ip 伪造 IP；null 表示这次故意不发 X-Forwarded-For（真实 IP 模式）
   */
  static JSONObject call(String path, JSONObject body, String token, String ip) throws Exception {
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
      // ip == null 表示「这次故意不伪造」；
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

  /** 登录拿 token。 */
  static String login(String email, String password, String ip) throws Exception {
    JSONObject body = new JSONObject();
    body.put("email", email);
    body.put("password", password);
    body.put("remember", "1");
    body.put("source_type", 1);
    body.put("reqtimestamp", System.currentTimeMillis());
    JSONObject res = call("/UserApi/login", body, null, ip);
    JSONObject data = res.optJSONObject("data");
    if (data == null) throw new Exception(res.optString("message", "登录失败"));
    String token = data.optString("token");
    if (token == null || token.isEmpty()) throw new Exception("登录没返回 token");
    return token;
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
