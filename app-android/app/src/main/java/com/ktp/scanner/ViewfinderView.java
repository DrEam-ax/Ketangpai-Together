package com.ktp.scanner;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.util.AttributeSet;
import android.view.View;

/**
 * 扫一扫的取景框遮罩：四周压暗、中间透亮，绿色四角 + 上下往返的扫描线，
 * 下面是提示文字 —— 照着微信「扫一扫」的样子画的。
 */
public class ViewfinderView extends View {

  private static final int COLOR_DIM = 0xB3000000;
  private static final int COLOR_FRAME = 0x66FFFFFF;
  private static final int COLOR_CORNER = 0xFF07C160; // 微信绿
  private static final int COLOR_HINT = 0xFFEDEDED;
  private static final int COLOR_FOUND = 0xFF07C160;

  private final Paint dimPaint = new Paint();
  private final Paint framePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Paint cornerPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Paint linePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Paint hintPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
  private final Paint hintPaint2 = new Paint(Paint.ANTI_ALIAS_FLAG);

  private final RectF frame = new RectF();
  private float density = 1f;
  private float scanY = 0f;
  private boolean goingDown = true;
  private boolean found = false;
  private boolean animating = false;
  private String zoomLabel = null;
  /** 屏幕上的诊断信息（预览尺寸 / ML Kit 状态等）—— 截图就能看到，不用接电脑 */
  private String debugText = null;

  public ViewfinderView(Context context, AttributeSet attrs) {
    super(context, attrs);
    density = getResources().getDisplayMetrics().density;
    dimPaint.setColor(COLOR_DIM);
    framePaint.setStyle(Paint.Style.STROKE);
    framePaint.setStrokeWidth(1f);
    framePaint.setColor(COLOR_FRAME);
    cornerPaint.setStyle(Paint.Style.STROKE);
    cornerPaint.setStrokeWidth(5f * density);
    cornerPaint.setStrokeCap(Paint.Cap.SQUARE);
    cornerPaint.setColor(COLOR_CORNER);
    linePaint.setStrokeWidth(2f * density);
    hintPaint.setColor(COLOR_HINT);
    hintPaint.setTextSize(14f * density);
    hintPaint.setTextAlign(Paint.Align.CENTER);
    hintPaint2.setColor(0xFF9AA0A6);
    hintPaint2.setTextSize(12f * density);
    hintPaint2.setTextAlign(Paint.Align.CENTER);
  }

  @Override
  protected void onSizeChanged(int w, int h, int oldw, int oldh) {
    super.onSizeChanged(w, h, oldw, oldh);
    float side = Math.min(w * 0.68f, h * 0.46f);
    float left = (w - side) / 2f;
    // 略高于正中，和微信一样给下面的提示留位置
    float top = h * 0.34f - side / 2f;
    if (top < 40 * density) top = 40 * density;
    frame.set(left, top, left + side, top + side);
    scanY = frame.top + 6 * density;

    linePaint.setShader(
        new LinearGradient(
            frame.left,
            0,
            frame.right,
            0,
            new int[] {0x0007C160, 0xCC07C160, 0x0007C160},
            new float[] {0f, 0.5f, 1f},
            Shader.TileMode.CLAMP));
  }

  @Override
  protected void onDraw(Canvas canvas) {
    super.onDraw(canvas);
    int w = getWidth();
    int h = getHeight();
    if (frame.width() <= 0) return;

    // 四周压暗，中间留空
    canvas.drawRect(0, 0, w, frame.top, dimPaint);
    canvas.drawRect(0, frame.bottom, w, h, dimPaint);
    canvas.drawRect(0, frame.top, frame.left, frame.bottom, dimPaint);
    canvas.drawRect(frame.right, frame.top, w, frame.bottom, dimPaint);

    // 内边框
    canvas.drawRect(frame, framePaint);

    // 四个角
    float len = 20 * density;
    cornerPaint.setColor(found ? COLOR_FOUND : COLOR_CORNER);
    // 左上
    canvas.drawLine(frame.left, frame.top, frame.left + len, frame.top, cornerPaint);
    canvas.drawLine(frame.left, frame.top, frame.left, frame.top + len, cornerPaint);
    // 右上
    canvas.drawLine(frame.right, frame.top, frame.right - len, frame.top, cornerPaint);
    canvas.drawLine(frame.right, frame.top, frame.right, frame.top + len, cornerPaint);
    // 左下
    canvas.drawLine(frame.left, frame.bottom, frame.left + len, frame.bottom, cornerPaint);
    canvas.drawLine(frame.left, frame.bottom, frame.left, frame.bottom - len, cornerPaint);
    // 右下
    canvas.drawLine(frame.right, frame.bottom, frame.right - len, frame.bottom, cornerPaint);
    canvas.drawLine(frame.right, frame.bottom, frame.right, frame.bottom - len, cornerPaint);

    // 扫描线
    if (!found) {
      canvas.drawLine(frame.left + 8 * density, scanY, frame.right - 8 * density, scanY, linePaint);
    }

    // 提示文字
    String hint = found ? "识别成功" : "对准二维码，自动识别";
    canvas.drawText(hint, w / 2f, frame.bottom + 34 * density, hintPaint);
    if (!found) {
      canvas.drawText("太远就双指放大", w / 2f, frame.bottom + 56 * density, hintPaint2);
    }

    // 缩放倍率（双指捏合时出现）
    if (zoomLabel != null && !found) {
      float badgeY = frame.top - 26 * density;
      if (badgeY > 0) {
        canvas.drawText(zoomLabel, w / 2f, badgeY, hintPaint);
      }
    }

    // 诊断信息：小字、贴底、不影响取景
    if (debugText != null) {
      Paint p = hintPaint2;
      p.setTextAlign(Paint.Align.LEFT);
      p.setTextSize(10f * density);
      p.setColor(0xFFB0B8C4);
      float y = frame.bottom + 78 * density;
      for (String line : debugText.split("\n")) {
        canvas.drawText(line, 10 * density, y, p);
        y += 13 * density;
      }
      p.setTextAlign(Paint.Align.CENTER);
      p.setTextSize(12f * density);
      p.setColor(0xFF9AA0A6);
    }

    if (!found) {
      stepScanLine();
      postInvalidateDelayed(16);
    }
  }

  private void stepScanLine() {
    float speed = 3.2f * density;
    float top = frame.top + 6 * density;
    float bottom = frame.bottom - 6 * density;
    if (goingDown) {
      scanY += speed;
      if (scanY >= bottom) {
        scanY = bottom;
        goingDown = false;
      }
    } else {
      scanY -= speed;
      if (scanY <= top) {
        scanY = top;
        goingDown = true;
      }
    }
  }

  public void setFound(boolean value) {
    found = value;
    postInvalidate();
  }

  /** 双指缩放时在框上方显示倍率；传 null 表示隐藏。 */
  public void setZoomLabel(String label) {
    zoomLabel = label;
    postInvalidate();
  }

  /** 屏幕上的诊断信息（多行）；传 null 隐藏。 */
  public void setDebugText(String text) {
    debugText = text;
    postInvalidate();
  }

  @Override
  protected void onAttachedToWindow() {
    super.onAttachedToWindow();
    if (!animating) {
      animating = true;
      postInvalidate();
    }
  }

  @Override
  protected void onDetachedFromWindow() {
    animating = false;
    super.onDetachedFromWindow();
  }
}
