import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.LuminanceSource;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.GlobalHistogramBinarizer;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;
import java.awt.image.BufferedImage;
import java.io.File;
import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;
import javax.imageio.ImageIO;

/**
 * 用**真正的 ZXing Java 3.5.3**（App 里用的就是它）在电脑上复现「扫不上」，
 * 并对同一张真实失败帧扫描各种「裁剪 + 放大倍数 + 提示」组合，找出到底哪种能救活。
 *
 * 这样就不用靠真机反复试了 —— 真机一次往返太贵。
 *
 * 跑法:
 *   javac -encoding UTF-8 -cp core-3.5.3.jar -d out ZxingProbe.java
 *   java -cp "out;core-3.5.3.jar" ZxingProbe tools/scan-debug/frame.jpg
 */
public class ZxingProbe {

  public static void main(String[] args) throws Exception {
    File f = new File(args.length > 0 ? args[0] : "tools/scan-debug/frame.jpg");
    BufferedImage img = ImageIO.read(f);
    int w = img.getWidth();
    int h = img.getHeight();
    System.out.println("帧尺寸 " + w + "x" + h);

    // 把整帧取成灰度 —— 相当于 App 里的 NV21 亮度平面
    byte[] gray = new byte[w * h];
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        int rgb = img.getRGB(x, y);
        int r = (rgb >> 16) & 0xFF;
        int g = (rgb >> 8) & 0xFF;
        int b = rgb & 0xFF;
        gray[y * w + x] = (byte) ((r * 299 + g * 587 + b * 114) / 1000);
      }
    }

    System.out.println("\n=== A) 整帧直接解（App 里 ML Kit 那条路喂的就是整帧）===");
    probe(gray, w, h, 0, 0, w, h, 1, false);
    probe(gray, w, h, 0, 0, w, h, 1, true);
    probe(gray, w, h, 0, 0, w, h, 2, true);
    probe(gray, w, h, 0, 0, w, h, 3, true);

    // 模拟 App 里的 crop：1920x864 的可见区域（这里帧是 864x1920，故取中心 864x864）
    int cw = Math.min(w, h);
    int ch = cw;
    int cl = (w - cw) / 2;
    int ct = (h - ch) / 2;
    System.out.println("\n=== B) 中心正方形 crop " + cw + "x" + ch + "（App 的救援路径取的就是它）===");
    for (int k = 1; k <= 4; k++) {
      probe(gray, w, h, cl, ct, cw, ch, k, true);
    }

    System.out.println("\n=== C) 中心正方形 + TRY_HARDER 关闭 ===");
    for (int k = 1; k <= 4; k++) {
      probe(gray, w, h, cl, ct, cw, ch, k, false);
    }

    System.out.println("\n=== D) 只裁二维码附近（用户把码对准取景框的情形）===");
    int bw = 380, bh = 400;
    int bl = Math.max(0, (w - bw) / 2);
    int bt = 500;
    if (bt + bh > h) bt = h - bh;
    for (int k = 1; k <= 4; k++) {
      probe(gray, w, h, bl, bt, bw, bh, k, true);
    }
  }

  /** 一次探测：裁 rect -> 放大 scale 倍 -> 用两种二值化各试一次。 */
  private static void probe(
      byte[] gray, int w, int h, int l, int t, int rw, int rh, int scale, boolean tryHarder) {
    byte[] data = gray;
    int dw = w;
    int dh = h;
    int left = l;
    int top = t;
    int cw = rw;
    int ch = rh;

    if (scale > 1) {
      dw = rw * scale;
      dh = rh * scale;
      data = new byte[dw * dh];
      for (int y = 0; y < dh; y++) {
        int sy = t + y / scale;
        int srow = sy * w;
        int drow = y * dw;
        for (int x = 0; x < dw; x++) {
          data[drow + x] = gray[srow + l + x / scale];
        }
      }
      left = 0;
      top = 0;
      cw = dw;
      ch = dh;
    }

    Map<DecodeHintType, Object> hints = null;
    if (tryHarder) {
      hints = new EnumMap<>(DecodeHintType.class);
      hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
      hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
    }

    String tag = String.format("crop %dx%d @%d,%d  scale=%dx  harder=%s", rw, rh, l, t, scale, tryHarder);

    // 1) HybridBinarizer
    String r1 = run(data, dw, dh, left, top, cw, ch, hints, false);
    if (r1 != null) {
      System.out.println("  ✅ " + tag + "  [Hybrid]     " + r1);
      return;
    }
    // 2) GlobalHistogramBinarizer
    String r2 = run(data, dw, dh, left, top, cw, ch, hints, true);
    if (r2 != null) {
      System.out.println("  ✅ " + tag + "  [GlobalHist] " + r2);
      return;
    }
    System.out.println("  ❌ " + tag);
  }

  private static String run(
      byte[] data,
      int dw,
      int dh,
      int left,
      int top,
      int cw,
      int ch,
      Map<DecodeHintType, Object> hints,
      boolean global) {
    try {
      LuminanceSource src = new PlanarYUVLuminanceSource(data, dw, dh, left, top, cw, ch, false);
      BinaryBitmap bmp =
          new BinaryBitmap(global ? new GlobalHistogramBinarizer(src) : new HybridBinarizer(src));
      QRCodeReader reader = new QRCodeReader();
      Result r = hints == null ? reader.decode(bmp) : reader.decode(bmp, hints);
      return r.getText();
    } catch (Throwable e) {
      return null;
    }
  }
}
