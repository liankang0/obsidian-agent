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
import { defaultLayout } from "./workspace";

/** 旧默认布局下的路径（直接调用兜底）；loop 驱动时由 layout 传参 */
export const CHANGELOG_PATH = defaultLayout().changelogPath;
const MARKER = "<!-- local-vault-agent:auto -->";

/**
 * 主文件超过这么多字符就把旧内容整段归档到年度文件。
 * 03 只追加不清理的话会一直长：真机上一年就能写到几百 KB，
 * 每次追加都是全文件读改写，手机上越来越慢。
 */
export const ARCHIVE_THRESHOLD_CHARS = 40_000;

/** 归档文件按年分，与主记录同目录：<dir>/03-修改记录-2026.md */
export function archivePathFor(changelogPath: string): string {
  const dir = changelogPath.split("/").slice(0, -1).join("/");
  return `${dir ? `${dir}/` : ""}03-修改记录-${new Date().getFullYear()}.md`;
}

/** 把旧内容挪到年度文件（存在就追加）。失败不打扰主流程。 */
async function archiveChangelog(
  app: App,
  changelogPath: string,
  content: string,
  log?: { warn(msg: string): void },
): Promise<boolean> {
  const path = archivePathFor(changelogPath);
  try {
    const body = content.trim();
    const existing = app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await app.vault.process(existing, (old) => `${old.replace(/\s*$/, "")}\n\n${body}\n`);
    } else {
      await app.vault.create(path, `${body}\n`);
    }
    return true;
  } catch (e) {
    log?.warn(`归档修改记录失败（不影响记录本身）：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

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
    `- **操作人**: Local Vault Agent（插件自动记录）`,
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
/** 自检产生的改动不该进用户的修改记录（撤销记账用同一把尺子） */
export function isSelftestOnly(paths: string[]): boolean {
  return paths.length > 0 && paths.every((p) => p.startsWith("_agent-selftest/") || p.startsWith(".obsidian/"));
}

export interface AppendRecordOpts {
  /** 实际写入的修改记录路径；缺省 = 旧默认 AI/03-修改记录.md */
  changelogPath?: string;
}

export async function appendRecord(
  app: App,
  state: RunState,
  log?: { warn(msg: string): void },
  opts?: AppendRecordOpts,
): Promise<boolean> {
  const changelogPath = opts?.changelogPath ?? CHANGELOG_PATH;
  if (state.appliedOps.length === 0) return false;
  if (isSelftestOnly(state.appliedOps.map((op) => op.path).filter((p): p is string => !!p))) return false;
  const record = buildRecord(state, Date.now());
  try {
    const existing = app.vault.getAbstractFileByPath(changelogPath);
    if (existing instanceof TFile) {
      // 幂等：同一个 run 不重复记录（恢复后重跑会再走一遍收尾）
      const current = await app.vault.read(existing);
      if (current.includes(`run ${state.runId}`)) return false;
      // 超阈值先归档：主文件回到骨架，旧内容整体进年度文件
      if (current.length > ARCHIVE_THRESHOLD_CHARS) {
        const archived = await archiveChangelog(app, changelogPath, current, log);
        if (archived) {
          await app.vault.process(
            existing,
            () => `# AI 修改记录\n\n> 由 Local Vault Agent 自动追加。\n${record}`,
          );
          return true;
        }
        // 归档失败就照旧追加，宁可文件大也不能丢记录
      }
      await app.vault.process(existing, (data) => `${data.replace(/\s*$/, "")}\n${record}`);
      return true;
    }
    await app.vault.create(changelogPath, `# AI 修改记录\n\n> 由 Local Vault Agent 自动追加。\n${record}`);
    return true;
  } catch (e) {
    log?.warn(`写修改记录失败（不影响任务）：${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}
