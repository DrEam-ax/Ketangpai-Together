# 课堂派远程扫码签到

一句话原理：**课堂派的签到二维码，一份票据可以给任意多个账号签到；但学生查不到这份票据，必须有二维码来源。**

所以整个系统就两件事：

1. **拿到二维码**（谁在教室／谁有教师权限 → 把 `ticketid / expire / sign` 交给你）
2. **用你自己的 token 提交**（`AttenceApi/AttenceResult`，成功返回 `data.state == 8`）

第 2 步已经 100% 跑通，第 1 步取决于你能拿到什么二维码。

---

## 两个形态

| | 手机 App（现场扫码用） | 电脑端（协议实现 / 调试） |
|---|---|---|
| 目录 | [`app-android/`](app-android/) | `src/` + `public/` |
| 安装包 | [`dist/ktp-signin-0.2.2.apk`](dist/) | 无（`npm run web` 起本地服务） |
| 能力 | 多账号 + 全屏原生扫码（微信扫一扫样式、可捏合变焦）+ **扫一次批量签到** | 图像识别最强（jsQR+OpenCV+zxing-cpp）、实时状态、轮询监听 |
| 依赖 | 独立，不需要电脑 | 需要电脑 / Node |

**最常用的是 App**：装到教室里那个人的手机上，他对着大屏扫一次，所有勾选的账号一起签掉。
细节见 [app-android/README.md](app-android/README.md)。

> ⚠️ 本项目会绕过课堂派**故意设计**的防代签机制。被判定代签可能导致考勤记 0 分、封号乃至学校处分，自行权衡。

---

## 一、实测结论（2026 版接口，全部亲测）

| 问题 | 结论 |
|---|---|
| 学生能不能不用二维码直接签到？ | ❌ 不能。必须带 `ticketid/expire/sign` |
| 学生能不能自己调接口拿到二维码？ | ❌ 不能，`getQrCode` 返回 `30202 你没有权限访问该班级的信息`（教师权限） |
| 老师发的二维码，学生用自己账号提交行不行？ | ✅ 行。**一份票据签所有账号**，票据跟学生身份无关 |
| 二维码有效期多久？ | ✅ **300 秒**（`expire = 签发时刻 + 300`）。比 2024 年那个教程里的 ~17 秒宽松得多 |
| 签发了新二维码后，旧二维码还有效吗？ | ✅ **仍然有效**。所以「朋友拍张照片发你」这条路完全可行，不用抢那几秒 |
| 过期的二维码还能签吗？ | ❌ 不能，服务端会返回 `此签到二维码已过期失效` |
| 怎么知道哪门课正在二维码签到？ | ✅ 轮询 `AttenceApi/getNotFinishAttenceStudent`，出现 `type=3` 就是 |
| 签到类型 | `1`=数字码 `2`=定位 `3`=二维码 `4`=签到签出 |

**一句话：你需要的只是一个 5 分钟内拍到的二维码照片。**

---

## 二、快速开始

