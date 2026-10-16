/**
 * 演示/测试用的签到助手（教师端）。
 *
 *   node tools/demo.ts create [--type qr|digit|gps] [--course <id>]
 *   node tools/demo.ts clean [attenceid]
 *   node tools/demo.ts list
 *
 * type 说明：
 *   qr    二维码考勤（type=3）—— 必须有人在教室拍到新码
 *   digit 数字码考勤（type=1）—— 只需要别人把 4 位数字告诉你，人在哪都能签
 *   gps   定位签到（type=2）  —— 填对坐标就行
 *
 * 课程 ID 从命令行参数取。二维码/票据有效期 300 秒，考勤窗口 600 秒。
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { KtpClient } from "../src/client.ts";
import {
  getCachedToken,
  loadConfig,
  resolveAccount,
  ROOT_DIR,
  setCachedToken,
} from "../src/config.ts";
import { parseQrTicket, secondsUntilExpire } from "../src/qr.ts";

const execFileAsync = promisify(execFile);
const ROOT = ROOT_DIR;
const STATE_PATH = path.join(ROOT, ".cache", "demo-attence.json");
// ⚠️ 课程 ID 不写死在仓库里（那是真实课程）。用法: node tools/demo.ts <courseid>
const DEFAULT_COURSE = process.argv[2] ?? process.env.KTP_COURSE ?? ";

const CREATE_API: Record<string, string> = {
  qr: "/AttenceApi/addNowsAttance",
  digit: "/AttenceApi/addDigitAttence",
  gps: "/AttenceApi/addGPSAttence",
};

const argv = process.argv.slice(2);
const command = argv[0] ?? "create";
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
// clean 的位置参数是 attenceid
const positional = argv.slice(1).filter((a, i, arr) => !a.startsWith("--") && !arr[i - 1]?.startsWith("--"));

const config = loadConfig();

async function makeClient(label: string): Promise<KtpClient> {
  const cached = getCachedToken(label);
  if (cached) return new KtpClient({ token: cached, label, fakeIpPrefixes: config.fakeIpPrefixes });
  const account = resolveAccount(label);
  const client = new KtpClient({ label, fakeIpPrefixes: config.fakeIpPrefixes });
  setCachedToken(label, await client.login(account.email, account.password));
  return client;
}

function readState(): Record<string, any> | null {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")) as Record<string, any>;
  } catch {
    return null;
  }
}

const teacher = await makeClient("teacher");

if (command === "create") {
  const type = flag("type") ?? "qr";
  const api = CREATE_API[type];
  if (!api) {
    console.error(`未知类型 ${type}，只能是 qr / digit / gps`);
    process.exit(1);
  }
  const courseid = flag("course") ?? DEFAULT_COURSE;
  const title = `演示${type === "qr" ? "二维码" : type === "digit" ? "数字码" : "定位"}签到 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;

  const created = await teacher.call(api, { courseid, title });
  const attenceid = created.json?.data?.attenceid;
  if (!attenceid) {
    console.error("创建考勤失败：", JSON.stringify(created.json));
    process.exit(1);
  }

  const state: Record<string, unknown> = {
    attenceid,
    courseid,
    title,
    type,
    createdAt: Date.now(),
  };

  console.log(`\n已创建进行中的考勤`);
  console.log(`  类型     : ${type}`);
  console.log(`  名称     : ${title}`);
  console.log(`  考勤 id  : ${attenceid}`);

  if (type === "qr") {
    const qrRes = await teacher.call("/AttenceApi/getQrCode", { attenceid });
    const url = String(qrRes.json?.data?.mobileCheckInUrl ?? "");
    const ticket = parseQrTicket(url);
    const png = path.join(ROOT, "captures", "qr", "demo.png");
    fs.mkdirSync(path.dirname(png), { recursive: true });
    await execFileAsync("python", [path.join(ROOT, "tools", "make_qr.py"), url, png], { cwd: ROOT });
    state.url = url;
    state.png = png;
    console.log(`  二维码图 : ${png}`);
    console.log(`  有效期   : ${secondsUntilExpire(ticket).toFixed(0)} 秒`);
    console.log(`\n  二维码 URL:\n  ${url}\n`);
  } else if (type === "digit") {
    const codeRes = await teacher.call("/AttenceApi/getDigitAttence", { id: attenceid });
    const code = codeRes.json?.data?.data?.code;
    state.code = code;
    console.log(`\n  4 位数字码: ${code}`);
    console.log(`\n  现在到网页「实时状态」里，把 ${code} 填进输入框点签到 ——`);
    console.log(`  这一步模拟的是「别人在群里发了 4 个数字给你」，不需要人在教室。\n`);
  } else {
    console.log(`\n  到网页「实时状态」里用定位签到即可。\n`);
  }

  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
} else if (command === "clean") {
  const state = readState();
  const attenceid = positional[0] ?? state?.attenceid;
  if (!attenceid) {
    console.error("没有找到要清理的考勤 id。用法: node tools/demo.ts clean <attenceid>");
    process.exit(1);
  }
  await teacher.call("/AttenceApi/overAttence", { id: attenceid });
  const del = await teacher.call("/AttenceApi/delAttence", { attenceid });
  console.log(`已结束并删除考勤 ${attenceid} -> status=${del.json?.status}`);
  if (state?.attenceid === attenceid) fs.rmSync(STATE_PATH, { force: true });
} else if (command === "list") {
  const courseid = flag("course") ?? readState()?.courseid ?? DEFAULT_COURSE;
  const res = await teacher.call("/AttenceApi/getNotFinishAttence", { courseid });
  const lists = res.json?.data?.lists ?? [];
  console.log(`课程 ${courseid} 进行中的考勤：${lists.length} 条`);
  for (const item of lists) console.log(`  id=${item.id}  type=${item.type}  ${item.title}`);
} else {
  console.log("用法: node tools/demo.ts create [--type qr|digit|gps] [--course <id>] | clean [id] | list");
}
