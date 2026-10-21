import { test } from "node:test";
import assert from "node:assert/strict";

import { finalAnswer } from "../src/agent/answer";
import { capTurn, slimHistory, HISTORY_TURN_CAP } from "../src/agent/trim";
import type { RunState } from "../src/agent/types";

function state(partial: Partial<RunState> & { messages: RunState["messages"] }): RunState {
  return {
    runId: "r",
    createdAt: 0,
    updatedAt: 0,
    status: "done",
    step: 1,
    maxSteps: 20,
    appliedOps: [],
    usage: { promptTokens: 0, completionTokens: 0 },
    ...partial,
  };
}

test("回答只取本轮：注入的历史里那段旧回答不算", () => {
  const msgs: RunState["messages"] = [
    { role: "system", content: "sys" },
    { role: "user", content: "上一轮的问题" },
    { role: "assistant", content: "上一轮的回答（很长）" },
    { role: "user", content: "reply with: ok" },
  ];
  // 本轮只有工具调用、没有文字：应返回空，而不是把上一轮的回答当成本轮回答
  const s = state({ messages: [...msgs, { role: "assistant", content: "" }], turnStart: 3 });
  assert.equal(finalAnswer(s), "");
});

test("回答只取本轮：本轮有内容就取本轮的", () => {
  const msgs: RunState["messages"] = [
    { role: "system", content: "sys" },
    { role: "user", content: "旧问题" },
    { role: "assistant", content: "旧回答" },
    { role: "user", content: "新问题" },
    { role: "assistant", content: "新回答" },
  ];
  assert.equal(finalAnswer(state({ messages: msgs, turnStart: 3 })), "新回答");
});

test("旧存档没有 turnStart 时退回老行为（取最后一条非空回答）", () => {
  const msgs: RunState["messages"] = [
    { role: "user", content: "q" },
    { role: "assistant", content: "a" },
  ];
  assert.equal(finalAnswer(state({ messages: msgs })), "a");
});

test("长回答头尾保留，中间标省略", () => {
  const long = `开头结论${"中".repeat(3000)}结尾要求`;
  const out = capTurn(long);
  assert.ok(out.length < HISTORY_TURN_CAP + 100, `截断后仍然太长：${out.length}`);
  assert.ok(out.startsWith("开头结论"));
  assert.ok(out.endsWith("结尾要求"));
  assert.ok(out.includes("中间省略"), "没有省略标记");
});

test("超预算时整条丢最旧的，保留连续的最新几条", () => {
  const turns = [
    { role: "user" as const, content: "一".repeat(1500) },
    { role: "assistant" as const, content: "二".repeat(1500) },
    { role: "user" as const, content: "三".repeat(1500) },
    { role: "assistant" as const, content: "四".repeat(500) },
  ];
  // 注意每条先被 capTurn 截到 ~1130，所以预算要压到 2000 才逼得它丢条
  const r = slimHistory(turns, 2000);
  assert.ok(r.chars <= 2000, `超预算：${r.chars}`);
  assert.equal(r.turns[0].role, "user", "开头不能是 assistant");
  assert.ok(r.turns[r.turns.length - 1].content.startsWith("四"), "最新一条必须在");
  assert.ok(r.dropped > 0);
});

test("预算够的时候一条都不动（幂等）", () => {
  const turns = [
    { role: "user" as const, content: "问" },
    { role: "assistant" as const, content: "答" },
  ];
  const r = slimHistory(turns);
  assert.deepEqual(r.turns, turns);
  assert.equal(r.dropped, 0);
  assert.deepEqual(slimHistory(r.turns).turns, turns);
});

test("空历史不炸", () => {
  assert.deepEqual(slimHistory([]), { turns: [], dropped: 0, chars: 0 });
});

import { contextSize, pruneOldToolResults, shouldPrune, worthPruning } from "../src/agent/prune";

/** 造一段真实形状的转录：assistant 发起调用 → tool 结果，交替若干轮 */
function transcript(sizes: number[]) {
  const msgs: { role: "assistant" | "tool"; content: string }[] = [];
  sizes.forEach((size, i) => {
    msgs.push({ role: "assistant", content: `调用第${i}次` });
    msgs.push({ role: "tool", content: `第${i}个结果${"x".repeat(Math.max(0, size - 6))}` });
  });
  return msgs as { role: "assistant" | "tool"; content: string }[];
}

test("门槛：16000 就该动手（24000 在真实使用里等于永不触发）", () => {
  assert.equal(shouldPrune(15000, 10), false);
  assert.equal(shouldPrune(16001, 10), true);
  assert.equal(shouldPrune(5000, 60), true, "消息太多也要动手");
});

test("省得太少不做：占位本身也要花 token", () => {
  // 3 批各 1000 字符：只剪得掉最早一批，省 760 字符 < 1500，不值得
  const r = pruneOldToolResults(transcript([1000, 1000, 1000]) as never);
  assert.equal(r.pruned, 1);
  assert.ok(r.savedChars > 0 && r.savedChars < 1500, `省了 ${r.savedChars}`);
  assert.equal(worthPruning(r), false);
});

test("一次调用带回的大结果：只要不是最近两批，再大也剪", () => {
  // 模拟真机：第 3 批是 read_files 一口气读 16 个文件（11918 字符）
  const msgs = transcript([600, 600, 11918, 300, 300]);
  const r = pruneOldToolResults(msgs as never);
  assert.equal(r.pruned, 1, `应只剪中间那批大的，实际 ${r.pruned}`);
  assert.ok(worthPruning(r), "省 11678 字符值得做");
  // 最近两批原样保留
  const tail = r.messages.slice(-4);
  assert.ok(tail.every((m: { content: string }) => !String(m.content).includes("已省略")));
});

test("幂等：剪过的再剪一次不变", () => {
  const once = pruneOldToolResults(transcript([3000, 3000, 3000, 3000, 3000]) as never);
  const twice = pruneOldToolResults(once.messages as never);
  assert.equal(twice.pruned, 0);
  assert.equal(contextSize(twice.messages), contextSize(once.messages));
});
