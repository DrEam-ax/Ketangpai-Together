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

import com.google.zxing.BinaryBitmap;
import com.google.zxing.LuminanceSource;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.common.GlobalHistogramBinarizer;
import com.google.zxing.common.HybridBinarizer;
import com.google.zxing.qrcode.QRCodeReader;

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
  private static final int MAX_PREVIEW_WIDTH = 1280;
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

    // 只解 Hybrid；每隔几帧再补一次 GlobalHistogram（它更慢，但能救低对比度的图）
    boolean secondPass = frameCount % 3 == 0;
    String text = decode(data, w, h, secondPass);
    if (text != null && !text.isEmpty()) {
      succeed(text);
    }
  }

  /**
   * 解一帧。只解 crop 区域（屏幕实际看得见的那部分），并且只认 QR 格式 ——
   * 这两点是识别速度的关键：像素少了、也不再逐个试其他条码格式。
   */
  private String decode(byte[] data, int width, int height, boolean secondPass) {
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
    QRCodeReader reader = new QRCodeReader();
    try {
      return reader.decode(new BinaryBitmap(new HybridBinarizer(source))).getText();
    } catch (Exception ignored) {
      // 换一种二值化再试
    }
    if (secondPass) {
      try {
        return reader.decode(new BinaryBitmap(new GlobalHistogramBinarizer(source))).getText();
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
