# 课堂派签到助手

一个能替**多个**课堂派账号远程签到的工具。手机 App 为主，另附电脑端脚本和控制台。

| | |
|---|---|
| **最新版** | [`dist/ktp-signin-0.7.0.apk`](dist/ktp-signin-0.7.0.apk)（16.3 MB，Android 7.0+） |
| **技术细节** | [app-android/README.md](app-android/README.md)（每个坑都有记录） |
| **电脑端** | `npm run web` 起本地控制台，或 `node src/cli.ts` 命令行 |

> ⚠️ **风险提示（请先读）**
> 本项目绕过的正是课堂派**故意设计**的防代签机制：二维码短时效 + 教师签名 +
> IP 聚集检测 + 定位校验。被判定为代签可能导致**课程考勤记 0 分、账号封禁，
> 乃至学校纪律处分**。请自行权衡，别怪工具。

---

## 一、使用方法

### 1. 添加成员

打开 App，进 **设置 → 添加账号**，填**课堂派账号密码**（手机号即可）。

- 备注名随便起（`小王`、`小李`…），只用于你自己认人
- 点「添加并验证登录」——会**真实登录一次**，成功才保存
- 加几个都行。**扫码签到时勾选谁，就替谁签**

> 密码只存在你自己手机上（`SharedPreferences`），不上传任何服务器。

### 2. 放行权限

第一次用会依次申请，都点**允许**：

| 权限 | 干什么用 |
|---|---|
| **摄像头** | 扫码签到（必须） |
| **通知** | 签到提醒（Android 13+ 要手动允许） |
| **定位** | 只在「读当前位置」时用，用来存教室坐标。**签到本身不读 GPS** |

### 3. 关掉后台限制（想用签到提醒才需要）

国产 ROM 会杀后台，**必须手动加白名单**，否则收不到提醒：

```
设置 → 应用管理 →「课堂派签到」：
· 自启动 / 允许后台运行 → 打开
· 电池 → 不限制后台行为（关掉省电优化）
· 通知 → 允许
```

各家叫法不同：小米＝「自启动」+「省电策略：无限制」，华为＝「应用启动管理：手动管理」，
OPPO/vivo＝「允许后台运行」。

### 4. 扫码签到（需要有人到场扫一次）

**原理**：一份二维码票据可以给**任意多个**账号签到，但学生自己查不到票据 ——
所以必须有个人在教室把二维码扫进来。

1. 让到场的人（或你自己）在 **扫码签到** 栏点「**扫一扫签到**」
2. 对准大屏上的二维码 —— 识别到就**自动提交**，不用再点
3. 下面会列出每个账号的结果（✅ 签到成功 / ❌ 重复签到 等）

- 勾选状态在「扫码签到」和「GPS 签到」两栏是**互通**的
- 二维码有效期 **300 秒**，但**旧二维码不会作废**，所以「朋友拍张照片发你」完全可行
- 扫一次签所有勾选的人 —— 不用一个个换账号

### 5. 定位签到（GPS，不用到场）

**原理**：定位签到的坐标只是**请求体里的一个参数**，服务端直接接受 ——
不需要手机 GPS、不需要影梭改定位、也不需要把微信塞进虚拟机。
（那些手段是为了骗**官方客户端**，它读系统定位；我们是自己发请求。）

**第一次课要做一次**（以后就不用管了）：

1. 人在教室时，进 **GPS 签到 → 签到位置 → 读当前位置**
2. 等它显示精度（`±12 米 · gps` 就很好），然后填个备注名（如 `二教305`）→ **新建**
3. 之后这门课的定位签到，直接一键完成

**上课时**：老师开了定位签到 → 手机弹通知 → 通知上直接有「**立即定位签到**」按钮，
点一下就签好了。App 的 **GPS 签到** 栏也会列出正在进行的定位签到，带「立即签到」按钮。

#### 定位方式（重要）

设置里有一项 **定位方式**，决定「读当前位置」时填哪套坐标：

