/* 课堂派签到 App —— 前端逻辑（网络与扫码都走原生 Android bridge） */

const $ = (s) => document.querySelector(s);
const native = window.Android || null;

const state = {
  accounts: [],
  keys: new Set(),
  selectionReady: false,
  scanning: false,
  ipMode: "perAccount",
  sharedIp: "",
  /** 「点击检测」的序号：原生侧每跑完一次 +1 */
  oneShotSeq: 0,
};

/** 上一次「点击检测」的结果文案（null = 还没点过） */
let lastCheckStatus = "";

// ---------------------------------------------------------------- 日志

function log(msg, cls = "d") {
  const el = $("#log");
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  el.insertAdjacentHTML(
    "beforeend",
    `<div><span class="d">[${t}]</span> <span class="${cls}">${esc(msg)}</span></div>`,
  );
  el.scrollTop = el.scrollHeight;
}

function esc(s) {
  return String(s).replace(
    /[&<>"']/g,
    (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m],
  );
}

// ---------------------------------------------------------------- 账号

function loadAccounts() {
  if (!native) return;
  let list = [];
  try {
    list = JSON.parse(native.listAccounts());
  } catch {
    list = [];
  }
  state.accounts = list;

  // 只有「首次加载」才默认全选。
  // 之前写成 `if (state.keys.size === 0) 全选`，导致取消全选后集合一空就被立刻勾回来 —— 全选框形同失效。
  if (!state.selectionReady) {
    for (const a of list) state.keys.add(a.key);
    state.selectionReady = true;
  }
  // 剪掉已经被删掉的账号
  for (const k of [...state.keys]) if (!list.some((a) => a.key === k)) state.keys.delete(k);
  // 迁移导出的人选也要跟着账号列表走（删掉的成员不该还留在选中集合里）
  for (const k of [...exportPick]) if (!list.some((a) => a.key === k)) exportPick.delete(k);

  const box = $("#accounts");
  box.innerHTML = "";
  if (list.length === 0) {
    box.innerHTML = `<div class="empty">还没有账号 —— 展开下面「添加账号」加一个。</div>`;
  }
  for (const a of list) {
    const on = state.keys.has(a.key);
    const el = document.createElement("label");
    el.className = "acc" + (on ? " checked" : "");
    el.innerHTML =
      `<input type="checkbox" data-k="${esc(a.key)}" ${on ? "checked" : ""} />` +
      `<span class="who">` +
      `<span class="nm">${esc(a.name || a.key)}</span>` +
      `<span class="sub2">${esc(a.key)}${a.school ? " · " + esc(a.school) : ""}</span>` +
      `</span>` +
      `<span class="ip">${esc(ipLabel(a))}</span>` +
      `<button class="x" data-x="${esc(a.key)}" title="删除">×</button>`;
    box.appendChild(el);
  }

  box.querySelectorAll("input[type=checkbox]").forEach((cb) =>
    cb.addEventListener("change", () => {
      if (cb.checked) state.keys.add(cb.dataset.k);
      else state.keys.delete(cb.dataset.k);
      cb.closest(".acc").classList.toggle("checked", cb.checked);
      syncAllBox();
      count();
    }),
  );
  box.querySelectorAll("button[data-x]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const k = b.dataset.x;
      if (!confirm(`删除账号「${k}」？`)) return;
      native.removeAccount(k);
      state.keys.delete(k);
      loadAccounts();
      log(`已删除账号 ${k}`, "wa");
    }),
  );
  syncAllBox();
  count();
  renderExportPick();
}

/** 全选框跟随实际选择状态（全选 / 半选 / 未选）。 */
function syncAllBox() {
  const all = $("#all");
  if (!all) return;
  const total = state.accounts.length;
  const picked = state.keys.size;
  all.checked = total > 0 && picked === total;
  all.indeterminate = picked > 0 && picked < total;
}

function setAll(checked) {
  state.selectionReady = true;
  state.keys.clear();
  if (checked) for (const a of state.accounts) state.keys.add(a.key);
  for (const cb of document.querySelectorAll("#accounts input[type=checkbox]")) {
    cb.checked = checked;
    const card = cb.closest(".acc");
    if (card) card.classList.toggle("checked", checked);
  }
  syncAllBox();
  count();
}

function count() {
  $("#count").textContent = `已选 ${state.keys.size} / ${state.accounts.length}`;
  loadMonitor(); // 主成员下拉框跟着账号列表走
}

// ---------------------------------------------------------------- 签到提醒

/**
 * 刷新「签到提醒」卡片。
 *
 * 判断有没有课正在签到是原生侧做的（MonitorService），
 * 依据是 getNotFinishAttenceStudent —— 实测它只返回进行中的签到，
 * 建一个考勤立刻出现、overAttence 一结束立刻消失。
 */
