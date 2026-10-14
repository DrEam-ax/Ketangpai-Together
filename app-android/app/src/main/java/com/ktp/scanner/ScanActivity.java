package com.ktp.scanner;

import android.Manifest;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.ImageFormat;
import android.graphics.Point;
import android.hardware.Camera;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.GestureDetector;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.ScaleGestureDetector;
import android.view.Surface;
import android.view.SurfaceHolder;
import android.view.SurfaceView;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;

import com.google.android.gms.tasks.OnFailureListener;
import com.google.android.gms.tasks.OnSuccessListener;
import com.google.mlkit.vision.barcode.BarcodeScanner;
import com.google.mlkit.vision.barcode.BarcodeScannerOptions;
import com.google.mlkit.vision.barcode.BarcodeScanning;
import com.google.mlkit.vision.barcode.common.Barcode;
import com.google.mlkit.vision.common.InputImage;
import com.google.zxing.BarcodeFormat;
import com.google.zxing.BinaryBitmap;
import com.google.zxing.DecodeHintType;
import com.google.zxing.LuminanceSource;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.common.GlobalHistogramBinarizer;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Locale;

/**
 * 全屏实时扫码（微信扫一扫那种）。
 *
 * 相机开在一个带 Looper 的后台线程上，onPreviewFrame 就在这个线程里跑，
 * 所以解码是就地做的 —— 解码期间收不到新帧，因此**每帧解码速度 = 识别快慢**。
 *
 * ── 为什么以前"举半天才识别"（实测踩过的坑）──────────────────────────
 *  1) 预览尺寸挑反了：拿竖屏比例 (1080/2400=0.45) 去比相机横向比例
 *     (1280/720=1.78)，结果挑成最不匹配的 4:3，分辨率可能到 1920x1440（276 万像素）。
 *     正确做法是比较「旋转之后」的比例 h/w 和屏幕比例。
 *  2) 每帧解码整幅 276 万像素，而且 MultiFormatReader 会把所有条码格式都试一遍，
 *     单帧要几百毫秒 —— 相机回调被堵住，实际每秒只识别 1~2 次。
 *  现在：预览封顶 1280、只解屏幕真正看得到的那块区域、只认 QR 格式、
 *  并且把尝试间隔压到 60ms，识别速度提升一个数量级。
 *
 * ── 另外两个坑 ───────────────────────────────────────────────────────
 *  3) 画面拉伸：按真实比例等比放大铺满 + 居中裁剪，不能直接用 match_parent。
 *  4) 双指缩放：优先用相机变焦（真裁传感器），不支持时退化成缩放 SurfaceView。
 */
public class ScanActivity extends Activity implements SurfaceHolder.Callback, Camera.PreviewCallback {

  public static final String EXTRA_TEXT = "text";
  public static final String EXTRA_ERROR = "error";
  /** 是哪个检测器认出来的（ZXing / ZXing·放大 / ML Kit）—— 用来定位"扫不上"到底卡在哪一环 */
  public static final String EXTRA_SOURCE = "source";

  private static final int REQ_CAM = 2001;
  /** 两次解码之间的最小间隔。解码本身不贵了，这里放小一点，多试几次。 */
  private static final long DECODE_INTERVAL_MS = 60;
  /** 预览长边上限：1280 足够解二维码，再大只是白白拖慢解码。 */
  /**
   * 预览分辨率上限。
   *
   * 从 1280 提回 1920 是因为小二维码：像素不够时 ZXing 的定位图案比例判断会失败。
   * 代价是每帧多解约 2 倍像素，但因为我们只解 crop 区域（不是全画幅），
   * 单帧解码仍然在几十毫秒量级，靠 DECODE_INTERVAL_MS 限流即可。
   */
  private static final int MAX_PREVIEW_WIDTH = 1920;
  private static final float MIN_ZOOM = 1f;
  private static final float MAX_ZOOM = 6f;

  private SurfaceHolder holder;
  private ViewfinderView viewfinder;
  private SurfaceView surface;
  private Camera camera;
  private HandlerThread camThread;
  private Handler camHandler;

  private int previewWidth = 0;
  private int previewHeight = 0;
  /** 显示方向（0/90/180/270），用来算预览在屏幕上的真实宽高比。 */
  private int displayRotation = 90;

  /** 屏幕实际能看到的预览区域（未旋转的 buffer 坐标系）。只解这块，快得多。 */
  private int cropLeft = 0;
  private int cropTop = 0;
  private int cropWidth = 0;
  private int cropHeight = 0;

  // 变焦相关
  private boolean zoomSupported = false;
  private List<Integer> zoomRatios;
  private int maxZoomLevel = 0;
  private int appliedZoomLevel = -1;
  private float pinchScale = 1f;
  private int baseSurfaceW = 0;
  private int baseSurfaceH = 0;

  /**
   * 是否设上了「连续对焦」模式。
   * 如果设备不支持连续对焦，就得靠定时调 autoFocus() 兜着 ——
   * 否则相机停在某个焦距上不动，画面一直糊，任何检测算法都救不回来。
   */
  private boolean continuousFocus = false;

