/**
 * WP1 结果可信度：四种降级点必须让模型看见。
 *
 * 背景见 docs/08 ADR：过去这些失败都被静默吞掉——
 *   · 反链 API 缺失 → get_backlinks 返回空数组，模型以为「没人引用」就敢删
 *   · 检索超时 → break 掉装作正常结束，模型把部分结果当全库结论
 *   · 记忆文件读失败 → 返回空串，模型以为「没有历史」
 *   · skill 扫描失败 → 返回空索引，模型以为「库里没有 skill」
 * 统一约定：降级结果带 degraded 说明，序列化时渲染成「⚠ 本次数据不完整：…」。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../src/agent/loop";
import { ApprovalStore } from "../src/agent/approvals";
import { buildSystemPrompt } from "../src/agent/loop";
import { buildMemoryBlock, readMemory } from "../src/agent/memory";
import { buildSkillIndex, scanSkills } from "../src/agent/skills";
import { serializeToolResult } from "../src/agent/serialize";
import { executeTool, type ConfirmRequest, type ToolContext } from "../src/agent/tools";
import type { Completion, Provider, ToolCall } from "../src/agent/types";
import { MockApp, TFile } from "./mocks/obsidian";

const LOG = { info() {}, warn() {}, error() {} };

const FILES: Record<string, string> = {
  "knowledge/life/旅行.md": ["---", "title: 旅行", "---", "", "# 旅行 #生活"].join("\n"),
  "日记.md": "# 日记\n\n今天看了 [[旅行]] 的笔记。\n",
  "a.md": "# A\n正文\n",
};

function makeCtx(app: MockApp, over: Partial<ToolContext> = {}): ToolContext {
  return {
    app: app as never,
    log: LOG,
    confirm: async () => true,
    changedFiles: new Set<string>(),
    confirmAfterFiles: 5,
    readOnly: false,
    runId: "t",
    approvals: new ApprovalStore(),
    ...over,
  };
}

async function run(ctx: ToolContext, name: string, args: Record<string, unknown>) {
  return executeTool({ id: "1", name, args }, ctx);
}

// ── get_backlinks：反链 API 缺失 vs 正常 ─────────────────────────────────────

test("get_backlinks：API 缺失时不能装作「没有反链」，要带 degraded 说明", async () => {
  const app = new MockApp(FILES);
  app.metadataCache.getBacklinksForFile = undefined;
  const r = await run(makeCtx(app), "get_backlinks", { path: "knowledge/life/旅行.md" });
  assert.equal(r.ok, true);
  const data = r.data as { count: number | null; backlinks: unknown[] };
  assert.equal(data.count, null, "count 必须是 null（未知），不是 0");
  assert.equal(data.backlinks.length, 0);
  assert.ok(r.degraded, "必须有 degraded 说明");
  assert.ok(r.degraded!.includes("反链"), `degraded 要说清是反链出了问题：${r.degraded}`);
});

test("get_backlinks：API 正常时返回真实计数，不带 degraded", async () => {
  const app = new MockApp(FILES);
  const r = await run(makeCtx(app), "get_backlinks", { path: "knowledge/life/旅行.md" });
  assert.equal(r.ok, true);
  const data = r.data as { count: number; backlinks: Array<{ path: string; count: number }>; degraded?: string };
  assert.equal(typeof data.count, "number");
  assert.equal(data.count, 1, "日记.md 里有 [[旅行]]，应算一条反链");
  assert.equal(data.backlinks[0]?.path, "日记.md");
  assert.equal(data.degraded, undefined);
});

// ── search：超时 vs 正常 ─────────────────────────────────────────────────────

test("search：超时中断时必须说「没扫完」，不能让 count=0 冒充「全库没有」", async () => {
  const app = new MockApp({
    "b.md": "无关内容",
    "a.md": "这里有关键词",
  });
  // 让每次读取都变慢：第一篇读完就超预算，第二篇（含目标的）根本不会被扫
  const orig = app.vault.cachedRead.bind(app.vault);
  app.vault.cachedRead = (async (f: TFile) => {
    await new Promise((r2) => setTimeout(r2, 30));
    return orig(f);
  }) as typeof app.vault.cachedRead;

  const ctx = makeCtx(app, { searchTimeBudgetMs: 10 });
  const r = await run(ctx, "search", { query: "关键词" });
  assert.equal(r.ok, true);
  const data = r.data as { count: number; hits: unknown[] };
  assert.equal(data.count, 0, "目标文件在超时后没被扫到");
  assert.ok(r.degraded, "count=0 但必须带 degraded，否则模型会断言「全库没有」");
  assert.ok(r.degraded!.includes("没有扫完全库"), `degraded 要说清是超时：${r.degraded}`);
});

test("search：预算内扫完时不带 degraded", async () => {
  const app = new MockApp(FILES);
  const r = await run(makeCtx(app), "search", { query: "旅行" });
  assert.equal(r.ok, true);
  const data = r.data as { count: number };
  assert.ok(data.count >= 1);
  assert.equal(r.degraded, undefined);
});

// ── trash_note：反链未知时确认框不许说「没有笔记链到它」───────────────────────

test("trash_note：反链 API 缺失时确认框要说「状态未知」，结果带 degraded", async () => {
  const app = new MockApp(FILES);
  app.metadataCache.getBacklinksForFile = undefined;
  let summary = "";
  const ctx = makeCtx(app, {
    confirm: async (req: ConfirmRequest) => {
      summary = req.summary;
      return true;
    },
  });
  const r = await run(ctx, "trash_note", { path: "knowledge/life/旅行.md" });
  assert.equal(r.ok, true, r.error);
  assert.ok(summary.includes("反链状态未知"), `确认框不能谎称没有反链：${summary}`);
  assert.ok(!summary.includes("没有笔记链到它"), "「未知」绝不能被说成「没有」");
  const data = r.data as { backlinks: number | null };
  assert.equal(data.backlinks, null);
  assert.ok(r.degraded, "删除前检查没做成，结果里必须告诉模型");
});

test("trash_note：反链正常时确认框给出真实计数", async () => {
  const app = new MockApp(FILES);
  let summary = "";
  const ctx = makeCtx(app, {
    confirm: async (req: ConfirmRequest) => {
      summary = req.summary;
      return true;
    },
  });
  const r = await run(ctx, "trash_note", { path: "knowledge/life/旅行.md" });
  assert.equal(r.ok, true, r.error);
  assert.ok(summary.includes("有 1 篇笔记链到它"), `确认框应给出真实反链数：${summary}`);
  const data = r.data as { backlinks: number };
  assert.equal(data.backlinks, 1);
  assert.equal(r.degraded, undefined);
});

// ── 工作记忆：读失败 vs 正常 ─────────────────────────────────────────────────

test("readMemory：文件读取失败时要带 degraded，不能和「没有记忆」混在一起", async () => {
  const app = new MockApp({
    "AI/04-临时工作记忆区.md": "# 04\n\n## 当前活跃任务\n\n### 任务甲 ✅\n**完成时间**: 2026-01-01 10:00:00\n**操作内容**: 改了 a.md\n",
    "AI/05-对话历史记录区.md": "# 05\n\n### 记录乙\n\n**任务**: 聊过天\n\n## 快速索引\n",
  });
  app.vault.cachedRead = async () => {
    throw new Error("EIO: 磁盘错误");
  };
  const mem = await readMemory(app as never);
  assert.ok(mem.degraded, "读取失败必须有 degraded 说明");
  assert.ok(mem.degraded!.includes("读取失败"), `degraded 内容：${mem.degraded}`);

  const block = buildMemoryBlock(mem);
  assert.ok(block.includes("本次数据不完整"), "记忆块里要让模型看见降级");
  assert.ok(block.includes("不要断言"), "要附上行为约束");
});

test("readMemory：文件不存在是正常情况，不带 degraded，空块不占位", async () => {
  const mem = await readMemory(new MockApp({}) as never);
  assert.equal(mem.degraded, undefined);
  assert.equal(mem.working, "");
  assert.equal(buildMemoryBlock(mem), "");
  // 既有行为保持：空 bundle 的块永远是空串
  assert.equal(buildMemoryBlock({ working: "", history: "" }), "");
});

test("readMemory：读取正常时块里就是内容，没有降级字样", async () => {
  const app = new MockApp({
    "AI/04-临时工作记忆区.md": "# 04\n\n## 当前活跃任务\n\n### 任务甲 ✅\n**完成时间**: 2026-01-01 10:00:00\n**操作内容**: 改了 a.md\n",
  });
  const mem = await readMemory(app as never);
  const block = buildMemoryBlock(mem);
  assert.ok(block.includes("任务甲"), `应包含工作记忆条目：${block.slice(0, 200)}`);
  assert.ok(!block.includes("本次数据不完整"), "正常路径不许出现降级标记");
});

// ── skills：扫描失败 vs 正常 ─────────────────────────────────────────────────

test("scanSkills：整体扫描失败要带 degraded，不能返回空数组装作没有 skill", async () => {
  const app = new MockApp({});
  (app.vault as unknown as { getMarkdownFiles: () => never }).getMarkdownFiles = () => {
    throw new Error("索引损坏");
  };
  const scan = await scanSkills(app as never);
  assert.equal(scan.skills.length, 0);
  assert.ok(scan.degraded, "必须有 degraded 说明");
  assert.ok(scan.degraded!.includes("索引损坏"), `degraded 内容：${scan.degraded}`);

  // 空索引 + degraded → prompt 里要有说明，不能静默空串
  const index = buildSkillIndex(scan.skills, scan.degraded);
  assert.ok(index.includes("本次数据不完整"), `降级时索引要说明：${index}`);
  // 既有行为保持：真空库且无降级 → 空串
  assert.equal(buildSkillIndex([]), "");
});

test("scanSkills：正常扫描不带 degraded，索引内容正常", async () => {
  const app = new MockApp({ "skills/abc.md": "---\nname: abc\ndescription: 测试\n---\n正文" });
  const scan = await scanSkills(app as never);
  assert.equal(scan.degraded, undefined);
  const index = buildSkillIndex(scan.skills);
  assert.ok(index.includes("abc"));
  assert.ok(!index.includes("本次数据不完整"), "正常路径不许出现降级标记");
});

// ── use_skill：回退扫描失败时也要说清楚 ──────────────────────────────────────

test("use_skill：回退扫描失败时，报错里要说明索引不可用", async () => {
  const app = new MockApp({});
  (app.vault as unknown as { getMarkdownFiles: () => never }).getMarkdownFiles = () => {
    throw new Error("boom");
  };
  const r = await run(makeCtx(app), "use_skill", { name: "x" });
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes("本次数据不完整"), `报错应提示索引降级：${r.error}`);
});

// ── 序列化：degraded 统一渲染成「⚠ 本次数据不完整：…」────────────────────────

async function serialize(result: unknown, tool = "search") {
  const app = new MockApp({});
  return serializeToolResult({ adapter: app.vault.adapter as never, log: { warn() {} } }, tool, "run-1", 1, result);
}

test("serializer：带 degraded 的结果在最前面渲染标记", async () => {
  const r = await serialize({ ok: true, data: { count: 0 }, degraded: "检索超时" });
  assert.ok(r.content.startsWith("⚠ 本次数据不完整：检索超时\n"), `content 开头：${r.content.slice(0, 60)}`);
  assert.ok(r.content.includes('"count":0'), "数据本体还在");
});

test("serializer：正常结果不加任何前缀", async () => {
  const r = await serialize({ ok: true, data: { count: 3 } });
  assert.ok(!r.content.includes("本次数据不完整"), "正常路径不许出现降级标记");
  assert.ok(r.content.startsWith('{"ok":true'));
});

test("serializer：外溢路径同样要带标记（模型可能只看头部）", async () => {
  const big = { ok: true, data: { hits: Array.from({ length: 200 }, (_, i) => ({ path: `file-${i}.md`, preview: "x".repeat(40) })) }, degraded: "部分命中" };
  const r = await serialize(big, "list_files");
  assert.ok(r.spilledPath, "应走外溢");
  assert.ok(r.content.startsWith("⚠ 本次数据不完整：部分命中\n"), `外溢内容开头：${r.content.slice(0, 60)}`);
});

// ── system prompt：原则 14 ───────────────────────────────────────────────────

test("system prompt：包含「本次数据不完整 ≠ 没有」的工作原则", () => {
  const prompt = buildSystemPrompt(new MockApp({}) as never);
  assert.ok(prompt.includes("本次数据不完整"), "必须有降级数据原则");
  assert.ok(prompt.includes("count"), "要提到 null/0 的语义区分");
});

// ── 集成：脚本化模型跑一轮，验证模型可见文本 ────────────────────────────────

class ScriptedProvider {
  calls: Array<Array<{ role: string; content?: string }>> = [];
  constructor(private readonly script: Completion[]) {}
  async chat(messages: unknown[]): Promise<Completion> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    return this.script.shift() ?? { content: "完成。", toolCalls: [] };
  }
}

function makeLoop(files: Record<string, string>, script: Completion[]) {
  const app = new MockApp(files);
  const provider = new ScriptedProvider(script);
  const loop = new AgentLoop({
    app: app as never,
    provider: provider as unknown as Provider,
    getConfig: () => ({
      baseUrl: "http://test",
      apiKey: "k",
      model: "m",
      temperature: 0,
      maxTokens: 1000,
      maxSteps: 6,
      confirmAfterFiles: 99,
    }),
    pluginDir: ".obsidian/plugins/local-vault-agent",
    log: LOG,
    confirm: async () => true,
    approvals: new ApprovalStore(),
  });
  return { loop, app, provider };
}

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, args });

test("集成：降级标记出现在模型看见的 tool 消息里；正常路径不出现", async () => {
  const { loop, app, provider } = makeLoop(FILES, [
    { content: "", toolCalls: [call("c1", "get_backlinks", { path: "knowledge/life/旅行.md" })] },
    { content: "", toolCalls: [call("c2", "read_file", { path: "a.md" })] },
    { content: "完成。", toolCalls: [] },
  ]);
  // 制造降级：反链 API 缺失
  app.metadataCache.getBacklinksForFile = undefined;

  const state = await loop.start("看看这篇笔记被谁引用", () => undefined);
  assert.equal(state.status, "done");

  const toolMsgs = state.messages.filter((m) => m.role === "tool");
  assert.equal(toolMsgs.length, 2);
  assert.ok(
    String(toolMsgs[0].content).includes("本次数据不完整"),
    `get_backlinks 降级结果没有标记：${toolMsgs[0].content.slice(0, 100)}`,
  );
  assert.ok(String(toolMsgs[0].content).includes("反链"), "标记要说清是反链的问题");
  assert.ok(
    !String(toolMsgs[1].content).includes("本次数据不完整"),
    "read_file 正常结果不许带标记",
  );
  assert.ok(String(toolMsgs[1].content).includes("# A"));

  // 模型第二轮真正收到的消息里也要有标记（不是只在 state 里）
  const secondCall = provider.calls[1];
  assert.ok(
    secondCall.some((m) => m.role === "tool" && String(m.content).includes("本次数据不完整")),
    "发给模型的消息里必须包含降级标记",
  );
});