| 选项 | 说明 |
|---|---|
| **高德坐标（GCJ-02）** | 默认。课堂派用的是高德定位，选这个 |
| **本机 GPS 坐标（WGS-84）** | 手机 GPS 原始坐标 |

**为什么会有这个选项**：同一个点，这两套坐标在国内相差 **300~600 米**。
如果签到位置总往一个方向偏几百米、或者签到说不在范围内，就换成另一套试试。

> 也可以**不用 GPS**：直接在高德里长按教室看经纬度，手填进「签到位置」，更可控。

#### 「新建」和「回填」的区别

| 按钮 | 行为 |
|---|---|
| **新建** | 用「备注名 + 输入框里的经纬度」建一个**新**位置（名字重复会报错） |
| **回填** | 把输入框里的经纬度写回**当前选中**的那个位置（名字不变） |

点位置列表里**任意位置**都能选中它，选中后经纬度会自动填到下面输入框；
但**改输入框不会动已存的位置** —— 要让改动生效必须点「回填」。

### 6. 签到提醒

不用一直盯着手机：进 **设置 → 签到提醒**，选一个人当「**主成员**」，
他/她的课**一旦有人在签到**，手机就会弹通知「您的 xxx 课程正在签到，请及时处理」。

- 点「开始监控」，检查频率建议 **10 秒**（每轮要逐门课问一遍，越短越费流量）
- 只在**主成员**的课程里找 —— 一个人盯着就够，也省流量
- **上课时开着，下课后记得关掉**

### 7. 换手机 / 多设备

**设置 → 成员迁移**：导出成一段文本 → 复制或分享到新手机 → 在新手机「从剪贴板导入」。
可以选**是否包含密码**（不勾选的话导入后要重填密码）。

### 8. 界面（三栏）

```
┌─────────────────────────┐
│ 课堂派签到               │
├─────────────────────────┤
│ 要签的人     已选5/5 ☑全选│  ← 只在扫码/GPS 栏出现
├─────────────────────────┤
│      （当前栏的内容）     │
├─────────────────────────┤
│  ▣扫码签到  ◎GPS签到  ⚙设置│  ← 固定在底部
└─────────────────────────┘
```

| 栏 | 内容 |
|---|---|
| **扫码签到** | 要签的人 + 「扫一扫签到」+ 签到结果 |
| **GPS 签到** | 要签的人 + 正在进行的定位签到 + 签到位置（位置库） |
| **设置** | 签到提醒、添加账号、定位方式、IP 设置、成员迁移、日志 |

---

## 二、实测结论（2026 版接口，全部亲测）

| 问题 | 结论 |
|---|---|
| 学生能不能不用二维码直接签到？ | ❌ 不能。必须带 `ticketid/expire/sign` |
| 学生能不能自己调接口拿到二维码？ | ❌ 不能，`getQrCode` 返回 `30202 你没有权限访问该班级的信息`（教师权限） |
| 老师发的二维码，学生用自己账号提交行不行？ | ✅ 行。**一份票据签所有账号**，票据跟学生身份无关 |
| 二维码有效期多久？ | ✅ **300 秒**（`expire = 签发时刻 + 300`）。比 2024 年教程里的 ~17 秒宽松得多 |
| 签发了新二维码后，旧二维码还有效吗？ | ✅ **仍然有效**。所以「朋友拍张照片发你」完全可行，不用抢那几秒 |
| 过期的二维码还能签吗？ | ❌ 不能，服务端返回 `此签到二维码已过期失效` |
| 怎么知道哪门课正在二维码签到？ | ✅ 轮询 `/AttenceApi/getNotFinishAttenceStudent`，出现 `type=3` 就是 |
| **定位签到的坐标能不能自己填？** | ✅ **能**。坐标就是请求参数，实测报了 `0,0` 和北京的坐标都被接受（8 次提交全部 `state=1`） |
| **服务端到底验不验"离教室多远"？** | ⚠️ **没验证成功**。详见下面 |
| 学生能不能读到老师设的目标位置？ | ❌ 不能，`/AttenceApi/getLocation` 返回 `30202`（教师权限），所以坐标只能自己填 |
| 签到类型 | `1`=数字码 `2`=定位 `3`=二维码 `4`=签到签出 |

