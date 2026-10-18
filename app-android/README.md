# 课堂派签到 App（Android）

**独立客户端，不依赖电脑、不需要服务器。** 装在教室里那个人的手机上即可。

> 当前版本 **0.7.3**：底部三栏（扫码签到 / GPS 签到 / 设置）、实时扫码、
> 签到提醒（通知）、定位签到（位置库 + 定位方式）。
> **使用说明请看仓库根目录的 [README.md](../README.md)** —— 本文只讲实现细节和踩过的坑。

## 一、装到手机上

把 [`dist/ktp-signin-0.7.3.apk`](../dist/ktp-signin-0.7.3.apk) 传到手机（微信/QQ 发给自己、数据线、或 U 盘都行），点开安装。

- 需要允许「安装未知来源应用」（因为是自签名调试包，没上架应用商店）
- 如果装过旧版本，**先卸载旧的再装**（清掉更省事），尤其是 0.2.x → 0.7.3 这种跨版本
- 装完桌面图标叫「课堂派签到」

要求：Android 7.0 (API 24) 及以上。包体 **16.3 MB**（大头是自己编译的 zxing-cpp
原生库和 ML Kit，见第十五节）。

首次使用会申请三个权限：**摄像头**（扫码）、**通知**（签到提醒）、
**定位**（只在「读当前位置」时用，签到本身不读 GPS）。

## 二、怎么用（简版）

1. **设置 → 添加账号**：填备注名 + 课堂派手机号 + 密码 → 「添加并验证登录」。
   **会先真的登录一次，成功才保存**，密码错了不会写进去。加多少个都行。
2. **勾选要签的人**：默认全选，只在「扫码签到」和「GPS 签到」两栏出现，状态互通。
3. **扫码签到**：点「扫一扫签到」→ 全屏扫码 → 对准大屏二维码 →
   **识别到自动签到并自动返回**，不用再点。结果逐人显示 ✅ / ❌。
4. **定位签到**：先在「GPS 签到 → 签到位置」里存好教室坐标（读当前位置，或手填高德坐标），
   之后老师开定位签到时，通知上点「立即定位签到」就行。
5. **签到提醒**（设置栏）：选一个人当「主成员」，他的课一有人在签到就弹通知。
   需要关掉后台限制，否则收不到（见根 README 的权限说明）。

扫码界面**只支持实时扫**，没有"从相册选图"入口。这是故意的 —— 照片有"拍下来到提交"
的时间差，虽然票据有 300 秒有效期，实时扫还是最稳。右上角 ✕ 或返回键可退出。

> 更详细的使用步骤（含定位方式怎么选、新建/回填的区别、换手机迁移）
> 在仓库根目录的 [README.md](../README.md) 第一节。

## 三、为什么"扫一次就能签好几个人"

这是实测出来的关键性质：**课堂派那张二维码的票据跟学生身份无关，一张票能签任意多个账号。**

所以现场那个人**不需要换账号、不需要重复扫**。扫一次，App 会把票同时提交给所有勾选的账号（并发 4 个），每个人拿到各自的签到结果。

（这也是为什么它的定位是"现场代签工具"：主动权在教室里的那台手机上。）

## 四、IP 伪造（重要）

教师端考勤表里有一列 **IP**。用工具签到如果这一列显示 `0.0.0.0`，等于直接告诉老师"这不是正常扫码"。
实测（2026 版接口，用 `getCheckInResult` 读回记录值）：

| 发送的请求头 | 服务端记录的 IP |
|---|---|
| 不带任何 IP 头 | 真实出口 IP（如 `203.0.113.45`） |
| `X-Forwarded-For: 203.0.113.77` | `203.0.113.77` ✅ **被逐字信任** |
| `X-Forwarded-For: 223.104.137` | `0.0.0.0` ❌ 只有 3 段，非法 |
| `X-Forwarded-For: 203.0.113.77:1234` | `0.0.0.0` ❌ 带端口，非法 |
| `X-Forwarded-For: 192.168.1.5` | `192.168.1.5`（**它不校验是否公网**） |
| `X-Real-IP: 203.0.113.55` | 被忽略，仍记真实 IP |

**结论：课堂派只认 `X-Forwarded-For`，且只做"格式是否合法"的检查 —— 格式不对就记 `0.0.0.0`。**

### 三次踩坑记录（都是同一个根因：地址少了一段）

