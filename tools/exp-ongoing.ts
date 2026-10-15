/**
 * 探测：API 返回的签到对象里，靠哪些字段能判断「**正在**签到」？
 *
 * 这个功能（主成员课程正在签到时弹窗提醒）全靠这一步：
 * 如果分不出「正在签」和「已结束但没签」，提醒就是错的。
 *
 * 做法：教师端现场建一个考勤 → 学生端查「我的未完成签到」→ 打印完整字段。
 * 顺便拿一条「已结束」的记录做对照，看差异字段。
 *
 * 用法: node tools/exp-ongoing.ts [courseid]
 */
import { KtpClient } from "../src/client.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";

const config = loadConfig();
const courseid = process.argv[2] ?? "FAKEid0002";

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
const student = await makeClient("stu", true);

console.log("=== 1) 教师端现场建一个考勤 ===");
const created = await teacher.call("/AttenceApi/addNowsAttance", {
  courseid,
  title: "监控探测(自动删除)",
});
const attenceid: string = created.json?.data?.attenceid;
console.log("attenceid =", attenceid);
console.log("返回字段  =", Object.keys(created.json?.data ?? {}).join(", "));

// 拿一下 duration / createtime（创建返回里 duration 是 0）
const summary = await teacher.call("/SummaryApi/attence", { courseid, page: 1, size: 20 });
const row =
  (summary.json?.data?.data ?? []).find((x: Record<string, unknown>) => x.id === attenceid) ?? {};
console.log("教师端列表字段 =", Object.keys(row).join(", "));
console.log("createtime/duration =", row.createtime, "/", row.duration);
if (row.createtime && row.duration) {
  const end = Number(row.createtime) + Number(row.duration);
  console.log(
    `时间窗 = ${new Date(Number(row.createtime) * 1000).toLocaleTimeString("zh-CN", { hour12: false })}` +
      ` ~ ${new Date(end * 1000).toLocaleTimeString("zh-CN", { hour12: false })}` +
      `   现在=${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`,
  );
}

try {
  console.log("\n=== 2) 学生端查「我的未完成签到」（完整返回）===");
  const res = await student.call("/AttenceApi/getNotFinishAttenceStudent", { courseid });
  const lists = res.json?.data?.lists ?? res.json?.data?.list ?? [];
  console.log(`共 ${lists.length} 条。逐条打印关键字段：\n`);
  const now = Math.floor(Date.now() / 1000);
  for (const item of lists) {
    const isNew = item.id === attenceid;
    console.log(`--- ${isNew ? "★ 刚建的这条" : "旧记录"} id=${item.id} ---`);
    console.log("  全部字段:", JSON.stringify(item));
    const start = Number(item.starttime ?? item.createtime ?? 0);
    const end = Number(item.endtime ?? 0);
    console.log(
      `  type=${item.type} status=${item.status} state=${item.state} ` +
        `starttime=${item.starttime} endtime=${item.endtime} ` +
        `duration=${item.duration} createtime=${item.createtime}`,
    );
    if (start && end) {
      console.log(`  时间窗判断: now=${now}  start=${start}  end=${end}  ->  ${now >= start && now <= end ? "★ 正在签到" : "不在窗口内"}`);
    }
    console.log("");
  }
} finally {
  console.log("=== 3) 清理：删掉刚建的考勤 ===");
  const del = await teacher.call("/AttenceApi/delAttence", { attenceid });
  console.log("删除结果:", JSON.stringify(del.json)?.slice(0, 200));
}