### 关于定位签到那个没验证成功的点

我试过很多办法想确认服务端验不验距离，但**造不出"有目标位置"的签到**：
`getLocation` 一直返回 `centerPoint=null, avgLocation={0,0}`。

我试了 6 种建参写法（`latitude/longitude`、`lat/lng`、`centerPoint` 对象/字符串、
`position`）**一个都设不上**；连「让老师自己先签一次」也不行（`avgLocation` 还是 0,0）。
说明真实场景里的目标位置是**老师端 GPS 自动带上的**，接口层设不了。

所以：**我的 8 次成功提交，可能是因为那些签到里根本没有目标位置**。
是否真能远程签，**只能拿真实课堂试一次**：

| 实测结果 | 含义 | 对策 |
|---|---|---|
| 不在教室也能签 | 只记录、不校验距离 | 坐标随便填 |
| 报错 / 不成功 | **确实校验距离** | 必须填教室真实坐标（见「定位方式」） |

**一句话：扫码签到靠的是"5 分钟内的一张二维码照片"；定位签到理论上不用到场，但需要你实测确认。**

---

## 三、电脑端（可选）

```bash
npm install          # 只有 jsqr + jimp 两个纯 JS 依赖
npm run web          # http://127.0.0.1:8787
```

先在 `config.local.json` 里填账号（这个文件已在 `.gitignore` 里）：

```json
{
  "fakeIpPrefixes": ["223.104.", "117.136.", "183.232."],
  "accounts": {
    "stu":     { "email": "学生手机号", "password": "密码" },
    "teacher": { "email": "教师手机号", "password": "密码" }
  }
}
```

`teacher` 这一项只在本地联调（自己造签到测试）时需要。

Web 控制台三个页签：

- **实时状态** —— 自动扫所有课程，哪个课正在签到、是不是二维码签到，一眼看到
- **摄像头扫描** —— 对着二维码／大屏幕逐帧识别，**识别到就自动提交**。
  适合「旧手机架在教室里一直扫」的用法
- **手动签到** —— 朋友发来的二维码照片，直接 **Ctrl+V 粘贴** 就自动解码并签到

命令行：

```bash
node src/cli.ts courses                  # 我的课程（学生号实测 28 门）
node src/cli.ts status                   # 扫所有课程，列出未完成的签到
node src/cli.ts watch --interval 3       # 轮询监听，出现二维码考勤立刻提示
node src/cli.ts qr --url "<二维码URL>"    # 直接提交签到
node src/cli.ts decode shot.png --submit # 从照片/截图解二维码并签到
node src/cli.ts whoami                   # 当前身份
```

> 浏览器摄像头权限只在 `localhost` 或 HTTPS 下可用，所以想让**手机**当扫描器
> 就用 App。识别图片还需要 `python` + `opencv`（本机已装 cv2 4.12），
> 再叠加 `zxing-cpp`（`python -m pip install zxing-cpp`，强烈建议装，拍屏幕的照片基本靠它）。
> 都没有也能跑，只是识别率会明显下降。

---

## 四、协议速查

所有业务接口都是 `POST https://openapiv5.ketangpai.com<Path>`，JSON body，必带 `reqtimestamp`（毫秒）。

**必须伪造的请求头**（服务端会校验 Origin/Referer）：

```
Accept: application/json, text/plain, */*
Content-Type: application/json
User-Agent: ...MicroMessenger/8.0.56...   # 微信内置浏览器
Origin:  https://w.ketangpai.com
Referer: https://w.ketangpai.com/
Sec-Fetch-Site: same-site
token:   <登录拿到的 token>                # 鉴权靠它，不是 Cookie
X-Forwarded-For: <随机国内 IP>             # 多个账号同 IP 提交会被判异常
```

