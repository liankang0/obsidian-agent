/**
 * 自动维护 `AI/03-修改记录.md`。
 *
 * 准则第 4 条：所有修改必须记录，便于追溯和审计。以前靠模型自觉写，
 * 它十次里能记得三次。现在由插件在任务结束时自动追加。
 *
 * 关键设计：一次任务写一条，不是一次写入写一条。用户那边 19 个文件批量改，
 * 记 19 条会把记录刷成垃圾——他们的既有格式本来就是「按任务记」。
 */

import type { App } from "obsidian";
import { TFile } from "obsidian";

import type { RunState } from "./types";

export const CHANGELOG_PATH = "AI/03-修改记录.md";
const MARKER = "<!-- obsidian-agent:auto -->";

/** 从第一条用户消息里取任务标题 */
function taskTitle(state: RunState): string {
  const first = state.messages.find((m) => m.role === "user" && typeof m.content === "string");
  const text = (first?.content ?? "").replace(/\s+/g, " ").trim();
  return text.length > 60 ? `${text.slice(0, 60)}…` : text || "（未记录任务名）";
}

function stamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 生成一条记录（Markdown 片段），按他们既有格式 */
export function buildRecord(state: RunState, at: number): string {
  const files = [...new Set(state.appliedOps.map((op) => op.path))];
  const lines = [
    "",
    `### ${stamp(at)} · ${taskTitle(state)}`,
    `- **操作人**: Obsidian Agent（插件自动记录）`,
    `- **操作时间**: ${stamp(at)}`,
    `- **操作内容**: ${state.step} 步完成，改动 ${files.length} 个文件（run ${state.runId}）`,
    `- **影响文件**: ${files.map((f) => `\`${f}\``).join("、")}`,
    MARKER,
    "",
  ];
  return lines.join("\n");
}

/**
 * 把一条记录追加进 03-修改记录.md。
 * 用 vault.process 做读改写，避免和同步客户端抢写入。
 * 失败只记日志，绝不影响任务本身。
 */
/** 自检产生的改动不该进用户的修改记录 */
function isSelftestOnly(paths: string[]): boolean {
  return paths.length > 0 && paths.every((p) => p.startsWith("_agent-selftest/") || p.startsWith(".obsidian/"));
}

export async function appendRecord(
  app: App,
  state: RunState,
  log?: { warn(msg: string): void },
): Promise<boolean> {
  if (state.appliedOps.length === 0) return false;
  if (isSelftestOnly(state.appliedOps.map((op) => op.path).filter((p): p is string => !!p))) return false;
  const record = buildRecord(state, Date.now());
  try {
    const existing = app.vault.getAbstractFileByPath(CHANGELOG_PATH);
    if (existing instanceof TFile) {
      // 幂等：同一个 run 不重复记录（恢复后重跑会再走一遍收尾）
      const current = await app.vault.read(existing);
      if (current.includes(`run ${state.runId}`)) return false;
      await app.vault.process(existing, (data) => `${data.replace(/\s*$/, "")}\n${record}`);
      return true;
    }
    await app.vault.create(CHANGELOG_PATH, `# AI 修改记录\n\n> 由 Obsidian Agent 自动追加。\n${record}`);
    return true;
  } catch (e) {
    log?.warn(`写修改记录失败（不影响任务）：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
