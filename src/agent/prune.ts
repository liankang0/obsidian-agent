import type { ChatMessage } from "./types";
import { CONTEXT_CHARS_GATE, PRUNE_MAX_MESSAGES } from "./budgets";

/**
 * 上下文瘦身：把「早就用完的」工具结果换成一行占位。
 *
 * 为什么必须有这一步：工具结果一旦进了 messages，每一轮都要重新发一遍。
 * 真机实测一个「统一 15 篇菜谱格式」的任务，9 步烧了 92405 个 prompt token——
 * 因为前面读过的 12 篇全文，后面 6 轮又原样发了 6 次。钱是这么烧掉的，
 * 思考型模型被截断也多半是因为上下文越长、它想得越久。
 *
 * 三条不动的规矩：
 * 1. 只改 role="tool" 的 content，**不删消息**——删了工具调用配对就断了，下次必 400。
 * 2. 最近几条工具结果绝不碰，模型正在用。
 * 3. 幂等：已经占位过的不再加工，重复跑不会越削越短。
 */

/**
 * 至少保留最近这么「批」工具结果。
 *
 * 「一批」= 一次 assistant 工具调用带回来的那串结果。原来是"最近 4 条结果"，
 * 但真机上大批读取已经合并成一次调用（`read_files` 一个结果装 16 个文件、11918 字符），
 * 按条数保护等于什么都不剪——门槛降到 16000 那次实测就是这么"静默通过"的。
 */
const KEEP_RECENT_BATCHES = 2;
/** 短于这个长度的结果不值得动（占位本身也要花 token） */
const MIN_LEN = 800;
/** 占位时保留的开头，够模型认出「这是哪个文件的什么结果」 */
const KEEP_HEAD = 240;

const MARK = "〔已省略";

export interface PruneOptions {
  /** 保留最近几批工具结果 */
  keepRecent?: number;
  minLen?: number;
  keepHead?: number;
}

export interface PruneResult {
  messages: ChatMessage[];
  pruned: number;
  savedChars: number;
}

/** 省得太少就别动：占位本身也要花 token，来回折腾不划算 */
const MIN_SAVE = 1500;

/**
 * 什么时候值得动手。
 *
 * 注意别看错成累积用量：`usage.promptTokens` 是**十轮之和**，一个 26k 字符的
 * 上下文跑 10 步就能累出 148k，拿它当门槛会在第 2 步就误判。
 * 所以这里看的是「当前上下文有多大」——一次性算清，语义直白。
 */
export function shouldPrune(contextChars: number, messageCount: number): boolean {
  return contextChars > CONTEXT_CHARS_GATE || messageCount > PRUNE_MAX_MESSAGES;
}

/** 这次瘦身值不值得做：先算能省多少，省得太少就别动 */
export function worthPruning(result: PruneResult): boolean {
  return result.pruned > 0 && result.savedChars >= MIN_SAVE;
}

/** 当前上下文的总字符数（用来判定要不要瘦身） */
export function contextSize(messages: ChatMessage[]): number {
  let n = 0;
  for (const m of messages) n += typeof m.content === "string" ? m.content.length : 0;
  return n;
}

/** 把工具结果按「批」分组：连续的一串 tool 消息算一批 */
function groupBatches(messages: ChatMessage[]): number[][] {
  const batches: number[][] = [];
  let cur: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "tool") {
      cur.push(i);
    } else if (cur.length > 0) {
      batches.push(cur);
      cur = [];
    }
  });
  if (cur.length > 0) batches.push(cur);
  return batches;
}

export function pruneOldToolResults(messages: ChatMessage[], opts: PruneOptions = {}): PruneResult {
  const keepBatches = opts.keepRecent ?? KEEP_RECENT_BATCHES;
  const minLen = opts.minLen ?? MIN_LEN;
  const keepHead = opts.keepHead ?? KEEP_HEAD;

  // 保护最近 keepBatches 批：模型正在用它们
  const batches = groupBatches(messages);
  const protectedSet = new Set(batches.slice(-keepBatches).flat());

  let pruned = 0;
  let savedChars = 0;
  const out = messages.map((m, i) => {
    if (m.role !== "tool" || protectedSet.has(i)) return m;
    const content = typeof m.content === "string" ? m.content : "";
    if (content.length <= minLen || content.includes(MARK)) return m;
    const omitted = content.length - keepHead;
    const next: ChatMessage = {
      ...m,
      content:
        content.slice(0, keepHead) +
        `\n${MARK} ${omitted} 字符以省 token；需要完整内容就重新调用一次工具〕`,
    };
    pruned++;
    savedChars += omitted;
    return next;
  });

  return { messages: out, pruned, savedChars };
}