> 浏览器的 `fetch` 会把 `Origin`/`Referer`/`Sec-*` 当禁止头静默丢掉，
> 所以电脑端用 `node:https`（`src/http.ts`）直接发原始请求；**App 里也必须走原生**
> （Java 的 `HttpURLConnection`），原因见 [app-android/README.md](app-android/README.md)。

| 用途 | 接口 | 关键返回 |
|---|---|---|
| 登录 | `/UserApi/login` `{email, password, remember:"1", source_type:1}` | `data.token` |
| 我的课程（学生） | `/courseApi/simpleLists`（**小写 c**） | `data.lists[]` |
| 我的课程（教师） | `/CourseApi/semesterCourseList` | `data[]` |
| 未完成签到 | `/AttenceApi/getNotFinishAttenceStudent` `{courseid}` | `data.lists[].type` |
| 创建二维码考勤 | `/AttenceApi/addNowsAttance` `{courseid, title}` | `data.attenceid`，type=3 |
| 创建定位考勤 | `/AttenceApi/addGPSAttence` `{courseid, title}` | `data.attenceid`，type=2 |
| 取二维码票据 | `/AttenceApi/getQrCode` `{attenceid}` | `data.mobileCheckInUrl`（**教师权限**） |
| **扫码签到** | `/AttenceApi/AttenceResult` `{ticketid, expire, sign}` | `data.state == 8` |
| **定位签到** | `/AttenceApi/checkin` `{id, latitude, longitude, accuracy:"30", clienttype:1}` | `data.state == 1` |
| 数字码签到 | `/AttenceApi/getDigitAttence` → `/AttenceApi/checkin` | `data.state == 1` |

二维码 URL 长这样：

```
https://w.ketangpai.com/checkIn/checkinCodeResult
  ?type=2&ticketid=<ticketid>
  &expire=1791970516
  &sign=<sign>
  &courseid=<courseid>&randNum=DWDY4MPB
```

真正参与校验的只有 `ticketid`、`expire`、`sign`；`randNum` 只是防重复的随机数。
`sign` 是服务端用类似 HMAC-SHA1 的算法对有效期签的名，**无法自己伪造**，
所以「凭空造一个二维码」这条路是死的。

---

## 五、二维码识别不出来怎么办

App 里是五级兜底（小的、远的、拍屏幕的照片都能认）：

| 顺序 | 手段 |
|---|---|
| ① | **zxing-cpp**（NDK 编译进 App）+ `FixedThreshold`，只处理取景框那一块 |
| ② | ZXing Java（原生库） |
| ③ | zxing-cpp + `LocalAverage`（每 4 帧一次） |
| ④ | ZXing 放大救援 |
| ⑤ | ML Kit（异步） |

> 说实话 ⑤ 从来没成功过（处理了 266 帧，0 命中），它只是留着当保险，还占 12 MB。
> 真正管用的是 ①②。

> 为什么自己编译 zxing-cpp：实测 ZXing Java **在 120 种预处理组合下全部失败**
> （缩放 1–5 倍 × 拉平/锐化/Otsu/中值 × 白边，两种二值化器都试了），
> 而 zxing-cpp 在原生分辨率 + `FixedThreshold` 下直接成功。细节见
> [app-android/README.md](app-android/README.md) 第十五节。

电脑端的 `decode` 是三级流水线：jsQR（最快）→ OpenCV → zxing-cpp（最鲁棒）。
每个引擎会依次尝试多种预处理：原图 → 缩小到 1600px → 放大 2x → Otsu →
自适应二值化 → 中值滤波去摩尔纹 → CLAHE。

**还是识别不出来时，按这个顺序退：**

1. 让朋友**直接把二维码里的 URL 文字**发你（微信扫完能长按复制），粘到「手动签到」的框里 —— 最稳
2. 让朋友发**原图**（微信发「原图」，不要被压缩过的缩略图）
3. 用「摄像头扫描」对着屏幕直接扫，比拍照再传更可靠

> 坑记录：**不要把二维码裁得太紧** —— 四周必须有至少 4 个模块宽的空白（quiet zone），
> 裁掉之后所有引擎都会失效。

---