```bash
npm install          # 只有 jsqr + jimp 两个纯 JS 依赖
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

> 其他依赖：解码兜底用 `python` + `opencv`（本机已装 cv2 4.12），再叠加 `zxing-cpp`
> （`python -m pip install zxing-cpp`，强烈建议装，拍屏幕的照片基本靠它）。
> 都没有也能跑，只是照片识别率会明显下降（只剩纯 jsQR）。

---

## 三、Web 控制台（推荐日常用）

```bash
npm run web            # http://127.0.0.1:8787
```

三个页签：

- **实时状态** —— 自动扫你所有课程，哪个课正在签到、是不是二维码签到，一眼看到
- **摄像头扫描** —— 摄像头对着二维码／大屏幕，逐帧识别，**识别到就自动提交**，不用手点。
  适合「旧手机架在教室里一直扫」的用法
- **手动签到** —— 朋友发来的二维码照片，直接 **Ctrl+V 粘贴** 到页面上就自动解码并签到；
  也可以粘贴二维码 URL 或选择图片文件

> 注意：浏览器的摄像头权限只在 `localhost` 或 HTTPS 下可用。
> 所以想让**手机**当扫描器，现在得靠打包成 App（见第六节），
> 或者用 `--host 0.0.0.0` 后在手机浏览器里手动上传照片。

---

## 四、命令行

```bash
node src/cli.ts courses                 # 我的课程（学生号实测 28 门）
node src/cli.ts status                  # 扫所有课程，列出未完成的签到
node src/cli.ts watch --interval 3      # 轮询监听，出现二维码考勤立刻提示
node src/cli.ts qr --url "<二维码URL>"   # 直接提交签到
node src/cli.ts decode shot.png --submit  # 从照片/截图解二维码并签到
node src/cli.ts whoami                  # 当前身份
```

`decode` 是最常用的一条：朋友微信发你一张照片 → 存下来 → 一条命令签到。

```
$ node src/cli.ts decode shot.png --submit
解码耗时 210ms，引擎：jsQR
解析出票据：ticketid=FAKEid0001  剩余 287 秒
恭喜您签到成功！班级名称：示例课程 考勤名称：…
```

---

## 五、协议速查

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

> 注意：浏览器的 `fetch` 会把 `Origin`/`Referer`/`Sec-*` 当禁止头静默丢掉，
> 所以本项目在 Node 侧直接用 `node:https`（`src/http.ts`）发送原始请求头。

| 用途 | 接口 | 关键返回 |
|---|---|---|
| 登录 | `/UserApi/login` `{email, password, remember:"1", source_type:1}` | `data.token` |
| 我的课程（学生） | `/courseApi/simpleLists`（**小写 c**） | `data.lists[]` |
| 我的课程（教师） | `/CourseApi/semesterCourseList` | `data[]` |
| 未完成签到 | `/AttenceApi/getNotFinishAttenceStudent` `{courseid}` | `data.lists[].type` |
| 创建二维码考勤 | `/AttenceApi/addNowsAttance` `{courseid, title}` | `data.attenceid`，type=3 |
| 取二维码票据 | `/AttenceApi/getQrCode` `{attenceid}` | `data.mobileCheckInUrl`（**教师权限**） |
| **扫码签到** | `/AttenceApi/AttenceResult` `{ticketid, expire, sign}` | `data.state == 8` |
| 数字码签到 | `/AttenceApi/getDigitAttence` → `/AttenceApi/checkin` | `data.state == 1` |

二维码 URL 长这样（就是你截图里那个）：

```
https://w.ketangpai.com/checkIn/checkinCodeResult
  ?type=2&ticketid=FAKEid0001
  &expire=1791970516
  &sign=0000000000000000000000000000000000000000
  &courseid=...&randNum=DWDY4MPB
