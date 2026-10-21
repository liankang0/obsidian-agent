import { App, TFile, normalizePath } from "obsidian";

import { sensitiveReason } from "./sensitive";

import { isSpillPath, SPILL_DIR } from "../agent/spill";

/**
 * 大结果外溢目录：由插件自己写入，read_file 需要能读回来。
 * 注意 `.obsidian/` 不在 Obsidian 的 vault 索引里，这类路径必须走
 * `vault.adapter` 直接读，`getAbstractFileByPath` 一定返回 null。
 */
export const SPILL_ROOT = SPILL_DIR;

export { isSpillPath };

/**
 * 路径护栏。
 * 所有文件操作都必须先过这里——这是唯一一道防止模型改坏 Vault 的硬约束，
 * 不能依赖提示词。
 */

/** 这些目录一律禁止写入（读也禁止，避免把 API Key 之类的配置喂给模型） */
const BLOCKED_DIRS = [".obsidian", ".git", ".trash"];

/** 允许写入的扩展名 */
const WRITABLE_EXT = new Set(["md", "canvas", "base"]);

/** 单文件大小上限（字节） */
export const MAX_FILE_BYTES = 1024 * 1024;

export class PathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PathError";
  }
}

/**
 * 把模型给的路径规范成 Vault 内相对路径。
 * 任何越界意图都直接抛错，不做「尽力修正」——修正只会掩盖问题。
 */
export function toVaultPath(input: unknown): string {
  if (typeof input !== "string" || !input.trim()) {
    throw new PathError("路径为空：请传入相对 Vault 根目录的路径，例如 读书/置身事内.md");
  }

  let p = input.trim().replace(/\\/g, "/");

  // 绝对路径 / Windows 盘符 / file:// —— 一律拒绝
  if (/^[a-zA-Z]:\//.test(p)) {
    throw new PathError(`不允许绝对路径：${input}。请使用相对 Vault 根目录的路径。`);
  }
  if (p.startsWith("file://")) {
    throw new PathError(`不允许 file:// 协议：${input}`);
  }

  p = p.replace(/^\/+/, "");

  // 越界：任何一段是 .. 都拒绝（不做 normalize 后再判断，避免绕过）
  if (p.split("/").some((seg) => seg === "..")) {
    throw new PathError(`路径越界：${input}。不允许使用 .. 跳出 Vault。`);
  }

  const normalized = normalizePath(p);

  // 外溢文件是插件自己写的大结果，必须允许读回，否则外溢没有意义
  const isSpill = normalized === SPILL_ROOT || normalized.startsWith(SPILL_ROOT + "/");

  for (const dir of BLOCKED_DIRS) {
    if (isSpill) break;
    if (normalized === dir || normalized.startsWith(dir + "/")) {
      throw new PathError(
        `禁止访问 ${dir}/ 目录（${input}）。该目录存放插件配置与版本控制数据，不允许读写。`
      );
    }
  }

  // 敏感文件：密钥、凭据、私钥。读也不行——内容会被发给模型 API。
  const reason = isSpill ? null : sensitiveReason(normalized);
  if (reason) {
    throw new PathError(
      `拒绝访问 ${input}：${reason}。这类文件的内容不会被发送给模型；如确需处理，请手动把内容复制到普通笔记里再让我操作。`
    );
  }

  return normalized;
}

export function extOf(path: string): string {
  const i = path.lastIndexOf(".");
  return i < 0 ? "" : path.slice(i + 1).toLowerCase();
}

/** 写入前的扩展名校验 */
export function assertWritable(path: string): void {
  const e = extOf(path);
  if (!WRITABLE_EXT.has(e)) {
    throw new PathError(
      `不支持写入 .${e || "(无扩展名)"} 文件。当前仅允许 ${[...WRITABLE_EXT].join(" / ")}。`
    );
  }
}

/** 读取时顺带做个大小保护 */
export async function assertReadableSize(app: App, path: string, limit = MAX_FILE_BYTES): Promise<void> {
  const stat = await app.vault.adapter.stat(path);
  if (!stat) throw new PathError(`文件不存在：${path}`);
  if (stat.type !== "file") throw new PathError(`不是文件：${path}`);
  if (stat.size > limit) {
    throw new PathError(
      `文件过大（${Math.round(stat.size / 1024)} KB > ${limit / 1024} KB）：${path}。请改用行区间读取。`
    );
  }
}

/** 取 TFile，不存在时给出可操作的错误信息 */
export function getTFile(app: App, rawPath: unknown): TFile {
  const path = toVaultPath(rawPath);
  const file = app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) {
    throw new PathError(`找不到笔记：${path}。请先用 list_files 或 search 确认路径。`);
  }
  return file;
}

/** 极简 glob：支持 ** / * / ? ，够用即可，不引依赖 */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/^\/+/, "");
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        // ** 匹配任意层（含 /）
        re += ".*";
        i++;
        if (g[i + 1] === "/") i++; // 吃掉 **/ 里的斜杠
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$", "i");
}