| 版本 | 现象 | 原因 |
|---|---|---|
| 0.2.2 及以前 | 教师端全班都是 `0.0.0.0` | 生成器拼出 3 段（`223.104.137`），照样发出去了 → 服务端记 `0.0.0.0` |
| 0.2.3 | 教师端全班都是**同一个真实 IP** | 生成器仍拼 3 段，但新增了客户端校验；校验不过就**干脆不发这个头** → 服务端记手机真实 IP |
| 0.2.5 | 已修复 | IP 逻辑抽成纯 Java 的 `IpUtil`，并加了可执行的单测 |

**第二种比第一种更糟**：所有人显示同一个真实 IP，等于直接告诉老师这批是同一台手机交的。

所以现在：

- `IpUtil.randomIp()` 保证**永远**返回合法四段地址（前缀允许只写 1~3 段，缺的自动补齐）
- `ensureValid()` 兜底：**宁可重新生成一个合法 IP，也绝不静默地不发这个头**
- 启动时会自动修复历史数据（早期版本存下来的 3 段 IP 会被换成合法地址）
- **每个账号分配一个固定假 IP**，而不是每次签到都换 —— 同一个学生每次从不同省份签到，
  比 `0.0.0.0` 更容易被看出问题
- 界面上账号卡片下面直接显示这个 IP，「IP 设置」里可以切换策略：

| 策略 | 说明 | 什么时候用 |
|---|---|---|
| **每个账号各自一个固定 IP**（默认） | 各账号像来自不同网络 | 人数多、想让每人看起来独立 |
| **所有账号共用同一个 IP** | 全部一样，像同一个 Wi-Fi 出来的 | 想让记录看起来像"一屋子人在教室连着同一个网" |
| **不伪造，用手机真实 IP** | 发真实出口 IP | 最自然，但所有账号会共用同一个真实 IP |

> 哪种"最不显眼"取决于你们班的实际情况：真实教室里，连同一个 Wi-Fi 的同学**本来就会显示同一个 IP**。
> 所以"全部相同"往往比"每人一个随机 IP"更贴近现实。这一点你得自己判断。

### 怎么防止再犯

IP 逻辑被抽到 `app-android/app/src/main/java/com/ktp/scanner/IpUtil.java` ——
**刻意不引用任何 Android 类**，所以可以直接用 JDK 跑单测，不需要手机或模拟器：

```bash
javac -encoding UTF-8 -d /tmp/ipout \
  app-android/app/src/main/java/com/ktp/scanner/IpUtil.java \
  tools/ip-test/IpUtilTest.java
java -cp /tmp/ipout IpUtilTest
# => generated 200000 ips, invalid count = 0
#    bad cases rejected = 11/11
#    ALL PASS
```

改了 IP 相关代码后请务必跑一遍这两条命令。

## 五、和电脑版的关系

| | 电脑版（`src/server.ts` + `public/`） | 手机 App（`app-android/`） |
|---|---|---|
| 定位 | 开发/调试、批量管理、图像识别更强 | 现场扫码签到 |
| 二维码识别 | jsQR + OpenCV + zxing-cpp（三级流水线，拍屏幕的烂图也能解） | 只用 ZXing（原生），够用但不如电脑版强 |
| 网络 | Node `node:https` | 原生 `HttpURLConnection` |
| 依赖 | 需要电脑开机 | 独立 |

App 里**没有**"实时状态/未完成签到列表"，那是电脑版的功能。App 只做一件事：现场扫码、批量提交。

## 六、安全提醒

- 账号密码**明文**存在 App 私有目录的 SharedPreferences 里（`/data/data/com.ktp.scanner/shared_prefs/ktp.xml`）。
  普通应用读不到，但手机 root 过就能看到。**别在别人的手机上长期留着自己的号。**
- token 缓存在同一个文件里，默认会一直复用；密码只在 token 失效时用于重新登录。
- 这是自签名调试包，**不要**用 `--release` 之类的方式分发签名错误的变体。

## 七、自己重新打包

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

## 八、代码结构

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

## 九、为什么网络必须走原生

网页里 `fetch` 有两个死穴：

1. **CORS**：`openapiv5.ketangpai.com` 不会给我们的来源发 CORS 头，浏览器直接拦掉。
2. **禁止头**：Fetch 规范把 `Origin` / `Referer` / `Sec-*` 列为 forbidden header name，
   JS 设置了也会被**静默丢弃**，而课堂派恰好校验它们。

所以 App 里所有请求都由 Java 侧 `HttpURLConnection` 发出，JS 只通过 bridge 调用。
外加每个请求随机伪造一个 `X-Forwarded-For`（多账号同 IP 提交会被判异常）。

## 十、为什么扫码也是原生的

`getUserMedia` 在 WebView + `file://` 页面里行为不稳定（要处理 `onPermissionRequest`、
安全上下文判定各版本不一），而且拿到的帧还要绕回 JS 再解码。

