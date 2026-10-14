#!/usr/bin/env node
/**
 * 课堂派远程扫码签到工具。
 *
 * 常用：
 *   node src/cli.ts courses                 我的课程
 *   node src/cli.ts status                  所有课程里我还没完成的签到
 *   node src/cli.ts watch                   轮询，一旦有二维码考勤立刻提示
 *   node src/cli.ts qr --url "<二维码URL>"   用二维码 URL 直接签到
 *   node src/cli.ts decode shot.png --submit 从截图/照片里解二维码并签到
 *
 * 全局开关：
 *   --who stu|teacher   用哪个账号（默认 stu）
 *   --token <t>         直接用 token，跳过登录
 *   --relogin           忽略 token 缓存，重新登录
 *   --debug             打印每个请求
 */
import { KtpClient } from "./client.ts";
import {
  clearCachedToken,
  getCachedToken,
  loadConfig,
  resolveAccount,
  setCachedToken,
} from "./config.ts";
import { ATTENCE_TYPE_NAME } from "./constants.ts";
import { parseQrTicket, secondsUntilExpire } from "./qr.ts";
import { decodeQrFromFile } from "./qrdecode.ts";
import { pretty, truncate } from "./util.ts";

// ---------------------------------------------------------------- 参数解析

interface Parsed {
  positional: string[];
  flags: Record<string, string | boolean>;
  /** 允许重复出现的开关，例如 --course a --course b */
  repeated: Record<string, string[]>;
}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const repeated: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        (repeated[key] ??= []).push(next);
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags, repeated };
}

function flagStr(flags: Record<string, string | boolean>, key: string): string | undefined {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
}

