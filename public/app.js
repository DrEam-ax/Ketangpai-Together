/* 课堂派远程签到 - 前端逻辑 */

const $ = (sel) => document.querySelector(sel);

const state = {
  who: "stu",
  scanning: false,
  stream: null,
  scanBusy: false,
  statusBusy: false,
  refreshTimer: null,
  lastLoggedTicket: null,
};

// ---------------------------------------------------------------- 基础

function log(message, cls = "") {
  const el = $("#log");
  const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  const line = document.createElement("div");
  line.innerHTML = `<span class="t">[${time}]</span> <span class="${cls}">${escapeHtml(message)}</span>`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[m]);
}

async function api(path, body = {}) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- Tab 切换

document.querySelectorAll(".tabs button").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    btn.classList.add("active");
    $(`#tab-${btn.dataset.tab}`).classList.add("active");
  });
});

// ---------------------------------------------------------------- 账号

async function initAccounts() {
  const cfg = await api("/api/config");
  const select = $("#who");
  select.innerHTML = "";
  for (const key of cfg.accounts) {
    const opt = document.createElement("option");
    opt.value = key;
    opt.textContent = key;
    select.appendChild(opt);
  }
  state.who = cfg.accounts.includes(cfg.defaultWho) ? cfg.defaultWho : cfg.accounts[0];
  if (state.who) select.value = state.who;

  // 用 onchange 而不是 addEventListener，避免重复调用时叠加监听
  select.onchange = async () => {
    state.who = select.value;
    await loadIdentity();
    await refreshStatus();
  };

  const hint = $("#lan-hint");
  if (hint) {
    hint.innerHTML = cfg.lanUrls?.length
      ? `手机在同一 Wi-Fi 下打开：<b>${cfg.lanUrls.map(escapeHtml).join(" 或 ")}</b>`
      : `手机访问需要带 <code>--host 0.0.0.0</code> 重启服务（当前只监听本机）`;
  }

  await loadIdentity();
}

async function loadIdentity() {
  try {
    const info = await api("/api/whoami", { who: state.who });
    $("#identity").textContent = `${info.name} · ${info.usertype === "1" ? "教师" : "学生"} · ${info.school ?? ""}`;
  } catch (err) {
    $("#identity").textContent = `登录失败：${err.message}`;
  }
}

// ---------------------------------------------------------------- 实时状态

function typeBadge(type) {
  const map = { "1": ["数字码签到", "digit"], "2": ["定位签到", ""], "3": ["二维码签到", "qr"], "4": ["签到签出", ""] };
  const [label, cls] = map[type] ?? [`类型${type}`, ""];
  return `<span class="badge ${cls}">${label}</span>`;
}

async function refreshStatus(manual = false) {
  const summary = $("#status-summary");
  if (state.statusBusy) return;
  state.statusBusy = true;
  if (manual) summary.textContent = "刷新中 …";
  try {
    const data = await api("/api/status", { who: state.who });
    const qrLive = data.courses.some((c) => c.items.some((i) => i.type === "3"));
    summary.innerHTML =
      `已扫描 ${data.scanned} 门课程，发现 <b>${data.courses.length}</b> 个进行中的签到` +
      (qrLive
        ? ` · <span style="color:var(--warn)">检测到二维码考勤，请到「摄像头扫描」或粘贴朋友发来的二维码照片</span>`
        : "");

    const list = $("#status-list");
    list.innerHTML = "";
    if (data.courses.length === 0) {
      list.innerHTML = `<div class="summary dim">当前没有未完成的签到。</div>`;
      return;
    }
    for (const course of data.courses) {
      const box = document.createElement("div");
      box.className = "course";
      box.innerHTML =
        `<h3>${escapeHtml(course.courseName)} <span class="dim" style="font-weight:400;font-size:13px">${escapeHtml(course.className)}</span></h3>` +
        course.items
          .map((i) => {
            // 数字码签到：只要能拿到那 4 个数字，人在哪都能签 —— 直接给个输入框
            const action =
              i.type === "1"
                ? `<input class="code-input" data-code-for="${escapeHtml(i.id)}" inputmode="numeric" maxlength="8" placeholder="4位数字码" /><button class="mini" data-checkin="${escapeHtml(i.id)}">签到</button>`
                : "";
            return `<div class="item">${typeBadge(i.type)}<span>${escapeHtml(i.title)}</span><span class="id">${escapeHtml(i.id)}</span>${action}</div>`;
          })
          .join("");
      list.appendChild(box);
    }

    // 绑定数字码签到的按钮
    list.querySelectorAll("button[data-checkin]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const attenceid = btn.dataset.checkin;
        const input = list.querySelector(`input[data-code-for="${attenceid}"]`);
        digitCheckin(attenceid, input ? input.value.trim() : "");
      });
    });
  } catch (err) {
    summary.textContent = `刷新失败：${err.message}`;
  } finally {
    state.statusBusy = false;
  }
}

