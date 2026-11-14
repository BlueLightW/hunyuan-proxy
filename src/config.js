import { URL } from "node:url";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Carrega .env (se existir) antes de ler as variáveis de ambiente.
try {
  const envPath = fileURLToPath(new URL("../.env", import.meta.url));
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].trim().replace(/\r$/, "").replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = val;
  }
} catch {
  // sem .env: usa apenas variáveis do shell
}

function parseNumber(val, fallback) {
  const n = Number(val);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export const config = {
  port: process.env.HUNYUAN_PROXY_PORT || 8787,
  host: process.env.HUNYUAN_PROXY_HOST || '0.0.0.0',
  token: process.env.HUNYUAN_PROXY_TOKEN,
  requireAuth: process.env.HUNYUAN_PROXY_REQUIRE_AUTH !== 'false',
  watchdogMs: parseInt(process.env.HUNYUAN_PROXY_WATCHDOG_MS || '600000'),

  // Multi-account settings
  accounts: {
    enabled: process.env.HUNYUAN_MULTI_ACCOUNT === 'true' || false,
    poolSize: parseInt(process.env.HUNYUAN_ACCOUNT_POOL_SIZE || '5'),
    cooldownMs: parseInt(process.env.HUNYUAN_ACCOUNT_COOLDOWN_MS || '60000'),
    maxConcurrency: parseInt(process.env.HUNYUAN_MAX_CONCURRENCY || '10'),
  },

  // Caminho para o banco de dados
  dbPath: process.env.HUNYUAN_DB_PATH || './data/accounts.db',
};

export function validateConfig() {
  if (config.requireAuth && !config.token) {
    throw new Error("HUNYUAN_PROXY_TOKEN é obrigatório quando HUNYUAN_PROXY_REQUIRE_AUTH != false");
  }
}

export const RAW = true;
export const SERVER_URL = process.env.HUNYUAN_UPSTREAM_URL || "http://127.0.0.1:4096";
export const SERVER_PASSWORD = process.env.HUNYUAN_UPSTREAM_PASSWORD || "";
export const DEFAULT_MODEL = process.env.HUNYUAN_PROXY_MODEL || "hunyuan-turbo";
export const BODY_MAX_BYTES = 4 * 1024 * 1024;
export const FALLBACK_MS = parseNumber(process.env.HUNYUAN_PROXY_FALLBACK_MS, 500);
export const CORS_ORIGIN = process.env.HUNYUAN_PROXY_CORS_ORIGIN || "*";

export const upstream = new URL(SERVER_URL);
export const SERVER_AUTH = SERVER_PASSWORD
  ? "Basic " + Buffer.from("hunyuan:" + SERVER_PASSWORD).toString("base64")
  : "";

export const hunyuanModels = [
  "hunyuan-turbo",
  "hunyuan-pro",
  "hunyuan-lite",
];