现在改成原生：相机开在一个带 Looper 的 `HandlerThread` 上，`onPreviewFrame` 就地用 ZXing
解 NV21 的 Y 平面（每 60ms 最多解一帧，不会卡 UI，也不会烧 CPU）。
二维码即使旋转 90° 也能识别 —— ZXing 的定位图案本来就是旋转不变的。

## 十一、成员迁移（换手机）

「成员迁移」卡片里可以一键导出/导入全部成员：

- **导出并复制** —— 生成一段文本（`KTP1:` + URL-safe Base64）并复制到剪贴板；也可以点「分享」直接发微信
- **从剪贴板导入** —— 在新手机上读剪贴板导入
- **从上面文本框导入** —— 手动粘贴的备用入口
- 导入模式：不勾「覆盖」= 按备注名**合并**（同名更新，其余保留）；勾上 = **清空后覆盖**
- 导出可选**是否包含密码**（不勾则导入后要重填密码）

格式设计上的两个考虑：

1. **单行、无空白** —— 走剪贴板/微信不会被换行破坏；导入时会先去掉所有空白再解码
2. **JSON 那条路不能去空白** —— 名字、密码、学校名里本来就可能带空格，
   所以导入时只有「Base64 那一路」才会 `replaceAll("\\s+","")`（这个坑我第一版写错了）

单测（不需要设备）：`node tools/test-migrate.mjs` —— 覆盖带空格的名字/密码、被换行拆开、
前后有空白、裸 JSON、非法输入等情况。

> ⚠️ 勾了「包含密码」导出的那段文本里是**明文密码**，别发到群里，用完把聊天记录删掉。

## 十二、开发时怎么验证（不用装机）

改 UI 或 IP 逻辑时，有两条**不需要手机、不需要模拟器**的验证路径 —— 都用上了才发版：

### 1. IP 逻辑单测（纯 Java）

```bash
javac -encoding UTF-8 -d /tmp/ipout \
  app-android/app/src/main/java/com/ktp/scanner/IpUtil.java \
  tools/ip-test/IpUtilTest.java
java -cp /tmp/ipout IpUtilTest
```

### 2. 界面布局实测（无头 Chrome）

`tools/ui-preview/` 会用假数据渲染真实界面，然后**量出真实几何**（行高、是否溢出、
IP 列是否对齐），避免"看着差不多就发版"：

```bash
node tools/ui-preview/diag-server.mjs          # 一个终端：起接收诊断的小服务
node tools/ui-preview/build.mjs                # 另一个终端：生成预览页
chrome --headless=new --disable-gpu --allow-file-access-from-files \
  --force-device-scale-factor=1 --window-size=400,900 --virtual-time-budget=3000 \
  --screenshot=tools/ui-preview/shot-360.png \
  file:///<repo>/tools/ui-preview/www/frame.html
```

`frame.html` 把宽度**锁死在 360px**（Chrome 的 `--window-size` 在某些机器上不生效），
这样验的就是最窄手机。结果写进 `tools/ui-preview/diag.log`，例如：

```
iframe 宽度 = 360   横向溢出 = 0 px   5行总高 = 291 px
每行 h=52  nm=120/174 截断=True 换行=1  ipLeft=204 ipRight=282
```

（这套工具是被真实 bug 逼出来的：账号卡片曾经因为文字换行被撑到 100+ px，
4 个人就占满一屏 —— 那次如果先量一下就不会发出去。）

## 十三、状态栏遮挡（Android 15 强制边到边）

`targetSdk 35` 起，**Android 15 强制 App 边到边显示** —— 内容会画到状态栏和导航栏底下。
表现就是主界面顶栏「课堂派签到」被状态栏图标压住。

处理方式（`MainActivity.applyEdgeToEdge()`）：

1. 显式声明铺满整屏：API 30+ 用 `setDecorFitsSystemWindows(false)`；
   更老的系统用 `SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | LAYOUT_HIDE_NAVIGATION`
   —— 两边都显式声明，行为才一致，也避免在已经自动避让的系统上**重复加内边距**。
2. 把状态栏/导航栏设为透明，并清掉 `APPEARANCE_LIGHT_*`（深色背景要浅色图标）。
3. 把系统栏高度作为 padding 让出来。
4. 兜底：若某个 ROM 仍上报 0，就直接取系统资源里的 `status_bar_height`。

### ⚠️ 关键坑：WebView 不认 `setPadding`

这是第一版改了却**依然遮挡**的原因。WebView 的内容由原生 `AwContents` 按 view 的实际边界渲染，
给它自己 `setPadding` 基本是无效的。

