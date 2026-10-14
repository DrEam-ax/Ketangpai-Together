#!/usr/bin/env node
/**
 * 本地 Web 服务：给浏览器提供一个界面，
 *   - 实时查看哪些课程正在签到
 *   - 摄像头对着二维码（或大屏幕）持续扫描，识别到就自动签到
 *   - 也可以直接粘贴二维码 URL / 上传朋友发来的截图
 *
 * 启动：
 *   node src/server.ts                 # http://127.0.0.1:8787
 *   node src/server.ts --port 9000 --host 0.0.0.0
 *
 * 「现场扫码」设计给教室里那个拿手机的人用：
 *   一次扫码 -> 同时给所有勾选的账号签到（实测一张票能签任意多个账号）
 * 手机通过局域网访问即可，不需要 HTTPS —— 因为用的是
 * <input type="file" capture="environment">（调起系统相机），
 * 而不是 getUserMedia（那个在非 localhost 的 HTTP 下会被浏览器拒绝）。
 */
import http from "node:http";
import os from "node:os";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { KtpClient } from "./client.ts";
import {
  getCachedToken,
  loadConfig,
  removeAccount,
  resolveAccount,
  setCachedToken,
  upsertAccount,
} from "./config.ts";
import { parseQrTicket, secondsUntilExpire } from "./qr.ts";
import { decodeQrFromBuffer } from "./qrdecode.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = path.join(ROOT, "public");

const args = process.argv.slice(2);
function argOf(name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const PORT = Number(argOf("port", "8787"));
const HOST = argOf("host", "127.0.0.1");

// ---------------------------------------------------------------- 客户端缓存

const clients = new Map<string, KtpClient>();

async function clientFor(who: string): Promise<KtpClient> {
  const cached = clients.get(who);
  if (cached) return cached;

  const cfg = loadConfig();
  const client = new KtpClient({
    token: getCachedToken(who),
    label: who,
    fakeIpPrefixes: cfg.fakeIpPrefixes,
  });
  if (!client.token) {
    const account = resolveAccount(who);
    setCachedToken(who, await client.login(account.email, account.password));
  }
  clients.set(who, client);
  return client;
}

/** 已经成功签到过的 ticketid，避免摄像头每帧都重复提交。 */
const submitted = new Set<string>();

/** 账号显示名缓存（用户名/学校），只放在内存里。 */
const displayNames = new Map<string, { name: string; school: string; usertype: string }>();

async function describeAccount(key: string): Promise<{ name: string; school: string; usertype: string }> {
  const cached = displayNames.get(key);
  if (cached) return cached;
  try {
    const client = await clientFor(key);
    const info = (await client.call("/UserApi/getUserInfo", {})).json?.data;
    const value = {
      name: String(info?.username ?? key),
      school: String(info?.school ?? ""),
      usertype: String(info?.usertype ?? ""),
    };
    displayNames.set(key, value);
    return value;
  } catch {
    return { name: key, school: "", usertype: "" };
  }
}

function accountKeys(): string[] {
  const cfg = loadConfig();
  return Object.keys(cfg.accounts).filter((k) => cfg.accounts[k]?.email);
}

/** 局域网地址，方便手机直接打开（现场扫码用）。 */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const item of list ?? []) {
      if (item.family === "IPv4" && !item.internal) out.push(item.address);
    }
  }
  return out;
}

// ---------------------------------------------------------------- 工具

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 24 * 1024 * 1024) throw new Error("请求体过大（图片太大？）");
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, any>) : {};
}

function stripDataUrl(dataUrl: string): Buffer {
  const comma = dataUrl.indexOf(",");
  const base64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return Buffer.from(base64, "base64");
}

// ---------------------------------------------------------------- 业务