function loadMonitor() {
  if (!native) return;
  let r;
  try {
    r = JSON.parse(native.getMonitor());
  } catch {
    return;
  }
  if (!r.ok) return;
  state.oneShotSeq = r.oneShotSeq || 0;

  const sel = $("#primary");
  const cur = r.primary || "";
  // 只重建选项（保留当前选择），避免每次轮询把用户正在操作的下拉框重置掉
  const keys = [...sel.options].map((o) => o.value).join(",");
  const want = ["", ...state.accounts.map((a) => a.key)].join(",");
  if (keys !== want) {
    sel.innerHTML = "";
    const none = document.createElement("option");
    none.value = "";
    none.textContent = "（未选择）";
    sel.appendChild(none);
    for (const a of state.accounts) {
      const o = document.createElement("option");
      o.value = a.key;
      o.textContent = a.name || a.key;
      sel.appendChild(o);
    }
  }
  sel.value = cur;

  // 检查频率跟着原生侧的值走（服务重启后也不会跑偏）
  const poll = $("#poll");
  const wantMs = String(r.pollMs || 10000);
  if ([...poll.options].some((o) => o.value === String(Number(wantMs) / 1000))) {
    poll.value = String(Number(wantMs) / 1000);
  }

  const when = r.lastCheckAt
    ? new Date(r.lastCheckAt).toLocaleTimeString("zh-CN", { hour12: false })
    : null;
  const lines = [];
  lines.push(r.running ? "● 监控运行中" : "○ 未运行");
  if (when) lines.push(`上次检查：${when}`);
  if (r.status) lines.push(r.status);
  if (r.running && !r.notifGranted) lines.push("⚠️ 没有通知权限，收不到提醒");

  const el = $("#mon-status");
  el.textContent = lines.join("\n");
  el.classList.toggle("live", !!r.running);

  const badge = $("#mon-badge");
  if (r.running) {
    const hit = (r.status || "").startsWith("发现正在签到");
    badge.textContent = hit ? "正在签到！" : "监控中";
    badge.style.color = hit ? "var(--danger)" : "var(--ok)";
  } else {
    badge.textContent = "";
  }

  renderPending(r.pending || [], lastCheckStatus);
  loadLocations();
}

const KIND = { 1: "数字码签到", 2: "定位签到", 3: "扫码签到", 4: "签到签出" };

/**
 * 正在进行的签到列表。
 *
 * 定位签到（type=2）可以一键提交 —— 坐标只是请求参数，不需要人真的在教室。
 * 数字码/扫码需要额外信息（老师念的码 / 现场二维码），所以只显示、不给按钮。
 *
 * 同一份数据画到两个地方：设置栏的「签到提醒」里画全部，
 * GPS 栏只画定位签到（那里才是处理它的地方）。
 */
function renderPending(list, statusText) {
  const gps = list.filter((x) => x.type === "2");
  paintPending($("#pending"), list);
  paintPending($("#pending-gps"), gps);

  const tip = $("#gps-tip");
  if (tip) {
    const base = gps.length
      ? "点「立即签到」就会用上面「签到位置」里生效的那个坐标提交。"
      : "现在没有进行中的定位签到。点右上角「点击检测」可以立刻查一次（不用一直开着监控）。";
    // 手动检测的结果附在后面（只有点过检测才有）
    tip.textContent = statusText ? base + "\n" + statusText : base;
  }
  const badge = $("#gps-badge");
  if (badge) badge.textContent = gps.length ? `${gps.length} 个待签` : "";

  // 底部标签上的小红点
  const tab = document.querySelector('#tabbar .tab[data-tab="gps"]');
  if (tab) {
    let dot = tab.querySelector(".dot");
    if (gps.length && !dot) {
      dot = document.createElement("span");
      dot.className = "dot";
      tab.appendChild(dot);
    } else if (!gps.length && dot) {
      dot.remove();
    }
  }
}

function paintPending(box, list) {
  if (!box) return;
  const sig = list.map((x) => x.id).join(",");
  if (box.dataset.sig === sig) return; // 列表没变就不重绘，免得按钮点到一半被重建
  box.dataset.sig = sig;
  box.innerHTML = "";
  if (!list.length) return;
  for (const it of list) {
    const el = document.createElement("div");
    el.className = "pend";
    const kind = KIND[it.type] || "签到";
    el.innerHTML =
      `<span class="who2">${esc(it.course)}<br /><span class="kind">${esc(kind)}${
        it.title ? " · " + esc(it.title) : ""
      }</span></span>` +
      (it.type === "2" ? `<button class="mini" data-sign="${esc(it.id)}">立即签到</button>` : "");
    box.appendChild(el);
  }
  box.querySelectorAll("button[data-sign]").forEach((b) =>
    b.addEventListener("click", () => {
      b.disabled = true;
      b.textContent = "提交中…";
      const r = JSON.parse(native.signLocationNow(b.dataset.sign));
      if (r.ok) {
        b.textContent = "已签到 ✓";
        log(
          `定位签到成功${r.place ? `（位置「${r.place}」）` : ""}：报的坐标 ${r.lat}, ${r.lng}`,
          "ok",
        );
      } else {
        b.disabled = false;
        b.textContent = "立即签到";
        log(`定位签到失败：${r.message}`, "er");
      }
    }),
  );
}

