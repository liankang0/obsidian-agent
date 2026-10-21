/**
 * 「本轮改了哪些文件」的摘要。
 *
 * 手机上跑完一个任务，面板上只有一段文字——用户看不出到底动了什么、动了几处。
 * 这里把 appliedOps 变成一行行可读的说明，界面上做成一张卡片。
 */

import type { AppliedOp } from "./types";

/** 工具 → 动作标签。write_file 和 create_note 都写内容，但一个覆盖一个新建，别混着说。 */
const OP_LABEL: Record<string, string> = {
  patch_file: "改",
  create_note: "新建",
  write_file: "写入",
  move_note: "移动",
  trash_note: "删除",
  trash_folder: "删除",
};

function lines(s: unknown): number {
  if (typeof s !== "string" || s.length === 0) return 0;
  return s.split("\n").length;
}

/** 一次工具调用 → 动作标签 + 一句话说明 */
export function describeChange(tool: string, args: Record<string, unknown>): { op: string; detail?: string } {
  const op = OP_LABEL[tool] ?? tool;
  if (tool === "patch_file") {
    // 看行数变化比看字符数直观：用户想知道「动了多少」
    const removed = lines(args.old);
    const added = lines(args.new);
    return { op, detail: `+${added} −${removed} 行` };
  }
  if (tool === "move_note") {
    return { op, detail: `${String(args.from ?? "")} → ${String(args.to ?? "")}` };
  }
  if (tool === "trash_note" || tool === "trash_folder") {
    return { op, detail: "移入回收站" };
  }
  const content = typeof args.content === "string" ? args.content : "";
  if (content.length > 0) return { op, detail: `${content.length} 字` };
  return { op };
}

export interface FileChange {
  path: string;
  ops: Array<{ op: string; detail?: string }>;
}

/** 按文件归并：同一个文件被改了三次，只出现一行 */
export function groupChanges(ops: AppliedOp[]): FileChange[] {
  const map = new Map<string, FileChange>();
  for (const o of ops) {
    const path = o.path ?? "（未知路径）";
    const cur = map.get(path) ?? { path, ops: [] };
    cur.ops.push({ op: o.op ?? o.tool, detail: o.detail });
    map.set(path, cur);
  }
  return [...map.values()];
}

/** 卡片标题用的一句话 */
export function changeSummary(changes: FileChange[]): string {
  if (changes.length === 0) return "本轮没有改动文件";
  const counts = new Map<string, number>();
  for (const c of changes) {
    for (const o of c.ops) counts.set(o.op, (counts.get(o.op) ?? 0) + 1);
  }
  const parts = [...counts.entries()].map(([op, n]) => `${op} ${n}`);
  return `${changes.length} 个文件 · ${parts.join(" / ")}`;
}
