/**
 * 用假数据把 App 的界面渲染出来，配合无头 Chrome：
 *   --screenshot  肉眼看布局
 *   --dump-dom    读取真实尺寸（写进 <pre id="DIAG">，不靠肉眼估）
 *
 * 关键：App 里对原生 bridge 的调用是同步的，所以 app.js 一执行完界面就已经渲染好了，
 * 诊断脚本可以直接同步跑，不需要等 setTimeout（--dump-dom 等不到定时器）。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const SRC = path.join(ROOT, "app-android", "app", "src", "main", "assets", "www");
const OUT = path.join(ROOT, "tools", "ui-preview", "www");

fs.mkdirSync(OUT, { recursive: true });

// 预览用的就是真实文件，避免"预览和实际不一致"
for (const f of ["style.css", "app.js"]) {
  fs.copyFileSync(path.join(SRC, f), path.join(OUT, f));
}

// 故意用长短不一的账号名，专门暴露"名字太长把行撑歪"
const ACCOUNTS = [
  { key: "a", name: "小明", school: "示例大学", ip: "203.0.113.11" },
  { key: "b", name: "小红", school: "示例大学", ip: "203.0.113.12" },
  { key: "c", name: "张三", school: "示例大学", ip: "203.0.113.13" },
  { key: "d", name: "李四", school: "示例大学", ip: "203.0.113.14" },
  { key: "e", name: "一个特别长的名字测试换行", school: "某某某大学某某学院", ip: "203.0.113.15" },
];

const MOCK = `
<script>
  const ACCOUNTS = ${JSON.stringify(ACCOUNTS)};
  window.Android = {
    listAccounts: () => JSON.stringify(ACCOUNTS),
    getSettings: () => JSON.stringify({ mode: "perAccount", sharedIp: "", accounts: ACCOUNTS }),
    setIpMode: () => '{"ok":true}',
    rerollIps: () => '{"ok":true}',
    removeAccount: () => '{"ok":true}',
    addAccount: () => '{"ok":true,"name":"测试","school":"测试大学"}',
    startScan: () => {},
    getMonitor: () => JSON.stringify({
      ok: true,
      primary: "a",
      running: true,
      status: "发现正在签到：软件工程；示例课程",
      lastCheckAt: Date.now(),
      notifGranted: true,
      pollMs: 10000,
      roomLat: "39.904200",
      roomLng: "116.407400",
      locationGranted: true,
      pending: [
        { course: "软件工程", id: "att1", type: "2", title: "2026.10.14" },
        { course: "大学英语（名字很长很长很长很长）", id: "att2", type: "3", title: "2026.10.14" },
      ],
    }),
    setPrimary: () => '{"ok":true}',
    setPollSeconds: () => '{"ok":true}',
    setRoomLocation: () => '{"ok":true}',
    readCurrentLocation: () => JSON.stringify({ ok: true, lat: "39.904200", lng: "116.407400", accuracy: 12, ageSec: 2, provider: "gps", mock: false, cached: false }),
    startLocating: () => JSON.stringify({ ok: true, providers: "gps network", gpsOn: true }),
    stopLocatingNow: () => '{"ok":true}',
    signLocationNow: () => JSON.stringify({ ok: true, state: 1, message: "签到成功", lat: "39.904200", lng: "116.407400" }),
    startMonitor: () => '{"ok":true}',
    stopMonitor: () => '{"ok":true}',
    submitQr: (keys, tid, exp) => JSON.stringify({
      okCount: 4,
      results: [
        { key: "a", label: "小明", ok: true, ip: "203.0.113.11" },
        { key: "b", label: "小红", ok: true, ip: "203.0.113.12" },
        { key: "c", label: "张三", ok: true, ip: "203.0.113.13" },
        { key: "d", label: "李四", ok: true, ip: "203.0.113.14" },
        { key: "e", label: "一个特别长的名字测试换行", ok: false, ip: "203.0.113.15", message: "重复签到" },
      ],
    }),
  };
<\/script>
`;

// 同步运行：先触发一次"扫码成功"把结果区渲染出来，再量尺寸
const DIAG = `
<script>
  (function () {
    if (window.onScanResult) {
      window.onScanResult(
        "https://w.ketangpai.com/checkIn/checkinCodeResult?type=2&ticketid=DEMO&expire=" +
          (Math.floor(Date.now() / 1000) + 300) + "&sign=abcdef"
      );
    }
    var de = document.documentElement;
    var rows = Array.prototype.slice.call(document.querySelectorAll("#accounts .acc"));
    var widest = { right: 0, sel: "" };
    document.querySelectorAll("*").forEach(function (el) {
      var b = el.getBoundingClientRect();
      if (b.right > widest.right) {
        widest = { right: Math.round(b.right), sel: el.tagName + "." + (el.className || "") };
      }
    });
    var out = {
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      dpr: window.devicePixelRatio,
      docScrollWidth: de.scrollWidth,
      overflowPx: de.scrollWidth - window.innerWidth,
      accountsTotalH: Math.round(document.getElementById("accounts").getBoundingClientRect().height),
      docHeight: de.scrollHeight,
      widest: widest,
      rows: rows.map(function (r) {
        var nm = r.querySelector(".nm"), ip = r.querySelector(".ip"), who = r.querySelector(".who");
        var cs = getComputedStyle(nm);
        var rr = r.getBoundingClientRect();
        return {
          name: nm.textContent.slice(0, 8),
          cardH: Math.round(rr.height), cardW: Math.round(rr.width), cardRight: Math.round(rr.right),
          whoW: Math.round(who.getBoundingClientRect().width),
          nmClientW: nm.clientWidth, nmScrollW: nm.scrollWidth,
          css: cs.textOverflow + "/" + cs.overflow,
          ipW: Math.round(ip.getBoundingClientRect().width),
          ipRight: Math.round(ip.getBoundingClientRect().right)
        };
      })
    };
    var pre = document.createElement("pre");
    pre.id = "DIAG";
    pre.textContent = "DIAGSTART" + JSON.stringify(out) + "DIAGEND";
    pre.style.cssText = "position:fixed;left:-9999px;top:0";
    document.body.appendChild(pre);

    // 用图片信标把数据发到本地诊断服务（不依赖 chrome 的 stdout）
    new Image().src = "http://127.0.0.1:8899/diag?d=" + encodeURIComponent(JSON.stringify(out));
  })();
<\/script>
`;

const html = fs.readFileSync(path.join(SRC, "index.html"), "utf8");
const withMock = html
  .replace('<script src="app.js"></script>', `${MOCK}\n    <script src="app.js"></script>`)
  .replace("</body>", `${DIAG}\n  </body>`);

if (withMock.indexOf("window.Android") < 0) {
  console.error('注入失败：没找到 <script src="app.js"></script>');
  process.exit(1);
}
fs.writeFileSync(path.join(OUT, "index.html"), withMock, "utf8");

// 再用一个 iframe 把宽度锁死在 360px（Chrome 的 --window-size 在这台机器上不生效），
// 专门验证"最窄的手机"下会不会溢出 / 换行。
const FRAME = `<!doctype html>
<html><head><meta charset="utf-8"><title>layout check</title>
<style>html,body{margin:0;background:#222}iframe{width:360px;height:820px;border:0;display:block}</style>
</head><body>
<iframe id="f" src="index.html"></iframe>
<script>
  document.getElementById("f").addEventListener("load", function () {
    var d = document.getElementById("f").contentDocument;
    var w = document.getElementById("f").contentWindow;
    var rows = Array.prototype.slice.call(d.querySelectorAll("#accounts .acc"));
    var out = {
      frameWidth: 360,
      innerWidth: w.innerWidth,
      docScrollWidth: d.documentElement.scrollWidth,
      overflowPx: d.documentElement.scrollWidth - w.innerWidth,
      accountsTotalH: Math.round(d.getElementById("accounts").getBoundingClientRect().height),
      rows: rows.map(function (r) {
        var nm = r.querySelector(".nm"), ip = r.querySelector(".ip");
        var nmcs = getComputedStyle(nm);
        var rr = r.getBoundingClientRect();
        return {
          h: Math.round(rr.height),
          right: Math.round(rr.right),
          nmClient: nm.clientWidth, nmScroll: nm.scrollWidth,
          clipped: nm.scrollWidth > nm.clientWidth,
          ipRight: Math.round(ip.getBoundingClientRect().right),
          ipLeft: Math.round(ip.getBoundingClientRect().left),
          ipW: Math.round(ip.getBoundingClientRect().width),
          wrap: nm.getClientRects().length
        };
      })
    };
    new Image().src = "http://127.0.0.1:8899/diag?d=" + encodeURIComponent(JSON.stringify(out));

    // 滚到「签到提醒」卡片，方便截图看它的布局
    if (window.location.hash === "#monitor") {
      var card = d.querySelectorAll(".card")[1];
      if (card) w.scrollTo(0, card.getBoundingClientRect().top + w.scrollY - 60);
    } else {
      w.scrollTo(0, 0);
    }
  });
<\/script>
</body></html>`;
fs.writeFileSync(path.join(OUT, "frame.html"), FRAME, "utf8");

console.log(`预览页已生成: ${path.join(OUT, "index.html")}`);
console.log(`窄屏检查页: ${path.join(OUT, "frame.html")}`);
