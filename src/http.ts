/**
 * 最小 HTTP 客户端。
 *
 * 为什么不用全局 fetch：Fetch 规范把 Origin / Referer / Sec-* 列为
 * "forbidden header name"，undici 会把它们静默丢掉，而课堂派正好校验这些头。
 * 直接用 node:https 可以原样发送任意请求头，且零依赖。
 */
import https from "node:https";
import zlib from "node:zlib";
import { sleep } from "./util.ts";

export interface HttpResponse {
  status: number;
  headers: NodeJS.Dict<string | string[]>;
  body: string;
  json: any;
}

export interface RequestOptions {
  method?: string;
  headers?: Record<string, string>;
  /** 对象会被 JSON.stringify；字符串原样发送；undefined 则不带 body。 */
  body?: unknown;
  timeoutMs?: number;
  /** 失败重试次数（不含首次）。 */
  retries?: number;
}

function decompress(buf: Buffer, encoding?: string | string[]): Buffer {
  const enc = Array.isArray(encoding) ? encoding.join(",") : (encoding ?? "");
  const e = enc.toLowerCase();
  try {
    if (e.includes("br")) return zlib.brotliDecompressSync(buf);
    if (e.includes("gzip")) return zlib.gunzipSync(buf);
    if (e.includes("deflate")) return zlib.inflateSync(buf);
  } catch {
    /* 服务端偶尔会撒个小谎，解不开就按原文返回 */
  }
  return buf;
}

function once(
  url: string,
  method: string,
  headers: Record<string, string>,
  payload: string | undefined,
  timeoutMs: number,
): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method,
        headers: {
          ...headers,
          ...(payload !== undefined
            ? { "Content-Length": String(Buffer.byteLength(payload)) }
            : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const buf = decompress(Buffer.concat(chunks), res.headers["content-encoding"]);
          const body = buf.toString("utf8");
          let json: any = null;
          try {
            json = JSON.parse(body);
          } catch {
            /* 非 JSON 响应留空，调用方看 body */
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
        });
        res.on("error", reject);
      },
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时（${timeoutMs}ms）`));
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export async function httpRequest(url: string, opts: RequestOptions = {}): Promise<HttpResponse> {
  const { method = "POST", headers = {}, body, timeoutMs = 20_000, retries = 2 } = opts;
  const payload =
    body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await once(url, method, headers, payload, timeoutMs);
    } catch (err) {
      lastError = err;
      if (attempt < retries) await sleep(300 * (attempt + 1));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
