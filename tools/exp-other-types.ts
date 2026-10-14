/**
 * 既然二维码签到被设计成「必须有人在场」，那看看另外两种签到类型能不能纯远程完成：
 *
 *   数字码签到（type=1）：只要有人把 4 位数字发出来（群里打 4 个字，几乎零成本）
 *   定位签到（type=2）  ：只要知道教室坐标（公开信息），可能根本不需要人
 *
 * 用法: node tools/exp-other-types.ts <courseid>
 */
import { KtpClient } from "../src/client.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";

const config = loadConfig();
const courseid = process.argv[2];
if (!courseid) {
  console.error("用法: node tools/exp-other-types.ts <courseid>");
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

const step = (t: string) => console.log(`\n${"=".repeat(78)}\n${t}\n${"=".repeat(78)}`);
const show = (r: { status: number; json: any }, max = 700) =>
  console.log(`HTTP ${r.status}  ${JSON.stringify(r.json).slice(0, max)}`);

const teacher = await makeClient("teacher", true);
const stu = await makeClient("stu", true);

// =================================================================
step("A. 数字码签到：老师建签到 -> 学生用「别人转发来的 4 位数字」签到");

const digit = await teacher.call("/AttenceApi/addDigitAttence", {
  courseid,
  title: "数字码远程实验(稍后删除)",
});
const digitId = digit.json?.data?.attenceid;
console.log(`attenceid = ${digitId}`);

const codeRes = await teacher.call("/AttenceApi/getDigitAttence", { id: digitId });
const code = codeRes.json?.data?.data?.code;
console.log(`老师端拿到的数字码 = ${code}`);

if (code) {
  // 关键：学生完全不需要摄像头，只需要这 4 个数字
  const res = await stu.call("/AttenceApi/checkin", {
    id: digitId,
    code,
    unusual: "",
    latitude: "",
    longitude: "",
    accuracy: "",
    clienttype: 1,
  });
  show(res);
  console.log(
    `>>> 数字码远程签到: ${KtpClient.checkinSucceeded(res.json) ? "✅ 成功（只需要 4 个数字，不需要在场）" : "❌ " + (res.json?.message ?? "")}`,
  );
}

// 顺便验证：没有数字码时能不能签（应该不行）
const noCode = await stu.call("/AttenceApi/checkin", {
  id: digitId,
  code: "",
  unusual: "",
  latitude: "",
  longitude: "",
  accuracy: "",
  clienttype: 1,
});
console.log(`\n不带数字码直接提交 -> ${noCode.json?.message ?? JSON.stringify(noCode.json).slice(0, 120)}`);

// =================================================================
step("B. 定位签到：老师建签到 -> 学生只填教室坐标签到");

const gps = await teacher.call("/AttenceApi/addGPSAttence", {
  courseid,
  title: "定位远程实验(稍后删除)",
});
const gpsId = gps.json?.data?.attenceid;
console.log(`attenceid = ${gpsId}  (${gps.json?.data?.info ?? ""})`);

// 老师这个签到要求的位置
const loc = await teacher.call("/AttenceApi/getLocation", { attenceid: gpsId });
show(loc, 800);

const locData = loc.json?.data ?? {};
const lat = String(locData.latitude ?? locData.lat ?? "39.9042");
const lng = String(locData.longitude ?? locData.lng ?? "116.4074");
console.log(`\n用教室坐标 latitude=${lat} longitude=${lng} 提交（学生不在教室）...`);

const gpsRes = await stu.call("/AttenceApi/checkin", {
  id: gpsId,
  code: "",
  unusual: "",
  latitude: lat,
  longitude: lng,
  accuracy: "30",
  clienttype: 1,
});
show(gpsRes, 900);
console.log(
  `>>> 定位远程签到: ${KtpClient.checkinSucceeded(gpsRes.json) ? "✅ 成功（只要坐标对，不需要在场！）" : "❌ " + (gpsRes.json?.message ?? "")}`,
);

// =================================================================
step("清理");
for (const id of [digitId, gpsId]) {
  if (!id) continue;
  await teacher.call("/AttenceApi/overAttence", { id });
  const del = await teacher.call("/AttenceApi/delAttence", { attenceid: id });
  console.log(`  删除 ${id} -> status=${del.json?.status}`);
}
console.log("\n实验结束。");
