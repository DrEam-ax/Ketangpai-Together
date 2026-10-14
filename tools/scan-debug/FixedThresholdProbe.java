import com.google.zxing.BarcodeFormat;
import com.google.zxing.Binarizer;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.LuminanceSource;
import com.google.zxing.NotFoundException;
import com.google.zxing.Result;
import com.google.zxing.common.BitArray;
import com.google.zxing.common.BitMatrix;
import com.google.zxing.qrcode.QRCodeReader;
import java.awt.image.BufferedImage;
import java.io.File;
import java.util.Collections;
import java.util.EnumMap;
import java.util.Map;
import javax.imageio.ImageIO;

/**
 * 决定性验证：zxing-cpp 用「固定阈值」在原分辨率就能解出这张帧，
 * 而默认的「局部自适应」不能。那我们 App 用的 ZXing Java 换上固定阈值行不行？
 *
 * 做法：自己把灰度图按阈值二值化成 BitMatrix，再用自定义 Binarizer 直接交给 QRCodeReader，
 * 绕开 ZXing 自带的 Hybrid/GlobalHistogram 二值化。
 *
 * 跑法:
 *   javac -encoding UTF-8 -cp core-3.5.3.jar -d out FixedThresholdProbe.java
 *   java -cp "out;core-3.5.3.jar" FixedThresholdProbe frame.jpg
 */
public class FixedThresholdProbe {

