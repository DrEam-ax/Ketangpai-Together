/** 服务端要求的毫秒级请求时间戳。 */
export function reqtimestamp(): number {
  return Date.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * X-Forwarded-For 伪造。
 *
 * 课堂派的定位签到会看来源 IP，几十个学生从同一个出口 IP 提交会被判异常。
 * ktpWarp 的做法是给每个请求随机分配一个「国内移动网络前缀 + 1~254」的假 IP，
 * 并用乱序池避免短时间内重复。
 */
export class FakeIp {
  #prefixes: string[];
  #suffixes: number[] = [];
  #enabled: boolean;

  constructor(prefixes: string[] = [], enabled = true) {
    this.#prefixes = [...prefixes];
    this.#enabled = enabled && this.#prefixes.length > 0;
    this.#shuffleSuffixes();
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  #shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  #shuffleSuffixes(): void {
    this.#suffixes = this.#shuffle(Array.from({ length: 254 }, (_, i) => i + 1));
  }

  /**
   * 取下一个假 IP。
   *
   * ⚠️ 必须凑够 4 段。课堂派是逐字记录 X-Forwarded-For 的，格式不合法
   * （只有 3 段、或带端口）就会被记成 0.0.0.0，教师端考勤表里一眼看出异常。
   * 实测：
   *   203.0.113.77       -> 203.0.113.77
   *   223.104.137         -> 0.0.0.0   （3 段）
   *   203.0.113.77:1234  -> 0.0.0.0   （带端口）
   *   192.168.1.5         -> 192.168.1.5（它不校验是否公网）
   *
   * 所以这里允许前缀只写 1~2 段，缺的段自动补齐，保证输出永远是合法 IPv4。
   */
  next(): string | null {
    if (!this.#enabled) return null;
    if (this.#suffixes.length === 0) this.#shuffleSuffixes();

    const prefix = this.#prefixes[Math.floor(Math.random() * this.#prefixes.length)];
    const octets = prefix.split(".").filter((part) => part.length > 0);
    while (octets.length < 3) octets.push(String(2 + Math.floor(Math.random() * 252)));
    octets.push(String(this.#suffixes.pop()!));
    return octets.slice(0, 4).join(".");
  }
}

/** 截断长字符串，便于日志输出。 */
export function truncate(s: string, max = 4000): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n... [已截断 ${s.length - max} 字符]`;
}

export function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
