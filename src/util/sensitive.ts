/**
 * 敏感文件判定（纯函数，无任何 import，便于单测）。
 *
 * 为什么需要它：Vault 是用户的整个笔记目录，里面完全可能躺着
 * `服务器/credentials.json`、`备份/id_rsa`、`.env`。
 * 一旦 `read_file` 或 `search` 读到它们，内容会原样发给模型厂商的 API——
 * 这是真实的数据外泄路径，不是假设。
 *
 * 两个容易漏的点：
 *   1. **点变体**：`.env.bak`、`.env.key`、`credentials.json.old` 换个后缀就绕过朴素黑名单。
 *   2. **同名豁免**：`.env.example` / `.env.sample` / `.env.template` 是模板，不含真实密钥。
 */

/** 文件名（小写比较）直接命中 */
const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".htpasswd",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "credentials",
  "credentials.json",
  "secrets.json",
  "secret.json",
  "kdbx",
]);

/** 扩展名命中（小写，不含点） */
const SENSITIVE_EXT = new Set([
  "pem",
  "key",
  "p12",
  "pfx",
  "keystore",
  "jks",
  "kdbx",
  "ppk", // PuTTY 私钥
]);

/** 路径里出现这些目录段就命中 */
const SENSITIVE_DIRS = new Set([".ssh", ".aws", ".gnupg", ".kube"]);

/** `.env` 的显式豁免（模板文件，无真实值） */
const ENV_EXEMPT = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);

/** 常见的改名后缀：剥掉一层再判一次 */
const CAMOUFLAGE_SUFFIXES = [
  ".bak", ".backup", ".copy", ".disabled", ".key", ".old",
  ".orig", ".pem", ".save", ".tmp", ".txt", ".md",
];

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i <= 0 ? "" : name.slice(i + 1).toLowerCase();
}

function basenameOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function dirSegments(path: string): string[] {
  return path.toLowerCase().split("/").slice(0, -1);
}

/** 剥掉伪装后缀后重试，最多两层（`id_rsa.old.bak`） */
function stripCamouflage(name: string): string[] {
  const out = [name];
  let cur = name;
  for (let depth = 0; depth < 2; depth++) {
    const hit = CAMOUFLAGE_SUFFIXES.find((s) => cur.toLowerCase().endsWith(s) && cur.length > s.length);
    if (!hit) break;
    cur = cur.slice(0, cur.length - hit.length);
    out.push(cur);
  }
  return out;
}

function matchesName(name: string): boolean {
  const lower = name.toLowerCase();
  if (ENV_EXEMPT.has(lower)) return false;

  // 公钥不是秘密：id_rsa.pub 之类放行
  const pubStem = lower.endsWith(".pub") ? lower.slice(0, -4) : null;
  if (pubStem && /^id_(rsa|dsa|ecdsa|ed25519)/.test(pubStem)) return false;

  for (const candidate of stripCamouflage(lower)) {
    if (SENSITIVE_BASENAMES.has(candidate)) return true;
    // `.env` 的任何变体（`.env.local`、`.env.production`）
    if (candidate === ".env" || candidate.startsWith(".env.")) return true;
    // `credentials*.json`、`id_rsa_xxx`
    if (candidate.startsWith("id_rsa") || candidate.startsWith("id_ed25519") || candidate.startsWith("id_ecdsa")) {
      return true;
    }
    if (candidate.startsWith("credentials")) return true;
    const e = extOf(candidate);
    if (e && SENSITIVE_EXT.has(e)) return true;
  }
  return false;
}

/**
 * 命中则返回人话理由（用于报错），未命中返回 null。
 */
export function sensitiveReason(path: string): string | null {
  const clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean) return null;

  const name = basenameOf(clean);
  if (!name) return null;

  for (const seg of dirSegments(clean)) {
    if (SENSITIVE_DIRS.has(seg)) {
      return `该文件位于 ${seg}/ 目录下，可能包含密钥凭据`;
    }
  }

  if (matchesName(name)) {
    return `文件名 ${name} 命中密钥/凭据特征`;
  }

  return null;
}

export function isSensitivePath(path: string): boolean {
  return sensitiveReason(path) !== null;
}
