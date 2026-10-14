/**
 * 二维码内容解析。
 *
 * 课堂派二维码签到展示的二维码，内容形如：
 *   https://w.ketangpai.com/checkin/checkinCodeResult?type=2&ticketid=<...>&expire=<...>&sign=<...>
 *
 * 真正参与签名校验的只有 ticketid / expire / sign 三个参数，
 * 提交到 AttenceApi/AttenceResult 时请求体也是这三个字段。
 */
export interface QrTicket {
  ticketid: string;
  expire: string;
  sign: string;
  /** 二维码 URL 里的 type 参数，观察用。 */
  type?: string;
  /** 原始内容，便于回溯。 */
  source: string;
}

const ALIASES: Record<string, string[]> = {
  ticketid: ["ticketid", "ticketId", "ticket_id"],
  expire: ["expire", "expires", "expiretime", "expire_time"],
  sign: ["sign", "signature", "sig"],
  type: ["type"],
};

function pick(source: Record<string, unknown>, field: keyof typeof ALIASES): string | undefined {
  const lower = new Map<string, unknown>();
  for (const [k, v] of Object.entries(source)) lower.set(k.toLowerCase(), v);
  for (const alias of ALIASES[field]) {
    const value = lower.get(alias.toLowerCase());
    if (value !== undefined && value !== null && value !== "") return String(value);
  }
  return undefined;
}

function assemble(source: Record<string, unknown>, raw: string): QrTicket {
  const ticketid = pick(source, "ticketid");
  const expire = pick(source, "expire");
  const sign = pick(source, "sign");

  const missing = [
    ticketid ? null : "ticketid",
    expire ? null : "expire",
    sign ? null : "sign",
  ].filter(Boolean);

  if (missing.length > 0) {
    throw new Error(
      `二维码内容里缺少必需字段 ${missing.join(", ")}。原始内容前 160 字符：${raw.slice(0, 160)}`,
    );
  }

  return {
    ticketid: ticketid!,
    expire: expire!,
    sign: sign!,
    type: pick(source, "type"),
    source: raw,
  };
}

/**
 * 接受多种输入形式：
 *  - 完整 URL（含 w.ketangpai.com/checkin/checkinCodeResult?...）
 *  - 纯查询串（ticketid=...&expire=...&sign=...）
 *  - JSON（手机端 App 抓包拿到的请求体）
 *  - 从照片里解出来的任意包含上述参数的文本
 */
export function parseQrTicket(input: string): QrTicket {
  const raw = String(input ?? "").trim();
  if (!raw) throw new Error("二维码内容是空的");

  if (raw.startsWith("{")) {
    try {
      return assemble(JSON.parse(raw) as Record<string, unknown>, raw);
    } catch (err) {
      if (err instanceof Error && err.message.includes("缺少必需字段")) throw err;
      // 不是合法 JSON，继续按查询串处理
    }
  }

  const queryStart = raw.indexOf("?");
  const query = queryStart >= 0 ? raw.slice(queryStart + 1) : raw;
  const params = new URLSearchParams(query);
  const source: Record<string, unknown> = {};
  for (const [k, v] of params.entries()) source[k] = v;

  return assemble(source, raw);
}

/** expire 是「秒级 unix 时间戳」，返回剩余有效秒数（负数表示已过期）。 */
export function secondsUntilExpire(ticket: QrTicket, now = Date.now()): number {
  const expire = Number(ticket.expire);
  if (!Number.isFinite(expire)) return Number.NaN;
  return expire - now / 1000;
}
