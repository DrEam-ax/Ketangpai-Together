package com.ktp.scanner;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 签到监控：盯着「主成员」的课程，一旦有课正在签到就弹通知。
 *
 * 判断依据（已用真机 API 实验验证，见 tools/exp-ongoing2.ts）：
 *   <code>/AttenceApi/getNotFinishAttenceStudent {courseid}</code> **只返回正在进行的签到** ——
 *   现场建一个考勤它立刻出现，调 overAttence 结束后它立刻消失。
 *   所以「列表非空」就等于「这门课正在签到」，不需要自己算时间窗
 *   （而且这个接口也不返回结束时间，本来就算不出来）。
 *
 * 注意**不能**用 `getNotFinishAttence`（少个 Student）：实测它连 12 小时前的旧签到都还留着。
 *
 * 之所以做成前台服务：Android 8 以后后台应用不能长期存活，
 * 要持续轮询就必须挂一个常驻通知。下课后请手动关掉（省电省流量）。
 */
public class MonitorService extends Service {

  static final String ACTION_START = "com.ktp.scanner.MONITOR_START";
  static final String ACTION_STOP = "com.ktp.scanner.MONITOR_STOP";
  /** 通知上的「立即定位签到」按钮 */
  static final String ACTION_SIGN = "com.ktp.scanner.MONITOR_SIGN";
  static final String EXTRA_ATTENCE = "attenceid";
  static final String PREFS = "ktp";
  static final String CHANNEL_ALERT = "ktp_alert";
  static final String CHANNEL_MONITOR = "ktp_monitor";
  static final int ID_MONITOR = 1001;
  static final int ID_ALERT = 2001;

  /**
   * 默认轮询间隔。
   *
   * 从 30 秒缩到 10 秒是因为真机反馈「不够及时」——签到窗口短，晚半分钟可能就错过了。
   * 代价：一次要给 28 门课发请求，10 秒一轮 ≈ 每分钟 168 个请求（每个几百字节），
   * 一节课两小时约 2~4MB 流量。可以在界面上调（5~120 秒）。
   */
  private static final long DEFAULT_POLL_MS = 10_000L;
  private static final long MIN_POLL_MS = 5_000L;
  private static final int MAX_PARALLEL = 8;

  /** 上一次轮询的结论，给界面显示用（静态，方便 Activity 直接读）。 */
  static volatile String lastStatus = "未启动";
  static volatile long lastCheckAt = 0;
  /** 服务是否在跑（界面据此显示按钮状态） */
  static volatile boolean running = false;
  /** 当前正在进行中的签到列表（JSON 数组字符串），界面据此显示「立即签到」按钮 */
  static volatile String pendingJson = "[]";

  private HandlerThread thread;
  private Handler handler;
  private SharedPreferences prefs;
  private final Set<String> notified = new HashSet<>();

  @Override
  public void onCreate() {
    super.onCreate();
    prefs = getSharedPreferences(PREFS, MODE_PRIVATE);
    createChannels();
    thread = new HandlerThread("ktp-monitor");
    thread.start();
    handler = new Handler(thread.getLooper());
    loadNotified();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    String action = intent == null ? ACTION_START : intent.getAction();
    if (ACTION_STOP.equals(action)) {
      stopSelf();
      return START_NOT_STICKY;
    }
    if (ACTION_SIGN.equals(action)) {
      // 通知上的「立即定位签到」按钮。服务此刻一定在跑（通知就是它发的），
      // 所以不需要再 startForeground。
      final String attenceId = intent.getStringExtra(EXTRA_ATTENCE);
      if (attenceId != null && !attenceId.isEmpty()) {
        new Thread(
                new Runnable() {
                  @Override
                  public void run() {
                    JSONObject r = CheckinHelper.signLocation(MonitorService.this, attenceId);
                    boolean ok = r.optBoolean("ok", false);
                    lastStatus =
                        (ok ? "定位签到成功（" : "定位签到失败：")
                            + r.optString("message", "")
                            + (ok ? "）" : "");
                    updateMonitorNotification(lastStatus);
                  }
                })
            .start();
      }
      return START_STICKY;
    }

    startForeground(ID_MONITOR, buildMonitorNotification(null));
    running = true;
    lastStatus = "已启动，正在检查…";
    handler.removeCallbacksAndMessages(null);
    handler.post(
        new Runnable() {
          @Override
          public void run() {
            pollOnce();
            handler.postDelayed(this, pollIntervalMs());
          }
        });
    return START_STICKY;
  }

