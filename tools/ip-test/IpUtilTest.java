import com.ktp.scanner.IpUtil;

/**
 * IpUtil 的单测：直接用 javac/java 跑，不需要 Android 设备或模拟器。
 *
 *   javac -encoding UTF-8 -d <outdir> app-android/app/src/main/java/com/ktp/scanner/IpUtil.java tools/ip-test/IpUtilTest.java
 *   java -cp <outdir> IpUtilTest
 *
 * 输出刻意只用 ASCII，避免 Windows 控制台编码问题。
 */
public class IpUtilTest {

  public static void main(String[] args) {
    int fail = 0;

    // 1) 大量生成，必须全部合法
    for (int i = 0; i < 200000; i++) {
      String ip = IpUtil.randomIp();
      if (!IpUtil.isValidIpv4(ip)) {
        if (fail < 6) System.out.println("FAIL randomIp produced invalid: " + ip);
        fail++;
      } else if (ip.split("\\.", -1).length != 4) {
        if (fail < 6) System.out.println("FAIL not 4 octets: " + ip);
        fail++;
      }
    }
    System.out.println("generated 200000 ips, invalid count = " + fail);

    // 2) 必须判为非法（这几条正是导致 0.0.0.0 或"不发头"的形态）
    String[] bad = {
      "223.104.213",          // 三段 —— 就是踩过的坑
      "203.0.113.4:80",     // 带端口
      "1.2.3.256",            // 越界
      "1.2.3.",               // 空段
      "",                     // 空
      null,                   // null
      "a.b.c.d",              // 非数字
      " 1.2.3.4",             // 前导空格
      "1.2.3.4 ",             // 尾随空格
      "1.2.3",                // 三段
      "1.2.3.4.5",            // 五段
    };
    int badFail = 0;
    for (String b : bad) {
      if (IpUtil.isValidIpv4(b)) {
        System.out.println("FAIL should be invalid: " + b);
        badFail++;
      }
    }
    System.out.println("bad cases rejected = " + (bad.length - badFail) + "/" + bad.length);
    fail += badFail;

    // 3) 必须判为合法
    String[] good = {"203.0.113.4", "0.0.0.0", "255.255.255.255", "1.2.3.4", "10.0.0.1"};
    int goodFail = 0;
    for (String g : good) {
      if (!IpUtil.isValidIpv4(g)) {
        System.out.println("FAIL should be valid: " + g);
        goodFail++;
      }
    }
    System.out.println("good cases accepted = " + (good.length - goodFail) + "/" + good.length);
    fail += goodFail;

    // 4) ensureValid 兜底：非法输入必须被换成一个合法 IP
    String[] junk = {"223.104.213", "", null, "abc"};
    int ensureFail = 0;
    for (String j : junk) {
      String out = IpUtil.ensureValid(j);
      if (!IpUtil.isValidIpv4(out)) {
        System.out.println("FAIL ensureValid returned invalid for input " + j + " -> " + out);
        ensureFail++;
      }
    }
    System.out.println("ensureValid fallback ok = " + (junk.length - ensureFail) + "/" + junk.length);
    fail += ensureFail;

    System.out.println(fail == 0 ? "ALL PASS" : ("FAILED: " + fail));
    System.exit(fail == 0 ? 0 : 1);
  }
}
