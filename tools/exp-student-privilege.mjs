/**
 * 学生 token 权限探测：面对一个「进行中的二维码考勤」，
 * 把所有可能泄露二维码票据 / 数字码的接口都试一遍。
 *
 * 只要有一个能用，就说明「完全不需要人配合」是可行的。
 *
 * 用法: node tools/exp-student-privilege.mjs <courseid>
 */
import { KtpClient } from "../src/client.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";
import { parseQrTicket, secondsUntilExpire } from "../src/qr.ts";

const config = loadConfig();
const courseid = process.argv[2];
if (!courseid) {
  console.error("用法: node tools/exp-student-privilege.mjs <courseid>");
  process.exit(1);
}

async function makeClient(label) {
  const cached = getCachedToken(label);
  if (cached) return new KtpClient({ token: cached, label, fakeIpPrefixes: config.fakeIpPrefixes });
  const account = resolveAccount(label);
  const client = new KtpClient({ label, fakeIpPrefixes: config.fakeIpPrefixes });
  setCachedToken(label, await client.login(account.email, account.password));
  return client;
}

const teacher = await makeClient("teacher");
const stu = await makeClient("stu");

// ---- 教师端造一个二维码考勤，并拿到「标准答案」票据 ----
const created = await teacher.call("/AttenceApi/addNowsAttance", {
  courseid,
  title: "权限探测(稍后删除)",
});
const attenceid = created.json?.data?.attenceid;
console.log(`考勤 id = ${attenceid}\n`);

const truth = await teacher.call("/AttenceApi/getQrCode", { attenceid });
const truthUrl = truth.json?.data?.mobileCheckInUrl ?? "";
const truthTicket = truthUrl ? parseQrTicket(truthUrl) : null;
console.log(`教师端正确答案: ticketid=${truthTicket?.ticketid} 剩余=${truthTicket ? secondsUntilExpire(truthTicket).toFixed(0) : "?"}s\n`);
console.log("=".repeat(78));

const CASES = [
  ["/AttenceApi/getQrCode", { attenceid }],
  ["/AttenceApi/getQrCode", { id: attenceid }],
  ["/AttenceApi/getDigitSignIn", { id: attenceid }],
  ["/AttenceApi/getDigitSignIn", { attenceid }],
  ["/AttenceApi/getDigitSignInCheckin", { attenceid }],
  ["/AttenceApi/getDigitAttence", { id: attenceid }],
  ["/AttenceApi/getCheckInResult", { attenceid }],
  ["/AttenceApi/getLocation", { attenceid }],
  ["/AttenceAttenceApi/getNotFinishAttence", { courseid }],
  ["/AttenceV2Api/getAttenceList", { courseid, page: 1, size: 20 }],
  ["/SummaryApi/attence", { courseid, page: 1, size: 20 }],
  ["/AttenceApi/attence", { courseid }],
  ["/AttenceApi/getNotFinishAttenceStudent", { courseid }],
];

const leaked = [];

for (const [path, body] of CASES) {
  const res = await stu.call(path, body);
  const json = res.json ?? {};
  const text = JSON.stringify(json);
  const ok = json.status === 1;
  // 有没有泄露 ticketid / sign / 数字码
  const hasTicket = /ticketid/i.test(text) && /sign/i.test(text);
  const hasCode = /"code"\s*:\s*"\d{4}"/.test(text);
  const flag = hasTicket ? "  <<< 泄露票据!!" : hasCode ? "  <<< 泄露数字码!!" : "";
  if (hasTicket || hasCode) leaked.push({ path, body, kind: hasTicket ? "ticket" : "code", text });

  console.log(
    `${ok ? "OK  " : "DENY"} ${path} ${JSON.stringify(body)}\n     code=${json.code ?? "-"} msg=${String(json.message ?? "").slice(0, 60)}${flag}`,
  );
  if (ok && !hasTicket && !hasCode) console.log(`     data=${text.slice(0, 260)}`);
}

console.log("=".repeat(78));
if (leaked.length === 0) {
  console.log("\n结论: 学生端拿不到票据，也没有数字码泄露 —— 必须靠外部二维码来源。");
} else {
  console.log(`\n结论: 发现 ${leaked.length} 个泄露接口！`);
  for (const l of leaked) console.log(`  ${l.path} -> ${l.kind}`);
}

// 清理
await teacher.call("/AttenceApi/overAttence", { id: attenceid });
await teacher.call("/AttenceApi/delAttence", { attenceid });
console.log("\n已清理探测考勤。");
