import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.LuminanceSource;
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
 * 第二轮：既然裸帧 ZXing Java 全败，那就看**预处理**能不能救活它。
 *
 * 逐个试：平场校正（除背景）、锐化、Otsu 二值化、加白边（补静区）、放大倍数，
 * 以及它们的组合。任何一组成功，都意味着我们只要在 App 里加同样的预处理就行，
 * 不必换解码库。
 *
 * 跑法:
 *   javac -encoding UTF-8 -cp core-3.5.3.jar -d out PreprocessProbe.java
 *   java -cp "out;core-3.5.3.jar" PreprocessProbe frame.jpg
 */
public class PreprocessProbe {

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

    // 二维码大致区域（按之前量出来的位置，留足边距）
    int rx = 220, ry = 500, rw = 380, rh = 400;

    String[] prepNames = {
      "无", "锐化", "平场", "平场+锐化", "Otsu", "平场+Otsu", "锐化+Otsu", "中值+锐化"
    };
    int[] scales = {1, 2, 3, 4, 5};
    int[] pads = {0, 30, 60};

    int tried = 0;
    for (int p = 0; p < prepNames.length; p++) {
      for (int sc : scales) {
        for (int pad : pads) {
          tried++;
          String got = attempt(gray, w, h, rx, ry, rw, rh, p, sc, pad);
          if (got != null) {
            System.out.println(
                "  ✅ 预处理=" + prepNames[p] + "  放大=" + sc + "x  白边=" + pad + "px   ->  " + got);
          }
        }
      }
    }
    System.out.println("共尝试 " + tried + " 种组合，上面没列出的都是失败。");
  }

  private static String attempt(
      int[] gray, int w, int h, int rx, int ry, int rw, int rh, int prep, int scale, int pad) {
    int ow = rw * scale;
    int oh = rh * scale;
    int[] buf = new int[ow * oh];
    // 最近邻放大
    for (int y = 0; y < oh; y++) {
      int sy = ry + y / scale;
      int srow = sy * w;
      int drow = y * ow;
      for (int x = 0; x < ow; x++) {
        buf[drow + x] = gray[srow + rx + x / scale];
      }
    }

    // 预处理（在放大后的图上做，锐化/二值化对像素更敏感）
    switch (prep) {
      case 1:
        buf = sharpen(buf, ow, oh, 1.4f);
        break;
      case 2:
        buf = flatten(buf, ow, oh);
        break;
      case 3:
        buf = sharpen(flatten(buf, ow, oh), ow, oh, 1.4f);
        break;
      case 4:
        buf = otsu(buf);
        break;
      case 5:
        buf = otsu(flatten(buf, ow, oh));
        break;
      case 6:
        buf = otsu(sharpen(buf, ow, oh, 1.4f));
        break;
      case 7:
        buf = otsu(sharpen(median3(buf, ow, oh), ow, oh, 1.2f));
        break;
      default:
        break;
    }

    // 加白边（补静区）
    int fw = ow + pad * 2;
    int fh = oh + pad * 2;
    int[] full = new int[fw * fh];
    java.util.Arrays.fill(full, 255);
    for (int y = 0; y < oh; y++) {
      System.arraycopy(buf, y * ow, full, (y + pad) * fw + pad, ow);
    }

    byte[] data = new byte[fw * fh];
    for (int i = 0; i < full.length; i++) {
      int v = full[i];
      data[i] = (byte) (v < 0 ? 0 : v > 255 ? 255 : v);
    }

    Map<DecodeHintType, Object> hints = new EnumMap<>(DecodeHintType.class);
    hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
    hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);

    String r = run(data, fw, fh, hints, false);
    if (r != null) return r;
    return run(data, fw, fh, hints, true);
  }

  private static String run(byte[] data, int w, int h, Map<DecodeHintType, Object> hints, boolean global) {
    try {
      LuminanceSource src = new GraySource(data, w, h);
      BinaryBitmap bmp =
          new BinaryBitmap(global ? new GlobalHistogramBinarizer(src) : new HybridBinarizer(src));
      Result r = new QRCodeReader().decode(bmp, hints);
      return r.getText();
    } catch (Throwable e) {
      return null;
    }
  }

  /** 平场校正：除以大窗口局部均值，消掉光照/反光不均。 */
  private static int[] flatten(int[] src, int w, int h) {
    int win = Math.max(9, (Math.min(w, h) / 2) | 1);
    int half = win / 2;
    long[] sum = new long[(w + 1) * (h + 1)];
    for (int y = 0; y < h; y++) {
      long rowSum = 0;
      for (int x = 0; x < w; x++) {
        rowSum += src[y * w + x];
        sum[(y + 1) * (w + 1) + (x + 1)] = sum[y * (w + 1) + (x + 1)] + rowSum;
      }
    }
    int[] out = new int[w * h];
    for (int y = 0; y < h; y++) {
      int y0 = Math.max(0, y - half);
      int y1 = Math.min(h - 1, y + half);
      for (int x = 0; x < w; x++) {
        int x0 = Math.max(0, x - half);
        int x1 = Math.min(w - 1, x + half);
        long area =
            sum[(y1 + 1) * (w + 1) + (x1 + 1)]
                - sum[y0 * (w + 1) + (x1 + 1)]
                - sum[(y1 + 1) * (w + 1) + x0]
                + sum[y0 * (w + 1) + x0];
        int count = (x1 - x0 + 1) * (y1 - y0 + 1);
        double bg = Math.max(1.0, (double) area / count);
        int v = (int) Math.round(src[y * w + x] / bg * 128.0);
        out[y * w + x] = v < 0 ? 0 : Math.min(v, 255);
      }
    }
    return out;
  }

  private static int[] sharpen(int[] src, int w, int h, float amount) {
    int[] out = new int[src.length];
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        int c = src[y * w + x];
        int s = 0;
        int n = 0;
        for (int dy = -1; dy <= 1; dy++) {
          int yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (int dx = -1; dx <= 1; dx++) {
            int xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            s += src[yy * w + xx];
            n++;
          }
        }
        double blur = (double) s / n;
        int v = (int) Math.round(c + amount * (c - blur));
        out[y * w + x] = v < 0 ? 0 : Math.min(v, 255);
      }
    }
    return out;
  }

  private static int[] median3(int[] src, int w, int h) {
    int[] out = new int[src.length];
    int[] win = new int[9];
    for (int y = 0; y < h; y++) {
      for (int x = 0; x < w; x++) {
        int n = 0;
        for (int dy = -1; dy <= 1; dy++) {
          int yy = Math.min(h - 1, Math.max(0, y + dy));
          for (int dx = -1; dx <= 1; dx++) {
            int xx = Math.min(w - 1, Math.max(0, x + dx));
            win[n++] = src[yy * w + xx];
          }
        }
        java.util.Arrays.sort(win);
        out[y * w + x] = win[4];
      }
    }
    return out;
  }

  private static int[] otsu(int[] src) {
    int[] hist = new int[256];
    for (int v : src) hist[Math.min(255, Math.max(0, v))]++;
    int total = src.length;
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
    int[] out = new int[src.length];
    for (int i = 0; i < src.length; i++) out[i] = src[i] > thr ? 255 : 0;
    return out;
  }

  /** 直接把灰度数组当亮度源（等价于 App 里 NV21 的 Y 平面）。 */
  private static class GraySource extends LuminanceSource {
    private final byte[] data;

    GraySource(byte[] data, int w, int h) {
      super(w, h);
      this.data = data;
    }

    @Override
    public byte[] getRow(int y, byte[] row) {
      int w = getWidth();
      if (row == null || row.length < w) row = new byte[w];
      System.arraycopy(data, y * w, row, 0, w);
      return row;
    }

    @Override
    public byte[] getMatrix() {
      return data;
    }
  }
}