## 六、IP 伪造（为什么需要）

教师端的考勤表里有一列 **IP**。如果 5 个账号都报同一个 IP，等于自己举报自己。

所以 App 会给每个账号分配一个**固定假 IP**（`X-Forwarded-For`），三种模式：

| 模式 | 说明 |
|---|---|
| 每个账号各自一个固定 IP（默认） | 首次分配后不再变，像各自的住处 |
| 所有账号共用同一个 IP | 适合「就是在一个宿舍里签的」这种说法 |
| 不伪造，用手机真实 IP | 调试用 |

> 踩过的坑：IP 必须凑够 **4 段**（`203.0.113.7` ✅，`223.104.` ❌）。
> 少了段数会被服务端记成 `0.0.0.0`，或者被我们的校验拦掉而**根本没发送** ——
> 后者更糟：服务端会记下你手机的真实出口 IP，五个账号全一样。

---

## 七、目录结构

```
app-android/            Android App（主要形态）
  app/src/main/java/com/ktp/scanner/
    MainActivity.java   界面 + JS Bridge
    ScanActivity.java   原生扫码（zxing-cpp + ZXing + ML Kit 五级兜底）
    ViewfinderView.java 取景框（微信样式，支持捏合变焦）
    KtpApi.java         课堂派 HTTP（原生，能设 Origin/Referer）
    MonitorService.java 前台服务：轮询签到 + 通知
    CheckinHelper.java  定位签到提交
    LocationStore.java  位置库（像"添加成员"那样存多个位置）
    CoordStore.java     定位方式（高德 GCJ-02 / 本机 GPS WGS-84）
    Coord.java          坐标系转换（有单元测试）
    IpUtil.java         假 IP 生成/校验
  app/src/main/assets/www/   界面（HTML/CSS/JS）
  app/src/main/jniLibs/      libktpzxing.so（自己编译的 zxing-cpp）

src/                    电脑端
  http.ts        node:https 裸请求（为了能发 Origin/Referer/Sec-*）
  client.ts      课堂派接口封装
  qr.ts          二维码 URL / JSON 解析
  qrdecode.ts    图片解码（jsQR → OpenCV / zxing-cpp 兜底）
  cli.ts         命令行
  server.ts      本地 Web 服务
public/          Web 控制台前端

tools/           开发/逆向过程留档
  exp-*.ts                   接口实验（含定位签到那几组）
  coord-test/                坐标系转换单元测试（不用手机就能跑）
  ui-preview/                界面布局预览 + 交互验证（不用装机就能测按钮）
  zxing-cpp-build/           zxing-cpp 的 NDK 编译工程
  icon/                      图标生成
dist/            打包好的 APK
```

---

## 八、自己重新打包

```powershell
$env:ANDROID_HOME = 'D:\Android\Sdk'
$env:JAVA_HOME    = '<JDK 17 的路径>'      # 必须是 17，系统 java 若是 23 会失败
cd app-android
.\gradlew.bat assembleDebug --console=plain --no-daemon
.\gradlew.bat --stop                        # 收尾，免得留着守护进程
```

环境：AGP 8.13.0 / Gradle 8.14.3 / JDK 17 / NDK 27.1 / CMake 3.31。

---

## 九、风险与说明

- 这套东西绕过的正是课堂派**故意设计**的防代签机制（二维码短时效 + 教师签名 +
  IP 聚集检测 + 定位校验），被判定为代签可能导致**课程考勤记 0 分、账号封禁、
  乃至学校纪律处分**。请自行权衡。
- 服务端随时可能改接口。实现基于 2026 年的 `openapiv5` 实测，
  协议变化时先跑 `node src/cli.ts whoami` 看鉴权是否还通。
- `config.local.json` 与 `.cache/tokens.json` 里是明文账号/token，**不要提交到 git**
  （已在 `.gitignore`）。
- 联调脚本会在课程里创建并删除考勤记录。请在**自己的测试课程**里跑，别在真实课程里试。
- App 里的账号密码只存在本机 `SharedPreferences`，没有任何上传行为。
