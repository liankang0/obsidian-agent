/**
 * 多轮对话的上下文瘦身。
 *
 * 为什么要单独一层：面板按「条数」限历史（12 条），但一条可能是 2000 字的表格总结。
 * 真机上量到的是——system prompt 3440 字、历史 2518 字，模型真正干活的空间被历史挤掉一半。
 * 换成按「字符预算」限制，并且超长的单条做头尾保留式截断。
 */

import type { HistoryTurn } from "./types";

/** 历史总共允许多少字符（不含本轮用户输入） */
export const HISTORY_BUDGET = 4000;
/** 单条超过这个长度就截断：留头留尾，中间标省略 */
export const HISTORY_TURN_CAP = 1200;
const HEAD = 800;
const TAIL = 300;

/** 截断一条太长的话：开头保留（结论通常在第一段），结尾保留（常是「要我怎么做」） */
export function capTurn(content: string, cap = HISTORY_TURN_CAP): string {
  if (content.length <= cap) return content;
  const head = content.slice(0, HEAD);
  const tail = content.slice(-TAIL);
  return `${head}\n…（中间省略 ${content.length - HEAD - TAIL} 字）…\n${tail}`;
}

export interface SlimResult {
  turns: HistoryTurn[];
  dropped: number;
  chars: number;
}

/**
 * 从最新往旧保留，超预算就整条丢（不做半条拼接，免得模型看到残句）。
 *
 * 两条约束：
 * - 必须连续：一旦某条放不下就停，不会跳过它去拿更旧的；
 * - 开头不能是 assistant：那样模型会以为自己在自言自语。
 */
export function slimHistory(turns: HistoryTurn[], budget = HISTORY_BUDGET): SlimResult {
  const capped = turns.map((t) => ({ ...t, content: capTurn(t.content) }));
  const kept: HistoryTurn[] = [];
  let chars = 0;

  for (let i = capped.length - 1; i >= 0; i--) {
    const t = capped[i];
    const size = t.content.length;
    if (chars + size > budget) break;
    kept.unshift(t);
    chars += size;
  }

  while (kept.length > 0 && kept[0].role === "assistant") kept.shift();
  // 去掉开头的 assistant 之后再算字符数，否则日志报的数和实际发出去的差一条
  const realChars = kept.reduce((n, t) => n + t.content.length, 0);
  return { turns: kept, dropped: turns.length - kept.length, chars: realChars };
}
