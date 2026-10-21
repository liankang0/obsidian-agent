import assert from "node:assert/strict";
import test from "node:test";

import { CHANGELOG_PATH, appendRecord, buildRecord } from "../src/agent/changelog";
import type { RunState } from "../src/agent/types";
import { MockApp } from "./mocks/obsidian";

function state(over: Partial<RunState> = {}): RunState {
  return {
    runId: "run-1",
    createdAt: 0,
    updatedAt: 0,
    status: "done",
    step: 3,
    maxSteps: 20,
    messages: [{ role: "user", content: "把三个 _index 末尾加邮箱" }],
    appliedOps: [
      { tool: "patch_file", path: "a.md", at: 1 },
      { tool: "patch_file", path: "b.md", at: 2 },
      { tool: "patch_file", path: "a.md", at: 3 },
    ],
    usage: { promptTokens: 1, completionTokens: 1 },
    ...over,
  };
}

test("记录里包含时间、任务名、去重后的影响文件", () => {
  const text = buildRecord(state(), Date.parse("2026-10-20T15:12:00"));
  assert.ok(text.includes("2026-10-20 15:12"), "缺时间");
  assert.ok(text.includes("把三个 _index 末尾加邮箱"), "缺任务名");
  assert.ok(text.includes("改动 2 个文件"), "影响文件应去重成 2 个");
  assert.ok(text.includes("run-1"), "缺 runId 便于追溯");
  assert.ok(!text.includes("操作人: 模型"), "应标明是插件自动记录");
});

test("没有改动就不写记录", async () => {
  const app = new MockApp({});
  const ok = await appendRecord(app as never, state({ appliedOps: [] }));
  assert.equal(ok, false);
  assert.equal(app.vault.getAbstractFileByPath(CHANGELOG_PATH), null);
});

test("追加到已有记录文件，且同一 run 不重复", async () => {
  const app = new MockApp({ [CHANGELOG_PATH]: "# AI 修改记录\n\n老内容\n" });
  assert.equal(await appendRecord(app as never, state()), true);
  const after = await app.vault.adapter.read(CHANGELOG_PATH);
  assert.ok(after.includes("老内容"), "不能冲掉原有内容");
  assert.ok(after.includes("run-1"));

  // 恢复后重跑会再走一遍收尾，必须幂等
  assert.equal(await appendRecord(app as never, state()), false);
  const twice = await app.vault.adapter.read(CHANGELOG_PATH);
  assert.equal((twice.match(/run-1/g) ?? []).length, 1, "重复记录了");
});

test("文件不存在时自动创建", async () => {
  const app = new MockApp({});
  assert.equal(await appendRecord(app as never, state()), true);
  const text = await app.vault.adapter.read(CHANGELOG_PATH);
  assert.ok(text.includes("# AI 修改记录"));
  assert.ok(text.includes("run-1"));
});