/** 数字码签到：别人把 4 个数字告诉你，人在哪都能签。 */
async function digitCheckin(attenceid, code) {
  if (!code) return log("请先填 4 位数字码", "warn");
  try {
    const result = await api("/api/checkin", { who: state.who, attenceid, code });
    if (result.ok) {
      log(`✅ 数字码签到成功：${result.message}`, "ok");
      refreshStatus();
    } else {
      log(`❌ 数字码签到失败：${result.message}`, "err");
    }
  } catch (err) {
    log(`提交出错：${err.message}`, "err");
  }
}

function scheduleRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if ($("#auto-refresh").checked && $("#tab-status").classList.contains("active")) refreshStatus();
  }, 5000);
}

$("#refresh-status").addEventListener("click", () => refreshStatus(true));

// ---------------------------------------------------------------- 摄像头扫描

async function startScan() {
  try {
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
  } catch (err) {
    log(`无法打开摄像头：${err.message}（浏览器只在 localhost 或 HTTPS 下允许摄像头）`, "err");
    return;
  }
  const video = $("#video");
  video.srcObject = state.stream;
  await video.play();

  state.scanning = true;
  state.lastLoggedTicket = null;
  $("#start-scan").disabled = true;
  $("#stop-scan").disabled = false;
  $("#scan-hint").textContent = "扫描中 …";
  log("摄像头已启动，开始逐帧识别二维码", "hl");
  scanTick();
}

function stopScan() {
  state.scanning = false;
  if (state.stream) {
    for (const track of state.stream.getTracks()) track.stop();
    state.stream = null;
  }
  $("#video").srcObject = null;
  $("#start-scan").disabled = false;
  $("#stop-scan").disabled = true;
  $("#scan-hint").textContent = "已停止";
  log("摄像头已停止");
}

const captureCanvas = document.createElement("canvas");

async function scanTick() {
  if (!state.scanning) return;
  if (!state.scanBusy) {
    state.scanBusy = true;
    try {
      const video = $("#video");
      if (video.videoWidth > 0) {
        const scale = Math.min(1, 1280 / video.videoWidth);
        captureCanvas.width = Math.round(video.videoWidth * scale);
        captureCanvas.height = Math.round(video.videoHeight * scale);
        const ctx = captureCanvas.getContext("2d");
        ctx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);
        const image = captureCanvas.toDataURL("image/jpeg", 0.75);

        const result = await api("/api/frame", {
          who: state.who,
          image,
          mode: "frame",
          autoSubmit: $("#scan-autosubmit").checked,
        });
        handleFrameResult(result);
      }
    } catch (err) {
      /* 单帧失败忽略，继续扫 */
    }
    state.scanBusy = false;
  }
  setTimeout(scanTick, 700);
}

function handleFrameResult(result) {
  if (!result.decoded) return;

  if (!result.isTicket) {
    if (state.lastLoggedTicket !== result.text) {
      state.lastLoggedTicket = result.text;
      log(`识别到二维码，但不是课堂派签到码：${result.text}`, "warn");
    }
    return;
  }

  const t = result.ticket;
  if (state.lastLoggedTicket === t.ticketid && !result.submitted) return;
  state.lastLoggedTicket = t.ticketid;

  log(`识别到签到二维码（${t.expireAt} 失效，剩余 ${t.remaining.toFixed(0)} 秒）`, "hl");
  if (result.submitted) {
    if (result.ok) {
      log(`✅ 签到成功：${result.message}`, "ok");
      refreshStatus();
    } else {
      log(`❌ 签到失败：${result.message}`, "err");
    }
  } else if (result.message) {
    // 例如「二维码已过期 120 秒」「这个二维码已经签到过了」
    log(`未提交：${result.message}（剩余 ${t.remaining.toFixed(0)} 秒）`, "warn");
  }
}

$("#start-scan").addEventListener("click", startScan);
$("#stop-scan").addEventListener("click", stopScan);

// ---------------------------------------------------------------- 手动签到