**必须套一层容器，把 padding 加在容器上**：

```java
FrameLayout root = new FrameLayout(this);
root.addView(web, new FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT));
setContentView(root);
root.setOnApplyWindowInsetsListener(...);   // padding 加在 root 上，不是 web 上
```

> 也别指望 CSS 的 `env(safe-area-inset-top)`：Android WebView 里那个值反映的是**刘海/挖孔屏的
> cutout**，不是状态栏高度 —— 没刘海的手机上它是 0，照样被压。内边距必须在原生侧加。

## 十四、App 图标
图标由 `tools/icon/make_icons.py` 从一张成品图生成（脚本留档，可重跑）：

```bash
python tools/icon/make_icons.py
```

生成的内容：

| 文件 | 用途 |
|---|---|
| `mipmap-anydpi-v26/ic_launcher(.round).xml` | 自适应图标（Android 8+） |
| `mipmap-*/ic_launcher_foreground.png` | 自适应图标前景（作品缩到 76%） |
| `mipmap-*/ic_launcher.png` | 传统图标（保留圆角，方角外透明） |
| `mipmap-*/ic_launcher_round.png` | 传统圆形图标 |
| `values/colors.xml` | `ic_launcher_background`（取自作品的边缘中位色） |

两个踩过的坑：

1. **`cv2.floodFill` 默认是「和相邻像素比」**，会顺着白→灰→蓝的渐变一路蔓延，
   把 97% 的像素都判成"外部"。必须加 `FLOODFILL_FIXED_RANGE`（跟种子像素比），
   这样就只吃掉真正的白底（实测占比 3.7%）。
2. **前景比例选 76% 不是随便填的**：作品的边缘有一圈亮光，落在画布 12%~88%，
   而启动器遮罩只显示中间约 17%~83% —— 亮边正好被裁掉，不会出现"方框套方框"；
   作品里那圈人像在 18%~82%，刚好完整保留。

## 十五、小二维码识别（为什么微信更强）

现象：二维码小/远的时候，微信放大后能扫上，我们扫不上。

**根本原因是两代技术差，不是参数没调好：**

| | 微信 | 我们原来的 ZXing |
|---|---|---|
| 检测方式 | 神经网络（CNN）检测 | 找"1:1:3:1:1"定位图案的经典算法 |
| 尺度 | 多尺度金字塔，大小码都过一遍 | 单一尺度 |
| 二值化 | 针对模糊/低对比度专门调 | 通用全局/局部直方图 |
| 对焦 | 针对感兴趣区域持续对焦 | 整幅连续对焦 |

ZXing 那条路在码很小时会崩在一个具体环节：每个模块只占 1~2 个像素时，
"黑:白:黑:白:黑 = 1:1:3:1:1"的比例判断就站不住，定位图案找不到，后面全免谈。

### 做了三件事

1. **预览分辨率 1280 → 1920**：直接给二维码更多真实像素。
   因为我们只解 crop 区域（不是全画幅），单帧解码仍在几十毫秒量级。
2. **加了「小码救援」那一路**（每 4 帧一次）：取画面中心正方形放大后再解，并开 `TRY_HARDER`
   （让 ZXing 逐行扫描，默认是每 3 行扫一次）。
   放大本身不增加信息，但能让模块占的像素变多，比例判断才站得住。
   用**固定目标边长**（1280）而不是固定 2 倍，这样预览分辨率提高后成本也不会失控。
3. **接入 ML Kit 兜底**（`com.google.mlkit:barcode-scanning:17.3.0`）：
   **ZXing 先试（快），认不出来才交给 ML Kit** —— 这就是微信那一档的 ML 检测器。
   之所以做成兜底而不是替换：万一某些机型上 ML Kit 起不来，扫码功能也不会坏
   （`initMlKit` 里 `catch (Throwable)`，失败就永远走 ZXing）。
   ML Kit 是异步的，用 `mlBusy` 防止任务堆积 —— 不等它做完就继续投喂只会越扫越卡。

### 包体积：25.8MB → 13.2MB

ML Kit 自带 native 库 `libbarhopper_v3.so`，每个 CPU 架构 3~6MB。默认会把四个架构全打进去：

```
lib/x86/      6.1 MB   ← 模拟器专用，手机上永远用不到
lib/x86_64/   5.9 MB   ← 同上
lib/arm64-v8a/    4.9 MB
lib/armeabi-v7a/  3.2 MB
```

加 `ndk { abiFilters 'arm64-v8a', 'armeabi-v7a' }` 砍掉 x86 两个，**25.8MB → 13.2MB**。

