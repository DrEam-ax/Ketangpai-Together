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
}

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
window.onScanResult = function (text) {
  setScanning(false);
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

// ---------------------------------------------------------------- 启动

(function main() {
  $("#env").textContent = native ? "原生扫码 · 原生网络" : "bridge 不可用";
  if (!native) {
    log("没有检测到 Android bridge —— 这个页面必须在 App 里打开。", "er");
    return;
  }
  loadSettings();
  loadAccounts();
  if (state.accounts.length === 0) $("#addbox").open = true;
  log("就绪。点「扫一扫签到」对准二维码即可。");
})();
