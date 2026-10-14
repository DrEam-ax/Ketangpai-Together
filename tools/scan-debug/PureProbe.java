import com.google.zxing.*;
import com.google.zxing.common.*;
import com.google.zxing.qrcode.QRCodeReader;
import java.awt.image.BufferedImage;
import java.io.File;
import java.util.*;
import javax.imageio.ImageIO;

/** 试 ZXing 的 PURE_BARCODE 通路：它绕过定位图案搜索，直接按最外层黑白边界算模块网格。 */
public class PureProbe {
  public static void main(String[] a) throws Exception {
    BufferedImage im = ImageIO.read(new File("frame.jpg"));
    int w = im.getWidth(), h = im.getHeight();
    int[] g = new int[w*h];
    for (int y=0;y<h;y++) for (int x=0;x<w;x++) {
      int c = im.getRGB(x,y);
      g[y*w+x] = (((c>>16)&255)*299 + ((c>>8)&255)*587 + (c&255)*114)/1000;
    }
    System.out.println("帧 "+w+"x"+h);
    // 二维码在 buffer 里的位置反推：保存图是 buffer 顺时针转 90 度
    // rx = 863-by, ry = bx  =>  bx = ry, by = 863-rx
    System.out.println("(二维码 buffer 坐标 x 530..855, y 303..618)");

    int[][] boxes = {
      {520, 293, 346, 336},   // 紧贴 + 8px 余量
      {500, 273, 386, 376},   // 多留 30px
      {359, 138, 588, 588},   // 取景框那块
      {0, 0, w, h},           // 整帧
    };
    String[] names = {"紧贴", "宽松", "取景框", "整帧"};
    int[] scales = {1,2,3,4};
    int[] thrs = {0, 100, 128, 160};   // 0 = 用 ZXing 自带二值化

    for (int b=0;b<boxes.length;b++) {
      for (int sc : scales) {
        for (int th : thrs) {
          String r = go(g,w,h,boxes[b][0],boxes[b][1],boxes[b][2],boxes[b][3],sc,th);
          if (r != null) System.out.println("  OK  "+names[b]+" scale="+sc+" thr="+th+"  -> "+r);
        }
      }
    }
    System.out.println("(上面没有的组合都是失败)");
  }

  static String go(int[] g,int w,int h,int l,int t,int rw,int rh,int sc,int thr) {
    int ow=rw*sc, oh=rh*sc;
    byte[] d = new byte[ow*oh];
    for (int y=0;y<oh;y++){ int sy=t+y/sc; for(int x=0;x<ow;x++) d[y*ow+x]=(byte)g[sy*w+l+x/sc]; }
    LuminanceSource src;
    if (thr>0) {
      BitMatrix m = new BitMatrix(ow,oh);
      for (int i=0;i<d.length;i++) if ((d[i]&255) < thr) m.set(i%ow, i/ow);
      src = null;
      return dec(m);
    }
    src = new PlanarYUVLuminanceSource(d,ow,oh,0,0,ow,oh,false);
    Map<DecodeHintType,Object> hints = new EnumMap<>(DecodeHintType.class);
    hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
    hints.put(DecodeHintType.PURE_BARCODE, Boolean.TRUE);
    try { return new QRCodeReader().decode(new BinaryBitmap(new HybridBinarizer(src)), hints).getText(); }
    catch (Throwable e) { return null; }
  }

  static String dec(BitMatrix m) {
    Map<DecodeHintType,Object> hints = new EnumMap<>(DecodeHintType.class);
    hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
    hints.put(DecodeHintType.PURE_BARCODE, Boolean.TRUE);
    try { return new QRCodeReader().decode(new BinaryBitmap(new Pre(m)), hints).getText(); }
    catch (Throwable e) { return null; }
  }

  static class Pre extends Binarizer {
    final BitMatrix m;
    Pre(BitMatrix m){ super(new LS(m.getWidth(), m.getHeight())); this.m=m; }
    public BitMatrix getBlackMatrix(){ return m; }
    public BitArray getBlackRow(int y, BitArray row){
      if (row==null||row.getSize()<m.getWidth()) row=new BitArray(m.getWidth());
      row.clear();
      for (int x=0;x<m.getWidth();x++) if (m.get(x,y)) row.set(x);
      return row;
    }
    public Binarizer createBinarizer(LuminanceSource s){ return this; }
  }
  static class LS extends LuminanceSource {
    LS(int w,int h){ super(w,h); }
    public byte[] getRow(int y, byte[] r){ if(r==null||r.length<getWidth()) r=new byte[getWidth()]; return r; }
    public byte[] getMatrix(){ return new byte[getWidth()*getHeight()]; }
  }
}