> 为什么用**捆绑模型**（`com.google.mlkit:barcode-scanning`）而不是更小的
> `com.google.android.gms:play-services-mlkit-barcode-scanning`：
> 后者依赖 Google Play 服务去下载模型，而国内很多手机根本没有 Play 服务，装上会直接不可用。
> 捆绑版离线可用，代价就是这十几 MB。

> `release` 里已经开了 `minifyEnabled` + `shrinkResources`（ML Kit 的 Java 层让 classes.dex 有 9MB，
> 走一次 R8 能砍掉不少）。但**目前发给你的是 debug 包**，混淆配置还没在真机上验证过，
> 所以没有切换过去 —— 等你确认功能没问题，我可以改发 release 包，体积还能再小一截。

### 0.3.2：真机反馈「还是扫不上」之后的三个修正

0.3.1 在真机上测的结果是**三条路（ZXing / 放大 / ML Kit）全部失败**。
三条都失败更像"喂进去的画面本身有问题"，而不是检测算法不够强。查下来三处：

1. **对焦有 bug（最可能的元凶）**：原来只处理了 `FOCUS_MODE_CONTINUOUS_PICTURE`，
   **没有 else 分支**。设备不支持这个模式时一个对焦模式都不设，而很多机型默认是
   `FOCUS_MODE_AUTO` —— AUTO **不主动调用 `autoFocus()` 就永远不对焦**，
   取景画面一直是虚的，什么检测算法都救不回来。
   现在改成：优先 `CONTINUOUS_VIDEO`（专为预览流设计）→ `CONTINUOUS_PICTURE`
   → `AUTO`/`MACRO`，并且**非连续模式时每 1.5 秒主动触发一次 `autoFocus()`**。

2. **ML Kit 一直拿的是整帧**：1920×1080 ≈ 200 万像素里，小二维码只是个小目标，
   ML Kit 内部还要再缩放一次，很容易漏。现在改成**轮流看「整幅 + 3×3 九块」**
   （每块占 55%）：裁成子块后码在输入图里占的比例大 3 倍多。
   这么做还有个好处：**完全不需要算取景框到 buffer 的坐标映射**
   （那涉及 90° 旋转的翻转方向，盲写必错），不管码在画面哪儿，总有一块能包住它。

3. **`InputImage` 的长度校验被静默吞掉了**：`fromByteArray` 要求缓冲长度**严格等于** `w*h*3/2`，
   而原来我在 `catch (Throwable)` 里直接 `return` —— 万一长度不符，
   表现就是"ML Kit 好像从来没生效"却查不出任何原因。
   现在裁剪缓冲按精确长度分配（整幅/子块各一个，避免反复 new），
   并且把失败原因记进 `mlLastError`。

另外加了「**存图排查**」按钮（扫码页右上角）：按一下把**当前相机原始亮度帧**存进
相册 `Pictures/KTP排查/`，同时把这些数字写进 logcat：

```
snapshot 1920x1080 rot=90 crop=0,108 1920x864 z=3/5 contFocus=false mlErr=null
```

把图发出来就能直接判断：是糊了（对焦）、码太小（分辨率/倍率）、还是反光（对比度），
不用再靠猜。

### 0.3.4：用真实失败帧做的离线实验，把根因钉死了

用户把「扫不上的那一帧」存了下来（就是「存图排查」按钮的产物）。有了真实样本，
就不用再靠真机往返试错了 —— **在电脑上用同一张图跑实验**即可。

**结论：问题不在放大倍数、不在对焦、不在预处理，而在解码库本身。**

| 解码器 | 同一张帧 |
|---|---|
| **ZXing Java 3.5.3**（App 用的） | ❌ **120 种预处理组合全败**（放大 1~5 倍 × 平场校正/锐化/Otsu/中值 × 白边，两种二值化） |
| zxing-cpp | ✅ 原分辨率就能解（**但只有用「固定阈值」二值化时**；默认的局部自适应要放大 3 倍才行） |
| 微信 | ✅ 直接能解 |

关键的一步：把 zxing-cpp 的参数扫一遍，发现它换成 `FixedThreshold` 后**原分辨率就成功**了 ——
说明这张帧并不算难，是**局部自适应二值化**在「大面积灰色 UI 边框 + 屏幕反光」下把它毁了。
于是我把 ZXing Java 也换成固定阈值（自己算 BitMatrix，绕过它自带的二值化）——
**依然失败**。这就排除了二值化，坐实了是 ZXing Java 的**检测器**找不到定位图案。

复现实验代码都在 `tools/scan-debug/`（不需要手机）：

