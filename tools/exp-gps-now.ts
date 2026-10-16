/**
 * 决定性实验：定位签到到底怎么判？
 *
 * 用户的实际问题：他们平时用「影梭」改高德定位，有人还得把微信塞进虚拟机才能骗过课堂派。
 * 那是为了骗**官方客户端**（它读系统定位）。我们自己发请求的话，
 * 坐标只是请求体里的普通参数 —— 所以真正要搞清楚的是：
 *   1) 学生能不能自己取到老师设的目标坐标（能的话就能一键签到，不用手动查）
 *   2) 服务器到底验不验「你离目标多远」
 *
 * 三种提交各试一次：目标坐标 / 差一点点 / 差一座城。对比结果就知道判据是什么。
 *
 * 用法: node tools/exp-gps-now.ts [courseid]
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

async function makeClient(label: string, force = false): Promise<KtpClient> {
  if (!force) {
    const cached = getCachedToken(label);
    if (cached) return new KtpClient({ token: cached, label, fakeIpPrefixes: config.fakeIpPrefixes });
  }
  const account = resolveAccount(label);
  const client = new KtpClient({ label, fakeIpPrefixes: config.fakeIpPrefixes });
  setCachedToken(label, await client.login(account.email, account.password));
  return client;
}

const teacher = await makeClient("teacher", true);
const stu = await makeClient("stu", true);

type Coords = { lat: string; lng: string };

async function submit(id: string, c: Coords, note: string): Promise<void> {
  const res = await stu.call("/AttenceApi/checkin", {
    id,
    code: "",
    unusual: "",
    latitude: c.lat,
    longitude: c.lng,
    accuracy: "30",
    clienttype: 1,
  });
  const state = res.json?.data?.state;
  const ok = KtpClient.checkinSucceeded(res.json);
  console.log(
    `  ${ok ? "✅ 成功" : "❌ 失败"}  ${note.padEnd(28)} ` +
      `lat=${c.lat} lng=${c.lng}  state=${state ?? "-"}  ${ok ? "" : res.json?.message ?? ""}`,
  );
}

/** 两条坐标之间大概多少米（球面近似，够用了） */
function meters(a: Coords, b: Coords): number {
  const R = 6371000;
  const dLat = ((Number(b.lat) - Number(a.lat)) * Math.PI) / 180;
  const dLng = ((Number(b.lng) - Number(a.lng)) * Math.PI) / 180;
  const la = (Number(a.lat) * Math.PI) / 180;
  const x = dLng * Math.cos(la);
  return Math.sqrt(dLat * dLat + x * x) * R;
}

async function oneCase(label: string, submitCoords: (t: Coords) => Coords): Promise<void> {
  const created = await teacher.call("/AttenceApi/addGPSAttence", {
    courseid,
    title: `定位判据实验-${label}(自动删除)`,
  });
  const id: string = created.json?.data?.attenceid;
  if (!id) {
    console.log(`\n=== ${label} ===  创建失败: ${JSON.stringify(created.json)?.slice(0, 150)}`);
    return;
  }
  console.log(`\n=== ${label} ===  attenceid=${id}`);
  console.log(`  创建返回: ${created.json?.data?.info ?? ""}  status=${created.json?.status}`);

  try {
    // 1) 老师取目标坐标
    const tLoc = await teacher.call("/AttenceApi/getLocation", { attenceid: id });
    const td = tLoc.json?.data ?? {};
    const target: Coords = {
      lat: String(td.latitude ?? td.lat ?? ""),
      lng: String(td.longitude ?? td.lng ?? ""),
    };
    console.log(`  老师 getLocation -> lat=${target.lat} lng=${target.lng}`);
    console.log(`  getLocation 全部字段: ${JSON.stringify(td).slice(0, 300)}`);

    // 2) 学生也能取吗？（能的话 App 就能一键，不用用户自己查坐标）
    const sLoc = await stu.call("/AttenceApi/getLocation", { attenceid: id });
    const sd = sLoc.json?.data ?? {};
    const stuOk = String(sd.latitude ?? sd.lat ?? "") !== "";
    console.log(
      `  学生 getLocation -> ${stuOk ? "✅ 能取到" : "❌ 取不到"} ` +
        `code=${sLoc.json?.code} ${String(sLoc.json?.message ?? "").slice(0, 20)}`,
    );

    // 3) 用指定坐标提交
    const use = submitCoords(target.lat ? target : { lat: "39.9042", lng: "116.4074" });
    const dist = meters(target.lat ? target : { lat: "0", lng: "0" }, use);
    await submit(id, use, `差约 ${dist > 1000 ? (dist / 1000).toFixed(1) + " km" : dist.toFixed(0) + " m"}`);
  } finally {
    await teacher.call("/AttenceApi/overAttence", { id });
    const del = await teacher.call("/AttenceApi/delAttence", { attenceid: id });
    console.log(`  清理: ${JSON.stringify(del.json)?.slice(0, 90)}`);
  }
}

console.log("每次都要新建一个签到 —— 因为一旦签过就不能再签（会报「已参与过」）\n");

// A: 用目标坐标
await oneCase("A-目标坐标", (t) => t);
// B: 偏 300 米左右
await oneCase("B-偏几百米", (t) => ({
  lat: (Number(t.lat) + 0.003).toFixed(6),
  lng: (Number(t.lng) + 0.003).toFixed(6),
}));
// C: 换一座城（上海 -> 北京）
await oneCase("C-差一座城", () => ({ lat: "39.9087", lng: "116.3975" }));
// D: 完全瞎填
await oneCase("D-瞎填", () => ({ lat: "0.000000", lng: "0.000000" }));

console.log("\n判据很清楚：A/B 成功而 C/D 失败 => 服务器**确实校验距离**，必须知道教室坐标；");
console.log("           四个都成功    => 坐标根本不校验，随便填（那影梭/虚拟机就完全是多余的）。");
