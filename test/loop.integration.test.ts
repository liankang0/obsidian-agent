/**
 * 集成测试：用 mock 的 Obsidian API 驱动真实的 AgentLoop。
 *
 * 这一层能抓住单测抓不到的 bug：
 *   · 昨天那个「外溢文件读不回来」——根因是 .obsidian/ 不在 vault 索引里
 *   · patch_file 从参数到落盘的完整链路（含确认、并发保护）
 *   · 工具调用与结果的配对不变量
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentLoop } from "../src/agent/loop";
import { ApprovalStore } from "../src/agent/approvals";
import { SPILL_DIR } from "../src/agent/spill";
import type { Completion, ToolCall } from "../src/agent/types";
import type { Provider } from "../src/agent/provider";
import { MockApp } from "./mocks/obsidian";

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, name, args };
}

/** 按脚本逐轮返回，脚本用尽后返回「完成」 */
class ScriptedProvider {
  calls: Array<Array<{ role: string; content?: string }>> = [];
  constructor(private readonly script: Completion[]) {}

  async chat(messages: unknown[]): Promise<Completion> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    return this.script.shift() ?? { content: "完成。", toolCalls: [] };
  }
}

interface HarnessOptions {
  files?: Record<string, string>;
  script: Completion[];
  confirm?: () => boolean;
  confirmAfterFiles?: number;
  maxSteps?: number;
}

function makeLoop(opts: HarnessOptions) {
  const app = new MockApp(opts.files ?? {});
  const provider = new ScriptedProvider(opts.script);
  const loop = new AgentLoop({
    app: app as never,
    provider: provider as unknown as Provider,
    getConfig: () => ({
      baseUrl: "http://test",
      apiKey: "k",
      model: "m",
      temperature: 0,
      maxTokens: 1000,
      maxSteps: opts.maxSteps ?? 6,
      confirmAfterFiles: opts.confirmAfterFiles ?? 99,
    }),
    pluginDir: `${SPILL_DIR.split("/").slice(0, 3).join("/")}`,
    log: silentLog,
    confirm: async () => (opts.confirm ? opts.confirm() : true),
    approvals: new ApprovalStore(),
  });
  return { loop, app, provider };
}

const run = async (loop: AgentLoop, text = "测试指令") => {
  const events: string[] = [];
  const state = await loop.start(text, (e) => events.push(e.type));
  return { state, events };
};

// ---------------------------------------------------------------------------