```bash
# 用真正的 ZXing Java 复现失败，并扫各种裁剪/放大/提示组合
javac -encoding UTF-8 -cp core-3.5.3.jar -d out ZxingProbe.java
java -cp "out;core-3.5.3.jar" ZxingProbe frame.jpg

# 120 种预处理组合
javac -encoding UTF-8 -cp core-3.5.3.jar -d out PreprocessProbe.java
java -cp "out;core-3.5.3.jar" PreprocessProbe frame.jpg

# 固定阈值 vs 局部自适应（就是这一步找到根因的）
javac -encoding UTF-8 -cp core-3.5.3.jar -d out FixedThresholdProbe.java
java -cp "out;core-3.5.3.jar" FixedThresholdProbe frame.jpg
```

顺带纠正了一个我自己的误判：我曾以为「三条路全失败」= 完全扫不上，
实际是**只在远距离失败**（走近就行）。所以在动算法之前先问清楚现象，能省很多无效改动。

### 屏幕上的诊断信息（0.3.4 起）

取景框下方会实时显示：

```
预览 1920x864  裁剪 1920x864  变焦 6/6
MLKit 就绪  处理 37  失败 0
帧 812  连续对焦
```

加这个的原因：**ML Kit 没法在电脑上跑**，而真机往返一次成本很高。
把它「有没有在工作、处理了多少帧、报了什么错」直接显示出来，一张截图就能定性。

### 0.3.6：换掉解码库 —— 编入 zxing-cpp

真机数据（用户截图）显示：`MLKit 就绪 处理 266 失败 0` —— ML Kit 在跑、不报错，
但认不出来。而离线实验已经证明 zxing-cpp 能解同一张帧。

于是把 zxing-cpp 编成原生库打进 App：`app/src/main/jniLibs/<abi>/libktpzxing.so`
（arm64-v8a 1.79MB / armeabi-v7a 1.29MB，已 strip）。

**解码顺序**（按实测效果排）：

| 顺序 | 路径 | 说明 |
|---|---|---|
| 1 | **zxing-cpp + 固定阈值**，只扫取景框那块 | 唯一被证明能解这种帧的组合 |
| 2 | ZXing Java | 老路径，够快，正常大小的码靠它 |
| 3 | zxing-cpp + 局部自适应 | 换一种二值化再试（每 4 帧） |
| 4 | ZXing Java 放大救援 | 每 4 帧 |
| 5 | ML Kit | 异步兜底 |

原生库加载失败时（`System.loadLibrary` 抛异常）自动跳过第 1、3 步，
`cppOk=false` 会显示在屏幕上（`cpp✗`），不影响其它路径。

**怎么重新编**（改了 native 代码或想升级 zxing-cpp 时）：

```bash
cd tools/zxing-cpp-build
git clone --depth 1 --branch v2.3.0 https://github.com/zxing-cpp/zxing-cpp.git src

# 1) 编 zxing-cpp 静态库
$CM  = D:/Android/Sdk/cmake/3.31.6/bin/cmake.exe
$NDK = D:/Android/Sdk/ndk/27.1.12297006
$CM -S src -B build-arm64 -G Ninja -DCMAKE_TOOLCHAIN_FILE=$NDK/build/cmake/android.toolchain.cmake \
    -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-24 -DCMAKE_BUILD_TYPE=Release \
    -DBUILD_SHARED_LIBS=OFF -DZXING_EXAMPLES=OFF -DZXING_UNIT_TESTS=OFF -DZXING_BLACKBOX_TESTS=OFF
$CM --build build-arm64

# 2) 编 JNI 包装 -> libktpzxing.so
$CM -S jni -B jniA -G Ninja -DCMAKE_TOOLCHAIN_FILE=$NDK/build/cmake/android.toolchain.cmake \
    -DANDROID_ABI=arm64-v8a -DANDROID_PLATFORM=android-24 -DCMAKE_BUILD_TYPE=Release \
    -DZXING_LIB=D:/.../build-arm64/core/libZXing.a
$CM --build jniA
# 拷到 app/src/main/jniLibs/arm64-v8a/ 并用 llvm-strip --strip-unneeded 瘦身
```

> 四个踩过的坑（都很隐蔽，浪费了不少时间）：
> 1. `project()` 里**必须同时声明 C 和 CXX**，只写 CXX 会报
>    `CMAKE_CXX_COMPILER not set, after EnableLanguage`
> 2. 传给 CMake 的路径**用正斜杠** —— 反斜杠会被当转义符，导致编译器探测失败
> 3. 构建目录名**不要带短横线**
> 4. 在 PowerShell 里给 cmake 的输出加 `| Out-Null` 也会让配置失败

> `libktpzxing.so` 只依赖 `liblog/libm/libdl/libc`（C++ 运行时是静态链接的），
> 所以不需要额外打包 `libc++_shared.so`。

