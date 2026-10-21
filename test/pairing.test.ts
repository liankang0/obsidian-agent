/**
 * tool_call / tool_result 配对修复的单元测试。
 * 用 Node 内置 test runner，不引入新依赖。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { repairToolPairing } from "../src/agent/pairing";
import type { ChatMessage } from "../src/agent/types";

const call = (id: string): ChatMessage => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id, name: "read_file", args: { path: "a.md" } }],
});

const result = (id: string): ChatMessage => ({
  role: "tool",
  tool_call_id: id,
  content: JSON.stringify({ ok: true, data: "内容" }),
});

test("合法的序列原样通过", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "读一下 a.md" },
    call("c1"),
    result("c1"),
    { role: "assistant", content: "读完了" },
  ];
  const { messages: out, report } = repairToolPairing(messages);
  assert.equal(out.length, messages.length);
  assert.equal(report.synthesized, 0);
  assert.equal(report.dropped, 0);
});

test("恢复到「3 个调用只回了 1 个」的存档：补 2 条", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "做三件事" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "c1", name: "read_file", args: { path: "a.md" } },
        { id: "c2", name: "read_file", args: { path: "b.md" } },
        { id: "c3", name: "read_file", args: { path: "c.md" } },
      ],
    },
    result("c1"),
  ];
  const { messages: out, report } = repairToolPairing(messages);
  assert.equal(report.synthesized, 2);
  assert.equal(report.dropped, 0);

  // 每个 tool_call 都有应答，且恰好一条
  const answered = out.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
  assert.deepEqual(answered.sort(), ["c1", "c2", "c3"]);

  // 补桩紧跟在那条 assistant 之后，且内容是明确的「未执行」
  assert.equal(out[2].role, "tool");
  assert.match(String(out[2].content), /未执行/);
});

test("完全没执行（用户立刻取消）：全部补桩", () => {
  const messages: ChatMessage[] = [call("c1"), call("c2")];
  const { messages: out, report } = repairToolPairing(messages);
  assert.equal(report.synthesized, 2);
  assert.equal(out.filter((m) => m.role === "tool").length, 2);
});

test("孤立的 tool 消息被丢掉（否则同样 400）", () => {
  const messages: ChatMessage[] = [
    { role: "user", content: "hi" },
    { role: "tool", tool_call_id: "ghost", content: "无主结果" },
    { role: "assistant", content: "ok" },
  ];
  const { messages: out, report } = repairToolPairing(messages);
  assert.equal(report.dropped, 1);
  assert.equal(out.some((m) => m.role === "tool"), false);
});

test("重复的工具结果只保留第一条", () => {
  const messages: ChatMessage[] = [call("c1"), result("c1"), result("c1")];
  const { messages: out, report } = repairToolPairing(messages);
  assert.equal(report.dropped, 1);
  assert.equal(out.filter((m) => m.role === "tool").length, 1);
});

test("幂等：修一次和修两次结果相同", () => {
  const broken: ChatMessage[] = [call("c1"), call("c2")];
  const once = repairToolPairing(broken).messages;
  const twice = repairToolPairing(once).messages;
  assert.deepEqual(twice, once);
  assert.equal(repairToolPairing(once).report.synthesized, 0);
});

test("没有工具调用的普通对话完全不动", () => {
  const messages: ChatMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好" },
  ];
  const { messages: out, report } = repairToolPairing(messages);
  assert.deepEqual(out, messages);
  assert.equal(report.synthesized + report.dropped, 0);
});
