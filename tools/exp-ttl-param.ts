/**
 * 决定性实验：哪个参数控制二维码票据的寿命（TTL）？
 *
 * 背景：我通过 API 建的考勤，getQrCode 永远返回 expire = now + 300。
 * 但用户把「二维码刷新频率」设成 3-5 秒后，拍照中转每次都失效。
 * 如果刷新频率同时把 TTL 压短了，那必然有一个创建参数在起作用。
 *
 * 做法：用各种可能的参数名创建考勤，立刻取票看剩余时间。
 * 任何一次剩余时间远小于 300，就说明找到了那个参数。
 *
 * 用法: node tools/exp-ttl-param.ts <courseid>
 */
import { KtpClient } from "../src/client.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";
import { parseQrTicket, secondsUntilExpire } from "../src/qr.ts";

const config = loadConfig();
const courseid = process.argv[2];
if (!courseid) {
  console.error("用法: node tools/exp-ttl-param.ts <courseid>");
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

const teacher = await makeClient("teacher", true);

const NAMES = [
  "refreshrate", "refresh_rate", "refreshRate", "refresh", "rate", "interval", "qrcodeinterval",
  "qrcode_interval", "seconds", "second", "secondtime", "duration", "time", "validtime",
  "expire", "frequency", "delay", "speed", "qrcodetime", "scantime", "updatetime", "ratetime",
];

// 先建立基线
const baseline = await teacher.call("/AttenceApi/addNowsAttance", { courseid, title: "ttl-基线" });
const baseId = baseline.json?.data?.attenceid;
const baseQr = await teacher.call("/AttenceApi/getQrCode", { attenceid: baseId });
const baseRemain = secondsUntilExpire(parseQrTicket(baseQr.json?.data?.mobileCheckInUrl ?? ""));
console.log(`基线（不带额外参数）: 剩余 ${baseRemain.toFixed(0)} 秒\n`);
console.log("参数名                剩余秒数");
console.log("-".repeat(40));
await teacher.call("/AttenceApi/overAttence", { id: baseId });
await teacher.call("/AttenceApi/delAttence", { attenceid: baseId });

const hits: string[] = [];

for (const name of NAMES) {
  const created = await teacher.call("/AttenceApi/addNowsAttance", {
    courseid,
    title: `ttl-${name}`,
    [name]: 5,
  });
  const attenceid = created.json?.data?.attenceid;
  if (!attenceid) {
    console.log(`${name.padEnd(22)} (创建失败)`);
    continue;
  }
  const qr = await teacher.call("/AttenceApi/getQrCode", { attenceid });
  const url = String(qr.json?.data?.mobileCheckInUrl ?? "");
  let remain = Number.NaN;
  try {
    remain = secondsUntilExpire(parseQrTicket(url));
  } catch {
    /* ignore */
  }
  const short = Number.isFinite(remain) && remain < 120;
  console.log(`${name.padEnd(22)} ${Number.isFinite(remain) ? remain.toFixed(0) : "取票失败"}${short ? "   ★★★ 命中了！" : ""}`);
  if (short) hits.push(name);

  await teacher.call("/AttenceApi/overAttence", { id: attenceid });
  await teacher.call("/AttenceApi/delAttence", { attenceid });
}

console.log("-".repeat(40));
console.log(
  hits.length > 0
    ? `\n找到控制 TTL 的参数: ${hits.join(", ")}`
    : "\n没有任何参数能改变 TTL —— 说明「刷新频率」是纯客户端显示设置，\n服务端签发的票据寿命恒为 300 秒。",
);
