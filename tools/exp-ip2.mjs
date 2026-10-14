/**
 * 逐个验证：课堂派记录下来的 IP，到底由哪个请求头决定？
 *
 * 用 /AttenceApi/getCheckInResult 读回该学生这次签到记录的 ip 字段
 * （它直接返回 ip，比翻教师端名单准确）。
 * 学生同一考勤只能签一次，所以每种情况都新建一条考勤。
 *
 * 用法: node tools/exp-ip2.mjs <courseid>
 */
import { KtpClient } from "../src/client.ts";
import { BASE_HEADERS, API_BASE } from "../src/constants.ts";
import { httpRequest } from "../src/http.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";
import { parseQrTicket } from "../src/qr.ts";

const config = loadConfig();
const courseid = process.argv[2];
if (!courseid) {
  console.error("用法: node tools/exp-ip2.mjs <courseid>");
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

const CASES = [
  ["不带任何 IP 头（对照组）", {}],
  ["合法 XFF 203.0.113.77", { "X-Forwarded-For": "203.0.113.77" }],
  ["三段式 XFF 223.104.137（我们现在的 bug）", { "X-Forwarded-For": "223.104.137" }],
  ["只带 X-Real-IP 203.0.113.55", { "X-Real-IP": "203.0.113.55" }],
  ["合法 XFF + X-Real-IP 都是 203.0.113.201", { "X-Forwarded-For": "203.0.113.201", "X-Real-IP": "203.0.113.201" }],
  ["XFF 带端口 203.0.113.77:1234", { "X-Forwarded-For": "203.0.113.77:1234" }],
  ["XFF 是内网 192.168.1.5", { "X-Forwarded-For": "192.168.1.5" }],
];

console.log("情况                                      服务端记录的 ip");
console.log("-".repeat(72));

for (const [label, headers] of CASES) {
  const created = await teacher.call("/AttenceApi/addNowsAttance", {
    courseid,
    title: "IP对照实验",
  });
  const attenceid = created.json?.data?.attenceid;
  if (!attenceid) {
    console.log(`${label}  —— 建考勤失败`);
    continue;
  }

  const qr = await teacher.call("/AttenceApi/getQrCode", { attenceid });
  const ticket = parseQrTicket(qr.json?.data?.mobileCheckInUrl ?? "");

  const submit = await httpRequest(`${API_BASE}/AttenceApi/AttenceResult`, {
    method: "POST",
    headers: { ...BASE_HEADERS, token: stu.token, ...headers },
    body: {
      ticketid: ticket.ticketid,
      expire: ticket.expire,
      sign: ticket.sign,
      reqtimestamp: Date.now(),
    },
  });
  const state = submit.json?.data?.state;

  await new Promise((r) => setTimeout(r, 600));
  const result = await stu.call("/AttenceApi/getCheckInResult", { attenceid });
  const ip = result.json?.data?.ip;
  const coord = result.json?.data?.latitude;

  console.log(
    `${label.padEnd(42)} ip=${String(ip)}  state=${state}${coord ? "  lat=" + coord : ""}`,
  );

  await teacher.call("/AttenceApi/overAttence", { id: attenceid });
  await teacher.call("/AttenceApi/delAttence", { attenceid });
  await new Promise((r) => setTimeout(r, 800));
}

console.log("-".repeat(72));
console.log("已清理全部对照考勤。");
