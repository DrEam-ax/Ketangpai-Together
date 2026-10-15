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
  static final String PREFS = "ktp";
  static final String CHANNEL_ALERT = "ktp_alert";
  static final String CHANNEL_MONITOR = "ktp_monitor";
  static final int ID_MONITOR = 1001;
  static final int ID_ALERT = 2001;

  /** 轮询间隔。一次要问 28 门课，30 秒已经有点密了，别再往下调。 */
  private static final long POLL_INTERVAL_MS = 30_000L;
  private static final int MAX_PARALLEL = 5;

  /** 上一次轮询的结论，给界面显示用（静态，方便 Activity 直接读）。 */
  static volatile String lastStatus = "未启动";
  static volatile long lastCheckAt = 0;
  /** 服务是否在跑（界面据此显示按钮状态） */
  static volatile boolean running = false;

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

    startForeground(ID_MONITOR, buildMonitorNotification(null));
    running = true;
    lastStatus = "已启动，正在检查…";
    handler.removeCallbacksAndMessages(null);
    handler.post(
        new Runnable() {
          @Override
          public void run() {
            pollOnce();
            handler.postDelayed(this, POLL_INTERVAL_MS);
          }
        });
    return START_STICKY;
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

  private void pollOnce() {
    JSONObject acc = primaryAccount();
    if (acc == null) {
      lastStatus = "还没选主成员";
      updateMonitorNotification(lastStatus);
      return;
    }

    String key = acc.optString("key");
    String email = acc.optString("email");
    String password = acc.optString("password");
    String ip = ipForAccount(acc);
    String token = acc.optString("token", "");

    try {
      if (token.isEmpty()) {
        token = KtpApi.login(email, password, ip);
        saveToken(key, token);
      }

      JSONObject courseRes = KtpApi.call("/courseApi/simpleLists", new JSONObject(), token, ip);
      if (isTokenBad(courseRes)) {
        // token 过期（换了手机/太久没用）→ 重新登录一次
        token = KtpApi.login(email, password, ip);
        saveToken(key, token);
        courseRes = KtpApi.call("/courseApi/simpleLists", new JSONObject(), token, ip);
      }

      JSONObject data = courseRes.optJSONObject("data");
      List<JSONObject> courses = new ArrayList<>();
      if (data != null) {
        collect(data.optJSONArray("toplists"), courses);
        collect(data.optJSONArray("lists"), courses);
      }
      if (courses.isEmpty()) {
        lastStatus = "没读到课程列表";
        updateMonitorNotification(lastStatus);
        return;
      }

      final List<String[]> ongoing = Collections.synchronizedList(new ArrayList<String[]>());
      final String fToken = token;
      final String fIp = ip;
      final int n = courses.size();
      final CountDownLatch latch = new CountDownLatch(n);

      // 并发问，但限制并发数 —— 28 门课串行问会拖到十几秒
      for (int i = 0; i < n; i++) {
        final JSONObject c = courses.get(i);
        new Thread(
                new Runnable() {
                  @Override
                  public void run() {
                    try {
                      JSONObject body = new JSONObject();
                      body.put("courseid", c.optString("id"));
                      JSONObject res =
                          KtpApi.call("/AttenceApi/getNotFinishAttenceStudent", body, fToken, fIp);
                      JSONArray lists = res.optJSONObject("data") == null
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
                      latch.countDown();
                    }
                  }
                })
            .start();
      }
      latch.await(20, TimeUnit.SECONDS);

      lastCheckAt = System.currentTimeMillis();
      if (ongoing.isEmpty()) {
        lastStatus = "正常 · " + n + " 门课都没有在签到";
        updateMonitorNotification(lastStatus);
        return;
      }

      StringBuilder sb = new StringBuilder();
      for (String[] o : ongoing) {
        notifyOngoing(o[0], o[1], o[2], o[3]);
        if (sb.length() > 0) sb.append('；');
        sb.append(o[0]);
      }
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

    JSONObject acc = primaryAccount();
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

  private JSONObject primaryAccount() {
    String key = prefs.getString("primaryKey", "");
    if (key == null || key.isEmpty()) return null;
    try {
      JSONArray arr = new JSONArray(prefs.getString("accounts", "[]"));
      for (int i = 0; i < arr.length(); i++) {
        JSONObject o = arr.getJSONObject(i);
        if (key.equals(o.optString("key"))) return o;
      }
    } catch (Exception ignored) {
    }
    return null;
  }

  private void saveToken(String key, String token) {
    if (key == null || key.isEmpty() || token == null) return;
    try {
      JSONArray arr = new JSONArray(prefs.getString("accounts", "[]"));
      for (int i = 0; i < arr.length(); i++) {
        JSONObject o = arr.getJSONObject(i);
        if (key.equals(o.optString("key"))) {
          o.put("token", token);
          break;
        }
      }
      prefs.edit().putString("accounts", arr.toString()).apply();
    } catch (Exception ignored) {
    }
  }

  private String ipForAccount(JSONObject acc) {
    String mode = prefs.getString("ipMode", "perAccount");
    if ("real".equals(mode)) return null;
    if ("same".equals(mode)) {
      String shared = prefs.getString("sharedIp", "");
      if (shared == null || !IpUtil.isValidIpv4(shared)) {
        shared = IpUtil.randomIp();
        prefs.edit().putString("sharedIp", shared).apply();
      }
      return shared;
    }
    String ip = acc == null ? null : acc.optString("ip", "");
    return IpUtil.ensureValid(ip);
  }

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