## 十六、签到提醒（0.4.0）

选一个成员当「主成员」，他/她的课一旦有人在签到，手机就弹通知：
**「您的『xxx』课程正在签到，请及时处理」**。

### 判断「正在签到」的依据（这一步必须验证过，否则会一直误报）

| 接口 | 行为 | 能用吗 |
|---|---|---|
| `/AttenceApi/getNotFinishAttenceStudent {courseid}` | **只返回正在进行的** | ✅ 用它 |
| `/AttenceApi/getNotFinishAttence {courseid}` | 连 **12.7 小时前**的旧签到都还留着 | ❌ |
| 不带 courseid | 返回空列表 | ❌ 没有跨课程批量接口 |

验证方法在 `tools/exp-ongoing2.ts`（秒级，不用等考勤自然过期）：
现场建一个考勤 → 它立刻出现在列表里 → 调 `overAttence` 结束 → **它立刻消失**。
所以「列表非空」就等于「这门课正在签到」，不需要自己算时间窗
（而且那个接口压根不返回结束时间，本来就算不出来）。

### 实现

- `MonitorService`：**前台服务**（Android 8 以后后台应用不能长期存活），
  每 30 秒轮询一次，常驻一条低优先级通知显示当前状态。
  一次要给 28 门课发请求，所以用 5 并发 + 20 秒总超时，单门课失败不影响整轮。
- 提醒去重：同一场签到只提醒一次，已提醒的 id 存在 `notifiedAttence` 里（重启不重复）。
- token 过期会自动重新登录一次，并把新 token 写回账号。
- Android 13+ 需要 `POST_NOTIFICATIONS` 运行时授权，开启监控时会申请。
- `KtpApi` 是从 `MainActivity` 里抽出来的 HTTP 层，这样服务和界面用同一套逻辑
  （Origin/Referer/Sec-Fetch-* 这些头只能用原生发，见第八节）。

### 已知限制（用之前要知道）

1. **一次检查要发 28 个请求**（每门课一个），30 秒一轮 ≈ 每天几十 MB 流量。
   所以界面上写着「上课时打开，下课后记得关掉」。
2. **国产 ROM 的后台限制**：需要在系统设置里给本应用「允许后台运行 / 自启动 / 关闭电池优化」，
   否则服务可能被杀。这个没法在代码里绕过，只能手动加白名单。
3. 只在**主成员**的课程里找 —— 一个人盯着就够，也顺便省掉了多账号的 N 倍请求。

> 别用 `getNotFinishAttence`（少个 Student 那个）—— 实测它会把早已结束的签到也返回，
> 拿它做提醒会不停误报。

## 十七、定位签到（0.5.0）

### 结论先说：**不需要影梭，也不需要虚拟机**

大家平时用「影梭」改高德定位、有人还得把微信塞进虚拟机，那是为了骗**官方客户端** ——
它读系统定位，而微信还额外做了防「模拟位置」检测，所以得多绕一层。

**我们是自己发请求：坐标就是请求体里的普通参数**，服务端直接接受：

```
/AttenceApi/checkin { id, latitude, longitude, accuracy: "30", clienttype: 1 }
```

不需要手机 GPS、不需要改定位、不需要虚拟机，手机定位关着都行
（`ACCESS_FINE_LOCATION` 权限**只**用于「站在教室里点一下读当前位置」这个便利功能）。

### ⚠️ 但有一点我没能验证，必须真机实测

实验在 `tools/exp-gps-now.ts` / `exp-gps-real.ts`：8 次提交（含 `0,0` 和北京坐标）**全部成功**。
但那可能是**因为我造出来的签到里没有目标位置** —— `getLocation` 一直返回
`centerPoint=null, avgLocation={0,0}`。

我试了 6 种建参写法（`latitude/longitude`、`lat/lng`、`centerPoint` 对象/字符串、`position`），
**一个都设不上** —— 说明真实场景里的目标位置是**老师端 GPS 自动带上的**，接口层设不了。
连「让老师自己先签一次」也不行（`avgLocation` 还是 0,0）。

**所以请拿真实课堂试一次：**

| 结果 | 含义 | 对策 |
|---|---|---|
| 不在教室也能签到 | 只记录、不校验距离 | 坐标随便填 |
| 报错 / 不成功 | **确实校验距离** | 必须填教室真实坐标（见下） |

### 教室坐标怎么来

- **站在教室里点「读当前位置」**（读完记得点「保存坐标」）—— 最准，一次就够
- 或直接照抄高德里显示的经纬度（你们本来就熟悉高德）

