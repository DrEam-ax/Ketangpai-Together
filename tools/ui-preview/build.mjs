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

// 故意用长短不一的账号名，专门暴露"名字太长把行撑歪"。
// ⚠️ 这里必须是**编造的**假数据 —— 预览会截图，截图会进 issue/聊天，别把真实账号写进来。
// IP 用 RFC 5737 的文档保留段（203.0.113.x / 198.51.100.x），一看就知道是假的。
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
  // 位置库的假数据（有状态）
  var LOCS = [
    { name: "二教305", lat: "39.904200", lng: "116.407400" },
    { name: "宿舍", lat: "39.910000", lng: "116.420000" },
    { name: "一个特别长的位置名字测试", lat: "39.908700", lng: "116.397500" },
  ];
  var ACTIVE = "二教305";
  var COORD = "gcj";
  window.Android = {
    listAccounts: () => JSON.stringify(ACCOUNTS),
    getSettings: () => JSON.stringify({ mode: "perAccount", sharedIp: "", accounts: ACCOUNTS, coordMode: COORD }),
    setIpMode: () => '{"ok":true}',
    rerollIps: () => '{"ok":true}',
    removeAccount: () => '{"ok":true}',
    addAccount: () => '{"ok":true,"name":"测试","school":"测试大学"}',
    startScan: () => {},
    getMonitor: () => JSON.stringify({
      ok: true,
      primary: "a",
      running: true,
      status: "发现正在签到：高等数学；大学英语",
      lastCheckAt: Date.now(),
      notifGranted: true,
      pollMs: 10000,
      roomLat: "39.904200",
      roomLng: "116.407400",
      locationGranted: true,
      pending: [
        { course: "高等数学", id: "att1", type: "2", title: "2026.10.14" },
        { course: "大学英语（名字很长很长很长很长）", id: "att2", type: "3", title: "2026.10.14" },
      ],
    }),
    setPrimary: () => '{"ok":true}',
    setPollSeconds: () => '{"ok":true}',
    setRoomLocation: () => '{"ok":true}',
    // 位置库做**有状态**的假实现 —— 这样交互验证（#loctest）才有意义：
    // 选中/新建/回填/删除之后，listLocations 会返回更新后的数据。
    listLocations: () => JSON.stringify({ ok: true, active: ACTIVE, locations: LOCS }),
    addLocation: (n, la, ln) => {
      if (LOCS.some((x) => x.name === n)) return '{"ok":false,"error":"已经有叫「' + n + '」的位置了"}';
      LOCS.push({ name: n, lat: la, lng: ln });
      ACTIVE = n;
      return '{"ok":true}';
    },
    refillLocation: (n, la, ln) => {
      const o = LOCS.find((x) => x.name === n);
      if (!o) return '{"ok":false,"error":"找不到位置"}';
      o.lat = la;
      o.lng = ln;
      ACTIVE = n;
      return '{"ok":true}';
    },
    removeLocation: (n) => {
      LOCS = LOCS.filter((x) => x.name !== n);
      if (ACTIVE === n) ACTIVE = "";
      return '{"ok":true}';
    },
    useLocation: (n) => {
      ACTIVE = n;
      return '{"ok":true}';
    },
    readCurrentLocation: () => JSON.stringify({ ok: true, lat: "39.904200", lng: "116.407400", latGcj: "39.907500", lngGcj: "116.413500", offsetMeters: 465, latPick: COORD === "wgs" ? "39.904200" : "39.907500", lngPick: COORD === "wgs" ? "116.407400" : "116.413500", coordMode: COORD, accuracy: 12, ageSec: 2, provider: "gps", mock: false, cached: false }),
    setCoordMode: (m) => { COORD = m; return '{"ok":true}'; },
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

  // 记录所有 bridge 调用 —— 用来验证"点某个按钮到底有没有调到原生方法"，
  // 这比肉眼看界面可靠（比如 × 删除点了没反应，到底是没调、还是原生那边没删掉）。
  window.__calls = [];
  const raw = window.Android;
  window.Android = {};
  for (const k of Object.keys(raw)) {
    window.Android[k] = function () {
      window.__calls.push(k + "(" + Array.prototype.join.call(arguments, ",") + ")");
      return raw[k].apply(null, arguments);
    };
  }
  // 预览里 confirm 一律返回 true（真机上这是 WebChromeClient 的事，见 MainActivity）
  window.confirm = function (m) {
    window.__calls.push("confirm(" + m + ")");
    return true;
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

    // ==== 交互验证：hash 为 #deltest 时模拟点「位置 ×」「切换生效位置」「成员 ×」，
    //      再把这些 bridge 调用一起上报 —— 用来证明按钮确实调到了原生方法。

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
<iframe id="f"></iframe>
<script>
  // 把外层的 hash 传给 iframe 的 src —— DIAG 脚本在 iframe 内部跑，
  // 它读的是 iframe 自己的 location.hash，拿不到外层的。
  (function () {
    var f = document.getElementById("f");
    f.src = "index.html" + (window.location.hash || "");
  })();
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

    // ==== 交互验证（#deltest）：真的去点那些按钮，再看 bridge 调用记录。
    //      比肉眼看界面可靠 —— 能区分"按钮没绑上事件"和"绑上了但原生没删掉"。
    if (window.location.hash === "#deltest") {
      var tg = d.querySelector('#tabbar .tab[data-tab="gps"]');
      if (tg) tg.click();
      var lb = d.getElementById("locbox");
      if (lb) lb.open = true;
      var delLoc = d.querySelectorAll("#locations button[data-del]");
      out.delButtons = delLoc.length;
      if (delLoc.length) delLoc[0].click();
      var useLoc = d.querySelectorAll("#locations input[data-use]");
      if (useLoc.length > 1) {
        useLoc[1].checked = true;
        useLoc[1].dispatchEvent(new Event("change"));
      }
      var ts = d.querySelector('#tabbar .tab[data-tab="settings"]');
      if (ts) ts.click();
      var delAcc = d.querySelectorAll("#accounts button[data-x]");
      if (delAcc.length) delAcc[0].click();
      out.calls = w.__calls || [];
    }

    // ==== 交互验证（#loctest）：验证这次改的三条行为
    //   1) 点行内任意位置（不是 radio）也能选中
    //   2) 选中后经纬度输入框被自动填入
    //   3) 「新建」建新位置、「回填」改当前选中位置的坐标
    if (window.location.hash === "#loctest") {
      var tg2 = d.querySelector('#tabbar .tab[data-tab="gps"]');
      if (tg2) tg2.click();
      var lb2 = d.getElementById("locbox");
      if (lb2) lb2.open = true;

      // ① 点第 2 行的文字区域（不是 radio）
      var rows = d.querySelectorAll("#locations .acc");
      out.rows = rows.length;
      var picked = null;
      if (rows.length > 1) {
        var target = rows[1].querySelector(".nm").textContent;
        rows[1].querySelector(".who").click();
        picked = target;
      }
      out.pickedByName = picked;
      out.activeAfterClick = d.querySelector("#locations input[data-use]:checked")
        ? d.querySelector("#locations input[data-use]:checked").dataset.use
        : "";
      out.latInput = d.getElementById("loc-lat").value;
      out.lngInput = d.getElementById("loc-lng").value;

      // ② 新建：填名字 + 坐标，点「新建」
      d.getElementById("loc-name").value = "三教101";
      d.getElementById("loc-lat").value = "39.990000";
      d.getElementById("loc-lng").value = "116.410000";
      d.getElementById("loc-new").click();
      out.afterNew = d.querySelectorAll("#locations .acc").length;
      out.activeAfterNew = d.querySelector("#locations input[data-use]:checked")
        ? d.querySelector("#locations input[data-use]:checked").dataset.use
        : "";

      // ③ 回填：改输入框的坐标，点「回填」，看列表里那条的坐标有没有变
      d.getElementById("loc-lat").value = "39.111111";
      d.getElementById("loc-lng").value = "116.222222";
      d.getElementById("loc-fill").click();
      var back = JSON.parse(w.Android.listLocations());
      var hit = (back.locations || []).filter(function (x) {
        return x.lat === "39.111111" && x.lng === "116.222222";
      });
      out.refilledName = hit.length ? hit[0].name : "";
      out.calls = w.__calls || [];
    }

    // ==== 交互验证（#coordtest）：定位方式这个链路
    //   设置里改成「本机 GPS」-> 读当前位置 -> 输入框应是 WGS 那组
    //   再改回「高德」-> 立刻重填成 GCJ 那组（不用重新定位）
    if (window.location.hash === "#coordtest") {
      d.querySelector('#tabbar .tab[data-tab="settings"]').click();
      var cm = d.getElementById("coordmode");
      cm.value = "wgs";
      cm.dispatchEvent(new Event("change"));
      out.badgeAfterWgs = d.getElementById("coord-badge").textContent;

      d.querySelector('#tabbar .tab[data-tab="gps"]').click();
      var lb3 = d.getElementById("locbox");
      if (lb3) lb3.open = true;
      d.getElementById("loc-here").click(); // 异步，要等它跑完

      window.setTimeout(function () {
        out.latAfterWgs = d.getElementById("loc-lat").value;
        out.lngAfterWgs = d.getElementById("loc-lng").value;

        d.querySelector('#tabbar .tab[data-tab="settings"]').click();
        cm.value = "gcj";
        cm.dispatchEvent(new Event("change"));
        out.latAfterSwitchBack = d.getElementById("loc-lat").value;
        out.lngAfterSwitchBack = d.getElementById("loc-lng").value;
        out.calls = w.__calls || [];
        sendDiag();
      }, 2500);
      return;
    }

    sendDiag();

    function sendDiag() {
      new Image().src =
        "http://127.0.0.1:8899/diag?d=" + encodeURIComponent(JSON.stringify(out));
    }

    // 看哪一栏 / 哪张卡：frame.html#scan / #gps / #settings / #location / #monitor
    // 注意：App 是从 localStorage 恢复栏位的（不看 hash），所以这里直接**点那个标签**。
    var hash = window.location.hash.replace("#", "");
    if (hash === "scan" || hash === "gps" || hash === "settings") {
      var t = d.querySelector('#tabbar .tab[data-tab="' + hash + '"]');
      if (t) t.click();
      w.scrollTo(0, 0);
    } else if (hash === "location" || hash === "monitor") {
      if (hash === "location") {
        d.querySelector('#tabbar .tab[data-tab="gps"]').click();
        var lb = d.getElementById("locbox");
        if (lb) lb.open = true;
      } else {
        d.querySelector('#tabbar .tab[data-tab="settings"]').click();
        var mb = d.getElementById("monbox");
        if (mb) mb.open = true;
      }
      w.scrollTo(0, 0);
    } else {
      w.scrollTo(0, 0);
    }
  });
<\/script>
</body></html>`;
fs.writeFileSync(path.join(OUT, "frame.html"), FRAME, "utf8");

console.log(`预览页已生成: ${path.join(OUT, "index.html")}`);
console.log(`窄屏检查页: ${path.join(OUT, "frame.html")}`);
