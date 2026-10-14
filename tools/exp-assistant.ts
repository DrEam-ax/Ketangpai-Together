/**
 * 关键实验：如果学生拿到该课程的「助教」身份，能不能调 getQrCode？
 *
 * 能 -> 整个功能就变成全自动：不需要二维码、不需要任何人配合，
 *       只要轮询未完成签到 + 取票据 + 提交即可。
 * 不能 -> 确认「必须有人在教室给二维码」这条约束无法绕过。
 *
 * 用法: node tools/exp-assistant.ts <courseid> [--keep]
 *   --keep 表示测完保留助教身份（方便你接着在网页上验证全自动）
 */
import { KtpClient } from "../src/client.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";
import { parseQrTicket, secondsUntilExpire } from "../src/qr.ts";

const config = loadConfig();
const args = process.argv.slice(2);
const courseid = args[0];
const keep = args.includes("--keep");
if (!courseid) {
  console.error("用法: node tools/exp-assistant.ts <courseid> [--keep]");
  process.exit(1);
}

async function makeClient(label: string, force = false): Promise<KtpClient> {
  if (!force) {
    const cached = getCachedToken(label);
    if (cached) return new KtpClient({ token: cached, label, fakeIpPrefixes: config.fakeIpPrefixes });
  }
  const account = resolveAccount(label);
  const client = new KtpClient({ label, fakeIpPrefixes: config.fakeIpPrefixes });
  setCachedToken(label, await client.login(account.email, account.password));
  return client;
}

const step = (t: string) => console.log(`\n${"=".repeat(76)}\n${t}\n${"=".repeat(76)}`);
const show = (r: { status: number; json: any }, max = 500) =>
  console.log(`HTTP ${r.status}  ${JSON.stringify(r.json).slice(0, max)}`);

const teacher = await makeClient("teacher", true);
const stu = await makeClient("stu", true);

const stuInfo = (await stu.call("/UserApi/getUserInfo", {})).json?.data;
const techInfo = (await teacher.call("/UserApi/getUserInfo", {})).json?.data;
console.log(`教师 uid = ${techInfo?.id}  (${techInfo?.username})`);
console.log(`学生 uid = ${stuInfo?.id}  (${stuInfo?.username})`);

// ---------------------------------------------------------------- 先确认现在没权限
step("① 加助教之前：学生调 getQrCode");
const attenceid0 = (await teacher.call("/AttenceApi/addNowsAttance", { courseid, title: "助教权限实验" }))
  .json?.data?.attenceid;
show(await teacher.call("/AttenceApi/getQrCode", { attenceid: attenceid0 }));
const before = await stu.call("/AttenceApi/getQrCode", { attenceid: attenceid0 });
show(before);
console.log(`学生能否取票据（加助教前）: ${before.json?.status === 1 ? "能" : "不能"}`);

// ---------------------------------------------------------------- 加助教
step("② 教师端把学生加成助教（试几种参数写法）");
const candidates = [
  { courseid, uid: stuInfo?.id },
  { courseid, uids: [stuInfo?.id] },
  { courseid, studentid: stuInfo?.id },
  { courseid, userid: stuInfo?.id },
];
let added = false;
for (const body of candidates) {
  const res = await teacher.call("/AssistantApi/addAssistant", body as Record<string, unknown>);
  const ok = res.json?.status === 1;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${JSON.stringify(body)} -> ${JSON.stringify(res.json).slice(0, 200)}`);
  if (ok) {
    added = true;
    break;
  }
}

step("③ getTeacherTeam 确认助教名单");
const team = await teacher.call("/AssistantApi/getTeacherTeam", { courseid });
show(team, 1200);

// ---------------------------------------------------------------- 再试
step("④ ★★★ 加助教之后：学生调 getQrCode");
const after = await stu.call("/AttenceApi/getQrCode", { attenceid: attenceid0 });
show(after, 1200);
let unlocked = false;
try {
  const url = after.json?.data?.mobileCheckInUrl ?? after.json?.data?.qrcode ?? "";
  if (url) {
    const t = parseQrTicket(url);
    unlocked = true;
    console.log(`\n拿到票据: ticketid=${t.ticketid} 剩余=${secondsUntilExpire(t).toFixed(0)}s`);
  }
} catch {
  /* 没拿到 */
}

console.log(
  `\n>>> 结论: 助教身份${unlocked ? " ✅ 可以取到二维码票据 —— 全自动可行！" : " ❌ 仍然取不到票据"}`,
);

// ---------------------------------------------------------------- 清理
if (!keep) {
  step("⑤ 撤销助教（--keep 可保留）");
  show(await teacher.call("/AssistantApi/delAssistant", { courseid, uid: stuInfo?.id }), 300);
} else {
  console.log("\n（已用 --keep，保留助教身份）");
}

await teacher.call("/AttenceApi/overAttence", { id: attenceid0 });
await teacher.call("/AttenceApi/delAttence", { attenceid: attenceid0 });
console.log(`\nadded=${added} unlocked=${unlocked}  实验考勤已清理。`);
