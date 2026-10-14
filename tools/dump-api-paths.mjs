/**
 * 从课堂派 H5 前端的 JS bundle 里提取所有接口路径。
 * 静态资源是公开的，用全局 fetch 即可（不需要伪造 Origin/Referer）。
 */
const UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_3_1 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.56 NetType/WIFI Language/zh_CN";

const INDEX = "https://w.ketangpai.com/";

async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
  return { status: res.status, text: await res.text(), url: res.url };
}

function assetUrls(html) {
  const out = new Set();
  for (const m of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) out.add(m[1]);
  for (const m of html.matchAll(/<link[^>]+href=["']([^"']+)["']/gi)) out.add(m[1]);
  return [...out].filter((u) => !u.startsWith("data:"));
}

function absolute(base, href) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

const index = await get(INDEX);
console.log(`index: HTTP ${index.status}, ${index.text.length} bytes, final=${index.url}`);

const assets = assetUrls(index.text)
  .map((a) => absolute(index.url, a))
  .filter(Boolean);

console.log(`\n发现 ${assets.length} 个静态资源：`);
for (const a of assets) console.log("  " + a);

const sources = [];
for (const url of assets) {
  try {
    const r = await get(url);
    if (r.status === 200 && /javascript|text\/css/i.test(url) === false && r.text.length > 0) {
      sources.push({ url, text: r.text });
    } else if (r.status === 200) {
      sources.push({ url, text: r.text });
    }
  } catch (err) {
    console.log(`  [warn] ${url} -> ${err.message}`);
  }
}

const paths = new Map();
for (const { url, text } of sources) {
  for (const m of text.matchAll(/([A-Za-z][A-Za-z0-9_]{1,30}Api)\/([A-Za-z0-9_]{2,40})/g)) {
    const p = `/${m[1]}/${m[2]}`;
    if (!paths.has(p)) paths.set(p, new Set());
    paths.get(p).add(url.split("/").pop());
  }
}

console.log(`\n提取到 ${paths.size} 个接口路径：`);
for (const p of [...paths.keys()].sort()) console.log("  " + p);
