/**
 * 下载课堂派 H5 的 JS bundle 到 captures/web/，并输出：
 *  - 全部接口路径（写入 captures/web/api-paths.txt）
 *  - 关键接口的调用上下文（参数名）
 */
import fs from "node:fs";
import path from "node:path";

const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_1 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.56 NetType/WIFI Language/zh_CN";

const OUT = path.resolve(import.meta.dirname, "..", "captures", "web");
fs.mkdirSync(OUT, { recursive: true });

const BUNDLES = [
  "https://w.ketangpai.com/js/app.0bdbe66c.js",
  "https://w.ketangpai.com/js/chunk-vendors.20131fc2.js",
  "https://w.ketangpai.com/js/readQRCode.js",
  "https://w.ketangpai.com/ktp-config.js",
];

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  return await res.text();
}

const saved = [];
for (const url of BUNDLES) {
  const name = url.split("/").pop();
  const text = await get(url);
  fs.writeFileSync(path.join(OUT, name), text, "utf8");
  saved.push({ name, text });
  console.log(`saved ${name} (${text.length} bytes)`);
}

// ---- 接口路径 ----
const paths = new Set();
for (const { text } of saved) {
  for (const m of text.matchAll(/([A-Za-z][A-Za-z0-9_]{1,30}Api)\/([A-Za-z0-9_]{2,40})/g)) {
    paths.add(`/${m[1]}/${m[2]}`);
  }
}
const sorted = [...paths].sort();
fs.writeFileSync(path.join(OUT, "api-paths.txt"), sorted.join("\n"), "utf8");
console.log(`\n共 ${sorted.length} 个接口路径 -> captures/web/api-paths.txt`);

// ---- 关键接口上下文 ----
const PATTERNS = process.argv.slice(2);
if (PATTERNS.length === 0) {
  PATTERNS.push("getQrCode", "AttentionApi/AttenceResult", "semesterCourseList", "getNotFinishAttenceStudent");
}

for (const pattern of PATTERNS) {
  console.log(`\n${"=".repeat(70)}\n>>> ${pattern}\n${"=".repeat(70)}`);
  let found = 0;
  for (const { name, text } of saved) {
    let idx = -1;
    while ((idx = text.indexOf(pattern, idx + 1)) !== -1) {
      found++;
      const start = Math.max(0, idx - 400);
      const end = Math.min(text.length, idx + 400);
      console.log(`\n[${name} @ ${idx}]\n...${text.slice(start, end)}...`);
      if (found >= 6) break;
    }
    if (found >= 6) break;
  }
  if (found === 0) console.log("(未找到)");
}