/** 限制并发的 map，避免 28 门课串行扫描要 5 秒多。 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function handleStatus(body: Record<string, any>) {
  const who = String(body.who ?? "stu");
  const client = await clientFor(who);
  let courses = await client.getMyCourses();
  const only: string[] | undefined = body.courseIds;

  if (only && only.length > 0) {
    courses = courses.filter((x) => only.includes(String(x.id)));
    for (const id of only) {
      if (!courses.some((x) => String(x.id) === id)) courses.push({ id, coursename: id });
    }
  }

  const scanned = await mapLimit(courses, 8, async (course) => {
    try {
      const list = await client.getNotFinishAttendance(String(course.id));
      if (list.length === 0) return null;
      return {
        courseId: String(course.id),
        courseName: course.coursename ?? String(course.id),
        className: course.classname ?? "",
        items: list.map((i) => ({
          id: i.id,
          type: String(i.type),
          title: i.title ?? "",
          createtime: i.createtime ?? "",
        })),
      };
    } catch {
      return null; // 无权限 / 已结课的课程直接跳过
    }
  });

  return { scanned: courses.length, courses: scanned.filter(Boolean) };
}

async function handleFrame(body: Record<string, any>) {
  const who = String(body.who ?? "stu");
  const autoSubmit = body.autoSubmit !== false;
  const image = String(body.image ?? "");
  if (!image) return { decoded: false, engine: null, message: "没有收到图像" };

  // 摄像头逐帧扫描走 fast（只试最快方案），上传的截图走完整流水线
  const fast = String(body.mode ?? "image") === "frame";
  const started = Date.now();
  const { text, engine } = await decodeQrFromBuffer(stripDataUrl(image), {
    fast,
    timeoutMs: fast ? 8_000 : 25_000,
  });
  const elapsed = Date.now() - started;
  if (!text) return { decoded: false, engine, elapsed };

  let ticket;
  try {
    ticket = parseQrTicket(text);
  } catch {
    return {
      decoded: true,
      engine,
      elapsed,
      text: text.slice(0, 200),
      isTicket: false,
      message: "识别到二维码，但不是课堂派签到二维码",
    };
  }

  const remaining = secondsUntilExpire(ticket);
  const expireAt = new Date(Number(ticket.expire) * 1000).toLocaleTimeString("zh-CN", {
    hour12: false,
  });
  const out: Record<string, unknown> = {
    decoded: true,
    engine,
    elapsed,
    isTicket: true,
    ticket: {
      ticketid: ticket.ticketid,
      expire: ticket.expire,
      sign: ticket.sign,
      remaining,
      expireAt,
    },
  };

  if (!autoSubmit) return out;

  if (remaining < -2) {
    // 关键提示：过期时间锚定在「服务端签发这张票的时刻」，不是「你拍照的时刻」。
    // 屏幕上那张二维码可能已经挂了好几分钟了。
    out.message =
      `这张二维码 ${expireAt} 就失效了（已过期 ${Math.abs(remaining).toFixed(0)} 秒）。` +
      `注意有效期是从服务端签发那一刻算起的，不是你拍照那一刻 —— 需要让教室那边重新出示一次二维码。`;
    return out;
  }

  const key = `${who}:${ticket.ticketid}`;
  if (submitted.has(key)) {
    out.message = "这个二维码已经签到过了";
    return out;
  }

  const client = await clientFor(who);
  const res = await client.submitQrTicket(ticket);
  const ok = KtpClient.qrSucceeded(res.json);
  out.submitted = true;
  out.ok = ok;
  out.state = res.json?.data?.state ?? null;
  out.message = ok
    ? String(res.json?.data?.info ?? "签到成功").replace(/<br\s*\/?>/g, " ")
    : String(res.json?.message ?? "签到失败");
  if (ok) submitted.add(key);
  return out;
}

// ---------------------------------------------------------------- 服务器

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  try {
    // --- 静态资源 ---
    if (req.method === "GET" && !url.pathname.startsWith("/api/")) {
      const rel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
      const file = path.join(PUBLIC_DIR, rel);
      if (!file.startsWith(PUBLIC_DIR)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      try {
        const data = await readFile(file);
        res.writeHead(200, {
          "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
          "Cache-Control": "no-store",
        });
        res.end(data);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404");
      }
      return;
    }

    // --- API ---
    if (req.method === "POST" && url.pathname.startsWith("/api/")) {
      const body = await readJson(req);
      switch (url.pathname) {
        case "/api/config": {
          const cfg = loadConfig();
          sendJson(res, 200, {
            accounts: accountKeys(),
            defaultWho: cfg.accounts.stu?.email ? "stu" : (accountKeys()[0] ?? "stu"),
            lanUrls: lanAddresses().map((ip) => `http://${ip}:${PORT}`),
          });
          return;
        }
        case "/api/accounts": {
          const list = await Promise.all(
            accountKeys().map(async (key) => ({ key, ...(await describeAccount(key)) })),
          );
          sendJson(res, 200, { accounts: list });
          return;
        }
        case "/api/accounts/add": {
          const key = String(body.key ?? "").trim();
          const email = String(body.email ?? "").trim();
          const password = String(body.password ?? "");
          if (!key || !email || !password) {
            sendJson(res, 400, { error: "key / email / password 都不能为空" });
            return;
          }
          // 先验证能登录，再落盘，避免存进去一个错的
          const probe = new KtpClient({ label: key, fakeIpPrefixes: loadConfig().fakeIpPrefixes });
          const token = await probe.login(email, password);
          const info = (await probe.call("/UserApi/getUserInfo", {})).json?.data;
          upsertAccount(key, { email, password });
          setCachedToken(key, token);
          clients.set(key, probe);
          displayNames.set(key, {
            name: String(info?.username ?? key),
            school: String(info?.school ?? ""),
            usertype: String(info?.usertype ?? ""),
          });
          sendJson(res, 200, {
            ok: true,
            key,
            name: String(info?.username ?? key),
            school: String(info?.school ?? ""),
          });
          return;
        }
        case "/api/accounts/remove": {
          const key = String(body.key ?? "");
          if (!key) {
            sendJson(res, 400, { error: "缺少 key" });
            return;
          }
          removeAccount(key);
          clients.delete(key);
          displayNames.delete(key);
          sendJson(res, 200, { ok: true, key });
          return;
        }
        case "/api/scan-submit": {
          // 一次扫码，给所有勾选的账号签到
          const keys: string[] = Array.isArray(body.keys) && body.keys.length > 0
            ? body.keys.map(String)
            : accountKeys();
          const image = String(body.image ?? "");
          if (!image) {
            sendJson(res, 400, { error: "没有收到图像" });
            return;
          }
          const started = Date.now();
          const { text, engine } = await decodeQrFromBuffer(stripDataUrl(image), {
            timeoutMs: 25_000,
          });
          if (!text) {
            sendJson(res, 200, { decoded: false, engine, message: "没能从图片里识别出二维码" });
            return;
          }
          let ticket;
          try {
            ticket = parseQrTicket(text);
          } catch {
            sendJson(res, 200, {
              decoded: true,
              engine,
              isTicket: false,
              message: "识别到二维码，但不是课堂派签到二维码",
              text: text.slice(0, 200),
            });
            return;
          }
          const remaining = secondsUntilExpire(ticket);
          const ticketInfo = {
            ticketid: ticket.ticketid,
            expireAt: new Date(Number(ticket.expire) * 1000).toLocaleTimeString("zh-CN", {
              hour12: false,
            }),
            remaining,
          };
          if (remaining < -2) {
            sendJson(res, 200, {
              decoded: true,
              engine,
              isTicket: true,
              ticket: ticketInfo,
              results: [],
              message: `这张票 ${ticketInfo.expireAt} 就失效了（已过期 ${Math.abs(remaining).toFixed(0)} 秒），需要重新扫一张新的`,
            });
            return;
          }

          const results = await mapLimit(keys, 4, async (key) => {
            const label = (await describeAccount(key)).name;
            try {
              const client = await clientFor(key);
              const res2 = await client.submitQrTicket(ticket!);
              const ok = KtpClient.qrSucceeded(res2.json);
              return {
                key,
                label,
                ok,
                state: res2.json?.data?.state ?? null,
                message: String(
                  ok ? (res2.json?.data?.info ?? "签到成功") : (res2.json?.message ?? "签到失败"),
                ).replace(/<br\s*\/?>/g, " "),
              };
            } catch (err) {
              return {
                key,
                label,
                ok: false,
                message: err instanceof Error ? err.message : String(err),
              };
            }
          });

          sendJson(res, 200, {
            decoded: true,
            engine,
            isTicket: true,
            elapsed: Date.now() - started,
            ticket: ticketInfo,
            results,
            okCount: results.filter((r) => r.ok).length,
          });
          return;
        }
        case "/api/whoami": {
          const who = String(body.who ?? "stu");
          const client = await clientFor(who);
          const info = (await client.call("/UserApi/getUserInfo", {})).json?.data;
          sendJson(res, 200, { who, name: info?.username, usertype: info?.usertype, school: info?.school });
          return;
        }
        case "/api/courses": {
          const client = await clientFor(String(body.who ?? "stu"));
          sendJson(res, 200, { courses: await client.getMyCourses() });
          return;
        }
        case "/api/status":
          sendJson(res, 200, await handleStatus(body));
          return;
        case "/api/frame":
          sendJson(res, 200, await handleFrame(body));
          return;
        case "/api/checkin": {
          // 数字码 / 定位签到：不需要任何二维码
          const who = String(body.who ?? "stu");
          const client = await clientFor(who);
          const res2 = await client.checkin({
            id: String(body.attenceid ?? ""),
            code: body.code === undefined ? undefined : String(body.code),
            latitude: body.latitude === undefined ? undefined : String(body.latitude),
            longitude: body.longitude === undefined ? undefined : String(body.longitude),
          });
          const ok = KtpClient.checkinSucceeded(res2.json);
          sendJson(res, 200, {
            ok,
            state: res2.json?.data?.state ?? null,
            message: ok
              ? String(res2.json?.data?.info ?? "签到成功").replace(/<br\s*\/?>/g, " ")
              : String(res2.json?.message ?? "签到失败"),
          });
          return;
        }
        case "/api/submit": {
          const who = String(body.who ?? "stu");
          const ticket = parseQrTicket(String(body.url ?? ""));
          const remaining = secondsUntilExpire(ticket);
          const client = await clientFor(who);
          const res2 = await client.submitQrTicket(ticket);
          const ok = KtpClient.qrSucceeded(res2.json);
          sendJson(res, 200, {
            ok,
            remaining,
            state: res2.json?.data?.state ?? null,
            message: ok
              ? String(res2.json?.data?.info ?? "签到成功").replace(/<br\s*\/?>/g, " ")
              : String(res2.json?.message ?? "签到失败"),
          });
          return;
        }
        default:
          sendJson(res, 404, { error: "未知接口" });
          return;
      }
    }

    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404");
  } catch (err) {
    sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  课堂派签到控制台`);
  console.log(`  本机   :  http://127.0.0.1:${PORT}`);
  if (HOST === "0.0.0.0") {
    for (const ip of lanAddresses()) {
      console.log(`  局域网 :  http://${ip}:${PORT}   <- 手机用这个打开「现场扫码」`);
    }
  } else {
    console.log(`  （想让手机访问，用 --host 0.0.0.0 重启）`);
  }
  console.log();
});
