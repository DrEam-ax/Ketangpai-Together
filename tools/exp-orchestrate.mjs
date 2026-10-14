/**
 * 端到端联调编排：
 *   教师端造一个数字码签到
 *   -> 教师端取二维码票据
 *   -> 学生端尝试各种「不扫码」捷径
 *   -> 学生端用教师票据完成签到
 *   -> 复查并清理
 *
 * 用法: node tools/exp-orchestrate.mjs <courseid>
 */
import { KtpClient } from "../src/client.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";
import { parseQrTicket, secondsUntilExpire } from "../src/qr.ts";

const config = loadConfig();
const courseid = process.argv[2];
const createApi = process.argv[3] ?? "/AttenceApi/addNowsAttance";
if (!courseid) {
  console.error("用法: node tools/exp-orchestrate.mjs <courseid> [createApi]");
  console.error("  createApi 默认 /AttenceApi/addNowsAttance（推测=二维码考勤）");
  process.exit(1);
}

async function makeClient(label, forceRelogin = false) {
  if (!forceRelogin) {
    const cached = getCachedToken(label);
    if (cached) {
      return new KtpClient({ token: cached, label, fakeIpPrefixes: config.fakeIpPrefixes });
    }
  }
  const account = resolveAccount(label);
  const client = new KtpClient({ label, fakeIpPrefixes: config.fakeIpPrefixes });
  const token = await client.login(account.email, account.password);
  setCachedToken(label, token);
  return client;
}

const step = (t) => console.log(`\n${"=".repeat(76)}\n${t}\n${"=".repeat(76)}`);
const show = (r, max = 1100) =>
  console.log(`HTTP ${r.status}  ${JSON.stringify(r.json ?? r.body).slice(0, max)}`);

const teacher = await makeClient("teacher", true);
const stu = await makeClient("stu", true);

// ---------------------------------------------------------------- 身份
step("① 身份确认");
for (const [label, client] of [
  ["teacher", teacher],
  ["stu", stu],
]) {
  const info = (await client.call("/UserApi/getUserInfo", {})).json?.data;
  console.log(
    `[${label}] name=${info?.username}  usertype=${info?.usertype}  stno=${info?.stno}  school=${info?.school}`,
  );
}

step("② 学生号看到的课程");
for (const c of await stu.getSemesterCourseList()) {
  console.log(`  ${c.id}  ${c.coursename}  role=${c.role}  code=${c.code}`);
}

// ---------------------------------------------------------------- 造签到
step(`③ 教师端创建考勤 ${createApi}`);
const created = await teacher.call(createApi, {
  courseid,
  title: "端到端联调(稍后删除)",
});
const attenceid = created.json?.data?.attenceid;
console.log(`attenceid = ${attenceid}   info=${created.json?.data?.info}`);
console.log(`考勤 type = ${created.json?.data?.attence?.type}`);
if (!attenceid) {
  show(created);
  process.exit(1);
}

step("④ 教师端取二维码票据 getQrCode");
const tQr = await teacher.call("/AttenceApi/getQrCode", { attenceid });
const tUrl = tQr.json?.data?.mobileCheckInUrl ?? "";
console.log(`教师票据 URL: ${tUrl}`);
const teacherTicket = tUrl ? parseQrTicket(tUrl) : null;
if (teacherTicket) {
  console.log(
    `   ticketid=${teacherTicket.ticketid}  剩余=${secondsUntilExpire(teacherTicket).toFixed(0)}s`,
  );
}

// ---------------------------------------------------------------- 学生视角
step("⑤ 学生端 getNotFinishAttenceStudent");
const nf = await stu.call("/AttenceApi/getNotFinishAttenceStudent", { courseid });
console.log(JSON.stringify(nf.json?.data, null, 2).slice(0, 1500));
const lists = nf.json?.data?.lists ?? [];
console.log(`\n>>> 学生看到 ${lists.length} 条未完成签到`);
for (const it of lists) console.log(`    id=${it.id} type=${it.type} title=${it.title}`);

// ---------------------------------------------------------------- 关键
step("⑥ ★★★ 学生 token 调 getQrCode —— 决定架构的关键实验");
const sQr = await stu.call("/AttenceApi/getQrCode", { attenceid });
show(sQr, 1600);
let stuTicket = null;
try {
  const u = sQr.json?.data?.mobileCheckInUrl ?? sQr.json?.data?.qrcode ?? "";
  stuTicket = u ? parseQrTicket(u) : null;
} catch {
  stuTicket = null;
}
console.log(
  stuTicket
    ? `\n>>> ✅✅✅ 学生可以直接取到二维码票据！无需任何人配合，纯远程签到可行。`
    : `\n>>> ❌ 学生取不到票据（${sQr.json?.message ?? "无数据"}），必须有二维码来源。`,
);

// ---------------------------------------------------------------- 用教师票据签到
if (teacherTicket) {
  step("⑦ 学生端拿「教师端取到的票据」提交 AttenceResult");
  const r = await stu.call("/AttenceApi/AttenceResult", {
    ticketid: teacherTicket.ticketid,
    expire: teacherTicket.expire,
    sign: teacherTicket.sign,
  });
  show(r, 900);
  console.log(
    `\n>>> ${KtpClient.qrSucceeded(r.json) ? "✅ state=8 二维码签到成功（证明票据与学生身份无关，一份票据可签多个账号）" : "❌ " + (r.json?.message ?? "")}`,
  );
}

// ---------------------------------------------------------------- 复查
step("⑧ 复查：学生端未完成签到是否已清空");
const nf2 = await stu.call("/AttenceApi/getNotFinishAttenceStudent", { courseid });
console.log(JSON.stringify(nf2.json?.data, null, 2).slice(0, 800));

// ---------------------------------------------------------------- 清理
step("⑨ 清理实验考勤");
await teacher.call("/AttenceApi/overAttence", { id: attenceid });
show(await teacher.call("/AttenceApi/delAttence", { attenceid }), 300);

console.log("\n编排实验结束。");
