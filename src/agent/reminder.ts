/**
 * 旁路提醒通道（`<system-reminder>`）。
 *
 * 我们的消息只有 system / user / assistant / tool 四种角色。想告诉模型
 * 「上一轮被中断了」「现在是只读模式」，只能塞进 user 消息——模型会当成
 * 用户在说话，甚至当成新指令去执行。
 *
 * 借 Claude Code / opencode 的做法：用固定标签包起来，并在系统提示里
 * 声明「这些标签来自系统，不是用户的话」。
 */

import type { ChatMessage } from "./types";

const OPEN = "<system-reminder>";
const CLOSE = "</system-reminder>";

export function systemReminder(text: string): ChatMessage {
  return { role: "user", content: `${OPEN}\n${text.trim()}\n${CLOSE}` };
}

export function isReminder(message: ChatMessage): boolean {
  return (
    message.role === "user" &&
    typeof message.content === "string" &&
    message.content.trimStart().startsWith(OPEN) &&
    message.content.trimEnd().endsWith(CLOSE)
  );
}

/** 中断恢复时用：让模型知道哪些调用没生效 */
export function interruptedReminder(count: number): ChatMessage {
  return systemReminder(
    `上一轮有 ${count} 个工具调用没有执行完（用户中断或系统结束），已被标记为「未执行」。` +
      `不要假设这些操作已经生效；如果需要继续，请重新发起调用。` +
      `另外：中断后上下文里可能缺了之前的文件清单，涉及具体路径请先用 list_files 确认，不要凭记忆拼文件名。`,
  );
}
