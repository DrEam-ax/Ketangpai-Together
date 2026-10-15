/**
 * Coord（WGS-84 ↔ GCJ-02）的单元测试。
 *
 * 这个转换必须对，因为它直接决定定位签到会不会偏几百米。
 * 而且它**不需要手机**就能测 —— 编译真实的 Coord.java 来跑。
 *
 * 跑法:
 *   javac -encoding UTF-8 -d out Coord.java CoordTest.java
 *   java -cp out CoordTest
 */
public class CoordTest {

  private static int fail = 0;

  private static void check(boolean ok, String label, String detail) {
    System.out.printf("%s  %s%s%n", ok ? "PASS" : "FAIL", label, ok ? "" : "   <- " + detail);
    if (!ok) fail++;
  }

  public static void main(String[] args) {
    // 1) 国内偏移量应在 100~700 米这个量级（这是「火星坐标」的已知特征）
    double[][] cities = {
      {39.904200, 116.407400}, // 北京
      {39.908700, 116.397500}, // 北京
      {22.543100, 114.057900}, // 深圳
      {30.572800, 104.066800}, // 成都
      {43.825600, 87.616800}, // 乌鲁木齐
    };
    for (double[] c : cities) {
      double[] g = Coord.wgs2gcj(c[0], c[1]);
      double d = Coord.meters(c[0], c[1], g[0], g[1]);
      check(
          d > 100 && d < 700,
          String.format("偏移量在合理区间 %.0f 米 (%.4f,%.4f)", d, c[0], c[1]),
          String.format("得到 %.1f 米 -> (%.6f,%.6f)", d, g[0], g[1]));
    }

    // 2) 往返精度：gcj2wgs(wgs2gcj(p)) ≈ p（迭代法应该到厘米级）
    double worst = 0;
    for (double[] c : cities) {
      double[] g = Coord.wgs2gcj(c[0], c[1]);
      double[] back = Coord.gcj2wgs(g[0], g[1]);
      double d = Coord.meters(c[0], c[1], back[0], back[1]);
      worst = Math.max(worst, d);
    }
    check(worst < 1.0, String.format("往返误差 < 1 米（实测最差 %.3f 米）", worst), "worst=" + worst);

    // 3) 偏移方向：GCJ-02 相对 WGS-84 在国内应整体偏东北（纬度、经度都增大）
    double[] g = Coord.wgs2gcj(39.9042, 116.4074);
    check(g[0] > 39.9042 && g[1] > 116.4074, "偏移方向是东北（纬度、经度都变大）", g[0] + "," + g[1]);

    // 4) 境外不动
    double[] us = Coord.wgs2gcj(40.7128, -74.0060); // 纽约
    check(
        us[0] == 40.7128 && us[1] == -74.0060,
        "境外坐标不做偏移（纽约）",
        us[0] + "," + us[1]);

    // 5) 同一个点反复调用结果稳定（纯函数）
    double[] a1 = Coord.wgs2gcj(39.9042, 116.4074);
    double[] a2 = Coord.wgs2gcj(39.9042, 116.4074);
    check(a1[0] == a2[0] && a1[1] == a2[1], "同输入同输出（纯函数）", a1[0] + " vs " + a2[0]);

    // 6) 距离函数自检：南京 -> 上海 约 270km
    double d = Coord.meters(32.0603, 118.7969, 31.2304, 121.4737);
    check(d > 250000 && d < 290000, String.format("距离函数自检 南京->上海 %.0f km", d / 1000), "d=" + d);

    System.out.println(fail == 0 ? "\nALL PASS" : "\nFAILED: " + fail);
    System.exit(fail == 0 ? 0 : 1);
  }
}
