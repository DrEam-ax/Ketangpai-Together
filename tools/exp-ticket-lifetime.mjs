/**
 * 票据生命周期实验 —— 直接决定「朋友发一张二维码照片」这条路走不走得通。
 *
 *   A. 旧票据是否仍有效：老师取票据 tA1，随后又取了一次 tA2（签发更新的 sign），
 *      此时用 tA1 签到还能不能成功？
 *      -> 能：说明「旧二维码/截图」在一段时间内都可用，朋友发照片完全可行。
 *
 *   B. 过期票据：取票据后等 320 秒再用（超过 300 秒有效期），验证是否被拒。
 *      -> 验证「过期二维码」到底能不能签（用户想知道的）。
 *
 * 用法: node tools/exp-ticket-lifetime.mjs <courseid>
 */
import { KtpClient } from "../src/client.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";
import { parseQrTicket, secondsUntilExpire } from "../src/qr.ts";

const config = loadConfig();
const courseid = process.argv[2];
if (!courseid) {
  console.error("用法: node tools/exp-ticket-lifetime.mjs <courseid>");
  process.exit(1);
}

const LOG = (msg) => console.log(`[${new Date().toLocaleTimeString("zh-CN")}] ${msg}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function makeClient(label, force = false) {
  if (!force) {
    const cached = getCachedToken(label);
    if (cached) return new KtpClient({ token: cached, label, fakeIpPrefixes: config.fakeIpPrefixes });
  }
  const account = resolveAccount(label);
  const client = new KtpClient({ label, fakeIpPrefixes: config.fakeIpPrefixes });
  setCachedToken(label, await client.login(account.email, account.password));
  return client;
}

async function ticketOf(client, attenceid) {
  const res = await client.call("/AttenceApi/getQrCode", { attenceid });
  const url = res.json?.data?.mobileCheckInUrl ?? res.json?.data?.qrcode ?? "";
  if (!url) throw new Error(`取票失败: ${JSON.stringify(res.json)}`);
  return parseQrTicket(url);
}

async function newAttendance(client, title) {
  const res = await client.call("/AttenceApi/addNowsAttance", { courseid, title });
  const id = res.json?.data?.attenceid;
  if (!id) throw new Error(`建考勤失败: ${JSON.stringify(res.json)}`);
  return id;
}

const teacher = await makeClient("teacher", true);
const stu = await makeClient("stu", true);

// ============================ A 旧票据是否仍有效 ============================
LOG("=== 实验 A：旧票据在「已签发更新 sign」之后是否仍有效 ===");
const attA = await newAttendance(teacher, "票据实验A-旧票据有效性");
LOG(`考勤 A = ${attA}`);

const tA1 = await ticketOf(teacher, attA);
LOG(`取到 tA1: sign=${tA1.sign.slice(0, 16)}... 剩余=${secondsUntilExpire(tA1).toFixed(0)}s`);

await sleep(4000);
const tA2 = await ticketOf(teacher, attA);
LOG(`取到 tA2: sign=${tA2.sign.slice(0, 16)}... 剩余=${secondsUntilExpire(tA2).toFixed(0)}s`);
LOG(`两次 sign 是否相同: ${tA1.sign === tA2.sign}`);

LOG("用「较旧的 tA1」提交签到 ...");
const resA = await stu.call("/AttenceApi/AttenceResult", {
  ticketid: tA1.ticketid,
  expire: tA1.expire,
  sign: tA1.sign,
});
LOG(`结果: state=${resA.json?.data?.state} message=${resA.json?.message ?? ""}`);
LOG(`A 结论: ${KtpClient.qrSucceeded(resA.json) ? "✅ 旧票据仍然有效 —— 朋友发照片/截图完全可行" : "❌ 旧票据作废 —— 必须实时获取二维码"}`);

// ============================ B 过期票据 ============================
LOG("");
LOG("=== 实验 B：票据过期（>300s）后是否还能签 ===");
const attB = await newAttendance(teacher, "票据实验B-过期票据");
LOG(`考勤 B = ${attB}`);
const tB = await ticketOf(teacher, attB);
LOG(`取到 tB: sign=${tB.sign.slice(0, 16)}... 剩余=${secondsUntilExpire(tB).toFixed(0)}s`);
LOG("等待 330 秒后再提交 ...");
await sleep(330_000);
LOG(`现在剩余=${secondsUntilExpire(tB).toFixed(0)}s，提交 ...`);
const resB = await stu.call("/AttenceApi/AttenceResult", {
  ticketid: tB.ticketid,
  expire: tB.expire,
  sign: tB.sign,
});
LOG(`结果: state=${resB.json?.data?.state} message=${resB.json?.message ?? ""}`);
LOG(`B 结论: ${KtpClient.qrSucceeded(resB.json) ? "❗ 过期票据居然也能签" : "❌ 过期票据确实无法签到（与官方提示一致）"}`);

// ============================ 清理 ============================
LOG("");
LOG("=== 清理 ===");
for (const id of [attA, attB]) {
  await teacher.call("/AttenceApi/overAttence", { id });
  const del = await teacher.call("/AttenceApi/delAttence", { attenceid: id });
  LOG(`删除 ${id} -> status=${del.json?.status}`);
}
LOG("实验结束");
