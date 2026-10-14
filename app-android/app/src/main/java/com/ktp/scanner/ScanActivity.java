package com.ktp.scanner;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.ImageFormat;
import android.graphics.Point;
import android.hardware.Camera;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
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
import java.util.Collections;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;

import java.util.List;
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
      try {
        List<String> focus = p.getSupportedFocusModes();
        if (focus != null && focus.contains(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE)) {
          p.setFocusMode(Camera.Parameters.FOCUS_MODE_CONTINUOUS_PICTURE);
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

    int w = previewWidth;
    int h = previewHeight;
    if (w <= 0 || h <= 0) {
      Camera.Size s = cam.getParameters().getPreviewSize();
      w = s.width;
      h = s.height;
      previewWidth = w;
      previewHeight = h;
    }

    // 每帧先按原尺寸快速解（正常大小的二维码靠这条）；
    // 每 4 帧再走一次「中心正方形 2 倍放大 + TRY_HARDER」——这是小二维码的救命路径。
    boolean extra = frameCount % 4 == 0;
    String text = decode(data, w, h, extra);
    if (text == null && extra) {
      text = decodeUpscaled(data, w, h);
    }
    if (text != null && !text.isEmpty()) {
      succeed(text);
      return;
    }

    // ZXing 都没认出来，交给 ML Kit（异步，不阻塞取景）。
    // 隔帧跑一次即可，它比 ZXing 重。
    if (frameCount % 2 == 0) {
      runMlKit(data, w, h);
    }
  }

  /**
   * 用 ML Kit 再试一次。异步执行，结果回到主线程。
   *
   * 用 mlBusy 防止任务堆积：ML Kit 一次处理要几十到上百毫秒，
   * 不等它做完就继续投喂只会把队列塞满、越扫越卡。
   */
  private void runMlKit(byte[] data, int width, int height) {
    initMlKit();
    if (mlScanner == null || mlBusy || finished) return;

    final InputImage image;
    try {
      image =
          InputImage.fromByteArray(
              data, width, height, displayRotation, InputImage.IMAGE_FORMAT_NV21);
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
                  if (finished) return;
                  for (Barcode b : barcodes) {
                    String value = b.getRawValue();
                    if (value != null && !value.isEmpty()) {
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
                }
              });
    } catch (Throwable t) {
      mlBusy = false;
    }
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
