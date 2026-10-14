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
import com.google.zxing.MultiFormatReader;
import com.google.zxing.PlanarYUVLuminanceSource;
import com.google.zxing.Result;
import com.google.zxing.common.GlobalHistogramBinarizer;
import com.google.zxing.common.HybridBinarizer;

import java.util.List;
import java.util.Locale;

/**
 * 全屏实时扫码（微信扫一扫那种）。
 *
 * 为什么用原生相机而不是 WebView 的 getUserMedia：
 *   getUserMedia 在 file:// 页面 + WebView 里行为不稳定，还要额外处理
 *   onPermissionRequest；原生 Camera 直接、可控、延迟低。
 *
 * 相机开在一个带 Looper 的后台线程上，所以 onPreviewFrame 回调也在这个线程，
 * 可以就地解码而不会卡 UI。每隔一小段时间才解一帧，避免浪费 CPU。
 *
 * 两个踩过的坑：
 *  1) 画面拉伸：相机预览是横向的（如 1280x960），旋转 90° 后在屏幕上是 960x1280
 *     （比例 0.75）。SurfaceView 若用 match_parent，在 1080x2400 上比例是 0.45，
 *     纵向会被拉 1.875 倍。所以这里按真实比例等比放大铺满 + 居中裁剪。
 *  2) 双指缩放：优先用相机自己的变焦（真裁传感器，细节更多，和微信一致）；
 *     设备不支持变焦时，退化成缩放 SurfaceView。
 */
public class ScanActivity extends Activity implements SurfaceHolder.Callback, Camera.PreviewCallback {

  public static final String EXTRA_TEXT = "text";
  public static final String EXTRA_ERROR = "error";

  private static final int REQ_CAM = 2001;
  private static final long DECODE_INTERVAL_MS = 180;
  /** 预览尺寸上限：够解码二维码，又不至于每帧太重。 */
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

  // 变焦相关
  private boolean zoomSupported = false;
  private List<Integer> zoomRatios;
  private int maxZoomLevel = 0;
  private int appliedZoomLevel = -1;
  private float pinchScale = 1f;
  /** 等比铺满后的基准尺寸（1x 时），缩放 SurfaceView 时按它乘。 */
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

  /** 把捏合倍率应用到画面上。 */
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
      // 设备不支持变焦：退化成缩放 SurfaceView（数字变焦，至少手感一致）
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
    // 尺寸变化（旋转/分辨率切换）后重启预览
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
      // 预览是横向的，要拿它和「屏幕横过来的比例」比，才知道旋转后裁掉多少
      double screenRatio = (double) screen.x / (double) screen.y;

      Camera.Size best = choosePreviewSize(p.getSupportedPreviewSizes(), screenRatio);
      if (best != null) {
        previewWidth = best.width;
        previewHeight = best.height;
        p.setPreviewSize(previewWidth, previewHeight);
      }

      // 变焦能力
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

      layoutSurface(screen);
    } catch (Exception e) {
      fail("相机初始化失败：" + e.getMessage());
    }
  }

  /**
   * 按真实比例给 SurfaceView 定尺寸：等比放大到刚好盖住整屏，然后居中。
   * 这样画面不会被拉扁/拉长，多出来的部分被父容器裁掉。
   */
  private void layoutSurface(final Point screen) {
    if (previewWidth <= 0 || previewHeight <= 0) return;
    final boolean swapped = displayRotation % 180 != 0;
    final int displayW = swapped ? previewHeight : previewWidth;
    final int displayH = swapped ? previewWidth : previewHeight;

    runOnUiThread(
        new Runnable() {
          @Override
          public void run() {
            if (finished || surface == null) return;
            float scale = Math.max((float) screen.x / displayW, (float) screen.y / displayH);
            baseSurfaceW = Math.round(displayW * scale);
            baseSurfaceH = Math.round(displayH * scale);
            applySurfaceSize(pinchScale);
          }
        });
  }

  /** 按倍率设置 SurfaceView 尺寸（仅在不支持相机变焦时使用）。 */
  private void applySurfaceSize(float scale) {
    if (surface == null || baseSurfaceW <= 0 || baseSurfaceH <= 0) return;
    FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) surface.getLayoutParams();
    lp.width = Math.round(baseSurfaceW * scale);
    lp.height = Math.round(baseSurfaceH * scale);
    lp.gravity = Gravity.CENTER;
    surface.setLayoutParams(lp);
  }

  /** 屏幕可用像素（含状态栏/导航栏，因为我们全屏）。 */
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

  /** 标准算法：用相机朝向 + 当前屏幕旋转算出预览该转多少度。 */
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
   * 挑预览尺寸：
   *   1) 先找比例和屏幕最接近的（这样旋转后裁掉的最少）
   *   2) 同比例里挑面积最大的（分辨率高，二维码更好认）
   *   3) 实在没有合适的，就挑不超过上限里最大的
   */
  private static Camera.Size choosePreviewSize(List<Camera.Size> sizes, double screenRatio) {
    if (sizes == null || sizes.isEmpty()) return null;

    Camera.Size best = null;
    double bestDiff = Double.MAX_VALUE;
    long bestArea = 0;

    for (Camera.Size s : sizes) {
      if (s.width > MAX_PREVIEW_WIDTH) continue;
      double ratio = (double) s.width / (double) s.height;
      double diff = Math.abs(ratio - screenRatio);
      long area = (long) s.width * s.height;
      // 比例差距小于 0.02 视为同一档，此时比面积
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

    String text = decode(data, w, h);
    if (text != null && !text.isEmpty()) {
      succeed(text);
    }
  }

  /** 拿 NV21 的 Y 平面直接给 ZXing。二维码旋转 90° 也能识别（定位图案是旋转不变的）。 */
  private static String decode(byte[] data, int width, int height) {
    LuminanceSource source = new PlanarYUVLuminanceSource(data, width, height, 0, 0, width, height, false);
    MultiFormatReader reader = new MultiFormatReader();
    try {
      Result r = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(source)));
      return r.getText();
    } catch (Exception ignored) {
      // 换个二值化再试一次
    }
    try {
      Result r = reader.decodeWithState(new BinaryBitmap(new GlobalHistogramBinarizer(source)));
      return r.getText();
    } catch (Exception ignored) {
    } finally {
      reader.reset();
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
