/**
 * 大结果外溢（spill）。
 *
 * 原来的做法是硬切：超过 20 000 字符直接 `slice(0, limit)`，中间段永久丢失。
 * 模型只能重跑工具——如果那个工具是 search，等于把整个检索重做一遍。
 *
 * 现在的做法（借 DSH 的 `spill/`）：全文写到磁盘，上下文里只留
 * 「开头一段 + 落点 + 分段读取提示」。模型想要细节就自己再读一次，
 * 拿到的是原文而不是截断品。
 *
 * 关键取舍：**写盘失败时退回原来的硬切**，不能因为存储故障把内容弄丢。
 */

export const SPILL_DIR = ".obsidian/plugins/obsidian-agent/spill";

/** 超过这个长度就外溢（字符） */
export const MAX_INLINE_CHARS = 4000;

/** 外溢后仍直接放进上下文的开头长度 */
export const SPILL_HEAD_CHARS = 1200;

/** 保留最近多少天的外溢文件 */
export const SPILL_KEEP_DAYS = 7;

/** 是否落在外溢目录下（纯字符串判断，便于单测） */
export function isSpillPath(path: string, root = SPILL_DIR): boolean {
  const p = path.replace(/\\/g, "/").replace(/^\/+/, "");
  return p === root || p.startsWith(root + "/");
}

export function spillFilePath(runId: string, tool: string, seq: number): string {
  const safeRun = runId.replace(/[^\w-]/g, "_");
  const safeTool = tool.replace(/[^\w-]/g, "_");
  return `${SPILL_DIR}/${safeRun}/${String(seq).padStart(2, "0")}-${safeTool}.txt`;
}

export function spillNotice(totalChars: number, filePath: string, head: string, totalLines: number): string {
  return [
    `[结果共 ${totalChars} 字符 / ${totalLines} 行，超出单次返回上限，已完整存到：${filePath}]`,
    "",
    "开头部分：",
    "```",
    head,
    "```",
    "",
    `需要其余内容时，用 read_file 分段读取该文件（例如 {"path":"${filePath}","from":${Math.max(
      1,
      head.split("\n").length,
    )},"to":${Math.min(totalLines, head.split("\n").length + 400)}}），不要重跑本工具。`,
  ].join("\n");
}