const c = {
  dim: (s: string) => `\x1b[90m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function clock(): string {
  return new Date().toLocaleTimeString("zh-CN", { hour12: false });
}

// ---------------------------------------------------------------- 客户端

async function makeClient(flags: Record<string, string | boolean>): Promise<KtpClient> {
  const debug = flags.debug === true;
  const who = flagStr(flags, "who") ?? "stu";
  const cfg = loadConfig();
  const explicitToken = flagStr(flags, "token");

  if (explicitToken) {
    return new KtpClient({ token: explicitToken, label: who, debug, fakeIpPrefixes: cfg.fakeIpPrefixes });
  }

  if (flags.relogin !== true) {
    const cached = getCachedToken(who);
    if (cached) {
      return new KtpClient({ token: cached, label: who, debug, fakeIpPrefixes: cfg.fakeIpPrefixes });
    }
  }

  const account = resolveAccount(who);
  const client = new KtpClient({ label: who, debug, fakeIpPrefixes: cfg.fakeIpPrefixes });
  const token = await client.login(account.email, account.password);
  setCachedToken(who, token);
  console.error(c.dim(`[${who}] 登录成功，token 已缓存到 .cache/tokens.json`));
  return client;
}

interface Attendance {
  id: string;
  type: string;
  title?: string;
  createtime?: string;
  [key: string]: unknown;
}

interface CourseHit {
  course: Record<string, any>;
  list: Attendance[];
}

/** 扫描若干课程（默认全部课程）里未完成的签到。 */
async function scanCourses(
  client: KtpClient,
  only?: string[],
): Promise<{ courses: Record<string, any>[]; hits: CourseHit[] }> {
  let courses = await client.getMyCourses();
  if (only && only.length > 0) {
    courses = courses.filter((x) => only.includes(String(x.id)));
    // 允许用户直接给 courseid（不在课程列表里也能查）
    for (const id of only) {
      if (!courses.some((x) => String(x.id) === id)) {
        courses.push({ id, coursename: `(未在课程列表中) ${id}` });
      }
    }
  }
  const hits: CourseHit[] = [];
  for (const course of courses) {
    try {
      const list = await client.getNotFinishAttendance(String(course.id));
      if (list.length > 0) hits.push({ course, list });
    } catch {
      /* 个别课程没权限就跳过 */
    }
  }
  return { courses, hits };
}

function describeType(type: string): string {
  const name = ATTENCE_TYPE_NAME[type] ?? `未知(${type})`;
  return type === "3" ? c.cyan(`${name}`) : name;
}

// ---------------------------------------------------------------- 各命令

async function cmdLogin(flags: Record<string, string | boolean>): Promise<void> {
  const who = flagStr(flags, "who") ?? "stu";
  clearCachedToken(who);
  const client = await makeClient({ ...flags, relogin: true });
  console.log(`[${who}] token = ${client.token}`);
}

async function cmdWhoami(flags: Record<string, string | boolean>): Promise<void> {
  const client = await makeClient(flags);
  const info = (await client.call("/UserApi/getUserInfo", {})).json?.data;
  console.log(`账号    : ${info?.username}`);
  console.log(`身份    : usertype=${info?.usertype} ${info?.usertype === "1" ? "(教师)" : "(学生)"}`);
  console.log(`学校/学号: ${info?.school ?? "-"} / ${info?.stno ?? "-"}`);
  console.log(`token   : ${client.token?.slice(0, 12)}...`);
}

async function cmdCourses(flags: Record<string, string | boolean>): Promise<void> {
  const client = await makeClient(flags);
  const list = await client.getMyCourses();
  console.log(`\n共 ${list.length} 门课程：\n`);
  for (const course of list) {
    const role = course.role === 0 ? "学生" : course.role === 1 ? "教师" : `role=${course.role}`;
    console.log(
      `  ${c.bold(String(course.id))}\n    ${course.coursename}${course.classname ? ` / ${course.classname}` : ""}  [${role}]  ${course.semester ?? ""}-${course.term ?? ""}`,
    );
  }
}

async function cmdStatus(flags: Record<string, string | boolean>): Promise<void> {
  const client = await makeClient(flags);
  const only = flags.course ? ([] as string[]).concat(flags.course as string) : undefined;
  const { courses, hits } = await scanCourses(client, only);

  console.log(c.dim(`扫描 ${courses.length} 门课程的未完成签到 ...\n`));
  if (hits.length === 0) {
    console.log("当前没有任何未完成的签到。");
    return;
  }
  for (const { course, list } of hits) {
    console.log(c.bold(`【${course.coursename}】`));
    for (const item of list) {
      const isQr = String(item.type) === "3";
      console.log(
        `  ${isQr ? c.cyan("★") : " "} ${describeType(String(item.type))}  id=${item.id}  ${item.title ?? ""}`,
      );
    }
    console.log();
  }
  if (hits.some((h) => h.list.some((i) => String(i.type) === "3"))) {
    console.log(
      c.cyan("检测到二维码考勤（type=3）。") +
        "课堂派不允许学生查询二维码内容，\n所以还需要一个二维码来源：让教室里的同学拍张照片发你，然后执行\n" +
        c.bold("  node src/cli.ts decode <图片路径> --submit"),
    );
  }
}

async function cmdWatch(flags: Record<string, string | boolean>): Promise<void> {
  const client = await makeClient(flags);
  const interval = Number(flagStr(flags, "interval") ?? 5);
  const only = flags.course ? ([] as string[]).concat(flags.course as string) : undefined;

  console.log(c.bold(`开始监听（每 ${interval}s 一轮，Ctrl+C 退出）`));
  const seen = new Set<string>();
  let rounds = 0;

  for (;;) {
    rounds++;
    try {
      const { courses, hits } = await scanCourses(client, only);
      const now = new Set<string>();
      for (const { course, list } of hits) {
        for (const item of list) {
          const key = `${course.id}:${item.id}`;
          now.add(key);
          if (!seen.has(key)) {
            const isQr = String(item.type) === "3";
            console.log(
              `\n${c.yellow(`[${clock()}] ★ 发现新的签到`)}  ${c.bold(String(course.coursename))}\n` +
                `    类型: ${describeType(String(item.type))}\n` +
                `    标题: ${item.title ?? ""}\n` +
                `    id  : ${item.id}\n` +
                (isQr
                  ? c.cyan("    → 二维码考勤！快让教室里的同学拍张二维码照片发你\n") +
                    c.bold("    → node src/cli.ts decode <图片> --submit")
                  : ""),
            );
          }
        }
      }
      seen.clear();
      for (const key of now) seen.add(key);
      if (flags.verbose === true) {
        console.log(c.dim(`[${clock()}] 第 ${rounds} 轮：${courses.length} 门课，${hits.length} 个进行中`));
      }
    } catch (err) {
      console.log(c.red(`[${clock()}] 轮询出错：${err instanceof Error ? err.message : String(err)}`));
    }
    if (flags.once === true) return;
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

async function cmdQr(flags: Record<string, string | boolean>): Promise<void> {
  const client = await makeClient(flags);
  const fromUrl = flagStr(flags, "url");
  const ticket = fromUrl
    ? parseQrTicket(fromUrl)
    : parseQrTicket(
        JSON.stringify({
          ticketid: flagStr(flags, "ticketid"),
          expire: flagStr(flags, "expire"),
          sign: flagStr(flags, "sign"),
        }),
      );

  const remain = secondsUntilExpire(ticket);
  const expireAt = new Date(Number(ticket.expire) * 1000).toLocaleTimeString("zh-CN", {
    hour12: false,
  });
  console.log(
    `票据: ticketid=${ticket.ticketid}\n      ${expireAt} 失效  剩余 ${remain.toFixed(0)} 秒${
      remain < 0 ? c.red("（已过期：有效期从服务端签发那一刻算起，不是你拿到它的那一刻）") : ""
    }\n      sign=${ticket.sign}`,
  );

  const started = Date.now();
  const res = await client.submitQrTicket(ticket);
  const ok = KtpClient.qrSucceeded(res.json);
  console.log(`\n耗时 ${Date.now() - started}ms`);
  if (ok) {
    console.log(c.green(res.json?.data?.info?.replace(/<br\s*\/?>/g, "\n") ?? "签到成功"));
  } else {
    console.log(c.red(`签到失败：${res.json?.message ?? res.body.slice(0, 200)}`));
  }
}

async function cmdDecode(flags: Record<string, string | boolean>, file?: string): Promise<void> {
  if (!file) throw new Error("用法: node src/cli.ts decode <图片路径> [--submit]");
  const started = Date.now();
  const { text, engine } = await decodeQrFromFile(file);
  console.log(`解码耗时 ${Date.now() - started}ms，引擎：${engine ?? "未识别"}`);
  if (!text) {
    console.log(c.red("没有从图片里识别出二维码。试试裁剪到只剩二维码再重试。"));
    return;
  }
  console.log(`内容：${truncate(text, 500)}`);

  const client = await makeClient(flags);
  const ticket = parseQrTicket(text);
  const remain = secondsUntilExpire(ticket);
  const expireAt = new Date(Number(ticket.expire) * 1000).toLocaleTimeString("zh-CN", {
    hour12: false,
  });
  console.log(
    `\n解析出票据：ticketid=${ticket.ticketid}  ${expireAt} 失效  剩余 ${remain.toFixed(0)} 秒${
      remain < 0 ? c.red("（已过期）") : ""
    }`,
  );

  if (flags.submit !== true) {
    console.log(c.dim("（加 --submit 可直接提交签到）"));
    return;
  }

  const res = await client.submitQrTicket(ticket);
  if (KtpClient.qrSucceeded(res.json)) {
    console.log(c.green(res.json?.data?.info?.replace(/<br\s*\/?>/g, "\n") ?? "签到成功"));
  } else {
    console.log(c.red(`签到失败：${res.json?.message ?? res.body.slice(0, 200)}`));
  }
}

async function cmdAttence(flags: Record<string, string | boolean>, courseid?: string): Promise<void> {
  if (!courseid) throw new Error("用法: node src/cli.ts attence <courseid>");
  const client = await makeClient(flags);
  const list = await client.getNotFinishAttendance(courseid);
  console.log(`课程 ${courseid} 未完成的签到：${list.length} 条`);
  for (const item of list) {
    console.log(`  - id=${item.id}  type=${item.type}  ${item.title ?? ""}`);
  }
}

async function cmdCall(flags: Record<string, string | boolean>, p?: string): Promise<void> {
  if (!p) throw new Error("用法: node src/cli.ts call </Path> --body '<json>' [--noauth]");
  const client = await makeClient(flags);
  const rawBody = flagStr(flags, "body");
  const res = await client.call(p, rawBody ? JSON.parse(rawBody) : {}, {
    authed: flags.noauth !== true,
  });
  console.log(`HTTP ${res.status}`);
  console.log(res.json ? pretty(res.json) : truncate(res.body, 2000));
}

async function cmdCheckin(flags: Record<string, string | boolean>, id?: string): Promise<void> {
  if (!id) throw new Error("用法: node src/cli.ts checkin <attenceId> [--code 1234]");
  const client = await makeClient(flags);
  const res = await client.checkin({
    id,
    code: flagStr(flags, "code"),
    latitude: flagStr(flags, "lat"),
    longitude: flagStr(flags, "lng"),
  });
  console.log(`HTTP ${res.status}  ${JSON.stringify(res.json)}`);
  console.log(KtpClient.checkinSucceeded(res.json) ? c.green("✅ 签到成功") : c.red("❌ 未成功"));
}

async function cmdDigit(flags: Record<string, string | boolean>, id?: string): Promise<void> {
  if (!id) throw new Error("用法: node src/cli.ts digit <attenceId>");
  const client = await makeClient(flags);
  const res = await client.getDigitAttendance(id);
  console.log(pretty(res.json));
}

const USAGE = `${c.bold("课堂派远程扫码签到")}

  ${c.bold("courses")}                      列出我的课程
  ${c.bold("status")} [--course <id>]        查看未完成的签到（默认扫全部课程）
  ${c.bold("watch")} [--interval 5]          轮询监听，出现二维码考勤立刻提示
  ${c.bold("qr")} --url <二维码URL>          用二维码 URL 直接签到
  ${c.bold("decode")} <图片> [--submit]      从截图/照片解二维码，可顺便签到
  ${c.bold("whoami")}                       查看当前身份
  ${c.bold("login")}                        强制重新登录

调试用：
  attence <courseid>            单课程未完成签到
  call <Path> [--body json]     直接调任意接口
  checkin <attenceId> [--code]  数字码/定位签到
  digit <attenceId>             取数字签到码

全局开关：--who stu|teacher  --token <t>  --relogin  --debug  --noauth
`;

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, ...rest] = positional;

  switch (command) {
    case "login":
      return cmdLogin(flags);
    case "whoami":
      return cmdWhoami(flags);
    case "courses":
      return cmdCourses(flags);
    case "status":
      return cmdStatus(flags);
    case "watch":
      return cmdWatch(flags);
    case "qr":
      return cmdQr(flags);
    case "decode":
      return cmdDecode(flags, rest[0]);
    case "attence":
      return cmdAttence(flags, rest[0]);
    case "call":
      return cmdCall(flags, rest[0]);
    case "checkin":
      return cmdCheckin(flags, rest[0]);
    case "digit":
      return cmdDigit(flags, rest[0]);
    default:
      console.log(USAGE);
  }
}

main().catch((err: unknown) => {
  console.error(`\n${c.red("❌")} ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