async function submitUrl() {
  const url = $("#qr-url").value.trim();
  if (!url) return log("请先粘贴二维码 URL", "warn");
  try {
    const result = await api("/api/submit", { who: state.who, url });
    if (result.ok) {
      log(`✅ 签到成功：${result.message}`, "ok");
      refreshStatus();
    } else {
      log(`❌ 签到失败：${result.message}（票据剩余 ${result.remaining?.toFixed?.(0) ?? "?"} 秒）`, "err");
    }
  } catch (err) {
    log(`提交出错：${err.message}`, "err");
  }
}

$("#submit-url").addEventListener("click", submitUrl);

async function submitImageFile(file) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  log(`正在识别图片（${Math.round(file.size / 1024)} KB）…`, "hl");
  try {
    const result = await api("/api/frame", {
      who: state.who,
      image: dataUrl,
      mode: "image",
      autoSubmit: $("#file-autosubmit").checked,
    });
    handleFrameResult(result);
    if (!result.decoded) {
      log(
        `图片里没识别出二维码（耗时 ${result.elapsed ?? "?"}ms）。试试把图片裁剪到只剩二维码再上传，` +
          `或者直接让朋友把二维码里的 URL 文字发你，粘到上面那个框里。`,
        "warn",
      );
    }
  } catch (err) {
    log(`识别出错：${err.message}`, "err");
  }
}

$("#qr-file").addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  if (file) submitImageFile(file);
  e.target.value = "";
});

// 直接 Ctrl+V 粘贴截图
document.addEventListener("paste", (e) => {
  const items = e.clipboardData?.items ?? [];
  for (const item of items) {
    if (item.type.startsWith("image/")) {
      const file = item.getAsFile();
      if (file) {
        submitImageFile(file);
        e.preventDefault();
      }
      return;
    }
  }
  // 粘贴的是文本，且看着像二维码 URL
  const text = e.clipboardData?.getData("text")?.trim();
  if (text && /ticketid=/i.test(text)) {
    $("#qr-url").value = text;
    log("已从剪贴板填入二维码 URL", "hl");
    e.preventDefault();
  }
});

// ---------------------------------------------------------------- 现场扫码

const onsite = { accounts: [], keys: new Set(), loaded: false };

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function loadAccounts() {
  const box = $("#onsite-accounts");
  let list = [];
  try {
    list = (await api("/api/accounts")).accounts ?? [];
  } catch (err) {
    box.innerHTML = `<div class="dim">加载账号失败：${escapeHtml(err.message)}</div>`;
    return;
  }
  onsite.accounts = list;

  // 首次加载默认全选；之后保留用户的选择，只剪掉已被删除的
  if (!onsite.loaded) {
    for (const a of list) onsite.keys.add(a.key);
    onsite.loaded = true;
  }
  for (const key of [...onsite.keys]) {
    if (!list.some((a) => a.key === key)) onsite.keys.delete(key);
  }

  box.innerHTML = "";
  if (list.length === 0) {
    box.innerHTML = `<div class="dim">还没有配置账号 —— 展开下面「添加账号」加一个。</div>`;
  }
  for (const acc of list) {
    const checked = onsite.keys.has(acc.key);
    const el = document.createElement("label");
    el.className = `acc${checked ? " checked" : ""}`;
    el.innerHTML =
      `<input type="checkbox" data-key="${escapeHtml(acc.key)}" ${checked ? "checked" : ""} />` +
      `<span><span class="who-name">${escapeHtml(acc.name)}</span><br>` +
      `<span class="who-sub">${escapeHtml(acc.key)}${acc.school ? " · " + escapeHtml(acc.school) : ""}</span></span>` +
      `<button class="del" data-del="${escapeHtml(acc.key)}" title="删除该账号">×</button>`;
    box.appendChild(el);
  }

  box.querySelectorAll("input[type=checkbox]").forEach((cb) => {
    cb.addEventListener("change", () => {
      if (cb.checked) onsite.keys.add(cb.dataset.key);
      else onsite.keys.delete(cb.dataset.key);
      cb.closest(".acc").classList.toggle("checked", cb.checked);
      $("#onsite-all").checked = onsite.keys.size === onsite.accounts.length;
      updateOnsiteCount();
    });
  });

  box.querySelectorAll("button[data-del]").forEach((btn) => {
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (!confirm(`确定删除账号「${btn.dataset.del}」？`)) return;
      await api("/api/accounts/remove", { key: btn.dataset.del });
      onsite.keys.delete(btn.dataset.del);
      await loadAccounts();
      await initAccounts();
    });
  });

  updateOnsiteCount();
}

