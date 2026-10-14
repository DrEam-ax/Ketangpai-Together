/**
 * 只为布局诊断用的小服务：接收页面发来的信标，把数据追加到 diag.log。
 * 用图片信标（<img src=...>）而不是 fetch，避免 file:// 下的 CORS 麻烦。
 *
 *   node tools/ui-preview/diag-server.mjs
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const PORT = 8899;
const LOG = path.join(import.meta.dirname, "diag.log");

fs.writeFileSync(LOG, "", "utf8");

// 1x1 透明 gif
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/diag") {
    const data = url.searchParams.get("d") ?? "";
    fs.appendFileSync(LOG, `${data}\n`, "utf8");
    console.log(`[diag] 收到 ${data.length} 字节`);
  }
  res.writeHead(200, {
    "Content-Type": "image/gif",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(GIF);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`diag server on http://127.0.0.1:${PORT}  -> ${LOG}`);
});
