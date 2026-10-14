/**
 * 完整链路实验：
 *   创建二维码签到 -> 取二维码票据 -> 提交 AttenceResult -> 校验结果 -> 清理
 * 同时观察「二维码是否会轮换」：连续多次 getQrCode，比较 ticketid/expire/sign。
 *
 * 用法: node tools/exp-full.mjs <courseid> [--who student|teacher]
 */
import { KtpClient } from "../src/client.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";
import { parseQrTicket, secondsUntilExpire } from "../src/qr.ts";

const config = loadConfig();
const who = process.argv.includes("--who")
  ? process.argv[process.argv.indexOf("--who") + 1]
  : "student";
const courseid = process.argv[2];
if (!courseid) {
  console.error("用法: node tools/exp-full.mjs <courseid> [--who student|teacher]");
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
const show = (r, max = 1600) => console.log(`HTTP ${r.status}\n${JSON.stringify(r.json ?? r.body, null, 2).slice(0, max)}`);

// ---------------------------------------------------------------- 1
step(1, `以 ${who} 身份创建二维码签到`);
const created = await client.call("/AttenceApi/addAttence", {
  courseid,
  title: "链路实验(稍后删除)",
});
const attenceid = created.json?.data?.attenceid ?? created.json?.data?.id;
console.log(`attenceid = ${attenceid}  /  info = ${created.json?.data?.info}`);
if (!attenceid) {
  show(created);
  process.exit(1);
}

// ---------------------------------------------------------------- 2
step(2, "教师视角 getNotFinishAttence（未结束的考勤列表）");
show(await client.call("/AttenceApi/getNotFinishAttence", { courseid }));

// ---------------------------------------------------------------- 3
step(3, "连续 3 次 getQrCode，观察二维码是否轮换");
const tickets = [];
for (let i = 1; i <= 3; i++) {
  const started = Date.now();
  const res = await client.call("/AttenceApi/getQrCode", { attenceid });
  const data = res.json?.data ?? {};
  const url = data.mobileCheckInUrl ?? data.qrcode ?? "";
  let parsed = null;
  try {
    parsed = parseQrTicket(url);
  } catch (err) {
    console.log(`  解析失败: ${err.message}`);
  }
  if (parsed) tickets.push(parsed);
  console.log(
    `  第${i}次 (${Date.now() - started}ms): ticketid=${parsed?.ticketid ?? "?"} expire=${parsed?.expire ?? "?"} 剩余=${parsed ? secondsUntilExpire(parsed).toFixed(0) : "?"}s sign=${parsed?.sign?.slice(0, 16) ?? "?"}...`,
  );
  console.log(`        randNum = ${new URL(url).searchParams.get("randNum")}`);
  await new Promise((r) => setTimeout(r, 1200));
}
const distinct = new Set(tickets.map((t) => t.ticketid));
console.log(
  `\n>>> 轮换结论：3 次拿到 ${distinct.size} 个不同 ticketid → ${distinct.size > 1 ? "会轮换" : "不轮换（同一个票据一直有效）"}`,
);

// ---------------------------------------------------------------- 4
step(4, "学生视角 getNotFinishAttenceStudent（能否看到这次签到）");
show(await client.call("/AttenceApi/getNotFinishAttenceStudent", { courseid }));

// ---------------------------------------------------------------- 5
step(5, "用票据提交 AttenceApi/AttenceResult");
const ticket = tickets.at(-1);
if (!ticket) {
  console.log("没有票据，跳过。");
} else {
  const res = await client.call("/AttenceApi/AttenceResult", {
    ticketid: ticket.ticketid,
    expire: ticket.expire,
    sign: ticket.sign,
  });
  show(res);
  console.log(
    `\n>>> ${KtpClient.qrSucceeded(res.json) ? "✅ state=8 签到成功" : "❌ 未成功：" + (res.json?.message ?? "")}`,
  );
}

// ---------------------------------------------------------------- 6
step(6, "getCheckInResult 查看签到结果");
show(await client.call("/AttenceApi/getCheckInResult", { attenceid }));

// ---------------------------------------------------------------- 7
step(7, "清理：结束并删除实验考勤");
show(await client.call("/AttenceApi/overAttence", { id: attenceid }), 400);
show(await client.call("/AttenceApi/delAttence", { attenceid }), 400);

console.log("\n实验结束。");