/**
 * 「点击检测」：立刻查一次有没有正在进行的定位签到。
 *
 * 原生侧**不等结果** —— 二十多门课挨个问，同步等会卡住界面甚至 ANR。
 * 它只是起个后台线程，跑完把 MonitorService.oneShotSeq +1。
 * 所以这里点完就开始轮询 getMonitor()，看到序号变大就说明跑完了。
 */
$("#gps-check").addEventListener("click", async () => {
  const btn = $("#gps-check");
  if (btn.disabled) return; // 连点忽略
  const before = state.oneShotSeq || 0;
  btn.disabled = true;
  btn.textContent = "检测中…";

  try {
    const r = JSON.parse(native.checkGpsNow());
    if (!r.ok) {
      lastCheckStatus = "检测没启动起来：" + (r.error || "");
      renderPending([], lastCheckStatus);
      log(lastCheckStatus, "er");
      return;
    }

    // 最多等 ~35 秒（28 门课 8 个并发，正常几秒就回来了）
    for (let i = 0; i < 50; i++) {
      await sleep(700);
      let m;
      try {
        m = JSON.parse(native.getMonitor());
      } catch {
        continue;
      }
      state.oneShotSeq = m.oneShotSeq || 0;
      if (state.oneShotSeq > before) {
        lastCheckStatus = m.status || "检测完成";
        renderPending(m.pending || [], lastCheckStatus);
        log(lastCheckStatus, "ok");
        return;
      }
    }
    lastCheckStatus = "检测超时 —— 网络可能不通，或者课程太多没跑完";
    renderPending([], lastCheckStatus);
    log(lastCheckStatus, "wa");
  } finally {
    btn.disabled = false;
    btn.textContent = "点击检测";
  }
});

// ---------------------------------------------------------------- 签到位置库

// ---------------------------------------------------------------- 三栏切换

const TABS = ["scan", "gps", "settings"];

/**
 * 切换底部三栏。
 *
 * 「要签的人」在扫码栏和 GPS 栏都要出现，而且勾选状态要互通 ——
 * 所以它**只有一个 DOM 元素**，切栏时只切换它的显示，不做任何状态同步。
 * 设置栏不需要它，就藏起来。
 */
function switchTab(name) {
  if (TABS.indexOf(name) < 0) name = "scan";
  for (const t of TABS) {
    const pane = $("#pane-" + t);
    if (pane) pane.classList.toggle("active", t === name);
  }
  const people = $("#pane-people");
  if (people) people.style.display = name === "settings" ? "none" : "";

  document.querySelectorAll("#tabbar .tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
  state.tab = name;
  try {
    localStorage.setItem("ktp.tab", name);
  } catch {
    /* 隐私模式下可能不让写，无所谓 */
  }
  if (name === "gps") loadLocations();
  window.scrollTo(0, 0);
}

document.querySelectorAll("#tabbar .tab").forEach((b) =>
  b.addEventListener("click", () => switchTab(b.dataset.tab)),
);

// ---------------------------------------------------------------- 签到位置库

/** 上次「读当前位置」拿到的结果（两套坐标都在里面） */
let lastFix = null;

/**
 * 画位置列表。
 *
 * 整行是 <label>，所以**点框内任意位置都能选中**（和成员列表一样的做法）。
 * 选中时把该位置的经纬度**回填到下面的输入框**，方便看清楚当前生效的是哪组坐标；
 * 但反过来改输入框**不会**动已存的位置 —— 要让改动生效得点「回填」。
 * 这样输入框就是个"草稿区"，不会误改数据。
 */
function loadLocations() {
  let r;
  try {
    r = JSON.parse(native.listLocations());
  } catch {
    return;
  }
  if (!r.ok) return;

  const box = $("#locations");
  box.innerHTML = "";
  const list = r.locations || [];
  if (list.length === 0) {
    box.innerHTML = `<div class="empty">还没有保存的位置 —— 在下面填一个，或者在教室里点「读当前位置」。</div>`;
  }
  for (const loc of list) {
    const on = loc.name === r.active;
    const el = document.createElement("label");
    el.className = "acc" + (on ? " checked" : "");
    el.innerHTML =
      `<input type="radio" name="loc" data-use="${esc(loc.name)}" ${on ? "checked" : ""} />` +
      `<span class="who"><span class="nm">${esc(loc.name)}</span>` +
      `<span class="sub2">${esc(loc.lat)}, ${esc(loc.lng)}</span></span>` +
      `<span class="ip">${on ? "生效中" : ""}</span>` +
      `<button class="x" data-del="${esc(loc.name)}" title="删除">×</button>`;
    box.appendChild(el);
  }

  const select = (name) => {
    native.useLocation(name);
    const loc = list.find((x) => x.name === name);
    if (loc) {
      // 选中即回填到草稿区 —— 但改输入框不会反向改位置
      $("#loc-lat").value = loc.lat;
      $("#loc-lng").value = loc.lng;
      $("#loc-name").value = "";
      $("#loc-name").placeholder = `备注名（新建用；「回填」不需要）`;
    }
    log(`签到位置已切换为「${name}」，并把它的坐标填到了下面`, "ok");
    loadLocations();
  };

  box.querySelectorAll("input[data-use]").forEach((rb) =>
    rb.addEventListener("change", () => select(rb.dataset.use)),
  );
  // 整行可点：<label> 会自动勾选里面的 radio 并触发 change，这里不用额外处理。
  // 但 × 在 label 里，要阻止它顺带触发选中。
  box.querySelectorAll("button[data-del]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!confirm(`删除位置「${b.dataset.del}」？`)) return;
      native.removeLocation(b.dataset.del);
      log(`已删除位置「${b.dataset.del}」`, "wa");
      loadLocations();
    }),
  );

  const badge = $("#loc-badge");
  const active = list.find((x) => x.name === r.active);
  if (active) {
    badge.textContent = active.name;
    badge.style.color = "var(--ok)";
  } else {
    badge.textContent = list.length ? "未选" : "";
    badge.style.color = "var(--warn)";
  }
}

