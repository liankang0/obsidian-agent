import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentLoop } from "../src/agent/loop";
import { MockApp } from "./mocks/obsidian";
import type { Completion } from "../src/agent/provider";

type Ev = { type: string; text?: string; state?: unknown };

function makeLoop(app: MockApp, script: Completion[], warns: string[]) {
  class P {
    i = 0;
    async chat(): Promise<Completion> {
      return script[this.i++] ?? { content: "完", toolCalls: [] };
    }
  }
  return new AgentLoop({
    app: app as never,
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
    log: { info() {}, warn: (m: string) => warns.push(m), error() {} },
    confirm: async () => true,
    approvals: { isApproved: () => false, isAllowed: () => true, approve: () => undefined } as never,
  });
}

const patchScript: Completion[] = [
  {
    content: "改一下",
    toolCalls: [{ id: "c1", name: "patch_file", args: { path: "a.md", old: "旧内容", new: "新内容" } }],
  },
  { content: "改好了", toolCalls: [] },
];

test("准则 Step 4：调过 record_memory 就不再误报「没回写 04/05」", async () => {
  const warns: string[] = [];
  // WP3：loop 按 vault 实况解析工作区，裸库不再有 AI/04——补上夹具才有 Step 4 语境
  const app = new MockApp({
    "a.md": "旧内容\n",
    "AI/04-临时工作记忆区.md": "# 04 · 临时工作记忆区\n\n## 当前活跃任务\n\n",
  });
  const script: Completion[] = [
    {
      content: "先改文件",
      toolCalls: [{ id: "c1", name: "patch_file", args: { path: "a.md", old: "旧内容", new: "新内容" } }],
    },
    {
      content: "再记一笔",
      toolCalls: [
        { id: "c2", name: "record_memory", args: { kind: "working", title: "改写了 a.md", content: "把旧内容换成新内容" } },
      ],
    },
    { content: "都做完了", toolCalls: [] },
  ];
  const loop = makeLoop(app, script, warns);
  const state = await loop.start("改 a.md 并记一下", () => undefined);
  assert.equal(state.status, "done");
  assert.equal(state.memoryWritten, true);
  const bad = warns.filter((w) => w.includes("准则 Step 4"));
  assert.deepEqual(bad, [], `不该报警，实际：${bad.join(" / ")}`);
});

test("准则 Step 4：改完文件又没记记忆，才提醒（别再误伤）", async () => {
  const warns: string[] = [];
  // 同上：提醒的前提是工作区已启用（库里有 AI/ 目录）
  const app = new MockApp({
    "a.md": "旧内容\n",
    "AI/04-临时工作记忆区.md": "# 04 · 临时工作记忆区\n\n## 当前活跃任务\n\n",
  });
  const loop = makeLoop(app, patchScript, warns);
  await loop.start("改 a.md", () => undefined);
  assert.equal(warns.filter((w) => w.includes("准则 Step 4")).length, 1);
});

test("动了结构也算改动：move_note / trash_note 进 appliedOps（否则 AI/03 少记一半）", async () => {
  const warns: string[] = [];
  const app = new MockApp({ "旧目录/a.md": "# a\n", "b.md": "# b\n" });

  class P {
    i = 0;
    async chat(): Promise<Completion> {
      const s: Completion[] = [
        {
          content: "整理一下",
          toolCalls: [
            { id: "m1", name: "move_note", args: { from: "旧目录/a.md", to: "新目录/a.md" } },
            { id: "t1", name: "trash_note", args: { path: "b.md" } },
          ],
        },
        { content: "整理完了", toolCalls: [] },
      ];
      return s[this.i++] ?? { content: "完", toolCalls: [] };
    }
  }
  const loop = new AgentLoop({
    app: app as never,
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
    log: { info() {}, warn: (m: string) => warns.push(m), error() {} },
    confirm: async () => true,
    approvals: { isApproved: () => false, isAllowed: () => true, approve: () => undefined } as never,
  });
  const state = await loop.start("整理目录", () => undefined);
  const tools = state.appliedOps.map((o) => o.tool);
  assert.ok(tools.includes("move_note"), `appliedOps 缺 move_note：${tools.join(",")}`);
  assert.ok(tools.includes("trash_note"), `appliedOps 缺 trash_note：${tools.join(",")}`);
  const paths = state.appliedOps.map((o) => o.path);
  assert.deepEqual(
    paths.filter((p) => p === "旧目录/a.md" || p === "b.md").sort(),
    ["b.md", "旧目录/a.md"],
    `影响文件里不该出现 undefined：${JSON.stringify(paths)}`,
  );
});