  /** 轮询间隔：界面可调，存 prefs；有下限保护，避免被填成 0 把服务打死。 */
  private long pollIntervalMs() {
    long v = prefs.getLong("pollIntervalMs", DEFAULT_POLL_MS);
    return Math.max(MIN_POLL_MS, Math.min(120_000L, v));
  }

  @Override
  public void onDestroy() {
    running = false;
    lastStatus = "已停止";
    if (handler != null) handler.removeCallbacksAndMessages(null);
    if (thread != null) {
      thread.quitSafely();
      thread = null;
    }
    super.onDestroy();
  }

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  // ------------------------------------------------------------------ 一轮检查

  /** 单次检测的序号（每跑完一次 +1）。界面靠它判断"我点的那次跑完了没"。 */
  static volatile long oneShotSeq = 0;
  static volatile boolean oneShotRunning = false;
  /** 上一轮扫了多少门课（只用于状态文案） */
  static volatile int lastCourseCount = 0;

  /**
   * 手动「点击检测」：在后台线程跑一轮，结果写进 pendingJson / lastStatus。
   *
   * 为什么不直接把结果 return 给界面：一轮要挨个问二十多门课，
   * 在 JS bridge 里同步等会卡住界面（甚至 ANR）。所以这里**立刻返回**，
   * 界面轮询 getMonitor() 的 oneShotSeq 就知道跑完没有。
   *
   * 也**不弹通知** —— 用户正看着屏幕，列表直接显示出来就够了。
   */
  static void checkOnce(final Context ctx) {
    if (oneShotRunning) return; // 连点就忽略，别叠着跑
    oneShotRunning = true;
    new Thread(
            new Runnable() {
              @Override
              public void run() {
                try {
                  List<String[]> list = scanOngoing(ctx);
                  JSONArray pend = new JSONArray();
                  StringBuilder sb = new StringBuilder();
                  for (String[] o : list) {
                    JSONObject item = new JSONObject();
                    item.put("course", o[0]);
                    item.put("id", o[1]);
                    item.put("type", o[2]);
                    item.put("title", o[3]);
                    pend.put(item);
                    if (sb.length() > 0) sb.append('；');
                    sb.append(o[0]);
                  }
                  pendingJson = pend.toString();
                  lastCheckAt = System.currentTimeMillis();
                  lastStatus =
                      list.isEmpty()
                          ? "检测完成 · " + lastCourseCount + " 门课都没有在签到"
                          : "发现正在签到（" + list.size() + "）：" + sb;
                } catch (Exception e) {
                  lastStatus = "检测出错：" + e.getMessage();
                } finally {
                  oneShotRunning = false;
                  oneShotSeq++;
                }
              }
            },
            "ktp-check-once")
        .start();
  }