坐标存在 `roomLat`/`roomLng`，定位签到时直接报这个。

### 用法

监控发现定位签到时：

1. **通知上直接有「立即定位签到」按钮** —— 点一下就用保存的坐标提交
2. App 里「签到提醒」卡片也列出正在进行的签到，定位签到那条带「立即签到」按钮

> 学生**取不到**老师的 `getLocation`（`30202 你没有权限访问该班级的信息`），
> 所以坐标只能自己填 —— App 没法自动知道教室在哪。

### 读当前位置为什么不准（0.5.1 修的坑）

真机现象：明明站在「菜鸟驿站」旁边，读出来的坐标却在几百米外的另一个点。

两个原因，第一个是主因：

1. **读到的"最后已知位置"来自模拟定位。** 装了影梭之类改定位的 App 时，
   系统返回的 `getLastKnownLocation` 就是**它设的那个假点**，跟你实际站的地方没关系。
   （用户正是用影梭的 —— 地图上那个蓝标很可能就是影梭当前设的位置。）
   现在会检测 `Location.isMock()` / `isFromMockProvider()`，**读到模拟定位会明确警告**，
   并提示「先去影梭里停止模拟，再点一次」。
2. **原来按「时间最新」挑，会挑到粗的网络定位。** 网络定位往往又新又粗（几百米），
   把 GPS 更准的结果顶掉。现在改成**按精度挑**（`getAccuracy()` 越小越好）。

另外还改了两处：

- 从「读一次系统缓存」改成**主动申请一次定位更新**（GPS + 网络同时听 20 秒），
  界面每 1.2 秒问一次原生侧，拿到 ±30 米以内就停
- 结果里带上 `accuracy` / `provider` / `mock` / `cached`，界面上直接显示
  「精度 ±12 米 · gps」，精度不够或来自模拟定位会给出对应建议

> 手机**定位开关关着**时只能靠基站/WiFi 估算，误差可能几百米 —— 界面也会提示这一点。

### 更可能的真因：**坐标系不一样**（WGS-84 vs GCJ-02）

用户实测：**没开影梭，读出来的位置照样偏几百米**。那就不是模拟定位的问题。

国内有三套坐标：

| 坐标系 | 谁在用 |
|---|---|
| **WGS-84** | 手机 `LocationManager` 给的原始 GPS 坐标 |
| **GCJ-02**（火星坐标） | 高德 / 腾讯地图，以及国内绝大多数 App 的定位 SDK |
| BD-09 | 百度地图 |

**同一个点，WGS-84 和 GCJ-02 在国内差 300~600 米** —— 正好是用户看到的偏移量级。
课堂派是国内 App，定位签到极可能存的是 GCJ-02；我们报 WGS-84 就会整体偏出去，
可能直接掉出签到半径（通常 200 米）。

转换算法在 `Coord.java`，**有单元测试**（不需要手机）：

```bash
cd tools/coord-test
javac -encoding UTF-8 -d out src/com/ktp/scanner/Coord.java src/com/ktp/scanner/CoordTest.java
java -cp out com.ktp.scanner.CoordTest
# PASS 偏移量在合理区间 555 米 (39.9087,116.3975)   ← 北京
# PASS 偏移量在合理区间 555 米 (39.9087,116.3975)   ← 北京
# PASS 往返误差 < 1 米（实测最差 0.000 米）
# ALL PASS
```

> 写测试时我**想当然**断言"GCJ-02 相对 WGS-84 偏东北"，结果在北京实测是**偏东南**
> —— 偏移方向随地区变化。测试当场打脸，改成了只断言"确实偏移且量级合理"。

**但该用哪一套，代码里猜不出来** —— 得看课堂派服务端存的是什么。
所以「读当前位置」会**两套都算出来**，并提示用户：

```
手机读到（WGS-84 GPS）：39.904200, 116.407400
换算成高德坐标（GCJ-02）：39.907500, 116.413500
两者相差 465 米
用哪个？ 在高德里长按教室看它显示的坐标，和哪一组一样就用哪一组。
```

界面给两个按钮「用 GPS 原始 / 用高德坐标」，默认预填高德坐标（国产 App 的绝大多数情况）。

### 位置库（像「添加成员」那样）

「签到位置」卡片可以存多个位置并选用：

```
locations      = [{"name":"二教305","lat":"39.904200","lng":"116.407400"}, ...]
activeLocation = "二教305"     ← 签到时报的是这个的原样数值
```

最多 30 个，名字最长 20 字；删除正在生效的那个会自动清空 active。
签到时报的是**用户填的原样数值**，不做任何转换 —— 转换只发生在「读当前位置」那一步。