/** 新建：用「备注名 + 下面的经纬度」建一个新位置。 */
$("#loc-new").addEventListener("click", () => {
  const name = $("#loc-name").value.trim();
  const lat = $("#loc-lat").value.trim();
  const lng = $("#loc-lng").value.trim();
  if (!name) return log("「新建」要先填个备注名（比如「二教305」）", "wa");
  if (!lat || !lng) return log("经纬度都要填", "wa");
  const r = JSON.parse(native.addLocation(name, lat, lng));
  if (!r.ok) return log(`新建失败：${r.error}`, "er");
  log(`已新建位置「${name}」并设为生效（${lat}, ${lng}）`, "ok");
  $("#loc-name").value = "";
  loadLocations();
});

/** 回填：把下面的经纬度写回**当前选中**的那个位置（名字不变）。 */
$("#loc-fill").addEventListener("click", () => {
  const active = currentActiveName();
  if (!active) return log("先在上面选一个位置，再点「回填」", "wa");
  const lat = $("#loc-lat").value.trim();
  const lng = $("#loc-lng").value.trim();
  if (!lat || !lng) return log("经纬度都要填", "wa");
  const r = JSON.parse(native.refillLocation(active, lat, lng));
  if (!r.ok) return log(`回填失败：${r.error}`, "er");
  log(`已把「${active}」的坐标改成 ${lat}, ${lng}`, "ok");
  loadLocations();
});

