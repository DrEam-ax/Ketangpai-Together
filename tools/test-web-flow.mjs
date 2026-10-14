/**
 * 端到端集成测试：走完整的「朋友拍照 -> 上传 -> 自动签到」链路。
 *   1. 教师端创建二维码考勤
 *   2. 教师端取二维码 URL
 *   3. 把 URL 渲染成二维码图片（模拟大屏幕）
 *   4. 以 base64 形式 POST 到本地服务 /api/frame（模拟上传一张照片）
 *   5. 校验学生签到成功
 *   6. 清理
 *
 * 用法: node tools/test-web-flow.mjs <courseid> [serverUrl]
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { KtpClient } from "../src/client.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";
import { parseQrTicket, secondsUntilExpire } from "../src/qr.ts";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const courseid = process.argv[2];
const serverUrl = process.argv[3] ?? "http://127.0.0.1:8787";
if (!courseid) {
  console.error("用法: node tools/test-web-flow.mjs <courseid> [serverUrl]");
  process.exit(1);
}

const config = loadConfig();
async function makeClient(label) {
  const cached = getCachedToken(label);
  if (cached) return new KtpClient({ token: cached, label, fakeIpPrefixes: config.fakeIpPrefixes });
  const account = resolveAccount(label);
  const client = new KtpClient({ label, fakeIpPrefixes: config.fakeIpPrefixes });
  setCachedToken(label, await client.login(account.email, account.password));
  return client;
}

const ok = (b) => (b ? "\x1b[32m✅\x1b[0m" : "\x1b[31m❌\x1b[0m");

const teacher = await makeClient("teacher");

console.log("[1] 教师端创建二维码考勤 ...");
const created = await teacher.call("/AttenceApi/addNowsAttance", {
  courseid,
  title: "Web链路端到端测试(稍后删除)",
});
const attenceid = created.json?.data?.attenceid;
console.log(`    attenceid = ${attenceid}  (${created.json?.data?.info})`);

console.log("[2] 教师端取二维码 ...");
const qrRes = await teacher.call("/AttenceApi/getQrCode", { attenceid });
const url = qrRes.json?.data?.mobileCheckInUrl;
const ticket = parseQrTicket(url);
console.log(`    剩余 ${secondsUntilExpire(ticket).toFixed(0)} 秒`);

console.log("[3] 渲染成二维码图片 ...");
const png = path.join(ROOT, "captures", "qr", "web-flow-test.png");
fs.mkdirSync(path.dirname(png), { recursive: true });
const { stdout } = await execFileAsync("python", [path.join(ROOT, "tools", "make_qr.py"), url, png], {
  cwd: ROOT,
});
console.log(`    ${stdout.trim()}`);

console.log("[4] 以「朋友发来的照片」形式 POST 到本地服务 /api/frame ...");
const dataUrl = `data:image/png;base64,${fs.readFileSync(png).toString("base64")}`;
const res = await fetch(`${serverUrl}/api/frame`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ who: "stu", image: dataUrl, autoSubmit: true }),
});
const result = await res.json();
console.log(`    ${JSON.stringify(result, null, 2)}`);

console.log("[5] 复核学生端未完成签到 ...");
const stu = await makeClient("stu");
const nf = await stu.call("/AttenceApi/getNotFinishAttenceStudent", { courseid });
const stillOpen = (nf.json?.data?.lists ?? []).some((i) => i.id === attenceid);
console.log(`    该考勤是否仍显示未完成: ${stillOpen ? "是 ❌" : "否 ✅"}`);

console.log("[6] 清理 ...");
await teacher.call("/AttenceApi/overAttence", { id: attenceid });
await teacher.call("/AttenceApi/delAttence", { attenceid });

console.log(`\n${ok(result.ok)} 端到端结果: ${result.ok ? "签到成功" : "失败 -> " + result.message}`);
process.exit(result.ok && !stillOpen ? 0 : 1);
