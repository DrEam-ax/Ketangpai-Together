import { KtpClient } from "../src/client.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";
const config = loadConfig();
async function mk(l, force=false){ if(!force){const c=getCachedToken(l); if(c) return new KtpClient({token:c,label:l,fakeIpPrefixes:config.fakeIpPrefixes});} const a=resolveAccount(l); const cl=new KtpClient({label:l,fakeIpPrefixes:config.fakeIpPrefixes}); setCachedToken(l, await cl.login(a.email,a.password)); return cl; }
const stu = await mk("stu", true);
const res = await stu.call("/courseApi/simpleLists", {});
const data = res.json?.data ?? {};
const lists = [...(data.toplists ?? []), ...(data.lists ?? [])];
console.log("课程数:", lists.length);
if (lists[0]) {
  console.log("\n第一条课程的完整字段:");
  console.log(JSON.stringify(lists[0], null, 2).slice(0, 900));
  console.log("\n候选名称字段:", ["coursename","name","title","courseName"].map(k=>k+"="+lists[0][k]).join("  "));
  console.log("候选 id 字段:", ["id","courseid","courseId"].map(k=>k+"="+lists[0][k]).join("  "));
}
console.log("\n全部课程（id / 名称）:");
for (const c of lists) console.log("  ", c.id ?? c.courseid, "|", c.coursename ?? c.name ?? c.title);
