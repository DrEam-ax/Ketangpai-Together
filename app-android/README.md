# 课堂派签到 App（Android）

**独立客户端，不依赖电脑、不需要服务器。** 装在教室里那个人的手机上即可。

> 当前版本 **0.2.0**：**只保留实时扫码**（全屏原生相机 + ZXing），已删除"选图/上传图片"那条路。

## 一、装到手机上

把 `dist\ktp-signin-0.2.0.apk` 传到手机（微信/QQ 发给自己、数据线、或 U 盘都行），点开安装。

- 需要允许「安装未知来源应用」（因为是自签名调试包，没上架应用商店）
- 如果装过 0.1.0，**先卸载旧的再装**（签名相同可覆盖，但清掉更省事）
- 装完桌面图标叫「课堂派签到」

要求：Android 7.0 (API 24) 及以上。包体约 0.3 MB —— 因为没塞任何第三方 UI 框架，就一个系统 WebView + ZXing。

## 二、怎么用

1. **添加账号**：展开「添加账号」，填 备注名（如"小王"）+ 课堂派手机号 + 密码，点「添加并验证登录」。
   **会先真的登录一次，成功才保存**，密码错了不会写进去。加多少个都行。
2. **勾选要签的人**：默认全选。只想签某个人就只勾他。
3. **扫一扫签到**：点蓝色大按钮 → 进全屏扫码界面（微信扫一扫那种：四周压暗、绿色四角、上下往返的扫描线）→ 对准大屏二维码 → **识别到自动签到并自动返回**，不用再点任何东西。
4. 结果逐人显示 ✅ / ❌，失败的在❌右边给出服务端原因。

扫码界面说明：**只支持实时扫**，没有"从相册选图"入口。这是故意的 —— 照片有"拍下来到提交"的时间差，
而二维码票据只有 300 秒有效期，实时扫最稳。右上角 ✕ 或返回键可退出。

## 三、为什么"扫一次就能签好几个人"

这是实测出来的关键性质：**课堂派那张二维码的票据跟学生身份无关，一张票能签任意多个账号。**

所以现场那个人**不需要换账号、不需要重复扫**。扫一次，App 会把票同时提交给所有勾选的账号（并发 4 个），每个人拿到各自的签到结果。

（这也是为什么它的定位是"现场代签工具"：主动权在教室里的那台手机上。）

## 四、和电脑版的关系

| | 电脑版（`src/server.ts` + `public/`） | 手机 App（`app-android/`） |
|---|---|---|
| 定位 | 开发/调试、批量管理、图像识别更强 | 现场扫码签到 |
| 二维码识别 | jsQR + OpenCV + zxing-cpp（三级流水线，拍屏幕的烂图也能解） | 只用 ZXing（原生），够用但不如电脑版强 |
| 网络 | Node `node:https` | 原生 `HttpURLConnection` |
| 依赖 | 需要电脑开机 | 独立 |

App 里**没有**"实时状态/未完成签到列表"，那是电脑版的功能。App 只做一件事：现场扫码、批量提交。

## 五、安全提醒

- 账号密码**明文**存在 App 私有目录的 SharedPreferences 里（`/data/data/com.ktp.scanner/shared_prefs/ktp.xml`）。
  普通应用读不到，但手机 root 过就能看到。**别在别人的手机上长期留着自己的号。**
- token 缓存在同一个文件里，默认会一直复用；密码只在 token 失效时用于重新登录。
- 这是自签名调试包，**不要**用 `--release` 之类的方式分发签名错误的变体。

## 六、自己重新打包

```powershell
# 一键打包（复用本机 D:\Android\Sdk 和 Gradle 缓存，不额外下载 SDK）
powershell -ExecutionPolicy Bypass -File app-android\build-apk.ps1

# 产物
app-android\app\build\outputs\apk\debug\app-debug.apk
```

环境要求（本机已满足）：

| 项 | 值 |
|---|---|
| Android SDK | `D:\Android\Sdk`（platforms 33/35/36，build-tools 35.0.0/36.0.0） |
| JDK | 17（`C:\Users\Lenovo\AppData\Local\Programs\Microsoft\jdk-17.0.10.7-hotspot`） |
| Gradle | 8.14.3（wrapper 已带，本机缓存里已解压） |
| AGP | 8.13.0 |

> 坑：Windows PowerShell 5.1 读**无 BOM 的 UTF-8 脚本**时会按 GBK 解析，
> 脚本里的中文会把引号搞坏导致语法错误。所以 `app-android\*.ps1` 全部写成**纯 ASCII**。

## 七、代码结构

```
app-android/
  build-apk.ps1                    一键打包
  app/build.gradle                 依赖只有 com.google.zxing:core
  app/src/main/AndroidManifest.xml INTERNET + CAMERA 权限；登记 MainActivity 和 ScanActivity
  app/src/main/java/com/ktp/scanner/
      MainActivity.java    WebView + JS bridge + 账号存储 + 原生 HTTP 提交
      ScanActivity.java    全屏实时扫码（原生 Camera + ZXing，相机跑在独立 HandlerThread）
      ViewfinderView.java  扫码遮罩：四周压暗 + 绿色四角 + 往返扫描线 + 提示文字
  app/src/main/res/layout/activity_scan.xml   扫码界面布局
  app/src/main/assets/www/         主界面（index.html / app.js / style.css）
  test-on-emulator.ps1             无头模拟器验证能否启动
  test-add-account.ps1             无头模拟器验证原生 HTTP 桥能否登录
```

## 八、为什么网络必须走原生

网页里 `fetch` 有两个死穴：

1. **CORS**：`openapiv5.ketangpai.com` 不会给我们的来源发 CORS 头，浏览器直接拦掉。
2. **禁止头**：Fetch 规范把 `Origin` / `Referer` / `Sec-*` 列为 forbidden header name，
   JS 设置了也会被**静默丢弃**，而课堂派恰好校验它们。

所以 App 里所有请求都由 Java 侧 `HttpURLConnection` 发出，JS 只通过 bridge 调用。
外加每个请求随机伪造一个 `X-Forwarded-For`（多账号同 IP 提交会被判异常）。

## 九、为什么扫码也是原生的

`getUserMedia` 在 WebView + `file://` 页面里行为不稳定（要处理 `onPermissionRequest`、
安全上下文判定各版本不一），而且拿到的帧还要绕回 JS 再解码。

现在改成原生：相机开在一个带 Looper 的 `HandlerThread` 上，`onPreviewFrame` 就地用 ZXing
解 NV21 的 Y 平面（每 180ms 最多解一帧，不会卡 UI，也不会烧 CPU）。
二维码即使旋转 90° 也能识别 —— ZXing 的定位图案本来就是旋转不变的。
