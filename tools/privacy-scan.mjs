/**
 * 隐私 / 凭据门禁。
 *
 * 为什么需要它：这个仓库是公开的，而开发过程中很容易顺手把真实信息写进去 ——
 * 我们真的犯过：真实姓名、真实课程名、真实学校、真实出口 IP、真实教室坐标，
 * 还有一张从手机相机截下来的实拍照片。更麻烦的是**一旦提交并推送，
 * 光删文件是不够的，历史里还有，得重写历史**。
 *
 * 所以：提交前先扫一遍，命中就 exit 1 挡住。
 *
 * 用法：
 *   node tools/privacy-scan.mjs                 # 扫整个仓库（工作区）
 *   node tools/privacy-scan.mjs a.md b.ts       # 只扫指定文件（pre-commit 用）
 *
 * 自己的姓名/手机号之类的**私有词**不要写进这个脚本 ——
 * 写到仓库根目录的 `privacy.local.txt`（每行一个词，# 开头是注释），
 * 那个文件在 .gitignore 里，永远不会被提交。
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SKIP_DIRS = new Set([
  ".git", "node_modules", ".cache", "captures", "build", ".gradle", "out", "www",
  // 本地克隆的第三方源码（zxing-cpp），本来就在 .gitignore 里，不扫
  "zxing-cpp-build",
]);
const SKIP_EXT = new Set([
  ".apk", ".so", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".jar", ".zip",
  ".class", ".keystore", ".jks", ".ttf", ".woff", ".woff2", ".pdf", ".mp4", ".bin",
]);

/** RFC 5737 文档保留段 / 私有段 / 环回 —— 这些是"示例地址"，允许出现 */
function isReservedIp(a, b) {
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 203 && b === 0) return true; // 203.0.113.0/24
  if (a === 198 && (b === 51 || b === 18 || b === 19)) return true; // 198.51.100.0/24 等
  if (a === 192 && b === 0) return true; // 192.0.2.0/24
  if (a >= 224) return true; // 组播/保留
  return false;
}

const RULES = [
  {
    name: "课堂派内部 ID（课程/用户/考勤/票据）",
    // privacy-scan:allow（这行的正则字面量会匹配它自己，故意豁免）
    re: /FAKEid0001[A-Za-z0-9_-]{6,}/g,
    why: "能定位到具体课程或账号，公开仓库里不要出现；改用命令行传参或编造值",
  },
  {
    name: "疑似手机号",
    re: /(?<!\d)1[3-9]\d{9}(?!\d)/g,
    why: "课堂派账号就是手机号",
  },
  {
    name: "疑似公网 IP",
    // 四段数字；前后不能再接数字/点/横杠（否则会把 jdk-17.0.10.7 这种版本号当成 IP）
    re: /(?<![\w.-])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g,
    filter: (m, a, b, c, d) => {
      const oct = [a, b, c, d].map(Number);
      if (oct.some((n) => n > 255)) return false; // 不是合法 IP（比如测试用的 1.2.3.256）
      return !isReservedIp(oct[0], oct[1]);
    },
    why: "真实出口 IP 是个人数据；示例一律用 203.0.113.x 这类文档保留段",
  },
  {
    name: "疑似明文口令",
    re: /(password|passwd|pwd)\s*[:=]\s*["'][^"'{}$][^"']{5,}["']/gi,
    why: "凭据不要进仓库（config.local.json 已在 .gitignore）",
  },
];

/** 这些路径根本不该被提交 */
const FORBIDDEN = [
  [/^config\.local\.json$/, "本地账号配置"],
  [/^\.cache\//, "token 缓存"],
  [/\.keystore$|\.jks$/, "签名密钥"],
  [/\.class$/, "编译产物"],
  [/^privacy\.local\.txt$/, "私有词表本身也不该提交"],
];

/** 这些文件本来就在 .gitignore 里（不会被提交），整仓扫描时跳过，免得刷屏误报 */
const SKIP_FILES = new Set([
  "config.local.json",
  "privacy.local.txt",
  "package-lock.json",
  // 预览时生成的日志（已在 .gitignore），里面有渲染出来的名字
  "tools/ui-preview/diag.log",
]);

function loadLocalTerms() {
  const p = path.join(ROOT, "privacy.local.txt");
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, "utf8")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(path.join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const explicit = args.length > 0;
const files = explicit ? args.map((f) => path.resolve(ROOT, f)) : walk(ROOT);

const localTerms = loadLocalTerms();
const problems = [];

for (const file of files) {
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  if (!fs.existsSync(file)) continue;
  // 整仓扫描时跳过已知的本地文件；但**显式指定**（pre-commit 传进来的暂存文件）时照查不误
  if (!explicit && SKIP_FILES.has(rel)) continue;

  for (const [re, what] of FORBIDDEN) {
    if (re.test(rel)) problems.push(`${rel}: 不该提交的文件（${what}）`);
  }

  const ext = path.extname(file).toLowerCase();
  if (SKIP_EXT.has(ext)) continue;
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    continue;
  }
  if (st.size > 2 * 1024 * 1024) continue;

  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (text.includes("\u0000")) continue;

  const lines = text.split(/\r?\n/);
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    lines.forEach((line, i) => {
      // 这一行如果写着 privacy-scan:allow（并说明原因），就跳过 ——
      // 给"故意放的假数据/版本号误报"留个出口，免得逼着人把规则改松
      if (line.includes("privacy-scan:allow")) return;
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        if (rule.filter && !rule.filter(m[0], m[1], m[2], m[3], m[4])) continue;
        problems.push(`${rel}:${i + 1}: ${rule.name}「${m[0]}」—— ${rule.why}`);
        if (m[0].length === 0) break;
      }
    });
  }

  for (const term of localTerms) {
    const idx = text.indexOf(term);
    if (idx >= 0) {
      const line = text.slice(0, idx).split(/\r?\n/).length;
      problems.push(`${rel}:${line}: 命中私有词表里的「${term}」（privacy.local.txt）`);
    }
  }
}

if (problems.length === 0) {
  const n = localTerms.length;
  console.log(`✅ 隐私门禁通过（扫了 ${files.length} 个文件${n ? `，私有词表 ${n} 条` : "，无私有词表"}）`);
  process.exit(0);
}

console.error("❌ 隐私门禁拦住了这次提交：\n");
for (const p of problems) console.error("   " + p);
console.error(
  "\n提示：真实姓名/学校/手机号这类私有词，写到仓库根目录的 privacy.local.txt（已在 .gitignore，不会提交），" +
    "然后重跑一次。\n" +
    "如果这些内容**已经提交过**，光改文件不够 —— 历史里还在，需要重写历史（见 README）。",
);
process.exit(1);