```

真正参与校验的只有 `ticketid`、`expire`、`sign`；`randNum` 只是防重复的随机数。
`sign` 是服务端用类似 HMAC-SHA1 的算法对有效期签的名，**无法自己伪造**，
所以「凭空造一个二维码」这条路是死的。

---

## 六、二维码识别不出来怎么办

`decode` / 上传图片走的是三级流水线，按「先快后准」：

| 引擎 | 特点 |
|---|---|
| **jsQR**（纯 JS） | 最快（~100ms），逐帧摄像头扫描用它 |
| **OpenCV** `QRCodeDetector` | 中等 |
| **zxing-cpp** | 最鲁棒，拍屏幕/斜角/低对比度基本靠它 |

每个引擎会依次尝试多种预处理：原图 → 缩小到 1600px（`INTER_AREA`）→ 放大 2x →
Otsu 二值化 → 自适应二值化 → 中值滤波去摩尔纹 → CLAHE。

实测：一张 2228×1220 的桌面截图（里面嵌着二维码），命中的是 **`Otsu` + `zxing-cpp`**，耗时约 1 秒。

踩过的两个坑，留个记录：

1. **不要把二维码裁得太紧。** 二维码四周必须有至少 4 个模块宽的空白（quiet zone），
   裁掉之后所有引擎都会失效 —— 我自己就是这么误判了一次。
   如果非要裁，记得留白边。
2. **Node 异步 `child_process.execFile` 没有 `input` 选项。**
   传了会被静默忽略，Python 端 `sys.stdin.buffer.read()` 就会一直阻塞到超时
   （表现为「上传一张图卡 30 秒然后失败」）。必须改用 `spawn` 手动
   `child.stdin.write(buf)` 再 `child.stdin.end()`。

还是识别不出来时，按这个顺序退：

1. 让朋友**直接把二维码里的 URL 文字**发你（微信扫完能长按复制），粘到「手动签到」的框里 —— 最稳
2. 让朋友发**原图**（微信发「原图」，不要被压缩过的缩略图）
3. 用「摄像头扫描」对着屏幕直接扫，比拍照再传更可靠

---

## 七、打包成手机 App 的路线

现在的代码已经是照着这个目标写的：

- 核心逻辑（`src/client.ts` / `src/qr.ts` / `src/http.ts`）零 Node 专有依赖，
  换成 `fetch` + Capacitor 的 `CapacitorHttp`（原生 HTTP，能自定义 Origin/Referer 等禁止头，也没有 CORS 问题）即可复用
- `decodeQrFromRgba()` 是纯函数，浏览器里直接喂 canvas 的 `ImageData` 就能用，
  配合 `getUserMedia` 或 Capacitor 的 barcode-scanner 插件就是原生扫码
- `src/server.ts` 里的接口划分可以直接照搬成 App 的内部逻辑

建议：**Capacitor**（复用这份 TS + HTML/JS，一套代码出安卓/iOS），
比 Flutter/Kivy 省一遍重写。

App 相比网页版多出来的能力：

- 原生相机常驻扫码（不受 HTTPS 限制）
- 后台轮询未完成签到 + 本地通知（"XX 课正在二维码签到"）
- 多账号保存

---

## 七、目录结构

```
src/
  http.ts        node:https 裸请求（为了能发 Origin/Referer/Sec-*）
  constants.ts   请求头、签到类型、成功状态码
  util.ts        reqtimestamp、FakeIp（X-Forwarded-For 伪造）、日志工具
  client.ts      课堂派接口封装
  qr.ts          二维码 URL / JSON 解析
  qrdecode.ts    图片解码（jsQR → OpenCV / zxing-cpp 兜底，多尺度 + 多种二值化）
  cli.ts         命令行
  server.ts      本地 Web 服务
public/          Web 控制台前端
tools/
  exp-*.mjs                  联调实验脚本（逆向过程留档）
  test-web-flow.mjs          端到端集成测试
  decode_qr.py               OpenCV 解码（支持 stdin 逐帧）
  make_qr.py                 生成测试二维码
  dump-api-paths.mjs         从 H5 bundle 里扒接口清单
  search-bundles.mjs         在 bundle 里搜上下文
captures/web/api-paths.txt   从课堂派前端扒出来的 203 个接口
```

---

## 八、风险与说明

- 这套东西绕过的正是课堂派**故意设计**的防代签机制（二维码短时效 + 教师签名 + IP 聚集检测），
  被判定为代签可能导致**课程考勤记 0 分、账号封禁、乃至学校纪律处分**。请自行权衡。
- 服务端随时可能改接口。这份实现基于 2026 年的 `openapiv5` 实测，
  协议变化时先跑 `node src/cli.ts whoami` 看鉴权是否还通。
- `config.local.json` 与 `.cache/tokens.json` 里是明文账号/token，**不要提交到 git**（已在 `.gitignore`）。
- 联调脚本会在课程里创建并删除考勤记录。请在**自己的测试课程**里跑，别在真实课程里试。
