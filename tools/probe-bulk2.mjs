import { KtpClient } from "../src/client.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";
const config = loadConfig();
const courseid = "FAKEid0002";
async function mk(l, force=false){ if(!force){const c=getCachedToken(l); if(c) return new KtpClient({token:c,label:l,fakeIpPrefixes:config.fakeIpPrefixes});} const a=resolveAccount(l); const cl=new KtpClient({label:l,fakeIpPrefixes:config.fakeIpPrefixes}); setCachedToken(l, await cl.login(a.email,a.password)); return cl; }
const teacher = await mk("teacher", true);
const stu = await mk("stu", true);

// 先在「示例课程」建一个正在进行的签到
const created = await teacher.call("/AttenceApi/addNowsAttance", { courseid, title: "跨课程探测(自动删)" });
const id = created.json?.data?.attenceid;
console.log("已建考勤:", id);
try {
  console.log("\n=== A) getNotFinishAttenceStudent 不带 courseid ===");
  const a = await stu.call("/AttenceApi/getNotFinishAttenceStudent", {});
  console.log(JSON.stringify(a.json?.data).slice(0, 800));
  const al = a.json?.data?.lists ?? [];
  console.log("条数:", al.length, " 含刚建的?", al.some(x=>x.id===id) ? "✅" : "❌");

  console.log("\n=== B) getNotFinishAttence 带 courseid ===");
  const b = await stu.call("/AttenceApi/getNotFinishAttence", { courseid });
  console.log("code=", b.json?.code, JSON.stringify(b.json?.data).slice(0, 600));

  console.log("\n=== C) 对照：带 courseid 的 Student 版 ===");
  const c = await stu.call("/AttenceApi/getNotFinishAttenceStudent", { courseid });
  console.log(JSON.stringify(c.json?.data).slice(0, 400));
} finally {
  const del = await teacher.call("/AttenceApi/delAttence", { attenceid: id });
  console.log("\n清理:", JSON.stringify(del.json)?.slice(0,120));
}
