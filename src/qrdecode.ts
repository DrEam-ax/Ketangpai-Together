/**
 * 从图片/视频帧里解出二维码字符串。
 *
 * 两级策略：
 *   1. jsQR（纯 JS，浏览器里也能跑，方便以后打包 App）—— 快，适合逐帧扫描
 *   2. Python + OpenCV / zxing-cpp —— 慢但鲁棒，适合「朋友拍屏幕发来的照片」
 *
 * 注意：Node 的 child_process.execFile（异步版）**不支持 input 选项**，
 * 传了会被忽略、Python 会一直阻塞在 stdin 上直到超时。
 * 所以这里用 spawn 手动写 stdin 并 end()。
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Jimp from "jimp";
import jsQR from "jsqr";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PY_SCRIPT = path.join(ROOT, "tools", "decode_qr.py");

export interface DecodeOutcome {
  text: string | null;
  engine: "jsQR" | "OpenCV" | null;
}

// ---------------------------------------------------------------- jsQR

/** 纯函数：从 RGBA 像素里解二维码。浏览器里可直接喂 canvas 的 ImageData。 */
export function decodeQrFromRgba(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): string | null {
  return jsQR(data, width, height, { inversionAttempts: "attemptBoth" })?.data ?? null;
}

/** 对一张 Jimp 图做多尺度 jsQR 尝试。 */
function jsQrAttempts(image: Jimp): string | null {
  const width = image.bitmap.width;
  const scales: number[] = [1];

  // 大截图先缩小：jsQR 在超大图上容易漏掉二维码
  if (width > 1600) scales.push(1600 / width);
  // 小图放大有助于细节
  if (width < 1200) scales.push(2);

  for (const scale of scales) {
    const img = scale === 1 ? image : image.clone().scale(scale);
    const found = decodeQrFromRgba(
      new Uint8ClampedArray(img.bitmap.data),
      img.bitmap.width,
      img.bitmap.height,
    );
    if (found) return found;
  }
  return null;
}

// ---------------------------------------------------------------- Python 兜底

function runPython(args: string[], input: Buffer | null, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("python", args, { cwd: ROOT, windowsHide: true });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`解码超时（${timeoutMs}ms）`));
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`python 退出码 ${code}: ${stderr.slice(0, 200)}`));
    });

    if (input) child.stdin.write(input);
    // 必须 end()，否则 Python 的 stdin.read() 会一直等
    child.stdin.end();
  });
}

async function tryPython(
  input: { file?: string; buffer?: Buffer },
  fast: boolean,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const args = input.file ? [PY_SCRIPT, input.file] : [PY_SCRIPT, "-"];
    if (fast) args.push("--fast");
    const stdout = await runPython(args, input.buffer ?? null, timeoutMs);
    const list = JSON.parse(stdout.trim() || "[]") as string[];
    return list[0] ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 对外接口

export interface DecodeOptions {
  /** 逐帧扫描用：只试最快的一两种方案。 */
  fast?: boolean;
  timeoutMs?: number;
}

/** 从文件解码（朋友的截图/照片）。 */
export async function decodeQrFromFile(
  file: string,
  options: DecodeOptions = {},
): Promise<DecodeOutcome> {
  if (!options.fast) {
    try {
      const image = await Jimp.read(file);
      const byJs = jsQrAttempts(image);
      if (byJs) return { text: byJs, engine: "jsQR" };
    } catch {
      /* 交给 Python */
    }
  }
  const byPy = await tryPython({ file }, options.fast ?? false, options.timeoutMs ?? 60_000);
  return { text: byPy, engine: byPy ? "OpenCV" : null };
}

/** 从内存里的图片字节解码（上传的截图 / 摄像头帧）。 */
export async function decodeQrFromBuffer(
  buffer: Buffer,
  options: DecodeOptions = {},
): Promise<DecodeOutcome> {
  try {
    const image = await Jimp.read(buffer);
    const byJs = jsQrAttempts(image);
    if (byJs) return { text: byJs, engine: "jsQR" };
  } catch {
    /* 交给 Python */
  }
  const byPy = await tryPython({ buffer }, options.fast ?? false, options.timeoutMs ?? 60_000);
  return { text: byPy, engine: byPy ? "OpenCV" : null };
}
