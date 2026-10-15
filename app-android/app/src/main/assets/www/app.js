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
};

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

  // 教室坐标（用户正在输入时不要覆盖他）
  const lat = $("#room-lat");
  const lng = $("#room-lng");
  if (document.activeElement !== lat && !lat.value) lat.value = r.roomLat || "";
  if (document.activeElement !== lng && !lng.value) lng.value = r.roomLng || "";

  renderPending(r.pending || []);
}

const KIND = { 1: "数字码签到", 2: "定位签到", 3: "扫码签到", 4: "签到签出" };

/**
 * 正在进行的签到列表。
 *
 * 定位签到（type=2）可以一键提交 —— 坐标只是请求参数，不需要人真的在教室。
 * 数字码/扫码需要额外信息（老师念的码 / 现场二维码），所以只显示、不给按钮。
 */
function renderPending(list) {
  const box = $("#pending");
  const sig = list.map((x) => x.id).join(",");
  if (box.dataset.sig === sig) return; // 列表没变就不重绘，免得按钮点到一半被重建
  box.dataset.sig = sig;
  box.innerHTML = "";
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
        log(`定位签到成功：报的坐标 ${r.lat}, ${r.lng}`, "ok");
      } else {
        b.disabled = false;
        b.textContent = "立即签到";
        log(`定位签到失败：${r.message}`, "er");
      }
    }),
  );
}

$("#room-save").addEventListener("click", () => {
  const lat = $("#room-lat").value.trim();
  const lng = $("#room-lng").value.trim();
  if (!lat || !lng) {
    log("经纬度都要填", "wa");
    return;
  }
  const r = JSON.parse(native.setRoomLocation(lat, lng));
  if (r.ok) log(`教室坐标已保存：${lat}, ${lng}`, "ok");
  else log(`保存失败：${r.error}`, "er");
  loadMonitor();
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 读当前位置。
 *
 * 之前只读一次系统的「最后已知位置」，真机上读偏了几百米 —— 两个原因：
 *   1. 那个位置**可能来自模拟定位**（装了影梭之类的改定位 App 时，
 *      系统返回的就是它设的假点，而不是你的真实位置）
 *   2. 网络定位常常又新又粗，原来"按时间取最新"会把 GPS 更准的结果顶掉
 * 现在：主动申请一次定位更新，反复取（原生侧按**精度**挑最好的），
 * 拿到 ±30 米以内就停；并明确标出「模拟定位」和「系统缓存」。
 */
$("#room-here").addEventListener("click", async () => {
  const btn = $("#room-here");
  const hint = $("#room-hint");
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

  $("#room-lat").value = best.lat;
  $("#room-lng").value = best.lng;

  if (best.mock) {
    hint.textContent +=
      "\n⚠️ 这个位置是**模拟定位**（影梭之类设的假点），不是你的真实位置。\n要读真实位置：先去影梭里「停止模拟」或直接关掉它，再点一次「读当前位置」。";
    log("⚠️ 读到的位置来自模拟定位 —— 很可能是影梭设的假点，不是你站的地方。", "wa");
  } else if (best.accuracy > 50) {
    hint.textContent += "\n精度还不够好（±" + best.accuracy + " 米）。到窗边/室外再点一次，或直接照抄高德的坐标。";
  }
  log(
    `读到位置 ${best.lat}, ${best.lng}（精度 ±${best.accuracy} 米 · ${best.provider}${
      best.cached ? " · 系统缓存" : ""
    }）—— 确认后点「保存坐标」`,
    best.mock ? "wa" : "ok",
  );
});

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
  } catch {
    state.ipMode = "perAccount";
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
}

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

function setMigrateHint(text) {
  const el = $("#migrate-hint");
  if (el) el.textContent = text;
}

/** 生成导出串（不复制）。分享前也会用到。 */
function buildExport() {
  const withSecrets = $("#exp-secrets").checked;
  const r = JSON.parse(native.exportAccounts(withSecrets));
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
  loadSettings();
  loadAccounts();
  loadMonitor();
  if (state.accounts.length === 0) $("#addbox").open = true;
  log("就绪。点「扫一扫签到」对准二维码即可。");
})();
