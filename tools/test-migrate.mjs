/**
 * 成员迁移格式的契约测试。
 *
 * 跑不了 Java 侧代码（需要 Android），但可以验证"格式设计"这件事本身：
 *   1. 导出串必须是**单行、无空白**（要能安全地走剪贴板/微信）
 *   2. 名字/密码里带空格也能原样往返（所以 /import 那条路不能对 JSON 去空白）
 *   3. 被换行拆开后再导入，也能还原
 *   4. 前缀 KTP1: 的处理和 Java 侧保持一致
 */

const CASES = [
  {
    name: "普通成员",
    payload: {
      v: 1,
      app: "ktp",
      ts: 1700000000,
      withSecrets: true,
      accounts: [
        { key: "a", email: "13800138000", password: "fake-pass-123", name: "某同学", school: "某大学", ip: "203.0.113.11" },
      ],
    },
  },
  {
    name: "名字和密码里带空格",
    payload: {
      v: 1,
      app: "ktp",
      ts: 1700000001,
      withSecrets: true,
      accounts: [
        { key: "b c", email: "138 0013 8000", password: "my pass word", name: "张 三 丰", school: "某某 大学", ip: "203.0.113.12" },
      ],
    },
  },
  {
    name: "不含密码",
    payload: {
      v: 1,
      app: "ktp",
      ts: 1700000002,
      withSecrets: false,
      accounts: [{ key: "x", email: "1", name: "甲", school: "乙", ip: "1.2.3.4" }],
    },
  },
];

/** 与 Java 侧 exportAccounts 完全一致的编码 */
function encode(payload) {
  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return "KTP1:" + b64;
}

/** 与 Java 侧 importAccounts 完全一致的解码 */
function decode(input) {
  const raw = String(input).trim();
  if (raw.startsWith("{")) return JSON.parse(raw);
  let text = raw.replace(/\s+/g, "");
  if (text.startsWith("KTP1:")) text = text.slice(5);
  else if (text.startsWith("KTP1")) text = text.slice(4);
  return JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
}

let fail = 0;
const check = (ok, label, extra = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok || !extra ? "" : "  <- " + extra}`);
  if (!ok) fail++;
};

for (const c of CASES) {
  const s = encode(c.payload);

  check(!/\s/.test(s), `[${c.name}] 导出串无空白字符`, JSON.stringify(s.slice(0, 60)));
  check(s.split("\n").length === 1, `[${c.name}] 导出串是单行`);
  check(s.startsWith("KTP1:"), `[${c.name}] 有 KTP1: 前缀`);

  const back = decode(s);
  check(
    JSON.stringify(back) === JSON.stringify(c.payload),
    `[${c.name}] 直接导入能原样还原`,
    JSON.stringify(back),
  );

  // 模拟被 textarea / 微信拆行后再导入
  const wrapped = s.replace(/(.{20})/g, "$1\n");
  const back2 = decode(wrapped);
  check(
    JSON.stringify(back2) === JSON.stringify(c.payload),
    `[${c.name}] 换行拆开后导入仍能还原`,
  );

  // 前后带空白（复制常见）
  const padded = `  \n${s}\n  `;
  check(
    JSON.stringify(decode(padded)) === JSON.stringify(c.payload),
    `[${c.name}] 前后空白不影响`,
  );
}

// 冗余前缀容错
const one = CASES[0].payload;
check(JSON.stringify(decode(encode(one).replace("KTP1:", "KTP1"))) === JSON.stringify(one), "只有 KTP1 没有冒号也能解");

// 裸 JSON 也要能导入（且保留空格）
const bare = JSON.stringify(CASES[1].payload);
check(JSON.stringify(decode(bare)) === JSON.stringify(CASES[1].payload), "裸 JSON 导入保留空格");

// 非法输入应抛错而不是静默
for (const bad of ["", "hello world", "KTP1:!!!!"]) {
  let threw = false;
  try {
    decode(bad);
  } catch {
    threw = true;
  }
  check(threw, `非法输入被拒绝: ${JSON.stringify(bad)}`);
}

console.log(fail === 0 ? "\nALL PASS" : `\nFAILED: ${fail}`);
process.exit(fail === 0 ? 0 : 1);