  /** ML Kit 分块扫描的网格数与每块占比 */
  /** ML Kit 子块边长占短边的比例（正方形块） */
  private static final float ML_TILE_FRAC = 0.6f;

  private volatile long lastAutoFocus = 0;
  /** ML Kit 分块扫描：-1 表示整幅，0..8 表示 3x3 里的某一块 */
  private int mlTile = -1;
  /** 整幅 / 子块各自一个**长度精确**的缓冲（见 buildNv21Crop 的说明） */
  private byte[] mlFullBuf;
  private byte[] mlTileBuf;
  /** ML Kit 最近一次报错，用来排查"它到底有没有在工作" */
  private volatile String mlLastError = null;
  /** ML Kit 的进展计数：处理了多少帧、有没有异常 —— 屏幕上看得到 */
  private volatile int mlProcessed = 0;
  private volatile int mlFailed = 0;
  private volatile long lastDebugUpdate = 0;

  // 「存图排查」用
  private volatile boolean wantCapture = false;
  private volatile boolean capturedReady = false;
  private byte[] captureBuf;
  private volatile int capturedW = 0;
  private volatile int capturedH = 0;

  private ScaleGestureDetector scaleDetector;
  private GestureDetector tapDetector;

  private volatile boolean finished = false;
  private volatile long lastDecode = 0;
  private volatile int frameCount = 0;
  /** 2 倍放大用的复用缓冲，避免每帧 new 几百 KB 的数组 */
  private byte[] upBuf;
  /**
   * 放大那一路的目标边长。
   * 用「固定目标」而不是「固定 2 倍」是为了让成本可控：
   * 预览分辨率提高后中心正方形本来就大了，再乘 2 会到 300 万像素，解码会卡。
   */
  private static final int UPSCALE_TARGET_SIDE = 1280;

  /** ML Kit 兜底检测器（ZXing 认不出来时才用） */
  private BarcodeScanner mlScanner;
  private boolean mlInitFailed = false;
  private volatile boolean mlBusy = false;
  /** 本次识别是谁做成的，随结果一起回传 */
  private volatile String foundBy = "ZXing";

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    setContentView(R.layout.activity_scan);

    viewfinder = findViewById(R.id.viewfinder);
    surface = findViewById(R.id.preview);
    surface.setKeepScreenOn(true);
    holder = surface.getHolder();
    holder.addCallback(this);

    findViewById(R.id.back).setOnClickListener(
        new View.OnClickListener() {
          @Override
          public void onClick(View v) {
            cancel();
          }
        });

    findViewById(R.id.snapshot).setOnClickListener(
        new View.OnClickListener() {
          @Override
          public void onClick(View v) {
            requestSnapshot();
          }
        });

    scaleDetector =
        new ScaleGestureDetector(
            this,
            new ScaleGestureDetector.SimpleOnScaleGestureListener() {
              @Override
              public boolean onScale(ScaleGestureDetector detector) {
                pinchScale *= detector.getScaleFactor();
                if (pinchScale < MIN_ZOOM) pinchScale = MIN_ZOOM;
                if (pinchScale > MAX_ZOOM) pinchScale = MAX_ZOOM;
                applyZoom();
                return true;
              }
            });

    tapDetector =
        new GestureDetector(
            this,
            new GestureDetector.SimpleOnGestureListener() {
              @Override
              public boolean onDoubleTap(MotionEvent e) {
                pinchScale = 1f;
                applyZoom();
                return true;
              }

              @Override
              public boolean onDown(MotionEvent e) {
                return true;
              }
            });

