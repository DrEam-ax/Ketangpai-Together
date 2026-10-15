import { KtpClient } from "../src/client.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";
const config = loadConfig();
async function mk(l, force=false){ if(!force){const c=getCachedToken(l); if(c) return new KtpClient({token:c,label:l,fakeIpPrefixes:config.fakeIpPrefixes});} const a=resolveAccount(l); const cl=new KtpClient({label:l,fakeIpPrefixes:config.fakeIpPrefixes}); setCachedToken(l, await cl.login(a.email,a.password)); return cl; }
const stu = await mk("stu", true);
const courseid = "FAKEid0002";

const tries = [
  ["/AttenceApi/getNotFinishAttenceStudent", {}],
  ["/AttenceApi/getNotFinishAttence", {}],
  ["/AttenceApi/getNotFinishAttenceList", {}],
  ["/AttenceApi/getStudentNotFinishAttence", {}],
  ["/AttenceApi/getAllNotFinishAttence", {}],
  ["/AttenceApi/getAttenceList", { page: 1, size: 20 }],
  ["/AttenceApi/getAttenceStudent", {}],
  ["/SummaryApi/notFinishAttence", {}],
  ["/SummaryApi/attence", { page: 1, size: 5 }],
  ["/UserApi/getNotFinishAttence", {}],
  ["/UserApi/getUserInfo", {}],
  ["/MessageApi/getNotReadCount", {}],
  ["/MessageApi/getMessageList", { page: 1, size: 5 }],
  ["/courseApi/simpleLists", {}],
];
for (const [p, b] of tries) {
  const res = await stu.call(p, b);
  const msg = res.json?.message ?? "";
  const data = res.json?.data;
  let shape = "null";
  if (Array.isArray(data)) shape = `array(${data.length})`;
  else if (data && typeof data === "object") shape = "{" + Object.keys(data).slice(0, 8).join(",") + "}";
  else if (data !== null && data !== undefined) shape = String(data).slice(0, 40);
  console.log(`${p.padEnd(44)} code=${res.json?.code ?? res.status}  ${String(msg).slice(0,18).padEnd(18)} data=${shape}`);
}