function currentActiveName() {
  const checked = document.querySelector("#locations input[data-use]:checked");
  return checked ? checked.dataset.use : "";
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 读当前位置。
 *
 * 真机上「读出来的位置偏了几百米」，两个原因都要处理：
 *   1. 系统的 getLastKnownLocation **可能来自模拟定位**（影梭之类设的假点）
 *      —— 现在会检测并明确警告（但用户实测没开影梭也偏，所以还有下面这条）
 *   2. **坐标系不一致**：手机给的是 WGS-84，而高德/腾讯地图（课堂派几乎肯定用它）
 *      用的是 GCJ-02「火星坐标」，国内两者差 300~600 米 —— 量级正好对得上。
 *      所以这里**两套都算出来**，让用户对着高德自己判断用哪个。
 */
$("#loc-here").addEventListener("click", async () => {
  const btn = $("#loc-here");
  const hint = $("#loc-hint");
  lastFix = null;

  const s = JSON.parse(native.startLocating());
  if (!s.ok) {
    hint.textContent = s.error || "定位没启动起来";
    return;
  }
  hint.textContent = s.gpsOn
    ? `定位中…（${s.providers || "无可用 provider"}）`
    : "⚠️ 手机的定位（GPS）是关着的，只能靠基站/WiFi 估算，误差可能几百米 —— 建议先打开定位";
  btn.disabled = true;
  btn.textContent = "定位中…";

  let best = null;
  for (let i = 0; i < 14; i++) {
    await sleep(1200);
    const r = JSON.parse(native.readCurrentLocation());
    if (!r.ok) {
      hint.textContent = `定位中… 已等 ${Math.round((i + 1) * 1.2)} 秒`;
      continue;
    }
    best = r;
    const bits = [r.accuracy >= 0 ? `精度 ±${r.accuracy} 米` : "精度未知", r.provider];
    if (r.cached) bits.push("系统缓存");
    hint.textContent = `已获得：${bits.join(" · ")}${r.mock ? "　⚠️ 来自模拟定位！" : ""}`;
    if (!r.mock && r.accuracy >= 0 && r.accuracy <= 30) break;
  }
  native.stopLocatingNow();
  btn.disabled = false;
  btn.textContent = "读当前位置";

  if (!best) {
    hint.textContent = "拿不到定位结果 —— 到窗边或室外再试一次，或直接照抄高德的坐标";
    return;
  }
  lastFix = best;
  applyFix(); // 用设置里选定的定位方式填
});

/**
 * 把 lastFix 填进输入框，并刷新说明文字。
 *
 * 用哪套坐标由**当前设置**（state.coordMode）决定，不是"读取那一刻"的方式 ——
 * 否则在设置里换了定位方式再重填，还会按旧方式填（这个 bug 就是交互验证抓出来的：
 * 之前优先用 lastFix.coordMode，改回高德后输入框纹丝不动）。
 *
 * lastFix 里两套坐标都有，所以这里能直接换，不用重新定位。
 */
function applyFix() {
  if (!lastFix) return;
  const hint = $("#loc-hint");
  const isGcj = (state.coordMode || "gcj") === "gcj";
  const haveBoth = lastFix.latGcj !== undefined && lastFix.latGcj !== "";

  if (haveBoth) {
    $("#loc-lat").value = isGcj ? lastFix.latGcj : lastFix.lat;
    $("#loc-lng").value = isGcj ? lastFix.lngGcj : lastFix.lng;
  } else {
    // 兜底：老版本的结果里可能只有原生挑好的那组
    $("#loc-lat").value = lastFix.latPick || lastFix.lat;
    $("#loc-lng").value = lastFix.lngPick || lastFix.lng;
  }

  const lines = [];
  lines.push(`手机读到（WGS-84 GPS）：${lastFix.lat}, ${lastFix.lng}`);
  lines.push(`换算成高德坐标（GCJ-02）：${lastFix.latGcj}, ${lastFix.lngGcj}`);
  lines.push(`两者相差 ${lastFix.offsetMeters} 米`);
  lines.push("");
  lines.push(
    `按设置里的定位方式，填的是【${isGcj ? "高德坐标 GCJ-02" : "本机 GPS 坐标 WGS-84"}】。\n` +
      `要换另一套，去「设置 → 定位方式」改，再点一次「读当前位置」。`,
  );
  if (lastFix.mock) {
    lines.push("");
    lines.push("⚠️ 这次读到的位置来自模拟定位（影梭之类），不是真实位置。");
  } else if (lastFix.accuracy > 50) {
    lines.push("");
    lines.push(`⚠️ 精度一般（±${lastFix.accuracy} 米），到窗边/室外再点一次会更准。`);
  }
  hint.textContent = lines.join("\n");
}


$("#primary").addEventListener("change", (e) => {
  native.setPrimary(e.target.value);
  const name = e.target.selectedOptions[0]?.textContent ?? "";
  log(e.target.value ? `主成员已设为「${name}」` : "已取消主成员", "ok");
  loadMonitor();
});

$("#poll").addEventListener("change", (e) => {
  const sec = Number(e.target.value);
  native.setPollSeconds(sec);
  log(`检查频率已改为 ${sec} 秒`, "ok");
  loadMonitor();
});

$("#mon-start").addEventListener("click", () => {
  const r = JSON.parse(native.startMonitor());
  if (r.ok) {
    log("已开启签到监控（前台服务，会有一条常驻通知）", "ok");
  } else {
    log(`开启失败：${r.error}`, "er");
  }
  setTimeout(loadMonitor, 600);
});

$("#mon-stop").addEventListener("click", () => {
  native.stopMonitor();
  log("已停止签到监控", "wa");
  setTimeout(loadMonitor, 600);
});

// 监控状态定时刷新（服务是独立进程外的东西，页面只能轮询）
setInterval(() => {
  if (!document.hidden) loadMonitor();
}, 3000);

// ---------------------------------------------------------------- IP 策略

function ipLabel(a) {
  if (state.ipMode === "real") return "真实 IP";
  if (state.ipMode === "same") return state.sharedIp || "(待生成)";
  return a.ip || "(待生成)";
}

function loadSettings() {
  if (!native) return;
  try {
    const s = JSON.parse(native.getSettings());
    state.ipMode = s.mode || "perAccount";
    state.sharedIp = s.sharedIp || "";
    state.coordMode = s.coordMode || "gcj";
  } catch {
    state.ipMode = "perAccount";
    state.coordMode = "gcj";
  }
  const sel = $("#ipmode");
  if (sel) sel.value = state.ipMode;
  const hint = $("#iphint");
  if (hint) {
    hint.textContent =
      state.ipMode === "real"
        ? "不发送 X-Forwarded-For，课堂派会记录你手机真实的出口 IP。"
        : state.ipMode === "same"
          ? `所有账号都报同一个 IP：${state.sharedIp}`
          : "每个账号一个固定假 IP（首次分配后不再变，像各自的住处）。";
  }

  const cm = $("#coordmode");
  if (cm) cm.value = state.coordMode;
  const ch = $("#coord-hint");
  if (ch) {
    ch.textContent =
      state.coordMode === "wgs"
        ? "读当前位置时填「手机 GPS 原始坐标（WGS-84）」。\n如果签到位置总往一个方向偏几百米，多半该换成高德坐标。"
        : "读当前位置时填「高德坐标（GCJ-02）」。\n判断方法：在高德里看你现在的位置，和读出来的坐标对得上，就是这套对。";
  }
  const cb = $("#coord-badge");
  if (cb) cb.textContent = state.coordMode === "wgs" ? "GPS" : "高德";
}

$("#coordmode").addEventListener("change", (e) => {
  native.setCoordMode(e.target.value);
  state.coordMode = e.target.value;
  loadSettings();
  // 已经读过位置的话，立刻按新方式重新填一次，省得再跑一遍定位
  if (lastFix) applyFix();
  log(`定位方式已改为「${e.target.value === "wgs" ? "本机 GPS（WGS-84）" : "高德（GCJ-02）"}」`, "ok");
});

// ---------------------------------------------------------------- 解析票据

function parseTicket(text) {
  if (!text) return null;
  const t = String(text).trim();

  if (t.startsWith("{")) {
    try {
      const o = JSON.parse(t);
      const g = (...names) => {
        for (const n of names) {
          for (const k of Object.keys(o)) if (k.toLowerCase() === n) return o[k];
        }
        return null;
      };
      const tid = g("ticketid");
      const expire = g("expire");
      const sign = g("sign");
      if (tid && expire && sign) {
        return { ticketid: String(tid), expire: String(expire), sign: String(sign) };
      }
    } catch {
      /* 继续按 URL 解析 */
    }
  }
  const pick = (name) => {
    const m = t.match(new RegExp(name + "=([^&\\s\"']+)", "i"));
    return m ? m[1] : null;
  };
  const ticketid = pick("ticketid");
  const expire = pick("expire");
  const sign = pick("sign");
  return ticketid && expire && sign ? { ticketid, expire, sign } : null;
}

function fmtTime(epochSeconds) {
  return new Date(Number(epochSeconds) * 1000).toLocaleTimeString("zh-CN", { hour12: false });
}

// ---------------------------------------------------------------- 结果渲染

function render(headline, results, note) {
  const box = $("#result");
  let html = headline ? `<div class="dim small" style="margin:8px 0">${esc(headline)}</div>` : "";
  for (const r of results || []) {
    html +=
      `<div class="res ${r.ok ? "ok" : "bad"}"><span class="t">${r.ok ? "✅" : "❌"}</span>` +
      `<span>${esc(r.label || r.key)}</span>` +
      `<span class="why">${esc(r.ok ? "签到成功" : r.message || "失败")}${
        r.ip ? "<br>IP " + esc(r.ip) : ""
      }</span></div>`;
  }
  if (note) {
    html += `<div class="res bad"><span class="t">!</span><span class="why">${esc(note)}</span></div>`;
  }
  box.innerHTML = html;
}

// ---------------------------------------------------------------- 扫码流程

function setScanning(on) {
  state.scanning = on;
  const btn = $("#scan");
  btn.disabled = on;
  btn.textContent = on ? "等待扫码 …" : "扫一扫签到";
}

function startScan() {
  if (!native) return log("原生 bridge 不可用（是不是用浏览器打开的？）", "er");
  if (state.keys.size === 0) return log("请至少勾选一个账号", "wa");
  setScanning(true);
  $("#result").innerHTML = `<div class="dim small" style="margin:8px 0">正在打开相机 …</div>`;
  native.startScan();
}

/** 扫码成功后，把票据提交给所有勾选的账号。 */
function handleScannedText(text) {
  const ticket = parseTicket(text);
  if (!ticket) {
    render("扫到的不是签到码", [], String(text).slice(0, 120));
    log("扫到内容但不是课堂派签到码", "wa");
    return;
  }

  const left = Number(ticket.expire) - Date.now() / 1000;
  if (left < -2) {
    render(`票据 ${fmtTime(ticket.expire)} 失效（已过期 ${Math.abs(left).toFixed(0)} 秒）`, [], "重新扫一张新的二维码");
    log(`票据已过期 ${Math.abs(left).toFixed(0)} 秒`, "er");
    return;
  }

  const keys = [...state.keys];
  const raw = native.submitQr(JSON.stringify(keys), ticket.ticketid, ticket.expire, ticket.sign);
  const out = JSON.parse(raw);
  const results = out.results || [];
  render(
    `${fmtTime(ticket.expire)} 失效 · 剩余 ${left.toFixed(0)} 秒 · 成功 ${out.okCount}/${results.length}`,
    results,
  );
  log(`扫码提交：成功 ${out.okCount}/${results.length}`, out.okCount > 0 ? "ok" : "er");
  for (const r of results) if (!r.ok) log(`　${r.label} 失败：${r.message}`, "wa");
}

// 由原生侧回调（MainActivity.callJs）
window.onScanResult = function (text, source) {
  setScanning(false);
  // 记下是哪个检测器认出来的 —— 排查「小二维码扫不上」时这是最关键的一条信息
  if (source) log(`识别方式：${source}`, "d");
  try {
    handleScannedText(text);
  } catch (err) {
    render("出错", [], String(err && err.message ? err.message : err));
    log(`出错：${err}`, "er");
  }
};

window.onScanCancelled = function () {
  setScanning(false);
  $("#result").innerHTML = `<div class="dim small" style="margin:8px 0">已取消扫码</div>`;
};

window.onScanError = function (message) {
  setScanning(false);
  render("打不开相机", [], message);
  log(`扫码失败：${message}`, "er");
};

// ---------------------------------------------------------------- 事件

$("#scan").addEventListener("click", startScan);

$("#ipmode").addEventListener("change", (e) => {
  native.setIpMode(e.target.value);
  loadSettings();
  loadAccounts();
  log(`IP 策略已改为「${e.target.selectedOptions[0].textContent}」`, "ok");
});

$("#reroll").addEventListener("click", () => {
  native.rerollIps();
  loadSettings();
  loadAccounts();
  log("已重新随机所有账号的 IP", "ok");
});

$("#all").addEventListener("change", (e) => {
  setAll(e.target.checked);
});

$("#add").addEventListener("click", () => {
  if (!native) return log("原生 bridge 不可用", "er");
  const key = $("#k").value.trim();
  const email = $("#e").value.trim();
  const password = $("#p").value;
  if (!key || !email || !password) return log("备注名 / 手机号 / 密码都要填", "wa");
  $("#addhint").textContent = "正在登录验证 …";
  try {
    const out = JSON.parse(native.addAccount(key, email, password));
    if (out.ok) {
      $("#addhint").textContent = `已添加：${out.name}（${out.school || "—"}）`;
      $("#k").value = $("#e").value = $("#p").value = "";
      loadAccounts();
      log(`已添加账号 ${key} -> ${out.name}`, "ok");
    } else {
      $("#addhint").textContent = `添加失败：${out.error}`;
      log(`添加失败：${out.error}`, "er");
    }
  } catch (err) {
    $("#addhint").textContent = `添加失败：${err}`;
  }
});

// ---------------------------------------------------------------- 成员迁移

/**
 * 「要导出哪些人」的选中集合。
 *
 * 默认**一个都不选** —— 导出谁必须是明确点过的，不能一打开就顺手把全班导出去。
 */
const exportPick = new Set();

/** 画「要导出哪些人」那一排小框（一行三个）。 */
function renderExportPick() {
  const box = $("#exp-pick");
  if (!box) return;
  box.innerHTML = "";
  if (state.accounts.length === 0) {
    box.innerHTML = `<div class="empty">还没有成员</div>`;
    syncPickHint();
    return;
  }
  for (const a of state.accounts) {
    const on = exportPick.has(a.key);
    const el = document.createElement("label");
    el.className = "pick" + (on ? " on" : "");
    el.innerHTML =
      `<input type="checkbox" data-e="${esc(a.key)}" ${on ? "checked" : ""} />` +
      `<span class="nm2">${esc(a.name || a.key)}</span>`;
    box.appendChild(el);
  }
  box.querySelectorAll("input[data-e]").forEach((cb) =>
    cb.addEventListener("change", () => {
      if (cb.checked) exportPick.add(cb.dataset.e);
      else exportPick.delete(cb.dataset.e);
      cb.closest(".pick").classList.toggle("on", cb.checked);
      syncPickHint();
    }),
  );
  syncPickHint();
}

function syncPickHint() {
  const el = $("#exp-pick-hint");
  if (!el) return;
  const n = exportPick.size;
  const total = state.accounts.length;
  el.textContent = n
    ? `已选 ${n} / ${total} 人`
    : `还没选人（共 ${total} 个）—— 点上面的框，或点「全选」`;
}

$("#exp-all").addEventListener("click", () => {
  for (const a of state.accounts) exportPick.add(a.key);
  renderExportPick();
});

$("#exp-none").addEventListener("click", () => {
  exportPick.clear();
  renderExportPick();
});

function setMigrateHint(text) {
  const el = $("#migrate-hint");
  if (el) el.textContent = text;
}

/** 生成导出串（不复制）。分享前也会用到。只导出选中的那些人。 */
function buildExport() {
  const withSecrets = $("#exp-secrets").checked;
  const keys = [...exportPick];
  if (keys.length === 0) {
    const msg = "还没选要导出谁 —— 先在上面点选，或点「全选」";
    setMigrateHint(msg);
    log(msg, "wa");
    return null;
  }
  const r = JSON.parse(native.exportAccounts(withSecrets, JSON.stringify(keys)));
  if (!r.ok) {
    log(`导出失败：${r.error}`, "er");
    setMigrateHint(`导出失败：${r.error}`);
    return null;
  }
  $("#exp-out").value = r.payload;
  return r;
}

function doExportCopy() {
  const r = buildExport();
  if (!r) return;
  const c = JSON.parse(native.copyToClipboard(r.payload));
  if (c.ok) {
    setMigrateHint(
      `已导出 ${r.count} 个成员并复制到剪贴板${r.withSecrets ? "（含密码，别外传）" : "（不含密码）"}`,
    );
    log(`已导出 ${r.count} 个成员到剪贴板`, "ok");
  } else {
    setMigrateHint(`已生成但复制失败：${c.error} —— 可以长按下面文本框手动复制`);
    log(`复制到剪贴板失败：${c.error}`, "wa");
  }
}

function doExportShare() {
  const r = buildExport();
  if (!r) return;
  const s = JSON.parse(native.shareText(r.payload));
  if (s.ok) {
    setMigrateHint(`已调起分享（${r.count} 个成员）`);
    log(`已调起系统分享`, "ok");
  } else {
    setMigrateHint(`分享失败：${s.error}`);
  }
}

function doImport(payload, from) {
  if (!payload || !payload.trim()) {
    log("没有可导入的内容", "wa");
    setMigrateHint("没有可导入的内容");
    return;
  }
  const replace = $("#imp-replace").checked;
  const r = JSON.parse(native.importAccounts(payload, replace));
  if (!r.ok) {
    log(`导入失败：${r.error}`, "er");
    setMigrateHint(`导入失败：${r.error}`);
    return;
  }
  setMigrateHint(
    `从${from}导入完成：新增 ${r.added}、更新 ${r.updated}，当前共 ${r.total} 个成员` +
      (r.withSecrets ? "" : "（这份数据不含密码，需要重新填）"),
  );
  log(`导入完成：新增 ${r.added}、更新 ${r.updated}，共 ${r.total}`, "ok");
  // 导入后让新成员默认全选
  state.selectionReady = false;
  state.keys.clear();
  loadSettings();
  loadAccounts();
}

function doImportClipboard() {
  const c = JSON.parse(native.readClipboard());
  if (!c.ok) {
    log(`读剪贴板失败：${c.error}`, "er");
    setMigrateHint(`读剪贴板失败：${c.error}`);
    return;
  }
  if (!c.text || !c.text.trim()) {
    log("剪贴板是空的", "wa");
    setMigrateHint("剪贴板是空的 —— 先在上面「导出并复制」，或先在旧手机上复制好");
    return;
  }
  doImport(c.text, "剪贴板");
}

$("#exp-copy").addEventListener("click", doExportCopy);
$("#exp-share").addEventListener("click", doExportShare);
$("#imp-clip").addEventListener("click", doImportClipboard);
$("#imp-text").addEventListener("click", () => doImport($("#exp-out").value, "文本框"));

// ---------------------------------------------------------------- 启动

(function main() {
  $("#env").textContent = native ? "原生扫码 · 原生网络" : "bridge 不可用";
  if (!native) {
    log("没有检测到 Android bridge —— 这个页面必须在 App 里打开。", "er");
    return;
  }

  // 恢复上次停留的那一栏
  let tab = "scan";
  try {
    const saved = localStorage.getItem("ktp.tab");
    if (saved && TABS.indexOf(saved) >= 0) tab = saved;
  } catch {
    /* ignore */
  }
  switchTab(tab);

  loadSettings();
  loadAccounts();
  loadMonitor();
  if (state.accounts.length === 0) {
    $("#addbox").open = true;
    switchTab("settings"); // 一个账号都没有时直接把设置栏打开，省得用户找
  }
  log("就绪。点「扫一扫签到」对准二维码即可。");
})();
