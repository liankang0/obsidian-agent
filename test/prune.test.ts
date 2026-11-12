import { test } from "node:test";
import assert from "node:assert/strict";
import { contextSize, pruneOldToolResults, shouldPrune } from "../src/agent/prune";
import type { ChatMessage } from "../src/agent/types";

const big = (n: number) => `{"ok":true,"data":{"content":"${"菜谱内容".repeat(n)}"}}`;

function toolMsg(id: string, content: string): ChatMessage {
  return { role: "tool", tool_call_id: id, content };
}

function callMsg(id: string): ChatMessage {
  return { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "read_file", arguments: "{}" } }] } as ChatMessage;
}

/**
 * 造一段真实形状的转录：每次调用一条 assistant 消息 + 一条工具结果。
 * 注意不能直接甩一串 tool 消息——那样它们全是同一批，都会被当成「最近两批」保护起来。
 */
function turns(results: Array<[string, string]>): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const [id, content] of results) {
    out.push(callMsg(id), toolMsg(id, content));
  }
  return out;
}

test("瘦身：只动老的大结果，最近两批和短结果原样留着", () => {
  const msgs = turns([
    ["t1", big(300)],
    ["t2", big(300)],
    ["t3", '{"ok":true}'],
    ["t4", big(300)],
    ["t5", big(300)],
  ]);
  const r = pruneOldToolResults(msgs);
  assert.equal(r.pruned, 2, "只有 t1 t2 被削：t3 太短，t4/t5 是最近两批");
  assert.ok(r.savedChars > 0);
  assert.ok(String(r.messages[1].content).includes("〔已省略"));
  assert.equal(r.messages[5].content, msgs[5].content, "t3 太短，不能动");
  assert.equal(r.messages[7].content, msgs[7].content, "最近一批必须原样");
  assert.equal(r.messages[9].content, msgs[9].content, "最近一批必须原样");
});

test("瘦身：一次调用带回的大结果（read_files 16 个文件）也逃不掉", () => {
  const msgs = turns([
    ["a", big(20)],
    ["b", big(20)],
    ["c", big(3000)],
    ["d", big(20)],
    ["e", big(20)],
  ]);
  const r = pruneOldToolResults(msgs);
  assert.equal(r.pruned, 1, "中间那批大的要被剪");
  assert.ok(String(r.messages[5].content).includes("〔已省略"));
});

test("瘦身：消息一条都不删（删了工具配对就断了）", () => {
  const msgs = turns(Array.from({ length: 8 }, (_, i) => [`t${i}`, big(300)] as [string, string]));
  const r = pruneOldToolResults(msgs);
  assert.equal(r.messages.length, msgs.length);
  r.messages.forEach((m, i) => assert.equal(m.tool_call_id, msgs[i].tool_call_id));
});

test("瘦身：幂等，跑两次不会越削越短", () => {
  const msgs = turns(Array.from({ length: 7 }, (_, i) => [`t${i}`, big(300)] as [string, string]));
  const once = pruneOldToolResults(msgs);
  const twice = pruneOldToolResults(once.messages);
  assert.equal(twice.pruned, 0);
  assert.deepEqual(twice.messages, once.messages);
});

test("瘦身门槛：看的是当前上下文大小，不是累积用量", () => {
  assert.equal(shouldPrune(9000, 8), false);
  assert.equal(shouldPrune(17000, 20), true);
  assert.equal(shouldPrune(9000, 60), true);
});

test("contextSize：只数内容，不看角色", () => {
  const msgs: ChatMessage[] = [
    { role: "user", content: "12345" },
    { role: "tool", tool_call_id: "t", content: "123" },
    { role: "assistant", content: null as unknown as string, tool_calls: [] },
  ];
  assert.equal(contextSize(msgs), 8);
});

test("继续执行时清掉旧的待答问题（否则面板会再弹一次卡片）", async () => {
  const { AgentLoop } = await import("../src/agent/loop");
  const { MockApp } = await import("./mocks/obsidian");
  const state = {
    runId: "r1",
    createdAt: 1,
    updatedAt: 1,
    status: "awaiting_confirm" as const,
    step: 1,
    maxSteps: 20,
    messages: [{ role: "user" as const, content: "统一格式" }],
    appliedOps: [],
    usage: { promptTokens: 1, completionTokens: 1 },
    pendingQuestion: { text: "做吗？", options: ["做", "不做"] },
    error: "旧错误",
  };
  class P {
    async chat() {
      return { content: "好，开始", toolCalls: [] };
    }
  }
  const loop = new AgentLoop({
    app: new MockApp({}) as never,
    provider: new P() as never,
    getConfig: () => ({
      baseUrl: "http://x/v1",
      apiKey: "k",
      model: "m",
      temperature: 0.3,
      maxTokens: 100,
      maxSteps: 20,
      confirmAfterFiles: 5,
    }),
    pluginDir: "/tmp",
    log: { info() {}, warn() {}, error() {} },
    confirm: async () => true,
    approvals: { isApproved: () => false, approve: () => undefined } as never,
  });
  const out = await loop.resume(state as never, () => undefined);
  assert.equal(out.pendingQuestion, undefined);
  assert.equal(out.error, undefined);
  assert.equal(out.status, "done");
});
