/**
 * 从存档里取「模型最后真正说了什么」。
 *
 * 不能从面板 DOM 抓：那里混着运行汇总（「— 运行结束…」）、空回复占位和工具行，
 * 抓到的往往是汇总而不是回答——这正是对话历史被污染的原因。
 */

import type { RunState } from "./types";

/** 这些内容不是模型的回答 */
const NOT_ANSWER = new Set(["（空回复）"]);

export function finalAnswer(state: RunState): string {
  // 只在本轮的范围内找：state.messages 前面还有注入的对话历史，
  // 从那儿往前扫会把上一轮的回答当成这一轮的回答（真机上见过同一段重复 3 次）
  const from = typeof state.turnStart === "number" ? state.turnStart : 0;
  for (let i = state.messages.length - 1; i >= from; i--) {
    const m = state.messages[i];
    if (m.role !== "assistant") continue;
    const text = typeof m.content === "string" ? m.content.trim() : "";
    if (!text) continue;
    if (NOT_ANSWER.has(text)) continue;
    if (text.startsWith("— 运行结束")) continue;
    return text.slice(0, 2000);
  }
  return "";
}

/** 什么样的说法算「接着上次干」 */
const RESUME_INTENT = /^(继续|接着|续上|continue)/i;

export function wantsResume(text: string): boolean {
  return RESUME_INTENT.test(text.trim());
}
