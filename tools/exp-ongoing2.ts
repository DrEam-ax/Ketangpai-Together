/**
 * 决定性验证：学生端的「未完成签到」列表，到底只包含**正在签到**的，
 * 还是连「已结束但我没签」的也一起返回？
 *
 * 为什么这一步最关键：
 *   提醒功能（「您的 xxx 课程正在签到」）如果分不清这两者，就会一直误报。
 *   而 getNotFinishAttenceStudent 只返回 id/title/type/createtime，**没有结束时间**，
 *   所以没法自己算窗口 —— 除非这个接口本身就只给"进行中"的。
 *
 * 做法：建一个考勤 → 看它在不在列表里 → 用 overAttence 结束它 → 再看还在不在。
 * 全是秒级操作，不用等考勤自然过期。
 *
 * 用法: node tools/exp-ongoing2.ts [courseid]
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

async function studentList(): Promise<Record<string, any>[]> {
  const res = await student.call("/AttenceApi/getNotFinishAttenceStudent", { courseid });
  return res.json?.data?.lists ?? res.json?.data?.list ?? [];
}

const before = await studentList();
console.log(`起始状态：学生端未完成签到 ${before.length} 条`);
for (const it of before) console.log(`   - ${it.id}  type=${it.type}  ${it.title}`);

console.log("\n=== 建一个新考勤 ===");
const created = await teacher.call("/AttenceApi/addNowsAttance", {
  courseid,
  title: "监控探测2(自动删除)",
});
const id: string = created.json?.data?.attenceid;
console.log("attenceid =", id, " status =", created.json?.status);

try {
  const afterCreate = await studentList();
  const found1 = afterCreate.some((x) => x.id === id);
  console.log(`\n① 建好之后：列表 ${afterCreate.length} 条，包含它？ ${found1 ? "✅ 在" : "❌ 不在"}`);
  if (!found1) console.log(`   列表内容: ${JSON.stringify(afterCreate)}`);

  console.log("\n=== 用 overAttence 结束这个考勤 ===");
  const over = await teacher.call("/AttenceApi/overAttence", { id });
  console.log("结束结果:", JSON.stringify(over.json)?.slice(0, 200));

  // 稍等一下，避免服务端还没落库
  await new Promise((r) => setTimeout(r, 1500));

  const afterEnd = await studentList();
  const found2 = afterEnd.some((x) => x.id === id);
  console.log(`\n② 结束之后：列表 ${afterEnd.length} 条，还包含它？ ${found2 ? "✅ 还在（说明接口不过滤状态）" : "❌ 已移除（说明接口只给进行中的）"}`);

  console.log("\n" + "=".repeat(60));
  if (found1 && !found2) {
    console.log("结论：✅ 这个接口**只返回正在进行的签到**。");
    console.log("      → 提醒逻辑可以很简单：只要列表非空，就是有课程正在签到。");
  } else if (found1 && found2) {
    console.log("结论：⚠️ 这个接口**包含已结束的签到**，不能只看列表是否非空。");
    console.log("      → 需要另外找「结束时间/状态」字段，或用 createtime + 默认时长 估算。");
  } else {
    console.log("结论：❓ 结果不符合预期，需要再看原始返回。");
  }
  console.log("=".repeat(60));
} finally {
  const del = await teacher.call("/AttenceApi/delAttence", { attenceid: id });
  console.log("\n清理：", JSON.stringify(del.json)?.slice(0, 150));
}
