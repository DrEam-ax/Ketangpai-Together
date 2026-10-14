/**
 * 数字码签到（= 课堂派的「扫一扫签到」）完整链路实验。
 * 数字签到同时下发 4 位数字码 与 二维码票据，学生两种方式都能签。
 *
 * 用法: node tools/exp-digit.mjs <courseid> [--who student|teacher]
 */
import { KtpClient } from "../src/client.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";
import { parseQrTicket, secondsUntilExpire } from "../src/qr.ts";

const config = loadConfig();
const argv = process.argv.slice(2);
const who = argv.includes("--who") ? argv[argv.indexOf("--who") + 1] : "student";
const courseid = argv[0];
if (!courseid) {
  console.error("用法: node tools/exp-digit.mjs <courseid> [--who student|teacher]");
  process.exit(1);
}

async function makeClient(label) {
  const cached = getCachedToken(label);
  const client = new KtpClient({ token: cached, label, fakeIpPrefixes: config.fakeIpPrefixes });
  if (cached) return client;
  const account = resolveAccount(label);
  const token = await client.login(account.email, account.password);
  setCachedToken(label, token);
  return client;
}

const client = await makeClient(who);
const step = (n, t) => console.log(`\n${"=".repeat(74)}\n[${n}] ${t}\n${"=".repeat(74)}`);
const show = (r, max = 1400) =>
  console.log(`HTTP ${r.status}\n${JSON.stringify(r.json ?? r.body, null, 2).slice(0, max)}`);

step(1, `以 ${who} 身份创建数字码签到 addDigitAttence`);
const created = await client.call("/AttenceApi/addDigitAttence", {
  courseid,
  title: "数字签到链路实验(稍后删除)",
});
show(created, 900);
const attenceid = created.json?.data?.attenceid ?? created.json?.data?.id;
console.log(`\nattenceid = ${attenceid}`);
if (!attenceid) process.exit(1);

step(2, "getDigitAttence —— 取 4 位数字码");
const digit = await client.call("/AttenceApi/getDigitAttence", { id: attenceid });
show(digit);

step(3, "getQrCode ×2 —— 二维码票据与轮换情况");
const tickets = [];
for (let i = 1; i <= 2; i++) {
  const res = await client.call("/AttenceApi/getQrCode", { attenceid });
  const data = res.json?.data ?? {};
  const url = data.mobileCheckInUrl ?? data.qrcode ?? "";
  try {
    const t = parseQrTicket(url);
    tickets.push(t);
    console.log(
      `  第${i}次: ticketid=${t.ticketid}  expire=${t.expire}  剩余=${secondsUntilExpire(t).toFixed(0)}s  sign=${t.sign.slice(0, 20)}...`,
    );
    console.log(`        full url = ${url}`);
  } catch (err) {
    console.log(`  第${i}次解析失败: ${err.message}`);
    console.log(`        raw = ${JSON.stringify(data).slice(0, 400)}`);
  }
  await new Promise((r) => setTimeout(r, 1500));
}

step(4, "学生视角 getNotFinishAttenceStudent");
show(await client.call("/AttenceApi/getNotFinishAttenceStudent", { courseid }));

step(5, "教师视角 getNotFinishAttence");
show(await client.call("/AttenceApi/getNotFinishAttence", { courseid }));

step(6, "用票据提交 AttenceResult");
const ticket = tickets.at(-1);
if (ticket) {
  const res = await client.call("/AttenceApi/AttenceResult", {
    ticketid: ticket.ticketid,
    expire: ticket.expire,
    sign: ticket.sign,
  });
  show(res);
  console.log(`\n>>> ${KtpClient.qrSucceeded(res.json) ? "✅ state=8" : "❌ " + (res.json?.message ?? "")}`);
} else {
  console.log("无票据");
}

step(7, "清理");
show(await client.call("/AttenceApi/overAttence", { id: attenceid }), 300);
show(await client.call("/AttenceApi/delAttence", { attenceid }), 300);

console.log("\n实验结束。");