function updateOnsiteCount() {
  $("#onsite-count").textContent = `已选 ${onsite.keys.size} / ${onsite.accounts.length} 个账号`;
}

function renderOnsiteResult(result) {
  const box = $("#onsite-result");

  if (!result.decoded) {
    box.innerHTML =
      `<div class="result-row bad"><span class="tag">没识别出二维码</span>` +
      `<span class="why">让二维码占满画面、别糊，重新拍一张</span></div>`;
    log("现场扫码：没能识别出二维码", "err");
    return;
  }
  if (!result.isTicket) {
    box.innerHTML =
      `<div class="result-row bad"><span class="tag">不是签到码</span>` +
      `<span class="why">${escapeHtml(result.message ?? "")}</span></div>`;
    return;
  }

  const t = result.ticket;
  const head = `<div class="dim" style="margin-bottom:8px">票据 ${t.expireAt} 失效 · 剩余 ${t.remaining.toFixed(0)} 秒</div>`;
  const rows = (result.results ?? [])
    .map(
      (x) =>
        `<div class="result-row ${x.ok ? "ok" : "bad"}">` +
        `<span class="tag">${x.ok ? "✅" : "❌"}</span>` +
        `<span>${escapeHtml(x.label)}</span>` +
        `<span class="why">${escapeHtml(x.ok ? "签到成功" : x.message)}</span></div>`,
    )
    .join("");

  const summary = result.results?.length
    ? `<div class="summary"><b>成功 ${result.okCount} / ${result.results.length}</b>　用时 ${result.elapsed}ms</div>`
    : "";

  const stale = result.message && !result.results?.length
    ? `<div class="result-row bad"><span class="tag">未提交</span><span class="why">${escapeHtml(result.message)}</span></div>`
    : "";

  box.innerHTML = head + summary + rows + stale;

  if (result.results?.length) {
    log(
      `现场扫码（${result.engine}，${result.elapsed}ms）：成功 ${result.okCount}/${result.results.length}`,
      result.okCount > 0 ? "ok" : "err",
    );
    for (const x of result.results) {
      if (!x.ok) log(`　${x.label} 失败：${x.message}`, "warn");
    }
  }
}

async function onsiteScan(file) {
  if (!file) return;
  const keys = [...onsite.keys];
  if (keys.length === 0) return log("请先至少勾选一个账号", "warn");

  const dataUrl = await fileToDataUrl(file);
  $("#onsite-result").innerHTML = `<div class="dim">识别中 …（${Math.round(file.size / 1024)} KB，${keys.length} 个账号）</div>`;
  try {
    const result = await api("/api/scan-submit", { keys, image: dataUrl });
    renderOnsiteResult(result);
  } catch (err) {
    $("#onsite-result").innerHTML = `<div class="result-row bad"><span class="tag">出错</span><span class="why">${escapeHtml(err.message)}</span></div>`;
  }
}

$("#onsite-camera").addEventListener("change", (e) => {
  onsiteScan(e.target.files?.[0]);
  e.target.value = "";
});
$("#onsite-gallery").addEventListener("change", (e) => {
  onsiteScan(e.target.files?.[0]);
  e.target.value = "";
});
$("#accounts-refresh").addEventListener("click", () => loadAccounts());
$("#onsite-all").addEventListener("change", (e) => {
  onsite.keys.clear();
  if (e.target.checked) for (const a of onsite.accounts) onsite.keys.add(a.key);
  loadAccounts();
});
$("#acc-add").addEventListener("click", async () => {
  const key = $("#acc-key").value.trim();
  const email = $("#acc-email").value.trim();
  const password = $("#acc-pass").value;
  if (!key || !email || !password) return log("备注名 / 手机号 / 密码都要填", "warn");
  $("#acc-hint").textContent = "正在登录验证 …";
  try {
    const r = await api("/api/accounts/add", { key, email, password });
    $("#acc-hint").textContent = `已添加并验证：${r.name}（${r.school || "—"}）`;
    log(`已添加账号 ${key} -> ${r.name}`, "ok");
    $("#acc-key").value = $("#acc-email").value = $("#acc-pass").value = "";
    await loadAccounts();
    await initAccounts();
  } catch (err) {
    $("#acc-hint").textContent = `添加失败：${err.message}`;
    log(`添加账号失败：${err.message}`, "err");
  }
});

// ---------------------------------------------------------------- 启动

(async function main() {
  log("页面已就绪");
  await initAccounts();
  await loadAccounts();
  await refreshStatus();
  scheduleRefresh();
})();
