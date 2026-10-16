/**
 * 最接近真实的复现：老师先签到（模拟"老师在教室开定位签到"），
 * 然后学生从不同距离提交，看服务器到底认不认。
 *
 * 为什么必须这样测：
 *   前一轮四个坐标全部成功，但那是因为签到里没设位置（centerPoint=null）——服务器没得校验。
 *   而接口层又设不上位置（试了 6 种建参写法都不行），说明目标位置是老师端 GPS 带上的。
 *   所以唯一能复现"有目标位置"的办法，就是让老师自己先提交一次位置。
 *   这也符合接口返回里的字段名：avgLocation（平均位置）、radius（半径）。
 *
 * 用法: node tools/exp-gps-real.ts [courseid]
 */
import { KtpClient } from "../src/client.ts";
import { getCachedToken, loadConfig, resolveAccount, setCachedToken } from "../src/config.ts";

const config = loadConfig();
// ⚠️ 课程 ID 不再写死在仓库里（那是真实的课程，不该公开）。
// 用法: node <本脚本> <courseid>    —— courseid 可以从 `node src/cli.ts courses` 里抄
const courseid = process.argv[2];
if (!courseid) {
  console.error("用法: node " + process.argv[1] + " <courseid>");
  console.error("（courseid 用 `node src/cli.ts courses` 查）");
  process.exit(1);
}

async function makeClient(label: string): Promise<KtpClient> {
  const account = resolveAccount(label);
  const client = new KtpClient({ label, fakeIpPrefixes: config.fakeIpPrefixes });
  setCachedToken(label, await client.login(account.email, account.password));
  return client;
}

const teacher = await makeClient("teacher");
const stu = await makeClient("stu");

const CLASSROOM = { lat: "39.904200", lng: "116.407400" };
type Coords = { lat: string; lng: string };

function meters(a: Coords, b: Coords): number {
  const R = 6371000;
  const dLat = ((Number(b.lat) - Number(a.lat)) * Math.PI) / 180;
  const dLng = ((Number(b.lng) - Number(a.lng)) * Math.PI) / 180;
  const la = (Number(a.lat) * Math.PI) / 180;
  const x = dLng * Math.cos(la);
  return Math.sqrt(dLat * dLat + x * x) * R;
}

async function checkin(client: KtpClient, id: string, c: Coords): Promise<{ ok: boolean; msg: string }> {
  const res = await client.call("/AttenceApi/checkin", {
    id,
    code: "",
    unusual: "",
    latitude: c.lat,
    longitude: c.lng,
    accuracy: "30",
    clienttype: 1,
  });
  return {
    ok: KtpClient.checkinSucceeded(res.json),
    msg: String(res.json?.message ?? res.json?.data?.info ?? "").slice(0, 50),
  };
}

async function oneCase(note: string, stuCoords: Coords): Promise<void> {
  const created = await teacher.call("/AttenceApi/addGPSAttence", {
    courseid,
    title: `真实复现-${note}(自动删)`,
  });
  const id: string = created.json?.data?.attenceid;
  if (!id) {
    console.log(`  ${note}: 创建失败`);
    return;
  }
  try {
    // 老师先签（模拟老师在教室）
    const t = await checkin(teacher, id, CLASSROOM);
    console.log(`  [老师签到] ${t.ok ? "✅" : "❌"} ${t.msg}`);

    // 老师签完之后，目标位置有了吗？
    const loc = await teacher.call("/AttenceApi/getLocation", { attenceid: id });
    const d = loc.json?.data ?? {};
    console.log(`  [位置信息] centerPoint=${JSON.stringify(d.centerPoint)} avgLocation=${JSON.stringify(d.avgLocation)} radius=${d.radius}`);

    // 学生提交
    const s = await checkin(stu, id, stuCoords);
    const dist = meters(CLASSROOM, stuCoords);
    console.log(
      `  [学生签到] ${s.ok ? "✅ 成功" : "❌ 失败"}  离教室 ` +
        `${dist > 1000 ? (dist / 1000).toFixed(1) + " km" : dist.toFixed(0) + " m"}  ${s.msg}`,
    );
  } finally {
    await teacher.call("/AttenceApi/overAttence", { id });
    await teacher.call("/AttenceApi/delAttence", { attenceid: id });
  }
}

console.log("每个用例都新建签到（签过一次就不能再签）\n");

console.log("=== 用例1：学生也在教室 ===");
await oneCase("同位置", CLASSROOM);

console.log("\n=== 用例2：学生偏 800 米（超出 radius=200）===");
await oneCase("偏800米", { lat: "39.911200", lng: "116.407400" });

console.log("\n=== 用例3：学生在北京 ===");
await oneCase("北京", { lat: "39.908700", lng: "116.397500" });

console.log("\n=== 用例4：学生填 0,0 ===");
await oneCase("0,0", { lat: "0.000000", lng: "0.000000" });

console.log("\n结论：");
console.log("  用例2/3/4 若失败 => 服务器**按老师提交的位置校验距离**，必须知道教室坐标；");
console.log("  全部成功        => 只记录不校验，坐标随便填。");
