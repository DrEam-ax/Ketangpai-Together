package com.ktp.scanner;

/**
 * Coord（WGS-84 ↔ GCJ-02）的单元测试。
 *
 * 这个转换必须对，因为它直接决定定位签到会不会整体偏几百米。
 * 而且它**不需要手机**就能测 —— 编译真实的 Coord.java 来跑。
 *
 * 注意放在同一个包（com.ktp.scanner）里，因为 Coord 是包内可见的。
 *
 * 跑法:
 *   javac -encoding UTF-8 -d out src/com/ktp/scanner/Coord.java src/com/ktp/scanner/CoordTest.java
 *   java -cp out com.ktp.scanner.CoordTest
 */
public class CoordTest {

  private static int fail = 0;

  private static void check(boolean ok, String label, String detail) {
    System.out.printf("%s  %s%s%n", ok ? "PASS" : "FAIL", label, ok ? "" : "   <- " + detail);
    if (!ok) fail++;
  }

  public static void main(String[] args) {
    // 1) 国内偏移量应在 100~700 米这个量级（「火星坐标」的已知特征）
    //    用各城市**著名地标**的公开坐标，不涉及任何个人位置
    double[][] cities = {
      {39.908700, 116.397500}, // 北京
      {31.230400, 121.473700}, // 上海
      {23.129100, 113.264400}, // 广州
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

    // 2) 往返精度：gcj2wgs(wgs2gcj(p)) ≈ p
    double worst = 0;
    for (double[] c : cities) {
      double[] g = Coord.wgs2gcj(c[0], c[1]);
      double[] back = Coord.gcj2wgs(g[0], g[1]);
      worst = Math.max(worst, Coord.meters(c[0], c[1], back[0], back[1]));
    }
    check(worst < 1.0, String.format("往返误差 < 1 米（实测最差 %.3f 米）", worst), "worst=" + worst);

    // 3) 偏移方向**不是固定的**（随地区变化），所以只断言"确实移动了且量级合理"。
    //    我一开始想当然写成"偏东北"，实测在北京是偏东南 —— 这种假设就该被测试打脸。
    double[] g = Coord.wgs2gcj(39.9087, 116.3975);
    double moved = Coord.meters(39.9087, 116.3975, g[0], g[1]);
    check(
        moved > 100 && (g[0] != 39.9087 || g[1] != 116.3975),
        String.format("确实产生了偏移（北京偏东南，%.0f 米）", moved),
        g[0] + "," + g[1]);

    // 4) 境外不动
    double[] us = Coord.wgs2gcj(40.7128, -74.0060);
    check(us[0] == 40.7128 && us[1] == -74.0060, "境外坐标不偏移（纽约）", us[0] + "," + us[1]);

    // 5) 纯函数：同输入同输出
    double[] a1 = Coord.wgs2gcj(39.9087, 116.3975);
    double[] a2 = Coord.wgs2gcj(39.9087, 116.3975);
    check(a1[0] == a2[0] && a1[1] == a2[1], "同输入同输出", a1[0] + " vs " + a2[0]);

    // 6) 距离函数自检：南京 -> 上海 约 270km
    double d = Coord.meters(32.0603, 118.7969, 31.2304, 121.4737);
    check(d > 250000 && d < 290000, String.format("距离函数自检 南京->上海 %.0f km", d / 1000), "d=" + d);

    System.out.println(fail == 0 ? "\nALL PASS" : "\nFAILED: " + fail);
    System.exit(fail == 0 ? 0 : 1);
  }
}
