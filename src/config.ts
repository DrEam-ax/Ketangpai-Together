import fs from "node:fs";
import path from "node:path";

export const ROOT_DIR = path.resolve(import.meta.dirname, "..");
const CONFIG_PATH = path.join(ROOT_DIR, "config.local.json");
const CACHE_DIR = path.join(ROOT_DIR, ".cache");
const TOKEN_PATH = path.join(CACHE_DIR, "tokens.json");

export interface Account {
  email: string;
  password: string;
}

export interface AppConfig {
  fakeIpPrefixes: string[];
  accounts: Record<string, Account>;
}

const DEFAULT_CONFIG: AppConfig = {
  fakeIpPrefixes: ["223.104.", "117.136.", "183.232."],
  accounts: {},
};

export function loadConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_PATH)) return { ...DEFAULT_CONFIG };
  const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as Partial<AppConfig>;
  return {
    fakeIpPrefixes: parsed.fakeIpPrefixes ?? DEFAULT_CONFIG.fakeIpPrefixes,
    accounts: parsed.accounts ?? {},
  };
}

export function resolveAccount(who: string): Account {
  const cfg = loadConfig();
  const account = cfg.accounts[who];
  if (!account?.email) {
    throw new Error(
      `config.local.json 里没有配置账号 "${who}"。已配置：${
        Object.keys(cfg.accounts).join(", ") || "(空)"
      }`,
    );
  }
  return account;
}

function writeConfig(cfg: AppConfig): void {
  const payload = { fakeIpPrefixes: cfg.fakeIpPrefixes, accounts: cfg.accounts };
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** 新增或更新一个账号（现场收集别人的号时用）。 */
export function upsertAccount(key: string, account: Account): void {
  const cfg = loadConfig();
  cfg.accounts[key] = account;
  writeConfig(cfg);
}

/** 删除一个账号，同时清掉它的 token 缓存。 */
export function removeAccount(key: string): void {
  const cfg = loadConfig();
  delete cfg.accounts[key];
  writeConfig(cfg);
  clearCachedToken(key);
}

type TokenCache = Record<string, { token: string; savedAt: number }>;

function readTokenCache(): TokenCache {
  if (!fs.existsSync(TOKEN_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8")) as TokenCache;
  } catch {
    return {};
  }
}

export function getCachedToken(key: string): string | null {
  return readTokenCache()[key]?.token ?? null;
}

export function setCachedToken(key: string, token: string): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cache = readTokenCache();
  cache[key] = { token, savedAt: Date.now() };
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(cache, null, 2), "utf8");
}

export function clearCachedToken(key: string): void {
  const cache = readTokenCache();
  delete cache[key];
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(cache, null, 2), "utf8");
}