test("闭环：read_file → patch_file → 落盘生效", async () => {
  const { loop, app } = makeLoop({
    files: { "知识地图.md": "---\ntitle: 知识地图\n---\n\n# 🗺️ 知识地图\n\n> 第二大脑的导航中心，所有笔记的总索引\n" },
    script: [
      { content: "", toolCalls: [call("c1", "read_file", { path: "知识地图.md" })] },
      {
        content: "",
        toolCalls: [
          call("c2", "patch_file", { path: "知识地图.md", old: "# 🗺️ 知识地图", new: "# 🗺️ 知识地图 " }),
        ],
      },
      { content: "改好了。", toolCalls: [] },
    ],
  });

  const { state } = await run(loop);
  assert.equal(state.status, "done");
  assert.match(app.vault.readRaw("知识地图.md")!, /# 🗺️ 知识地图 \n/);
  assert.equal(state.appliedOps.length, 1);
});

test("半句 old 匹配失败时，报错里要带「文件第 N 行」的实际内容", async () => {
  const { loop, app } = makeLoop({
    files: { "知识地图.md": "---\ntitle: 知识地图\n---\n\n# 🗺️ 知识地图\n\n> 第二大脑的导航中心，所有笔记的总索引\n" },
    script: [
      {
        content: "",
        toolCalls: [
          call("c1", "patch_file", {
            path: "知识地图.md",
            old: "# 🗺️ 知识地图\n\n> 第二大脑的导航中心",
            new: "# 🗺️ 知识地图 \n\n> 第二大脑的导航中心",
          }),
        ],
      },
      { content: "失败了。", toolCalls: [] },
    ],
  });

  const { state } = await run(loop);
  const toolMsg = state.messages.find((m) => m.role === "tool")!;
  assert.match(String(toolMsg.content), /所有笔记的总索引/);
  assert.match(String(toolMsg.content), /文件第 \d+ 行/);
  // 文件不能被改
  assert.match(app.vault.readRaw("知识地图.md")!, /# 🗺️ 知识地图\n/);
});

test("外溢：结果写盘后，read_file 能读回来（回归 .obsidian 不被索引）", async () => {
  // 造够多长名字文件，让 list_files 的结果稳稳超过 4000 字符阈值
  const files: Record<string, string> = {};
  for (let i = 0; i < 250; i++) {
    files[`knowledge/tech/分类${i}/一篇名字很长的笔记用来把结果撑过阈值-${i}.md`] = "x";
  }

  const { loop, app } = makeLoop({
    files,
    script: [
      { content: "", toolCalls: [call("c1", "list_files", { glob: "**/*.md", limit: 100 })] },
      // 第二轮：从上一轮结果里拿到落点，尝试读回
      { content: "外溢了，我读一下。", toolCalls: [] },
    ],
  });

  const { state } = await run(loop);
  assert.equal(state.status, "done");

  const listResult = state.messages.find((m) => m.role === "tool")!;
  const notice = String(listResult.content);
  assert.match(notice, /已完整存到/);
  assert.ok(notice.length < 6000, "外溢后内联内容应该变短");

  const spilled = notice.match(/已完整存到：(\S+?)\]/)?.[1];
  assert.ok(spilled, "没从提示里解析出落点");
  assert.ok(spilled!.startsWith(SPILL_DIR), `落点不对：${spilled}`);

  // 文件确实写进了 store
  const raw = app.vault.readRaw(spilled!);
  assert.ok(raw && raw.length > 4000, "外溢文件没写进存储");

  // 关键：走真实 read_file 把它读回来（这一步之前会报「找不到笔记」）
  const { loop: loop2, app: app2 } = makeLoop({
    files: { "占位.md": "x" },
    script: [{ content: "", toolCalls: [call("c9", "read_file", { path: spilled!, from: 1, to: 5 })] }, { content: "读到了。", toolCalls: [] }],
  });
  // 把外溢文件搬进第二个 harness 的 store 里
  app2.vault.writeRaw(spilled!, raw!);

  const { state: s2 } = await run(loop2);
  const readResult = s2.messages.filter((m) => m.role === "tool")[0];
  assert.equal(JSON.parse(String(readResult.content)).ok, true, `read_file 失败：${readResult.content}`);
});

test("用户拒绝时文件不变", async () => {
  const { loop, app } = makeLoop({
    files: { "a.md": "# 标题\n正文\n" },
    confirmAfterFiles: 0, // 立即进入逐次确认
    confirm: () => false,
    script: [
      { content: "", toolCalls: [call("c1", "patch_file", { path: "a.md", old: "# 标题", new: "# 新标题" })] },
      { content: "用户拒绝了。", toolCalls: [] },
    ],
  });

  const { state } = await run(loop);
  assert.equal(app.vault.readRaw("a.md"), "# 标题\n正文\n");
  const toolMsg = state.messages.find((m) => m.role === "tool")!;
  assert.match(String(toolMsg.content), /拒绝/);
});

test("接受一次后，同目录的后续修改不再弹窗", async () => {
  let asked = 0;
  const { loop } = makeLoop({
    files: { "日记/a.md": "第一行\n", "日记/b.md": "第一行\n" },
    confirmAfterFiles: 0,
    confirm: () => {
      asked++;
      return true;
    },
    script: [
      { content: "", toolCalls: [call("c1", "patch_file", { path: "日记/a.md", old: "第一行", new: "改过" })] },
      { content: "", toolCalls: [call("c2", "patch_file", { path: "日记/b.md", old: "第一行", new: "改过" })] },
      { content: "都好。", toolCalls: [] },
    ],
  });

  const { state } = await run(loop);
  assert.equal(state.status, "done");
  assert.equal(asked, 1, `应该只问一次，实际问了 ${asked} 次`);
});

test("不变量：一轮结束后，每个 tool_call 都有对应的 tool 结果", async () => {
  const { loop } = makeLoop({
    files: { "a.md": "内容\n" },
    script: [
      {
        content: "",
        toolCalls: [call("c1", "read_file", { path: "a.md" }), call("c2", "read_file", { path: "a.md" })],
      },
      { content: "两次都读了。", toolCalls: [] },
    ],
  });

  const { state } = await run(loop);
  const calls = new Set<string>();
  for (const m of state.messages) {
    if (m.role === "assistant") for (const c of m.tool_calls ?? []) calls.add(c.id);
  }
  const answered = new Set(state.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id));
  for (const id of calls) assert.ok(answered.has(id), `工具调用 ${id} 没有结果`);
});

