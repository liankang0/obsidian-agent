/**
 * WP3 撤销本轮：按修改记录（appliedOps）逆向回放内容级改动。
 *
 * 范围（doc 里的明确取舍）：只保证内容级还原——patch / write / create 三类；
 * 移动、删除不走这条路径，元数据级还原仍由回收站负责。
 *
 * 安全性设计，三道闸：
 * 1. 采集端：工具成功时手里本来就有改前/改后文本，顺手留存；超过 UNDO_TEXT_CAP
 *    的不留（宁可该操作不可撤销，也不能拿截断过的文本去「还原」出半坏不坏的文件）；
 * 2. 回放前校验：逐文件模拟逆向回放，唯一性/一致性任何一条不满足就整个文件跳过
 *    并逐条说明——绝不产生「半撤销」状态；
 * 3. 落盘端：全部校验通过后每个文件只写一次（vault.process 原子写），新建文件的
 *    撤销走系统回收站（可找回），不做硬删除。
 */

import { TFile } from "obsidian";
import type { App } from "obsidian";

import type { AppliedOp, RunState, UndoInfo } from "./types";
import { CHANGELOG_PATH, isSelftestOnly } from "./changelog";

/** 单侧改前/改后文本的留存上限（字符）。超过就不留存撤销数据。 */
export const UNDO_TEXT_CAP = 50_000;

export interface UndoReport {
  /** 逐字节还原成功的文件（含「新建 → 回收站」的撤销） */
  reverted: string[];
  /** 没动的文件与原因——模型和面板都要逐条看得见 */
  skipped: Array<{ path: string; note: string }>;
}

type Log = { info(s: string): void; warn(s: string): void; error(s: string): void };

/** 会在 appliedOps 里留下「内容级改动」的工具（move/trash 属元数据级，不在撤销范围） */
const CONTENT_TOOLS = new Set(["patch_file", "write_file", "create_note"]);

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

/**
 * 在「当前内容」上按逆序回放一组撤销操作，得到还原后的内容。
 * 任何一步校验不过就整体失败——调用方据此跳过整个文件。
 */
export function reverseReplay(
  content: string,
  undos: UndoInfo[],
): { ok: true; next: string } | { ok: false; note: string } {
  let cur = content;
  for (let i = undos.length - 1; i >= 0; i--) {
    const u = undos[i];
    if (u.kind === "patch") {
      const n = countOccurrences(cur, u.new);
      if (n === 0) return { ok: false, note: "要还原的替换内容已找不到（文件在本轮之后被外部修改过）" };
      if (n > 1) return { ok: false, note: "要还原的替换内容出现多处，无法唯一定位" };
      cur = cur.slice(0, cur.indexOf(u.new)) + u.old + cur.slice(cur.indexOf(u.new) + u.new.length);
    } else if (u.kind === "write") {
      if (cur !== u.after) {
        return { ok: false, note: "当前内容与本轮写入后的版本不一致（文件在本轮之后被外部修改过）" };
      }
      cur = u.before;
    } else {
      // create：字符串层面是空操作，最终由「整文件是否回到新建时内容」决定回收站
      if (cur !== u.after) {
        return { ok: false, note: "当前内容与新建时的版本不一致（文件在本轮之后被外部修改过）" };
      }
    }
  }
  return { ok: true, next: cur };
}

interface PathGroup {
  /** 时间正序的内容级撤销数据 */
  undos: UndoInfo[];
  /** 本轮内被移动过：旧路径已不存在，内容还原无从谈起 */
  moved: boolean;
  /** 本轮内被删除：撤销不还原删除（回收站负责），但要把这件事说清楚 */
  trashed: boolean;
  /** 有内容改动但没留存撤销数据（超大文本） */
  oversized: boolean;
  lastAt: number;
}

function groupByPath(ops: AppliedOp[]): Map<string, PathGroup> {
  const groups = new Map<string, PathGroup>();
  for (const op of ops) {
    if (!op.path || op.undone) continue; // 已还原过的操作不再参与回放
    const g = groups.get(op.path) ?? { undos: [], moved: false, trashed: false, oversized: false, lastAt: 0 };
    g.lastAt = Math.max(g.lastAt, op.at);
    if (op.tool === "move_note") g.moved = true;
    if (op.tool === "trash_note" || op.tool === "trash_folder") g.trashed = true;
    if (CONTENT_TOOLS.has(op.tool)) {
      if (op.undo) g.undos.push(op.undo);
      else g.oversized = true;
    }
    groups.set(op.path, g);
  }
  return groups;
}