    if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      requestPermissions(new String[] {Manifest.permission.CAMERA}, REQ_CAM);
    }
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    if (requestCode == REQ_CAM
        && (grantResults.length == 0 || grantResults[0] != PackageManager.PERMISSION_GRANTED)) {
      fail("没有相机权限。请到「设置 → 应用 → 课堂派签到 → 权限」里允许相机。");
    }
  }

  // ------------------------------------------------------------------ 手势

  @Override
  public boolean dispatchTouchEvent(MotionEvent ev) {
    // 两个手势探测器都要收到事件，所以在这里统一分发
    scaleDetector.onTouchEvent(ev);
    tapDetector.onTouchEvent(ev);
    return super.dispatchTouchEvent(ev);
  }

  private void applyZoom() {
    if (finished) return;

    if (zoomSupported && zoomRatios != null && !zoomRatios.isEmpty()) {
      int base = zoomRatios.get(0);
      int target = Math.round(base * pinchScale);
      int best = 0;
      int bestDiff = Integer.MAX_VALUE;
      for (int i = 0; i < zoomRatios.size(); i++) {
        int diff = Math.abs(zoomRatios.get(i) - target);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = i;
        }
      }
      if (best > maxZoomLevel) best = maxZoomLevel;
      if (best == appliedZoomLevel) {
        updateZoomLabel();
        return;
      }
      appliedZoomLevel = best;
      final int level = best;
      if (camHandler != null) {
        camHandler.post(
            new Runnable() {
              @Override
              public void run() {
                Camera cam = camera;
                if (cam == null) return;
                try {
                  Camera.Parameters p = cam.getParameters();
                  p.setZoom(level);
                  cam.setParameters(p);
                } catch (Exception ignored) {
                }
              }
            });
      }
    } else {
      final float scale = pinchScale;
      runOnUiThread(
          new Runnable() {
            @Override
            public void run() {
              applySurfaceSize(scale);
            }
          });
    }
    updateZoomLabel();
  }

  private void updateZoomLabel() {
    if (viewfinder == null) return;
    if (Math.abs(pinchScale - 1f) < 0.02f) viewfinder.setZoomLabel(null);
    else viewfinder.setZoomLabel(String.format(Locale.US, "%.1fx", pinchScale));
  }

  // ------------------------------------------------------------------ 生命周期

  @Override
  protected void onResume() {
    super.onResume();
    if (holder != null && holder.getSurface() != null && holder.getSurface().isValid()) {
      startCamera();
    }
  }

  @Override
  protected void onPause() {
    stopCamera();
    super.onPause();
  }

  /**
   * 初始化 ML Kit 的条码检测器。
   *
   * 这是微信那一档的能力：ML Kit 用神经网络做检测，对小码、糊码、低对比度、
   * 角度刁钻的码都明显强于 ZXing 那种"找 1:1:3:1:1 定位图案"的经典算法。
   *
   * 拿来兜底而不是替换：ZXing 先试（快、够用），它失败了才交给 ML Kit。
   * 这样万一某些机型上 ML Kit 起不来，扫码功能也不会坏。
   */
  private void initMlKit() {
    if (mlScanner != null || mlInitFailed) return;
    try {
      BarcodeScannerOptions options =
          new BarcodeScannerOptions.Builder().setBarcodeFormats(Barcode.FORMAT_QR_CODE).build();
      mlScanner = BarcodeScanning.getClient(options);
    } catch (Throwable t) {
      mlInitFailed = true;
      mlScanner = null;
    }
  }

  @Override
  protected void onDestroy() {
    if (mlScanner != null) {
      try {
        mlScanner.close();
      } catch (Throwable ignored) {
      }
      mlScanner = null;
    }
    super.onDestroy();
  }

  @Override
  public void surfaceCreated(SurfaceHolder h) {
    startCamera();
  }

  @Override
  public void surfaceChanged(SurfaceHolder h, int format, int width, int height) {
    if (camera == null) return;
    try {
      camera.stopPreview();
      camera.setPreviewDisplay(h);
      camera.startPreview();
    } catch (Exception ignored) {
    }
  }

  @Override
  public void surfaceDestroyed(SurfaceHolder h) {
    stopCamera();
  }

  @Override
  public void onBackPressed() {
    cancel();
  }

  // ------------------------------------------------------------------ 相机

  private void startCamera() {
    if (camThread != null) return;
    camThread = new HandlerThread("ktp-camera");
    camThread.start();
    camHandler = new Handler(camThread.getLooper());
    camHandler.post(
        new Runnable() {
          @Override
          public void run() {
            openCamera();
          }
        });
  }

  private void openCamera() {
    if (camera != null) return;
    try {
      camera = Camera.open();
    } catch (Exception e) {
      fail("打不开摄像头：" + e.getMessage());
      return;
    }
    try {
      Camera.Parameters p = camera.getParameters();

      Point screen = screenSize();
      Camera.Size best = choosePreviewSize(p.getSupportedPreviewSizes(), screen);
      if (best != null) {
        previewWidth = best.width;
        previewHeight = best.height;
        p.setPreviewSize(previewWidth, previewHeight);
      }

      try {
        if (p.isZoomSupported()) {
          maxZoomLevel = p.getMaxZoom();
          zoomRatios = p.getZoomRatios();
          zoomSupported = maxZoomLevel > 0 && zoomRatios != null && !zoomRatios.isEmpty();
        }
      } catch (Exception ignored) {
        zoomSupported = false;
      }

      p.setPreviewFormat(ImageFormat.NV21);

      // 对焦模式必须「有兜底」。
      // 之前只处理了 CONTINUOUS_PICTURE：设备不支持时一个模式都不设，
      // 而很多机型默认是 FOCUS_MODE_AUTO —— AUTO 不主动调 autoFocus() 就永远不对焦，
      // 取景画面一直是虚的，小二维码根本无从识别。
      try {
        List<String> focus = p.getSupportedFocusModes();
        continuousFocus = false;
        if (focus != null && focus.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO)) {
          // 连续视频对焦是专门为「预览流」设计的，比 continuous picture 更适合扫码
          p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_VIDEO);
          continuousFocus = true;
        } else if (focus != null
            && focus.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
          p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
          continuousFocus = true;
        } else if (focus != null && focus.contains(Camera.Parameters.FOCUS_MODE_AUTO)) {
          p.setFocusMode(Camera.Parameters.FOCUS_MODE_AUTO);
        } else if (focus != null && focus.contains(Camera.Parameters.FOCUS_MODE_MACRO)) {
          p.setFocusMode(Camera.Parameters.FOCUS_MODE_MACRO);
        }
      } catch (Exception ignored) {
      }
      try {
        camera.setParameters(p);
      } catch (Exception ignored) {
      }

      displayRotation = calcDisplayRotation();
      camera.setDisplayOrientation(displayRotation);
      camera.setPreviewDisplay(holder);
      camera.setPreviewCallback(this);
      camera.startPreview();

      computeLayout(screen);
    } catch (Exception e) {
      fail("相机初始化失败：" + e.getMessage());
    }
  }

  /**
   * 一次算清两件事：
   *   1) SurfaceView 该多大（等比铺满屏幕，居中，多出来的裁掉）—— 这样画面不变形
   *   2) 屏幕实际能看到预览的哪一块 —— 解码只解这块，省掉大部分像素
   */
  private void computeLayout(final Point screen) {
    if (previewWidth <= 0 || previewHeight <= 0) return;

    final boolean swapped = displayRotation % 180 != 0;
    final int displayW = swapped ? previewHeight : previewWidth; // 屏幕上的宽
    final int displayH = swapped ? previewWidth : previewHeight; // 屏幕上的高

    float scale = Math.max((float) screen.x / displayW, (float) screen.y / displayH);

    // 可见的显示区域
    int visibleW = Math.min(displayW, Math.round(screen.x / scale));
    int visibleH = Math.min(displayH, Math.round(screen.y / scale));

    // 映射回未旋转的 buffer 坐标
    int bufW = swapped ? visibleH : visibleW;
    int bufH = swapped ? visibleW : visibleH;
    bufW = Math.min(bufW, previewWidth);
    bufH = Math.min(bufH, previewHeight);
    cropWidth = bufW;
    cropHeight = bufH;
    cropLeft = Math.max(0, (previewWidth - bufW) / 2);
    cropTop = Math.max(0, (previewHeight - bufH) / 2);

    baseSurfaceW = Math.round(displayW * scale);
    baseSurfaceH = Math.round(displayH * scale);

    runOnUiThread(
        new Runnable() {
          @Override
          public void run() {
            if (finished || surface == null) return;
            applySurfaceSize(pinchScale);
          }
        });
  }

  private void applySurfaceSize(float scale) {
    if (surface == null || baseSurfaceW <= 0 || baseSurfaceH <= 0) return;
    FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) surface.getLayoutParams();
    lp.width = Math.round(baseSurfaceW * scale);
    lp.height = Math.round(baseSurfaceH * scale);
    lp.gravity = Gravity.CENTER;
    surface.setLayoutParams(lp);
  }

  @SuppressWarnings("deprecation")
  private Point screenSize() {
    Point p = new Point();
    WindowManager wm = getWindowManager();
    wm.getDefaultDisplay().getRealSize(p);
    if (p.x <= 0 || p.y <= 0) {
      p.x = getResources().getDisplayMetrics().widthPixels;
      p.y = getResources().getDisplayMetrics().heightPixels;
    }
    return p;
  }

  private int calcDisplayRotation() {
    try {
      Camera.CameraInfo info = new Camera.CameraInfo();
      Camera.getCameraInfo(0, info);
      int rotation = getWindowManager().getDefaultDisplay().getRotation();
      int degrees = 0;
      switch (rotation) {
        case Surface.ROTATION_0:
          degrees = 0;
          break;
        case Surface.ROTATION_90:
          degrees = 90;
          break;
        case Surface.ROTATION_180:
          degrees = 180;
          break;
        case Surface.ROTATION_270:
          degrees = 270;
          break;
        default:
          break;
      }
      if (info.facing == Camera.CameraInfo.CAMERA_FACING_FRONT) {
        return (360 - ((info.orientation + degrees) % 360)) % 360;
      }
      return (info.orientation - degrees + 360) % 360;
    } catch (Exception e) {
      return 90;
    }
  }

  /**
   * 挑预览尺寸。
   *
   * 关键：预览缓冲区是**横向**的，经 setDisplayOrientation 旋转 90° 后，
   * 缓冲区的高变成屏幕的宽、缓冲区的宽变成屏幕的高。所以要拿
   * 「(height/width)」去和「屏幕宽/屏幕高」比，而不是拿 width/height 比 ——
   * 之前就是这里比反了，才挑成又大又不匹配的 4:3。
   */
  private static Camera.Size choosePreviewSize(List<Camera.Size> sizes, Point screen) {
    if (sizes == null || sizes.isEmpty()) return null;

    double screenRatio = (double) screen.x / (double) screen.y; // 例如 1080/2400 = 0.45
    Camera.Size best = null;
    double bestDiff = Double.MAX_VALUE;
    long bestArea = 0;

    for (Camera.Size s : sizes) {
      if (s.width > MAX_PREVIEW_WIDTH) continue;
      double rotatedRatio = (double) s.height / (double) s.width; // 16:9 -> 0.5625
      double diff = Math.abs(rotatedRatio - screenRatio);
      long area = (long) s.width * s.height;
      if (diff < bestDiff - 0.02 || (Math.abs(diff - bestDiff) <= 0.02 && area > bestArea)) {
        bestDiff = Math.min(bestDiff, diff);
        bestArea = area;
        best = s;
      }
    }

    if (best == null) {
      long area = 0;
      for (Camera.Size s : sizes) {
        if (s.width > MAX_PREVIEW_WIDTH) continue;
        long a = (long) s.width * s.height;
        if (a > area) {
          area = a;
          best = s;
        }
      }
    }
    if (best == null) {
      long area = 0;
      for (Camera.Size s : sizes) {
        long a = (long) s.width * s.height;
        if (a > area) {
          area = a;
          best = s;
        }
      }
    }
    return best;
  }

  private void stopCamera() {
    if (camera != null) {
      try {
        camera.setPreviewCallback(null);
        camera.stopPreview();
      } catch (Exception ignored) {
      }
      try {
        camera.release();
      } catch (Exception ignored) {
      }
      camera = null;
    }
    if (camThread != null) {
      camThread.quitSafely();
      camThread = null;
      camHandler = null;
    }
  }

  // ------------------------------------------------------------------ 解码

  @Override
  public void onPreviewFrame(byte[] data, Camera cam) {
    if (finished || data == null) return;

    long now = System.currentTimeMillis();
    if (now - lastDecode < DECODE_INTERVAL_MS) return;
    lastDecode = now;
    frameCount++;

    // 有些机型不支持连续对焦，那就得定时主动触发一次 ——
    // 老式扫码 App 都是这么干的。不这么做相机就停在初始焦距上不挪窝。
    if (!continuousFocus && camera != null && now - lastAutoFocus > 1500) {
      lastAutoFocus = now;
      try {
        camera.autoFocus(null);
      } catch (Exception ignored) {
      }
    }

    // 留着给"存图排查"用（真正拷贝在下面 wantCapture 分支里做）

    int w = previewWidth;
    int h = previewHeight;
    if (w <= 0 || h <= 0) {
      Camera.Size s = cam.getParameters().getPreviewSize();
      w = s.width;
      h = s.height;
      previewWidth = w;
      previewHeight = h;
    }

    // 「存图排查」：按需把这一帧拷下来。
    // 必须在这里拷贝而不是留着 data 的引用 —— 官方文档明确说
    // onPreviewFrame 的 buffer 只在回调期间有效。
    if (wantCapture) {
      wantCapture = false;
      final int need = w * h * 3 / 2;
      if (captureBuf == null || captureBuf.length < need) captureBuf = new byte[need];
      System.arraycopy(data, 0, captureBuf, 0, Math.min(need, data.length));
      capturedW = w;
      capturedH = h;
      capturedReady = true;
      uiPost(
          new Runnable() {
            @Override
            public void run() {
              doSaveCaptured();
            }
          });
    }

    // 每帧先按原尺寸快速解（正常大小的二维码靠这条）；
    // 每 4 帧再走一次「中心正方形 2 倍放大 + TRY_HARDER」——这是小二维码的救命路径。
    boolean extra = frameCount % 4 == 0;
    String text = decode(data, w, h, extra);
    String by = "ZXing";
    if (text == null && extra) {
      text = decodeUpscaled(data, w, h);
      by = "ZXing·放大";
    }
    if (text != null && !text.isEmpty()) {
      foundBy = by;
      succeed(text);
      return;
    }

    // ZXing 都没认出来，交给 ML Kit（异步，不阻塞取景）。
    // 隔帧跑一次即可，它比 ZXing 重。
    if (frameCount % 2 == 0) {
      runMlKit(data, w, h);
    }

    // 每 500ms 把状态刷到屏幕上 —— 真机出问题时截个图就能定位
    if (now - lastDebugUpdate > 500) {
      lastDebugUpdate = now;
      updateDebugText();
    }
  }

  /**
   * 把诊断信息画到取景框下方。
   *
   * 加这个是因为：我们没法在电脑上跑 ML Kit，而真机一次往返成本很高。
   * 把「ML Kit 到底有没有在工作、处理了多少帧、报了什么错」直接显示出来，
   * 一张截图就能回答所有问题。
   */
  private void updateDebugText() {
    final ViewfinderView vf = viewfinder;
    if (vf == null) return;

    StringBuilder sb = new StringBuilder();
    sb.append("预览 ")
        .append(previewWidth)
        .append('x')
        .append(previewHeight)
        .append("  裁剪 ")
        .append(cropWidth)
        .append('x')
        .append(cropHeight)
        .append("  变焦 ")
        .append(appliedZoomLevel + 1)
        .append('/')
        .append(maxZoomLevel + 1);
    sb.append('\n');
    if (mlScanner != null) {
      sb.append("MLKit 就绪  处理 ")
          .append(mlProcessed)
          .append("  失败 ")
          .append(mlFailed);
    } else if (mlInitFailed) {
      sb.append("MLKit 初始化失败");
    } else {
      sb.append("MLKit 尚未启动");
    }
    if (mlLastError != null) {
      sb.append("  错误: ").append(mlLastError);
    }
    sb.append('\n').append("帧 ").append(frameCount);
    sb.append(continuousFocus ? "  连续对焦" : "  定时对焦");

    final String text = sb.toString();
    uiPost(
        new Runnable() {
          @Override
          public void run() {
            vf.setDebugText(text);
          }
        });
  }

  /**
   * 用 ML Kit 再试一次。异步执行，结果回到主线程。
   *
   * 关键点：**喂给它的是裁剪后的小图，不是整帧**。
   * 小二维码在整帧 200 万像素里只是个很小的目标，ML Kit 内部还会再缩放一次，很容易漏。
   * 裁成 55% 的子块后，码在输入图里占的比例大 3 倍多，检出率完全不同 ——
   * 这也是「取景框」这个交互存在的意义。
   *
   * 轮流看「整幅 + 3x3 九块」，好处是**完全不需要算坐标映射**：
   * 不管用户把码放在画面哪个位置，总有一块能完整包住它。
   *
   * 用 mlBusy 防止任务堆积：ML Kit 一次要几十到上百毫秒，
   * 不等它做完就继续投喂只会把队列塞满、越扫越卡。
   */
  private void runMlKit(byte[] data, int width, int height) {
    initMlKit();
    if (mlScanner == null || mlBusy || finished) return;

    int left = cropLeft;
    int top = cropTop;
    int w = cropWidth;
    int h = cropHeight;
    if (w <= 0 || h <= 0 || left + w > width || top + h > height) {
      left = 0;
      top = 0;
      w = width;
      h = height;
    }

    boolean full = mlTile < 0;
    int count = 1;
    if (!full) {
      // 用**正方形**子块（边长按短边算）。
      // 之前用 55% 的矩形块，长边 1056 而码只有 380 宽 —— 码在输入图里仍只占 36%，
      // ML Kit 内部再一缩放就更小了。改成正方形后边长约 518，码占 73%。
      int side = Math.max(96, Math.round(Math.min(w, h) * ML_TILE_FRAC));
      int step = Math.max(1, Math.round(side * 0.5f));
      int cols = Math.max(1, (w - side) / step + 1);
      int rows = Math.max(1, (h - side) / step + 1);
      count = cols * rows;
      if (mlTile >= count) mlTile = -1;
      int idx = Math.max(0, mlTile);
      int tx = idx % cols;
      int ty = idx / cols;
      int tw = Math.min(side, w);
      int th = Math.min(side, h);
      left += Math.min(Math.max(0, w - tw), tx * step);
      top += Math.min(Math.max(0, h - th), ty * step);
      w = tw;
      h = th;
    }
    mlTile = (mlTile + 1 >= count) ? -1 : mlTile + 1;

    byte[] buf = buildNv21Crop(data, width, height, left, top, w, h, full);
    if (buf == null) return;

    final InputImage image;
    try {
      image =
          InputImage.fromByteArray(buf, w, h, displayRotation, InputImage.IMAGE_FORMAT_NV21);
    } catch (Throwable t) {
      return;
    }

    mlBusy = true;
    try {
      mlScanner
          .process(image)
          .addOnSuccessListener(
              new OnSuccessListener<List<Barcode>>() {
                @Override
                public void onSuccess(List<Barcode> barcodes) {
                  mlBusy = false;
                  mlProcessed++;
                  if (finished) return;
                  for (Barcode b : barcodes) {
                    String value = b.getRawValue();
                    if (value != null && !value.isEmpty()) {
                      foundBy = "ML Kit";
                      succeed(value);
                      return;
                    }
                  }
                }
              })
          .addOnFailureListener(
              new OnFailureListener() {
                @Override
                public void onFailure(Exception e) {
                  mlBusy = false;
                  mlFailed++;
                  mlLastError = String.valueOf(e.getMessage());
                }
              });
    } catch (Throwable t) {
      mlBusy = false;
      mlLastError = String.valueOf(t.getMessage());
    }
  }

  /**
   * 从整帧 NV21 裁出一块，拼成一块**尺寸严格等于 w*h*3/2** 的独立 NV21。
   *
   * 为什么必须严格相等：InputImage.fromByteArray 会校验长度，
   * 传一个复用的、偏大的数组会直接抛异常（而我原来是 catch 掉静默返回的，
   * 那就变成"ML Kit 好像从来没生效"却查不出原因）。
   *
   * 色度是 2x2 下采样的，所以起点和尺寸都取偶数，否则色度会错位。
   * 条码检测其实只用亮度，但长度校验过不了就没意义，所以还是老实搬过去。
   */
  private byte[] buildNv21Crop(
      byte[] src, int srcW, int srcH, int l, int t, int w, int h, boolean fullFrame) {
    l &= ~1;
    t &= ~1;
    w &= ~1;
    h &= ~1;
    if (l < 0) l = 0;
    if (t < 0) t = 0;
    if (l + w > srcW) w = (srcW - l) & ~1;
    if (t + h > srcH) h = (srcH - t) & ~1;
    if (w <= 0 || h <= 0) return null;

    final int need = w * h * 3 / 2;
    byte[] dst;
    if (fullFrame) {
      if (mlFullBuf == null || mlFullBuf.length != need) mlFullBuf = new byte[need];
      dst = mlFullBuf;
    } else {
      if (mlTileBuf == null || mlTileBuf.length != need) mlTileBuf = new byte[need];
      dst = mlTileBuf;
    }

    // 亮度平面：逐行搬
    for (int y = 0; y < h; y++) {
      System.arraycopy(src, (t + y) * srcW + l, dst, y * w, w);
    }

    // 色度平面：源里每两行存一份
    final int dstChroma = w * h;
    if (src.length >= srcW * srcH * 3 / 2) {
      final int srcY = srcW * srcH;
      for (int y = 0; y < h; y += 2) {
        System.arraycopy(src, srcY + ((t + y) >> 1) * srcW + l, dst, dstChroma + (y >> 1) * w, w);
      }
    } else {
      // 拿不到色度就填中性灰 —— 对条码检测没有任何影响
      java.util.Arrays.fill(dst, dstChroma, need, (byte) 128);
    }
    return dst;
  }

  /**
   * 解一帧。只解 crop 区域（屏幕实际看得见的那部分），并且只认 QR 格式 ——
   * 这两点是识别速度的关键：像素少了、也不再逐个试其他条码格式。
   */
  private String decode(byte[] data, int width, int height, boolean altBinarizer) {
    int left = cropLeft;
    int top = cropTop;
    int w = cropWidth;
    int h = cropHeight;
    if (w <= 0 || h <= 0 || left + w > width || top + h > height) {
      left = 0;
      top = 0;
      w = width;
      h = height;
    }

    LuminanceSource source = new PlanarYUVLuminanceSource(data, width, height, left, top, w, h, false);
    return runDecode(source, false, altBinarizer);
  }

  /**
   * 把小二维码救回来的那一路：取 crop 的中心正方形，2 倍最近邻放大后再解，并开 TRY_HARDER。
   *
   * 为什么要放大（而不是直接解原图）：
   * ZXing 靠扫描"黑:白:黑:白:黑 = 1:1:3:1:1"来找定位图案。二维码在画面里很小时，
   * 每个模块可能只占 1~2 个像素，这个比例判断就崩了 —— 表现就是"怎么举都扫不上"。
   * 放大后每个模块占的像素变多，比例判断才站得住。微信的多尺度检测本质也在做这件事。
   *
   * TRY_HARDER 让 ZXing 逐行扫描（默认是每 3 行扫一次），小码更容易被找到。
   *
   * 只取中心正方形 + 限制放大后的总像素，是为了不让这一路把帧率拖垮。
   */
  private String decodeUpscaled(byte[] data, int width, int height) {
    int left = cropLeft;
    int top = cropTop;
    int w = cropWidth;
    int h = cropHeight;
    if (w <= 0 || h <= 0 || left + w > width || top + h > height) {
      left = 0;
      top = 0;
      w = width;
      h = height;
    }

    int side = Math.min(w, h);
    int outSide = Math.min(side * 2, UPSCALE_TARGET_SIDE);
    if (outSide < side * 1.15f) return null; // 码已经够大了，用不着这一路
    int lx = left + (w - side) / 2;
    int ly = top + (h - side) / 2;

    int outW = outSide;
    int outH = outSide;
    if (upBuf == null || upBuf.length < outW * outH) upBuf = new byte[outW * outH];
    byte[] dst = upBuf;
    for (int y = 0; y < outH; y++) {
      int srcRow = (ly + (y * side) / outSide) * width + lx;
      int dstRow = y * outW;
      for (int x = 0; x < outW; x++) {
        dst[dstRow + x] = data[srcRow + (x * side) / outSide];
      }
    }

    LuminanceSource source = new PlanarYUVLuminanceSource(dst, outW, outH, 0, 0, outW, outH, false);
    return runDecode(source, true, true);
  }

  /** 统一的解码入口：先 HybridBinarizer，必要时换 GlobalHistogramBinarizer 再试一次。 */
  private String runDecode(LuminanceSource source, boolean tryHarder, boolean altBinarizer) {
    Map<DecodeHintType, Object> hints = null;
    if (tryHarder) {
      hints = new EnumMap<>(DecodeHintType.class);
      hints.put(DecodeHintType.POSSIBLE_FORMATS, Collections.singletonList(BarcodeFormat.QR_CODE));
      hints.put(DecodeHintType.TRY_HARDER, Boolean.TRUE);
    }

    QRCodeReader reader = new QRCodeReader();
    try {
      BinaryBitmap hybrid = new BinaryBitmap(new HybridBinarizer(source));
      return hints == null ? reader.decode(hybrid).getText() : reader.decode(hybrid, hints).getText();
    } catch (Exception ignored) {
      // 换一种二值化再试
    }
    if (altBinarizer) {
      try {
        BinaryBitmap global = new BinaryBitmap(new GlobalHistogramBinarizer(source));
        return hints == null
            ? reader.decode(global).getText()
            : reader.decode(global, hints).getText();
      } catch (Exception ignored) {
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ 存图排查

  private void requestSnapshot() {
    if (capturedW <= 0 && previewWidth <= 0) {
      toast("还没取到画面，稍等一下再按");
      return;
    }
    capturedReady = false;
    wantCapture = true;
    toast(
        "正在抓图 · 预览"
            + previewWidth
            + "x"
            + previewHeight
            + " · 变焦"
            + (appliedZoomLevel + 1)
            + "/"
            + (maxZoomLevel + 1)
            + " · MLKit"
            + (mlScanner != null ? "就绪" : mlInitFailed ? "失败" : "未启动"));
  }

  /**
   * 把抓到的这一帧写成 JPEG 存进相册。
   *
   * 存的是**相机原始亮度平面**（没有经过任何缩放/压缩），也就是解码器真正看到的那张图 ——
   * 这样拿过来就能判断：是糊了？码太小？还是投影反光。
   * 会按显示方向旋转成正的，方便人眼看。
   */
  private void doSaveCaptured() {
    if (!capturedReady) return;
    final byte[] data = captureBuf;
    final int w = capturedW;
    final int h = capturedH;
    if (data == null || w <= 0 || h <= 0) {
      toast("抓取失败");
      return;
    }

    OutputStream os = null;
    String shownPath;
    try {
      final int[] argb = new int[w * h];
      for (int i = 0; i < argb.length; i++) {
        final int y = data[i] & 0xFF;
        argb[i] = 0xFF000000 | (y << 16) | (y << 8) | y;
      }
      Bitmap bmp = Bitmap.createBitmap(argb, w, h, Bitmap.Config.ARGB_8888);

      // 旋转成竖的（和用户在屏幕上看到的朝向一致）
      if (displayRotation != 0) {
        android.graphics.Matrix m = new android.graphics.Matrix();
        m.postRotate(displayRotation);
        Bitmap rotated =
            Bitmap.createBitmap(bmp, 0, 0, bmp.getWidth(), bmp.getHeight(), m, true);
        if (rotated != bmp) bmp.recycle();
        bmp = rotated;
      }

      final String name =
          "ktp-"
              + new java.text.SimpleDateFormat("MMdd-HHmmss", java.util.Locale.US)
                  .format(new java.util.Date())
              + ".jpg";

      if (Build.VERSION.SDK_INT >= 29) {
        ContentValues cv = new ContentValues();
        cv.put(MediaStore.Images.Media.DISPLAY_NAME, name);
        cv.put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg");
        cv.put(
            MediaStore.Images.Media.RELATIVE_PATH,
            Environment.DIRECTORY_PICTURES + "/KTP排查");
        Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
        if (uri == null) throw new Exception("系统没给相册写入位置");
        os = getContentResolver().openOutputStream(uri);
        shownPath = "相册 / Pictures/KTP排查/" + name;
      } else {
        File dir =
            new File(
                Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_PICTURES),
                "KTP排查");
        if (!dir.exists() && !dir.mkdirs()) throw new Exception("建目录失败");
        File f = new File(dir, name);
        os = new FileOutputStream(f);
        shownPath = f.getAbsolutePath();
      }

      if (os == null) throw new Exception("打不开输出流");
      bmp.compress(Bitmap.CompressFormat.JPEG, 92, os);
      os.close();
      os = null;
      bmp.recycle();

      toast("已保存：" + shownPath);
      // 把这些数字也报出来（toast 里能看到，截图就够了，不用接电脑看 logcat）
      android.util.Log.i(
          "ktp-scan",
          "snapshot "
              + w
              + "x"
              + h
              + " rot="
              + displayRotation
              + " crop="
              + cropLeft
              + ","
              + cropTop
              + " "
              + cropWidth
              + "x"
              + cropHeight
              + " z="
              + appliedZoomLevel
              + "/"
              + maxZoomLevel
              + " contFocus="
              + continuousFocus
              + " mlErr="
              + mlLastError);
    } catch (Throwable t) {
      toast("保存失败：" + t.getMessage());
    } finally {
      try {
        if (os != null) os.close();
      } catch (Exception ignored) {
      }
    }
  }

  private void toast(final String message) {
    uiPost(
        new Runnable() {
          @Override
          public void run() {
            Toast.makeText(ScanActivity.this, message, Toast.LENGTH_SHORT).show();
          }
        });
  }

  // ------------------------------------------------------------------ 结束

  private void succeed(final String text) {
    if (finished) return;
    finished = true;
    if (viewfinder != null) viewfinder.setFound(true);
    stopCamera();
    uiPost(
        new Runnable() {
          @Override
          public void run() {
            Intent out = new Intent();
            out.putExtra(EXTRA_TEXT, text);
            out.putExtra(EXTRA_SOURCE, foundBy);
            setResult(RESULT_OK, out);
            finish();
          }
        });
  }

  private void fail(final String message) {
    if (finished) return;
    finished = true;
    stopCamera();
    uiPost(
        new Runnable() {
          @Override
          public void run() {
            Intent out = new Intent();
            out.putExtra(EXTRA_ERROR, message);
            setResult(RESULT_CANCELED, out);
            finish();
          }
        });
  }

  private void cancel() {
    if (finished) return;
    finished = true;
    stopCamera();
    uiPost(
        new Runnable() {
          @Override
          public void run() {
            setResult(RESULT_CANCELED);
            finish();
          }
        });
  }

  private void uiPost(Runnable r) {
    new Handler(Looper.getMainLooper()).post(r);
  }
}