  /**
   * 扫一轮主成员所有课程，返回正在进行的签到，每项 {课程名, attenceid, type, title}。
   *
   * 抽成静态方法，是为了让**手动检测**和**后台轮询**用同一套逻辑 ——
   * 两处各写一遍迟早会走偏（比如只在一处处理 token 过期、只在一处判断课程列表为空）。
   */
  static List<String[]> scanOngoing(Context ctx) throws Exception {
    SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    JSONObject acc = KtpApi.primaryAccount(prefs);
    if (acc == null) throw new Exception("还没选主成员");

    String ip = KtpApi.ipForAccount(prefs, acc);
    String token = KtpApi.ensureToken(prefs, acc, ip); // 没 token 会自动登录并写回

    JSONObject courseRes = KtpApi.call("/courseApi/simpleLists", new JSONObject(), token, ip);
    if (isTokenBad(courseRes)) {
      // token 过期（换了手机/太久没用）→ 重新登录一次
      token = KtpApi.login(acc.optString("email"), acc.optString("password"), ip);
      KtpApi.saveToken(prefs, acc.optString("key"), token);
      courseRes = KtpApi.call("/courseApi/simpleLists", new JSONObject(), token, ip);
    }

    JSONObject data = courseRes.optJSONObject("data");
    List<JSONObject> courses = new ArrayList<>();
    if (data != null) {
      collect(data.optJSONArray("toplists"), courses);
      collect(data.optJSONArray("lists"), courses);
    }
    lastCourseCount = courses.size();
    if (courses.isEmpty()) throw new Exception("没读到课程列表");

    final List<String[]> ongoing = Collections.synchronizedList(new ArrayList<String[]>());
    final String fToken = token;
    final String fIp = ip;
    final int n = courses.size();
    final CountDownLatch latch = new CountDownLatch(n);
    // 并发上限：28 门课同时开 28 个线程没必要，反而更容易被风控
    final java.util.concurrent.Semaphore gate = new java.util.concurrent.Semaphore(MAX_PARALLEL);

    for (int i = 0; i < n; i++) {
      final JSONObject c = courses.get(i);
      new Thread(
              new Runnable() {
                @Override
                public void run() {
                  try {
                    gate.acquire();
                  } catch (InterruptedException ie) {
                    latch.countDown();
                    return;
                  }
                  try {
                    JSONObject body = new JSONObject();
                    body.put("courseid", c.optString("id"));
                    JSONObject res =
                        KtpApi.call("/AttenceApi/getNotFinishAttenceStudent", body, fToken, fIp);
                    JSONArray lists =
                        res.optJSONObject("data") == null
                            ? null
                            : res.optJSONObject("data").optJSONArray("lists");
                    if (lists != null && lists.length() > 0) {
                      for (int k = 0; k < lists.length(); k++) {
                        JSONObject it = lists.getJSONObject(k);
                        ongoing.add(
                            new String[] {
                              c.optString("coursename", "未知课程"),
                              it.optString("id"),
                              it.optString("type", ""),
                              it.optString("title", "")
                            });
                      }
                    }
                  } catch (Exception ignored) {
                    // 单门课失败不该让整轮失败
                  } finally {
                    gate.release();
                    latch.countDown();
                  }
                }
              })
          .start();
    }
    latch.await(20, TimeUnit.SECONDS);
    return ongoing;
  }

  private void pollOnce() {
    try {
      List<String[]> ongoing = scanOngoing(this);
      lastCheckAt = System.currentTimeMillis();
      if (ongoing.isEmpty()) {
        pendingJson = "[]";
        lastStatus = "正常 · " + lastCourseCount + " 门课都没有在签到";
        updateMonitorNotification(lastStatus);
        return;
      }

      // 把列表交给界面（用来渲染「立即签到」按钮）
      JSONArray pend = new JSONArray();
      StringBuilder sb = new StringBuilder();
      for (String[] o : ongoing) {
        JSONObject item = new JSONObject();
        item.put("course", o[0]);
        item.put("id", o[1]);
        item.put("type", o[2]);
        item.put("title", o[3]);
        pend.put(item);

        notifyOngoing(o[0], o[1], o[2], o[3]);
        if (sb.length() > 0) sb.append('；');
        sb.append(o[0]);
      }
      pendingJson = pend.toString();
      lastStatus = "发现正在签到：" + sb;
      updateMonitorNotification(lastStatus);
    } catch (Exception e) {
      lastStatus = "检查出错：" + e.getMessage();
      updateMonitorNotification(lastStatus);
    }
  }

  private static void collect(JSONArray arr, List<JSONObject> out) {
    if (arr == null) return;
    for (int i = 0; i < arr.length(); i++) {
      JSONObject o = arr.optJSONObject(i);
      if (o != null && !o.optString("id").isEmpty()) out.add(o);
    }
  }

  /** token 失效的判断：状态码不是 10000 且消息里带"登录"/"token"。 */
  private static boolean isTokenBad(JSONObject res) {
    int code = res.optInt("code", 10000);
    String msg = res.optString("message", "");
    return code != 10000 && (msg.contains("登录") || msg.toLowerCase().contains("token"));
  }

  // ------------------------------------------------------------------ 通知

  private void notifyOngoing(String course, String attenceId, String type, String title) {
    String dedupKey = course + "|" + attenceId;
    if (notified.contains(dedupKey)) return; // 同一次签到只提醒一次
    notified.add(dedupKey);
    saveNotified();

    String typeName;
    switch (type) {
      case "1":
        typeName = "数字码签到";
        break;
      case "2":
        typeName = "定位签到";
        break;
      case "3":
        typeName = "扫码签到";
        break;
      case "4":
        typeName = "签到签出";
        break;
      default:
        typeName = "签到";
    }

    Notification.Builder b =
        Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, CHANNEL_ALERT)
            : new Notification.Builder(this);

