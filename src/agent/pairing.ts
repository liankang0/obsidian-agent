/**
 * 修复 tool_call / tool_result 配对。
 *
 * 为什么必须有这一步：OpenAI 兼容接口有硬约束——assistant 消息里出现的每个
 * tool_call 都必须有 role="tool" 的消息应答；反过来，孤立的 tool 消息同样非法。
 * 而中断点恰好落在配对中间：
 *   · 用户在某批工具执行到一半时取消
 *   · 连续失败中止，同一批后面的调用没执行
 *   · 压缩/裁剪把某条 tool 结果删掉，但它的 tool_call 还在
 *   · 会话恢复时 checkpoint 本身就是断的
 * 任何一条都会让下一次请求直接 400，且报错信息对用户毫无意义。
 */

import type { ChatMessage } from "./types";

export interface RepairReport {
  /** 补出来的「已中断」结果条数 */
  synthesized: number;
  /** 删掉的孤立/重复结果条数 */
  dropped: number;
}

const INTERRUPTED = "（已中断，该工具未执行。如需继续，请重新发起。）";

/**
 * 就地修复消息序列，返回新数组（不修改入参里的对象，但会复用对象引用）。
 *
 * 幂等：对已合法的序列调用不会产生任何变化。
 */
export function repairToolPairing(messages: ChatMessage[]): { messages: ChatMessage[]; report: RepairReport } {
  const report: RepairReport = { synthesized: 0, dropped: 0 };

  // 第一遍：统计每个 tool_call 是否已有结果（全局，不是只看紧邻的那几条）
  const answered = new Set<string>();
  for (const m of messages) {
    if (m.role === "tool" && m.tool_call_id) answered.add(m.tool_call_id);
  }
  const declared = new Set<string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.tool_calls) {
      for (const c of m.tool_calls) declared.add(c.id);
    }
  }

  const emittedResult = new Set<string>();
  const out: ChatMessage[] = [];

  for (const m of messages) {
    if (m.role === "tool") {
      const id = m.tool_call_id;
      // 孤立的 tool（对应的 call 不存在）、重复的 tool（同一个 call 回两次）都丢掉
      if (!id || !declared.has(id) || emittedResult.has(id)) {
        report.dropped++;
        continue;
      }
      emittedResult.add(id);
      out.push(m);
      continue;
    }

    out.push(m);

    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      for (const c of m.tool_calls) {
        if (answered.has(c.id)) continue; // 后面有真实结果，别插桩
        out.push({ role: "tool", tool_call_id: c.id, content: INTERRUPTED });
        emittedResult.add(c.id);
        report.synthesized++;
      }
    }
  }

  return { messages: out, report };
}

/** 只关心结果、不关心统计时的便捷包装。 */
export function repairMessages(messages: ChatMessage[]): ChatMessage[] {
  return repairToolPairing(messages).messages;
}
