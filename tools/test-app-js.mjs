/**
 * 直接加载 App 的 public 前端脚本，在 Node 里用桩 DOM 跑一遍纯逻辑，
 * 验证 parseTicket / 过期判断这些关键分支（不是复制的副本，是同一份文件）。
 */
import fs from "node:fs";
import path from "node:path";

const APP = path.resolve(import.meta.dirname, "..", "app-android", "app", "src", "main", "assets", "www", "app.js");
const source = fs.readFileSync(APP, "utf8");

function stubEl() {
  const el = {
    addEventListener() {},
    querySelector() { return stubEl(); },
    querySelectorAll() { return []; },
    insertAdjacentHTML() {},
    closest() { return stubEl(); },
    appendChild() {},
    remove() {},
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    dataset: {},
    style: {},
    value: "",
    checked: false,
    open: false,
    scrollTop: 0,
    scrollHeight: 0,
    innerHTML: "",
    textContent: "",
  };
  return el;
}

// document 也要有 querySelectorAll —— 底部三栏切换会用到（这里返回空数组就够了）
const documentStub = {
  querySelector: () => stubEl(),
  querySelectorAll: () => [],
  createElement: () => stubEl(),
};
const windowStub = { scrollTo() {} };

globalThis.document = documentStub;
globalThis.window = windowStub;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.Image = class {};
globalThis.FileReader = class {};
globalThis.URL = { createObjectURL: () => "", revokeObjectURL() {} };
globalThis.confirm = () => false;

// 加载脚本，并把内部函数暴露出来
const load = new Function("document", "window", "Image", "FileReader", "URL", "confirm",
  `${source}\n;return { parseTicket };`);
const { parseTicket } = load(documentStub, windowStub, globalThis.Image, globalThis.FileReader, globalThis.URL, globalThis.confirm);

const CASES = [
  {
    name: "完整 URL（课堂派移动端扫码结果）",
    input:
      "https://w.ketangpai.com/checkIn/checkinCodeResult?type=2&ticketid=FAKEticket0000000000000001&expire=1791977025&sign=0000000000000000000000000000000000000000&courseid=FAKEcourse0000000000000001&randNum=HCAZGNWF",
    expect: { ticketid: "FAKEticket0000000000000001", expire: "1791977025", sign: "0000000000000000000000000000000000000000" },
  },
  {
    name: "只有查询串、没有域名",
    input: "type=2&ticketid=AAA&expire=123&sign=BBB",
    expect: { ticketid: "AAA", expire: "123", sign: "BBB" },
  },
  {
    name: "JSON 形式（App 抓包得到的请求体）",
    input: JSON.stringify({ ticketid: "T1", expire: 999, sign: "S1", reqtimestamp: 123 }),
    expect: { ticketid: "T1", expire: "999", sign: "S1" },
  },
  {
    name: "JSON 里的 expire 是数字，也要能转成字符串",
    input: '{"ticketId":"T2","expire":1000,"sign":"S2"}',
    expect: { ticketid: "T2", expire: "1000", sign: "S2" },
  },
  { name: "普通文本 -> null", input: "今天天气不错", expect: null },
  { name: "只有 ticketid -> null", input: "ticketid=AAA", expect: null },
  { name: "空串 -> null", input: "", expect: null },
  { name: "其它二维码（微信群链接）-> null", input: "https://weixin.qq.com/g/ABC123", expect: null },
];

let pass = 0;
let fail = 0;

for (const c of CASES) {
  let got;
  try {
    got = parseTicket(c.input);
  } catch (err) {
    got = `THREW: ${err.message}`;
  }
  const ok = JSON.stringify(got) === JSON.stringify(c.expect);
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.name}`);
  if (!ok) {
    console.log(`       期望 ${JSON.stringify(c.expect)}`);
    console.log(`       实际 ${JSON.stringify(got)}`);
  }
}

// 过期判断
const now = Math.floor(Date.now() / 1000);
const fresh = parseTicket(`ticketid=X&expire=${now + 300}&sign=Y`);
const stale = parseTicket(`ticketid=X&expire=${now - 60}&sign=Y`);
const leftFresh = Number(fresh.expire) - Date.now() / 1000;
const leftStale = Number(stale.expire) - Date.now() / 1000;
console.log(`\n剩余时间计算: 新票 ~${leftFresh.toFixed(0)}s (应接近 300)  过期票 ~${leftStale.toFixed(0)}s (应为负)`);
const okFresh = leftFresh > 290 && leftFresh <= 300;
const okStale = leftStale < -50;
console.log(`${okFresh ? "PASS" : "FAIL"}  新票剩余时间`);
console.log(`${okStale ? "PASS" : "FAIL"}  过期票剩余时间为负`);
if (okFresh) pass++;
else fail++;
if (okStale) pass++;
else fail++;

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
