/** 在已下载的 bundle 里按上下文窗口搜索关键字（不联网）。 */
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve(import.meta.dirname, "..", "captures", "web");
const files = fs
  .readdirSync(OUT)
  .filter((f) => f.endsWith(".js"))
  .map((f) => ({ name: f, text: fs.readFileSync(path.join(OUT, f), "utf8") }));

const patterns = process.argv.slice(2);
const width = Number(process.env.WIN ?? 500);
const maxHits = Number(process.env.MAX ?? 5);

for (const pattern of patterns) {
  console.log(`\n${"=".repeat(76)}\n>>> ${pattern}\n${"=".repeat(76)}`);
  let hits = 0;
  outer: for (const { name, text } of files) {
    let idx = -1;
    while ((idx = text.indexOf(pattern, idx + 1)) !== -1) {
      console.log(
        `\n--- ${name} @ ${idx} ---\n${text.slice(Math.max(0, idx - width), idx + width)}`,
      );
      if (++hits >= maxHits) break outer;
    }
  }
  if (hits === 0) console.log("(未找到)");
}
