/**
 * 决定性实验：在「自己可以创建签到」的课程里造一个二维码签到，
 * 然后逐一验证几种「不需要真人扫码」的签到路径是否存在。
 *
 *   1. addAttence            创建二维码签到
 *   2. getQrCode             学生 token 能否直接取到当前二维码票据？（理想解）
 *   3. getNotFinishAttenceStudent  学生端未完成签到里是否直接带票据？
 *   4. checkin (无 code)     不带任何二维码直接提交能否成功？
 *   5. getDigitAttence       对二维码签到类型是否也下发数字码？
 *
 * 用法: node tools/exp-noqr.mjs <courseid>
 */
import { KtpClient } from "../src/client.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";

const config = loadConfig();
const who = process.env.WHO ?? "student";

async function makeClient(label) {
  const cached = getCachedToken(label);
  const client = new KtpClient({ token: cached, label, fakeIpPrefixes: config.fakeIpPrefixes });
  if (cached) return client;
  const account = resolveAccount(label);
  const token = await client.login(account.email, account.password);
  setCachedToken(label, token);
  return client;
}

const courseid = process.argv[2];
if (!courseid) {
  console.error("用法: node tools/exp-noqr.mjs <courseid>");
  process.exit(1);
}

const student = await makeClient(who);

function step(n, title) {
  console.log(`\n${"=".repeat(74)}\n[${n}] ${title}\n${"=".repeat(74)}`);
}

function show(res, max = 2000) {
  console.log(`HTTP ${res.status}`);
  console.log(JSON.stringify(res.json ?? res.body, null, 2).slice(0, max));
}

// ---------------------------------------------------------------- 1
step(1, "创建二维码签到 addAttence");
const created = await student.call("/AttenceApi/addAttence", {
  courseid,
  title: "远程签到链路实验",
});
show(created);

const data = created.json?.data;
const attenceid = typeof data === "string" ? data : (data?.id ?? data?.attenceid);
console.log(`\n>>> attenceid = ${attenceid}`);
if (!attenceid) {
  console.log("没拿到 attenceid，后续实验无法进行。");
  process.exit(1);
}

// ---------------------------------------------------------------- 2
step(2, "★ 核心问题：用学生 token 调 getQrCode 能否拿到 ticketid/expire/sign");
const qr = await student.call("/AttenceApi/getQrCode", { attenceid });
show(qr);

const ticket = qr.json?.data;
const hasTicket = Boolean(ticket && (ticket.ticketid ?? ticket.ticketId) && ticket.sign);
console.log(
  `\n>>> getQrCode 结论：${hasTicket ? "✅ 学生也能取到二维码票据 —— 可以完全无人配合！" : "❌ 拿不到票据（多半是教师权限）"}`,
);

// ---------------------------------------------------------------- 3
step(3, "学生视角 getNotFinishAttenceStudent（未完成签到里是否直接带票据）");
show(await student.call("/AttenceApi/getNotFinishAttenceStudent", { courseid }));

// ---------------------------------------------------------------- 4
step(4, "不带任何二维码，直接 POST AttenceApi/checkin");
show(
  await student.call("/AttenceApi/checkin", {
    id: attenceid,
    code: "",
    unusual: "",
    latitude: "",
    longitude: "",
    accuracy: "",
    clienttype: 1,
  }),
);

// ---------------------------------------------------------------- 5
step(5, "二维码签到类型下 getDigitAttence 是否下发数字码");
show(await student.call("/AttenceApi/getDigitAttence", { id: attenceid }));

// ---------------------------------------------------------------- 6
if (hasTicket) {
  step(6, "用 getQrCode 拿到的票据正式提交 AttenceResult");
  const tk = ticket;
  const res = await student.call("/AttenceApi/AttenceResult", {
    ticketid: tk.ticketid ?? tk.ticketId,
    expire: String(tk.expire),
    sign: tk.sign,
  });
  show(res);
  console.log(`\n>>> 提交结果: ${KtpClient.qrSucceeded(res.json) ? "✅ state=8 签到成功" : "❌ 未成功"}`);
}

// ---------------------------------------------------------------- 清理
step(9, "结束这个实验签到 overAttence");
show(await student.call("/AttenceApi/overAttence", { id: attenceid }));

console.log("\n实验结束。");
