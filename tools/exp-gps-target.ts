/**
 * 补实验：**把目标位置真正设上**之后，服务器还认不认"你离得有多远"？
 *
 * 上一轮四个坐标（含 0,0 和北京）全部成功，但那是因为我建签到时没设位置 ——
 * getLocation 返回 centerPoint=null、avgLocation=0,0，服务器没得可校验。
 * 真实场景里老师是设了位置的，所以必须重测。
 *
 * 用法: node tools/exp-gps-target.ts [courseid]
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

/** 上海某处，当"教室" */
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

/** 各种可能的建参写法，看哪种能把位置设上 */
const CREATE_VARIANTS: Array<{ name: string; extra: Record<string, unknown> }> = [
  { name: "latitude/longitude", extra: { latitude: CLASSROOM.lat, longitude: CLASSROOM.lng } },
  { name: "latitude/longitude/radius", extra: { latitude: CLASSROOM.lat, longitude: CLASSROOM.lng, radius: 200 } },
  { name: "lat/lng", extra: { lat: CLASSROOM.lat, lng: CLASSROOM.lng } },
  {
    name: "centerPoint 字符串",
    extra: { centerPoint: JSON.stringify({ latitude: Number(CLASSROOM.lat), longitude: Number(CLASSROOM.lng) }) },
  },
  {
    name: "centerPoint 对象",
    extra: { centerPoint: { latitude: Number(CLASSROOM.lat), longitude: Number(CLASSROOM.lng) } },
  },
  {
    name: "position 字符串",
    extra: { position: `${CLASSROOM.lng},${CLASSROOM.lat}` },
  },
];

async function createAndInspect(name: string, extra: Record<string, unknown>): Promise<boolean> {
  const created = await teacher.call("/AttenceApi/addGPSAttence", {
    courseid,
    title: `目标位置实验-${name}(自动删)`,
    ...extra,
  });
  const id: string = created.json?.data?.attenceid;
  if (!id) {
    console.log(`  ${name.padEnd(24)} 创建失败: ${String(created.json?.message ?? "").slice(0, 30)}`);
    return false;
  }
  try {
    const loc = await teacher.call("/AttenceApi/getLocation", { attenceid: id });
    const d = loc.json?.data ?? {};
    const cp = d.centerPoint ?? {};
    const got = cp.latitude != null && cp.longitude != null;
    console.log(
      `  ${name.padEnd(24)} centerPoint=${got ? `✅ ${cp.latitude},${cp.longitude}` : "❌ null"}  ` +
        `avgLocation=${JSON.stringify(d.avgLocation)}  radius=${d.radius}`,
    );
    return got;
  } finally {
    await teacher.call("/AttenceApi/overAttence", { id });
    await teacher.call("/AttenceApi/delAttence", { attenceid: id });
  }
}

console.log("=== 第一步：哪种建参能把目标位置设上？ ===");
let working: Record<string, unknown> | null = null;
for (const v of CREATE_VARIANTS) {
  if (await createAndInspect(v.name, v.extra)) {
    working = v.extra;
    break;
  }
}

if (!working) {
  console.log("\n所有写法都没能把位置设上 —— 说明目标位置是老师端 GPS 自动带上的，");
  console.log("接口层面可能根本设不了。那就在真实签到上验：");
  console.log("（退而求其次）用「老师端 GPS 自动定位」这条路走不通，只能看真实签到。");
  process.exit(0);
}

console.log(`\n✅ 用「${JSON.stringify(working)}」可以设上位置，接着验证距离判据：\n`);

async function caseWithTarget(note: string, coords: Coords): Promise<void> {
  const created = await teacher.call("/AttenceApi/addGPSAttence", {
    courseid,
    title: `距离判据-${note}(自动删)`,
    ...working!,
  });
  const id: string = created.json?.data?.attenceid;
  if (!id) {
    console.log(`  ${note}: 创建失败`);
    return;
  }
  try {
    const res = await stu.call("/AttenceApi/checkin", {
      id,
      code: "",
      unusual: "",
      latitude: coords.lat,
      longitude: coords.lng,
      accuracy: "30",
      clienttype: 1,
    });
    const ok = KtpClient.checkinSucceeded(res.json);
    const dist = meters(CLASSROOM, coords);
    console.log(
      `  ${ok ? "✅ 成功" : "❌ 失败"}  离教室 ${dist > 1000 ? (dist / 1000).toFixed(1) + " km" : dist.toFixed(0) + " m"}` +
        `  (${note})  ${ok ? "" : String(res.json?.message ?? "").slice(0, 40)}`,
    );
  } finally {
    await teacher.call("/AttenceApi/overAttence", { id });
    await teacher.call("/AttenceApi/delAttence", { attenceid: id });
  }
}

await caseWithTarget("正好在教室", CLASSROOM);
await caseWithTarget("偏 150 米(半径内)", { lat: "39.905400", lng: "116.407400" });
await caseWithTarget("偏 800 米(半径外)", { lat: "39.911200", lng: "116.407400" });
await caseWithTarget("北京", { lat: "39.908700", lng: "116.397500" });
await caseWithTarget("0,0", { lat: "0.000000", lng: "0.000000" });
