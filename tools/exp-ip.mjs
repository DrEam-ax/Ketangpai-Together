/**
 * 探测：课堂派考勤记录里的 IP 到底从哪来？
 *
 * 背景：用我们的工具签到，教师端看到的 IP 是 0.0.0.0；
 *       而同学用自己微信扫的显示真实公网 IP（如 203.0.113.222）。
 *
 * 怀疑点：我们的假 IP 生成器拼出来是「三段式」的非法地址，
 *         例如 223.104.137（只有 3 段）—— 服务端解析失败就记成 0.0.0.0。
 *
 * 做法：在测试班建一个二维码考勤，用不同的 IP 头提交，然后读教师端名单看记录了哪个 IP。
 *
 * 用法: node tools/exp-ip.mjs <courseid>
 */
import { KtpClient } from "../src/client.ts";
import { BASE_HEADERS, API_BASE } from "../src/constants.ts";
import { httpRequest } from "../src/http.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";
import { parseQrTicket } from "../src/qr.ts";

const config = loadConfig();
const courseid = process.argv[2];
if (!courseid) {
  console.error("用法: node tools/exp-ip.mjs <courseid>");
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

/** 用指定的 IP 头提交票据（绕开 KtpClient 自带的随机假 IP）。 */
async function submitWithIp(token, ticket, headers) {
  const res = await httpRequest(`${API_BASE}/AttenceApi/AttenceResult`, {
    method: "POST",
    headers: { ...BASE_HEADERS, token, ...headers },
    body: {
      ticketid: ticket.ticketid,
      expire: ticket.expire,
      sign: ticket.sign,
      reqtimestamp: Date.now(),
    },
  });
  return res.json;
}

/** 读教师端的学生名单，把带 ip 的字段都打印出来。 */
async function dumpStudentList(teacher, attenceid, label) {
  const res = await teacher.call("/AttenceV2Api/getAttenceStudentLists", {
    attenceid,
    state: "",
    page: 1,
    name: "",
  });
  const text = JSON.stringify(res.json);
  console.log(`\n--- ${label} 名单原始返回（截断 900 字符）---`);
  console.log(text.slice(0, 900));

  // 找出所有疑似 IP 的字段
  const found = [];
  const walk = (obj, path) => {
    if (obj === null || typeof obj !== "object") return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string" && /^(\d{1,3}\.){3}\d{1,3}$/.test(v)) {
        found.push(`${path}.${k} = ${v}`);
      }
      if (v && typeof v === "object") walk(v, `${path}.${k}`);
    }
  };
  walk(res.json, "");
  console.log(`>>> 在返回里找到的 IP 字段：${found.length ? found.join(" | ") : "（没有）"}`);
  return found;
}

const teacher = await makeClient("teacher");
const stu = await makeClient("stu");

const created = await teacher.call("/AttenceApi/addNowsAttance", {
  courseid,
  title: "IP 探测实验(稍后删除)",
});
const attenceid = created.json?.data?.attenceid;
console.log(`考勤 id = ${attenceid}`);

const qr = await teacher.call("/AttenceApi/getQrCode", { attenceid });
const ticket = parseQrTicket(qr.json?.data?.mobileCheckInUrl ?? "");
console.log(`票据剩余 ${(Number(ticket.expire) - Date.now() / 1000).toFixed(0)}s`);

const CASES = [
  ["什么都不带（对照）", {}],
  ["合法 XFF", { "X-Forwarded-For": "203.0.113.77" }],
  ["三段式 XFF（我们现在的写法）", { "X-Forwarded-For": "223.104.137" }],
  ["X-Real-IP", { "X-Real-IP": "203.0.113.55" }],
  ["合法 XFF + X-Real-IP", { "X-Forwarded-For": "203.0.113.201", "X-Real-IP": "203.0.113.201" }],
];

for (const [label, headers] of CASES) {
  const json = await submitWithIp(stu.token, ticket, headers);
  const state = json?.data?.state;
  console.log(
    `\n提交(${label}) -> state=${state} ${state === 8 ? "成功" : JSON.stringify(json).slice(0, 120)}`,
  );
  if (state === 8) await dumpStudentList(teacher, attenceid, label);
  await new Promise((r) => setTimeout(r, 1200));
}

console.log("\n--- 清理 ---");
await teacher.call("/AttenceApi/overAttence", { id: attenceid });
await teacher.call("/AttenceApi/delAttence", { attenceid });
console.log("已删除探测考勤。");
