/**
 * 存档（state/*.json）的清理。
 *
 * 每跑一个任务就往 state/ 写一个 JSON，之前没有任何清理：真机上攒到 93 个、
 * 1.7 MB。更要紧的是 listResumable() 每次打开面板要把整个目录读一遍再 parse，
 * 文件越多面板越慢——这是会随时间恶化的那类问题。
 *
 * 清理规则：
 * - 可续跑的（running / awaiting_confirm）优先留，但也有上限：最近 10 个、且不超过 30 天。
 *   真机上量过一次：光是我自己验证时没答完的问题就堆了 33 个 "awaiting_confirm"，
 *   "永不删"等于把面板的续跑列表变成一个越来越长的垃圾场。
 * - 其它只保留最近 50 个、且不超过 7 天
 * - 先按修改时间倒序排，只有"可能被删"的文件才去读它判断状态，避免每次全量读盘
 */

import type { DataAdapter } from "obsidian";

export interface StatePruneResult {
  removed: number;
  kept: number;
  /** 因为可续跑而保留下来的数量（用于日志和自检） */
  resumable: number;
}

export interface StatePruneOptions {
  keepDays?: number;
  keepFiles?: number;
  /** 未完成存档的保留上限 */
  keepResumableFiles?: number;
  /** 未完成存档的保留天数 */
  keepResumableDays?: number;
  now?: number;
}

export const STATE_KEEP_DAYS = 7;
export const STATE_KEEP_FILES = 50;
export const STATE_KEEP_RESUMABLE_FILES = 10;
export const STATE_KEEP_RESUMABLE_DAYS = 30;

const RESUMABLE = new Set(["running", "awaiting_confirm"]);

function statusOf(raw: string): string {
  try {
    return String((JSON.parse(raw) as { status?: unknown }).status ?? "");
  } catch {
    return "";
  }
}

export async function pruneStates(
  adapter: DataAdapter,
  dir: string,
  opts: StatePruneOptions = {},
): Promise<StatePruneResult> {
  const keepDays = opts.keepDays ?? STATE_KEEP_DAYS;
  const keepFiles = opts.keepFiles ?? STATE_KEEP_FILES;
  const keepResumableFiles = opts.keepResumableFiles ?? STATE_KEEP_RESUMABLE_FILES;
  const keepResumableDays = opts.keepResumableDays ?? STATE_KEEP_RESUMABLE_DAYS;
  const now = opts.now ?? Date.now();

  if (!(await adapter.exists(dir))) return { removed: 0, kept: 0, resumable: 0 };

  const { files } = await adapter.list(dir);
  const items: { path: string; mtime: number }[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const st = await adapter.stat(f).catch(() => null);
    items.push({ path: f, mtime: st?.mtime ?? 0 });
  }
  // 文件名是 20261021-1628-xxxx，但用 mtime 更可靠（复制/同步会改名字不改时间）
  items.sort((a, b) => b.mtime - a.mtime);

  const cutoff = now - keepDays * 86_400_000;
  const resumableCutoff = now - keepResumableDays * 86_400_000;
  const remove: string[] = [];
  let resumable = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const fresh = i < keepFiles && it.mtime >= cutoff;
    if (fresh) continue;
    // 只有可能被删的才读内容：判断是不是没做完的活
    const raw = await adapter.read(it.path).catch(() => "");
    const status = statusOf(raw);
    if (RESUMABLE.has(status) && resumable < keepResumableFiles && it.mtime >= resumableCutoff) {
      resumable++;
      continue;
    }
    remove.push(it.path);
  }

  let removed = 0;
  for (const p of remove) {
    try {
      await adapter.remove(p);
      removed++;
    } catch {
      /* 单个删不掉不影响其他 */
    }
  }

  return { removed, kept: items.length - removed, resumable };
}