/** 还原成功的路径：摘掉撤销数据并标记 undone，防止再点一次把同一批操作又撤一遍 */
function stripUndoFor(ops: AppliedOp[], path: string): void {
  for (const op of ops) {
    if (op.path === path) {
      delete op.undo;
      op.undone = true;
    }
  }
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 撤销本身也是一次修改：按准则第 4 条在修改记录里记一笔。失败不影响撤销本身。 */
async function recordUndo(
  app: App,
  state: RunState,
  report: UndoReport,
  log: Log,
  changelogPath: string,
): Promise<void> {
  const paths = [...report.reverted, ...report.skipped.map((s) => s.path)];
  if (paths.length === 0 || isSelftestOnly(paths)) return;
  const lines = [
    "",
    `### ${stamp(Date.now())} · 撤销本轮（run ${state.runId}）`,
    `- **操作人**: Local Vault Agent（用户在面板点「撤销本轮」）`,
    `- **操作内容**: 还原 ${report.reverted.length} 个文件，跳过 ${report.skipped.length} 个`,
    `- **影响文件**: ${paths.map((f) => `\`${f}\``).join("、")}`,
    "",
  ];
  try {
    const existing = app.vault.getAbstractFileByPath(changelogPath);
    if (existing instanceof TFile) {
      const current = await app.vault.read(existing);
      // 幂等：同一次撤销不重复记账
      if (current.includes(`撤销本轮（run ${state.runId}）`)) return;
      await app.vault.process(existing, (data) => `${data.replace(/\s*$/, "")}\n${lines.join("\n")}`);
    } else {
      await app.vault.create(changelogPath, `# AI 修改记录\n\n> 由 Local Vault Agent 自动追加。\n${lines.join("\n")}`);
    }
  } catch (e) {
    log.warn(`撤销记录写入失败（不影响撤销本身）：${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * 执行「撤销本轮」。
 *
 * 会修改 state.appliedOps（还原成功的操作摘掉 undo 字段）——调用方随后落盘存档，
 * 就能得到「重启后也不会重复撤销」的保证。跳过的文件保留 undo 数据，外部冲突
 * 解决后（比如手动恢复了回收站文件）再点一次可以重试。
 */
export interface UndoOpts {
  /**
   * 修改记录的实际路径；缺省 = 旧默认 AI/03-修改记录.md。
   * 传空串 = AI 工作区未启用：跳过记账，绝不凭空创建记录文件（Doc2-WP3）。
   */
  changelogPath?: string;
}

export async function undoRun(app: App, state: RunState, log: Log, opts?: UndoOpts): Promise<UndoReport> {
  const report: UndoReport = { reverted: [], skipped: [] };
  const groups = groupByPath(state.appliedOps);

  // 从最新的改动开始往前撤；文件之间没有依赖，这个顺序只是让报告更贴近直觉
  const paths = [...groups.entries()].sort((a, b) => b[1].lastAt - a[1].lastAt).map(([p]) => p);

  for (const path of paths) {
    const g = groups.get(path)!;
    // ① 元数据级改动不还原，但必须交代清楚为什么跳过
    if (g.trashed) {
      report.skipped.push({ path, note: "已在本轮删除；撤销不还原删除，请从回收站恢复后可再试" });
      continue;
    }
    if (g.moved) {
      report.skipped.push({ path, note: "本轮内被移动过；撤销只做内容还原，不还原移动，请手动处理" });
      continue;
    }
    // ② 采集端就没留全的（超大文本）：没有完整改前文本就没有可靠还原
    if (g.oversized) {
      report.skipped.push({ path, note: "本轮对其有超出留存上限的大改动，未留存撤销数据" });
      continue;
    }
    if (g.undos.length === 0) continue; // 只有元数据操作的路径已在上面交代过

    // ③ 回放前校验：整个文件要么全还原，要么全不动
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) {
      report.skipped.push({ path, note: "文件已不存在，无法还原" });
      continue;
    }
    const content = await app.vault.cachedRead(file);
    const replay = reverseReplay(content, g.undos);
    if (!replay.ok) {
      report.skipped.push({ path, note: replay.note });
      continue;
    }

    // ④ 落盘：每个文件只写一次；「新建」的撤销 = 内容逐字节一致时移入回收站
    try {
      const first = g.undos[0];
      if (first.kind === "create" && replay.next === first.after) {
        // 与 trash_note 同一条路径：走用户在 Obsidian 里设置的回收站，可找回
        await app.fileManager.trashFile(file);
      } else {
        await app.vault.process(file, (cur) => {
          // 校验到写入之间内容又变了：中止本文件（vault.process 的回调抛错不落盘）
          if (cur !== content) throw new Error("文件在校验后又被修改，已中止该文件的还原");
          return replay.next;
        });
      }
      stripUndoFor(state.appliedOps, path);
      report.reverted.push(path);
    } catch (e) {
      report.skipped.push({
        path,
        note: `还原写入失败：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }

  log.info(
    `撤销本轮（run ${state.runId}）：还原 ${report.reverted.length}，跳过 ${report.skipped.length}`,
  );
  const changelogPath = opts?.changelogPath ?? CHANGELOG_PATH;
  if (changelogPath) await recordUndo(app, state, report, log, changelogPath);
  return report;
}
