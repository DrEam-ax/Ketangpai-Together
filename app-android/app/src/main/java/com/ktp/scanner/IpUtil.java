package com.ktp.scanner;

import java.util.ArrayList;
import java.util.List;
import java.util.Random;

/**
 * 假 IP 生成 / 校验。
 *
 * ⚠️ 这个类的正确性非常关键，而且同一个坑踩过两次：
 *   课堂派是**逐字记录** X-Forwarded-For 的，但格式不合法就记成 0.0.0.0。
 *   如果生成的地址少一段（例如 223.104.213），会有两种糟糕后果：
 *     1) 直接发出去            -> 服务端记 0.0.0.0（一眼假）
 *     2) 被自己的校验挡住不发   -> 服务端记下**手机真实 IP**（更糟：所有账号全一样）
 *   第 2 种就真的发生过：五个账号在教师端全显示同一个 203.0.113.4。
 *
 * 所以 randomIp() 必须**永远**返回合法的四段地址。
 *
 * 这个类刻意不引用任何 Android 类，因此可以直接用 javac / java 单测，
 * 见 tools/ip-test/IpUtilTest.java。
 */
public final class IpUtil {

  private IpUtil() {}

  /** 国内三大运营商常见网段，允许只写 1~3 段，缺的段会自动补齐。 */
  private static final String[] PREFIX = {
    "223.104", "117.136", "183.232", "120.196", "111.24", // 移动
    "112.17", "27.184", "221.192", "60.28", // 联通
    "106.6", "171.8", "218.75", "58.100", "180.137", // 电信
  };

  private static final Random RND = new Random();

  /** 末段避开 0 / 1 / 255 这类容易被看出来的边界值。 */
  private static int lastOctet() {
    return 2 + RND.nextInt(252); // 2..253
  }

  /** 永远返回合法的四段 IPv4。 */
  public static String randomIp() {
    String prefix = PREFIX[RND.nextInt(PREFIX.length)];
    List<String> octets = new ArrayList<String>();
    for (String part : prefix.split("\\.")) {
      if (part != null && part.length() > 0) octets.add(part);
    }
    // 补齐到 4 段（关键：这里少写一段就是那个 bug）
    while (octets.size() < 3) octets.add(String.valueOf(lastOctet()));
    octets.add(String.valueOf(lastOctet()));

    StringBuilder sb = new StringBuilder(16);
    for (int i = 0; i < 4; i++) {
      if (i > 0) sb.append('.');
      sb.append(octets.get(i));
    }
    return sb.toString();
  }

  /** 严格的四段点分十进制。三段、带端口、带空格一律 false。 */
  public static boolean isValidIpv4(String s) {
    if (s == null) return false;
    String[] parts = s.split("\\.", -1);
    if (parts.length != 4) return false;
    for (String p : parts) {
      if (p == null || p.isEmpty() || p.length() > 3) return false;
      for (int i = 0; i < p.length(); i++) {
        char c = p.charAt(i);
        if (c < '0' || c > '9') return false;
      }
      int v = Integer.parseInt(p);
      if (v < 0 || v > 255) return false;
    }
    return true;
  }

  /** 无效就重新生成一个（用于兜底，避免静默地不发这个头）。 */
  public static String ensureValid(String candidate) {
    return isValidIpv4(candidate) ? candidate : randomIp();
  }
}