  public static void main(String[] args) throws Exception {
    BufferedImage img = ImageIO.read(new File(args[0]));
    int w = img.getWidth();
    int h = img.getHeight();
    int[] gray = new int[w * h];
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        int rgb = img.getRGB(x, y);
        gray[y * w + x] =
            (((rgb >> 16) & 0xFF) * 299 + ((rgb >> 8) & 0xFF) * 587 + (rgb & 0xFF) * 114) / 1000;
      }
    }
    System.out.println("帧 " + w + "x" + h);

    int rx = 220, ry = 500, rw = 380, rh = 400;

    System.out.println("\n=== 整帧 + 固定阈值 ===");
    for (int t = 70; t <= 190; t += 10) {
      String got = tryFixed(gray, w, h, 0, 0, w, h, t, 1);
      if (got != null) System.out.println("  ✅ 阈值=" + t + "  1x  -> " + got);
    }

    System.out.println("\n=== 二维码区域 + 固定阈值 ===");
    for (int t = 70; t <= 190; t += 10) {
      String got = tryFixed(gray, w, h, rx, ry, rw, rh, t, 1);
      if (got != null) System.out.println("  ✅ 阈值=" + t + "  1x  -> " + got);
    }

    System.out.println("\n=== 二维码区域 + 固定阈值 + 放大 ===");
    for (int sc = 1; sc <= 3; sc++) {
      for (int t = 70; t <= 190; t += 10) {
        String got = tryFixed(gray, w, h, rx, ry, rw, rh, t, sc);
        if (got != null) System.out.println("  ✅ 阈值=" + t + "  " + sc + "x  -> " + got);
      }
    }

    System.out.println("\n=== 二维码区域 + Otsu（全图统计出来的全局阈值）===");
    int otsu = otsuThreshold(gray, rx, ry, rw, rh);
    System.out.println("  Otsu 阈值 = " + otsu);
    String got = tryFixed(gray, w, h, rx, ry, rw, rh, otsu, 1);
    System.out.println("  " + (got != null ? "✅ -> " + got : "❌ 失败"));

    System.out.println("\n=== 对照：局部均值阈值（相当于自适应）在二维码区域 1x ===");
    for (int win : new int[] {15, 31, 51, 101}) {
      String r = tryLocalMean(gray, w, h, rx, ry, rw, rh, win);
      System.out.println("  窗口 " + win + ": " + (r != null ? "✅ -> " + r : "❌"));
    }
  }

  /** 固定阈值二值化后交给 ZXing 的检测器。 */
  private static String tryFixed(
      int[] gray, int w, int h, int l, int t, int rw, int rh, int thr, int scale) {
    int ow = rw * scale;
    int oh = rh * scale;
    BitMatrix m = new BitMatrix(ow, oh);
    for (int y = 0; y < oh; y++) {
      int sy = t + y / scale;
      int srow = sy * w;
      for (int x = 0; x < ow; x++) {
        if (gray[srow + l + x / scale] < thr) m.set(x, y);
      }
    }
    return decode(m);
  }

  /** 局部均值阈值（Bradley 式），用来对比。 */
  private static String tryLocalMean(
      int[] gray, int w, int h, int l, int t, int rw, int rh, int win) {
    int half = win / 2;
    BitMatrix m = new BitMatrix(rw, rh);
    for (int y = 0; y < rh; y++) {
      for (int x = 0; x < rw; x++) {
        long sum = 0;
        int n = 0;
        for (int dy = -half; dy <= half; dy += 3) {
          int yy = Math.max(0, Math.min(rh - 1, y + dy));
          for (int dx = -half; dx <= half; dx += 3) {
            int xx = Math.max(0, Math.min(rw - 1, x + dx));
            sum += gray[(t + yy) * w + (l + xx)];
            n++;
          }
        }
        double mean = (double) sum / n;
        if (gray[(t + y) * w + (l + x)] < mean * 0.88) m.set(x, y);
      }
    }
    return decode(m);
  }

  private static String decode(BitMatrix m) {
    Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
    hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
    hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
    try {
      Result r = new QRCodeReader().decode(new BinaryBitmap(new PresetBinarizer(m)), hints);
      return r.getText();
    } catch (Throwable e) {
      return null;
    }
  }

  private static int otsuThreshold(int[] gray, int l, int t, int rw, int rh) {
    int[] hist = new int[256];
    for (int y = 0; y < rh; y++) {
      int row = (t + y) * 864;
      for (int x = 0; x < rw; x++) hist[Math.min(255, gray[row + l + x])]++;
    }
    int total = rw * rh;
    double sumAll = 0;
    for (int v = 0; v < 256; v++) sumAll += (double) v * hist[v];
    double sumB = 0;
    int wB = 0;
    double best = -1;
    int thr = 128;
    for (int v = 0; v < 256; v++) {
      wB += hist[v];
      if (wB == 0) continue;
      int wF = total - wB;
      if (wF == 0) break;
      sumB += (double) v * hist[v];
      double mB = sumB / wB;
      double mF = (sumAll - sumB) / wF;
      double between = (double) wB * wF * (mB - mF) * (mB - mF);
      if (between > best) {
        best = between;
        thr = v;
      }
    }
    return thr;
  }

  /** 直接返回预先算好的 BitMatrix，绕开 ZXing 自己的二值化。 */
  private static class PresetBinarizer extends Binarizer {
    private final BitMatrix matrix;

    PresetBinarizer(BitMatrix matrix) {
      super(new GraySource(matrix.getWidth(), matrix.getHeight()));
      this.matrix = matrix;
    }

    @Override
    public BitMatrix getBlackMatrix() throws NotFoundException {
      return matrix;
    }

    @Override
    public BitArray getBlackRow(int y, BitArray row) throws NotFoundException {
      if (row == null || row.getSize() < matrix.getWidth()) row = new BitArray(matrix.getWidth());
      row.clear();
      for (int x = 0; x < matrix.getWidth(); x++) {
        if (matrix.get(x, y)) row.set(x);
      }
      return row;
    }

    @Override
    public Binarizer createBinarizer(LuminanceSource source) {
      return this;
    }
  }

  private static class GraySource extends LuminanceSource {
    GraySource(int w, int h) {
      super(w, h);
    }

    @Override
    public byte[] getRow(int y, byte[] row) {
      if (row == null || row.length < getWidth()) row = new byte[getWidth()];
      return row;
    }

    @Override
    public byte[] getMatrix() {
      return new byte[getWidth() * getHeight()];
    }
  }
}