    PendingIntent tap =
        PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    b.setSmallIcon(android.R.drawable.ic_dialog_info)
        .setContentTitle("您的「" + course + "」课程正在签到，请及时处理")
        .setContentText(typeName + (title.isEmpty() ? "" : " · " + title))
        .setStyle(new Notification.BigTextStyle().bigText(typeName + "（" + title + "）\n点开扫码签到"))
        .setPriority(Notification.PRIORITY_HIGH)
        .setDefaults(Notification.DEFAULT_ALL)
        .setAutoCancel(true)
        .setContentIntent(tap);

    // 定位签到可以一键完成：坐标只是请求参数，不需要人真的在教室
    // （能不能过要看服务器验不验距离，见 CheckinHelper 的说明）
    if ("2".equals(type)) {
      Intent sign = new Intent(this, MonitorService.class)
          .setAction(ACTION_SIGN)
          .putExtra(EXTRA_ATTENCE, attenceId);
      PendingIntent pi =
          PendingIntent.getService(
              this,
              attenceId.hashCode(),
              sign,
              PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
      b.addAction(android.R.drawable.ic_menu_mylocation, "立即定位签到", pi);
      b.setStyle(
          new Notification.BigTextStyle()
              .bigText(typeName + "（" + title + "）\n点下面的按钮可一键用「教室坐标」签到"));
    }

    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm != null) nm.notify(ID_ALERT, b.build());
  }

  private void updateMonitorNotification(String status) {
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm != null) nm.notify(ID_MONITOR, buildMonitorNotification(status));
  }

  private Notification buildMonitorNotification(String status) {
    Notification.Builder b =
        Build.VERSION.SDK_INT >= 26
            ? new Notification.Builder(this, CHANNEL_MONITOR)
            : new Notification.Builder(this);

    JSONObject acc = KtpApi.primaryAccount(prefs);
    String who = acc == null ? "未选主成员" : acc.optString("name", acc.optString("key", ""));

    PendingIntent tap =
        PendingIntent.getActivity(
            this,
            0,
            new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

    return b.setSmallIcon(android.R.drawable.ic_popup_sync)
        .setContentTitle("课堂派签到监控中")
        .setContentText((who.isEmpty() ? "" : who + " · ") + (status == null ? "正在检查…" : status))
        .setOngoing(true)
        .setPriority(Notification.PRIORITY_LOW)
        .setContentIntent(tap)
        .build();
  }

  private void createChannels() {
    if (Build.VERSION.SDK_INT < 26) return;
    NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
    if (nm == null) return;

    NotificationChannel alert =
        new NotificationChannel(CHANNEL_ALERT, "签到提醒", NotificationManager.IMPORTANCE_HIGH);
    alert.setDescription("有课程正在签到时弹出");
    nm.createNotificationChannel(alert);

    NotificationChannel monitor =
        new NotificationChannel(CHANNEL_MONITOR, "监控运行中", NotificationManager.IMPORTANCE_LOW);
    monitor.setDescription("常驻通知，表示监控服务在运行");
    monitor.setShowBadge(false);
    nm.createNotificationChannel(monitor);
  }

  // ------------------------------------------------------------------ 存储
  // 取账号 / 挑 IP / 存 token 的逻辑已经统一到 KtpApi 的静态方法里
  // （定位签到和手动检测也要用同一套，放两处迟早走偏）

  /**
   * 已提醒过的签到 id。
   * 存下来是为了重启服务后不重复提醒 —— 一次签到会持续十分钟，每 30 秒都会命中。
   */
  private void loadNotified() {
    try {
      JSONArray arr = new JSONArray(prefs.getString("notifiedAttence", "[]"));
      for (int i = 0; i < arr.length(); i++) notified.add(arr.getString(i));
    } catch (Exception ignored) {
    }
  }

  private void saveNotified() {
    // 只留最近 100 条，避免无限增长
    List<String> list = new ArrayList<>(notified);
    if (list.size() > 100) list = list.subList(list.size() - 100, list.size());
    prefs.edit().putString("notifiedAttence", new JSONArray(list).toString()).apply();
  }

  static void start(Context ctx) {
    Intent i = new Intent(ctx, MonitorService.class).setAction(ACTION_START);
    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i);
    else ctx.startService(i);
  }

  static void stop(Context ctx) {
    ctx.startService(new Intent(ctx, MonitorService.class).setAction(ACTION_STOP));
  }
}
