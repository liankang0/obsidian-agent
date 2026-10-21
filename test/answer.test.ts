import assert from "node:assert/strict";
import test from "node:test";

import { finalAnswer, wantsResume } from "../src/agent/answer";
import type { ChatMessage, RunState } from "../src/agent/types";

function stateWith(messages: ChatMessage[]): RunState {
  return {
    runId: "t",
    createdAt: 0,
    updatedAt: 0,
    status: "done",
    step: 1,
    maxSteps: 5,
    messages,
    appliedOps: [],
    usage: { promptTokens: 0, completionTokens: 0 },
  };
}

test("取出模型真正的回答", () => {
  const s = stateWith([
    { role: "system", content: "sys" },
    { role: "user", content: "问" },
    { role: "assistant", content: "回答在这里" },
  ]);
  assert.equal(finalAnswer(s), "回答在这里");
});

test("跳过运行汇总行（历史被污染的元凶）", () => {
  const s = stateWith([
    { role: "user", content: "问" },
    { role: "assistant", content: "— 运行结束，共 1 步，修改 0 个文件，token 1742+334" },
    { role: "assistant", content: "这才是回答" },
  ]);
  assert.equal(finalAnswer(s), "这才是回答");
});

test("跳过空回复占位", () => {
  const s = stateWith([
    { role: "user", content: "问" },
    { role: "assistant", content: "（空回复）" },
  ]);
  assert.equal(finalAnswer(s), "");
});

test("跳过空字符串与只有空白的回答", () => {
  const s = stateWith([
    { role: "user", content: "问" },
    { role: "assistant", content: "   \n  " },
  ]);
  assert.equal(finalAnswer(s), "");
});

test("从尾部往前找，取最后一条", () => {
  const s = stateWith([
    { role: "assistant", content: "旧的" },
    { role: "assistant", content: "新的" },
    { role: "assistant", content: "— 运行结束，共 2 步" },
  ]);
  assert.equal(finalAnswer(s), "新的");
});

test("超长回答被截到 2000 字符", () => {
  const s = stateWith([{ role: "assistant", content: "字".repeat(5000) }]);
  assert.equal(finalAnswer(s).length, 2000);
});

test("识别「继续」类说法", () => {
  for (const t of ["继续", "继续上个任务", "接着干", "续上", "continue", " 继续  "]) {
    assert.equal(wantsResume(t), true, t);
  }
});

test("普通指令不会被误判成继续", () => {
  for (const t of ["把知识地图标题加空格", "搜索递归", "继续看"] ) {
    // 「继续看」算继续，这里只验明显不是的
    if (t === "继续看") continue;
    assert.equal(wantsResume(t), false, t);
  }
});
