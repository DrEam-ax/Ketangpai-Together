/**
 * 验证一个猜想：票据的 expire 会不会被「考勤结束时间」截断？
 *
 * 背景：你给我的那张 2024 年教程截图里，二维码的 expire - reqtimestamp ≈ 17 秒，
 * 而我实测 getQrCode 每次都返回 now + 300 秒。差别可能在于：
 *   expire = min(now + 300, 考勤createtime + duration)
 * 如果是这样，那么「在考勤快结束时才出示的二维码」寿命会非常短 ——
 * 这正好解释了教程里为什么只剩 17 秒，也说明「越晚扫码，窗口越窄」。
 *
 * 用法: node tools/exp-ticket-clamp.ts <courseid>
 */
import { KtpClient } from "../src/client.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";
import { parseQrTicket, secondsUntilExpire } from "../src/qr.ts";

const config = loadConfig();
const courseid = process.argv[2];
if (!courseid) {
  console.error("用法: node tools/exp-ticket-clamp.ts <courseid>");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const teacher = await makeClient("teacher", true);

const created = await teacher.call("/AttenceApi/addNowsAttance", {
  courseid,
  title: "票据截断实验(稍后删除)",
});
const attenceid: string = created.json?.data?.attenceid;
const createtime = Number(created.json?.data?.attence?.createtime ?? 0);

// duration 在创建返回里是 0，得从 SummaryApi 拿
const summary = await teacher.call("/SummaryApi/attence", { courseid, page: 1, size: 20 });
const row = (summary.json?.data?.data ?? []).find((x: any) => x.id === attenceid) ?? {};
const duration = Number(row.duration ?? 600);

console.log(`考勤 id   = ${attenceid}`);
console.log(`createtime= ${createtime}  duration=${duration}`);
console.log(
  `考勤结束于 = ${new Date((createtime + duration) * 1000).toLocaleTimeString("zh-CN", { hour12: false })}`,
);
console.log(`\n检验方法：在 t=${duration - 270}s 取票。若 expire = now+300，则 expire-createtime 会是 ${duration + 30}s`);
console.log(`（超过考勤结束时间）；若被截断，则会是 ${duration}s。\n`);
console.log("时刻        票据剩余    expire-createtime   是否被截断");
console.log("-".repeat(64));

// 只取两个点：刚开始，以及「now+300 会超过考勤结束时间」之后
const marks = [5, Math.max(10, duration - 270)];
const start = Date.now();

for (const mark of marks) {
  const waitMs = start + mark * 1000 - Date.now();
  if (waitMs > 0) await sleep(waitMs);

  const res = await teacher.call("/AttenceApi/getQrCode", { attenceid });
  const url = res.json?.data?.mobileCheckInUrl ?? "";
  if (!url) {
    console.log(`${String(mark).padStart(4)}s       取票失败: ${JSON.stringify(res.json).slice(0, 80)}`);
    continue;
  }
  const t = parseQrTicket(url);
  const expire = Number(t.expire);
  const elapsed = Math.round(Date.now() / 1000) - createtime;
  const clamped = expire < Math.round(Date.now() / 1000) + 295;
  console.log(
    `${String(elapsed).padStart(4)}s       剩余 ${String(Math.round(secondsUntilExpire(t))).padStart(4)}s    expire-createtime=${String(expire - createtime).padStart(4)}s        ${clamped ? "★ 被截断" : "否（满 300s）"}`,
  );
}

console.log("-".repeat(64));
console.log("\n对照：duration=" + duration + "s → 如果 expire 被考勤结束时间截断，");
console.log("那么最后一张码的剩余时间会远小于 300s，教程里那 17 秒就是这么来的。");

await teacher.call("/AttenceApi/overAttence", { id: attenceid });
await teacher.call("/AttenceApi/delAttence", { attenceid });
console.log("\n已清理实验考勤。");