test("多轮上下文：history 拼在 system 与 user 之间", async () => {
  const seen: unknown[][] = [];
  const { loop } = makeLoop({
    script: [{ content: "好", toolCalls: [] }],
  });
  // 抓取真正发给模型的消息
  const anyLoop = loop as unknown as { deps: { provider: { chat: unknown } } };
  anyLoop.deps.provider.chat = async (messages: unknown[]) => {
    // 必须拷贝：循环传的是活数组，跑完会被继续追加
    seen.push(messages.map((m) => ({ ...(m as Record<string, unknown>) })));
    return { content: "好", toolCalls: [] };
  };

  await loop.start("第二句", () => undefined, [
    { role: "user", content: "第一句" },
    { role: "assistant", content: "第一轮的回答" },
  ]);

  assert.equal(seen.length, 1);
  const msgs = seen[0] as Array<{ role: string; content: string }>;
  assert.deepEqual(
    msgs.map((m) => m.role),
    ["system", "user", "assistant", "user"],
    "顺序必须是 system → 历史 → 当前输入",
  );
  assert.equal(msgs[1].content, "第一句");
  assert.equal(msgs[2].content, "第一轮的回答");
  assert.equal(msgs[3].content, "第二句");
  assert.ok(msgs[0].content.length > 100, "system prompt 应该还在");
});

test("多轮上下文：不传 history 时行为不变", async () => {
  const seen: unknown[][] = [];
  const { loop } = makeLoop({ script: [{ content: "好", toolCalls: [] }] });
  const anyLoop = loop as unknown as { deps: { provider: { chat: unknown } } };
  anyLoop.deps.provider.chat = async (messages: unknown[]) => {
    // 必须拷贝：循环传的是活数组，跑完会被继续追加
    seen.push(messages.map((m) => ({ ...(m as Record<string, unknown>) })));
    return { content: "好", toolCalls: [] };
  };
  await loop.start("只有这一句", () => undefined);
  const msgs = seen[0] as Array<{ role: string }>;
  assert.deepEqual(
    msgs.map((m) => `${m.role}`),
    ["system", "user"],
    `实际消息：${JSON.stringify(msgs.map((m) => [m.role, String((m as { content?: string }).content).slice(0, 20)]))}`,
  );
});

test("空回复：第一次空会重试，第二次正常就完成", async () => {
  const { loop } = makeLoop({
    script: [
      { content: "", toolCalls: [] }, // 空回复
      { content: "这次说清楚了。", toolCalls: [] },
    ],
    files: { "a.md": "# A\n" },
  });
  const state = await loop.start("随便做点什么", () => undefined);
  assert.equal(state.status, "done");
  assert.equal(state.emptyReplies, 1, "应该记录重试过一次");
  assert.ok(
    state.messages.some((m) => String(m.content).includes("上一条回复是空的")),
    "应该注入提醒",
  );
});

test("空回复：连续两次空判定失败，而不是静默完成", async () => {
  const { loop } = makeLoop({
    script: [
      { content: "", toolCalls: [] },
      { content: "  ", toolCalls: [] },
    ],
  });
  const state = await loop.start("随便做点什么", () => undefined);
  assert.equal(state.status, "failed", "不能把空回复当成完成");
  assert.ok(String(state.error).includes("空内容"), `错误应说清原因：${state.error}`);
});

test("每轮模型调用后都会实时上报用量", async () => {
  const { loop } = makeLoop({
    files: { "a.md": "- one\n" },
    script: [
      { content: "", toolCalls: [{ id: "1", name: "read_file", args: { path: "a.md" } }], usage: { promptTokens: 100, completionTokens: 10 } },
      { content: "好了。", toolCalls: [], usage: { promptTokens: 300, completionTokens: 20 } },
    ],
  });

  const seen: Array<{ p: number; c: number }> = [];
  const state = await loop.start("读一下 a.md", (e) => {
    if (e.type === "usage") seen.push({ p: e.usage.promptTokens, c: e.usage.completionTokens });
  });

  assert.equal(state.status, "done");
  assert.equal(seen.length, 2, "两轮模型调用应各上报一次");
  assert.deepEqual(seen[0], { p: 100, c: 10 });
  // 第二次是累计值：300+20 加上前面
  assert.deepEqual(seen[1], { p: 400, c: 30 });
});

test("用量是累计的，不会倒退", async () => {
  const { loop } = makeLoop({
    files: { "a.md": "- one\n" },
    script: [
      { content: "", toolCalls: [{ id: "1", name: "read_file", args: { path: "a.md" } }], usage: { promptTokens: 50, completionTokens: 5 } },
      { content: "", toolCalls: [{ id: "2", name: "read_file", args: { path: "a.md" } }], usage: { promptTokens: 50, completionTokens: 5 } },
      { content: "完成。", toolCalls: [], usage: { promptTokens: 50, completionTokens: 5 } },
    ],
  });
  const totals: number[] = [];
  await loop.start("读两次", (e) => {
    if (e.type === "usage") totals.push(e.usage.promptTokens + e.usage.completionTokens);
  });
  assert.equal(totals.length, 3);
  for (let i = 1; i < totals.length; i++) {
    assert.ok(totals[i] > totals[i - 1], `第 ${i} 次没有增长：${totals.join(",")}`);
  }
});
