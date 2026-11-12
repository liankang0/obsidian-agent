/**
 * WP5 一致性小缺陷批量修复：8 个缺陷每个至少一条钉住行为的测试。
 *
 *  1. move_note 传文件夹路径 → 可读报错（原来 throw 的是 ToolResult 对象，
 *     到模型手里变成 "[object Object]"，模型根本不知道错在哪）
 *  2. 只读模式的拒绝必须发生在最前面——不能因为路径不存在就报「找不到」
 *  3. changedFiles 持久化：续跑后确认计数不归零，安全阀不失效
 *  4. resume 后 turnStart 重置：失败的任务不许把上一轮的回答当成这一轮的
 *  5. 发送即落盘：用户消息先写进存档，再发模型请求
 *  6. search 结果带真实行号
 *  7. .canvas/.base 结构化文件写入前校验 JSON，坏 JSON 直接拒绝
 *  8. 修改记录超阈值自动归档到年度文件，主文件回到骨架
 */

import assert from "node:assert/strict";
import test from "node:test";

import { finalAnswer } from "../src/agent/answer";
import { appendRecord, ARCHIVE_THRESHOLD_CHARS } from "../src/agent/changelog";
import { AgentLoop } from "../src/agent/loop";
import { ApprovalStore } from "../src/agent/approvals";
import { executeTool, type ToolContext } from "../src/agent/tools";
import type { Completion, Provider, ToolCall } from "../src/agent/types";
import { MockApp } from "./mocks/obsidian";

const LOG = { info() {}, warn() {}, error() {} };

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

// ── 1. move_note：文件夹路径 → 可读报错 ──────────────────────────────────────

test("move_note：目标是文件夹时报错可读，不是 [object Object]", async () => {
  const app = new MockApp({ "sub/a.md": "# A\n" });
  const r = await run(makeCtx(app), "move_note", { from: "sub", to: "other" });
  assert.equal(r.ok, false);
  assert.ok(
    String(r.error).includes("目标是文件夹"),
    `报错必须能看懂（原来 throw ToolResult 会变 [object Object]）：${r.error}`,
  );
});

// ── 2. 只读模式：拒绝发生在最前面 ────────────────────────────────────────────

test("只读模式：7 个写工具全部拒绝，且拒绝理由优先于路径错误", async () => {
  // 注意 patch_file / trash_* 用的路径不存在：如果只读检查不是第一个动作，
  // 这里会报「找不到笔记」而不是「禁止修改」——那说明顺序又退回去了。
  const app = new MockApp({});
  const ctx = makeCtx(app, { readOnly: true });
  const cases: Array<[string, Record<string, unknown>]> = [
    ["patch_file", { path: "不存在.md", old: "a", new: "b" }],
    ["create_note", { path: "新笔记.md", content: "hi" }],
    ["write_file", { path: "不存在.md", content: "x" }],
    ["move_note", { from: "不存在.md", to: "b.md" }],
    ["record_memory", {}],
    ["trash_note", { path: "不存在.md" }],
    ["trash_folder", { path: "不存在文件夹/" }],
  ];
  for (const [name, args] of cases) {
    const r = await run(ctx, name, args);
    assert.equal(r.ok, false, `${name} 在只读模式下必须失败`);
    assert.ok(
      String(r.error).includes("只读"),
      `${name} 的拒绝理由要说只读，实际：${r.error}`,
    );
    assert.ok(
      !String(r.error).includes("找不到"),
      `${name} 不该先报路径错误（只读检查必须最先做）：${r.error}`,
    );
  }
});

// ── 3. changedFiles 持久化 + 续跑恢复 ────────────────────────────────────────

/** 脚本化 Provider：脚本耗尽后返回默认完成。脚本是 Error 时直接抛（模拟模型失败）。 */
class ScriptedProvider {
  calls: Array<Array<{ role: string; content?: string }>> = [];
  constructor(private readonly script: Array<Completion | Error>) {}
  async chat(messages: unknown[]): Promise<Completion> {
    this.calls.push(JSON.parse(JSON.stringify(messages)));
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    return next ?? { content: "完成。", toolCalls: [] };
  }
}

function makeLoop(
  files: Record<string, string>,
  script: Array<Completion | Error>,
  opts: { confirmAfterFiles?: number } = {},
) {
  const app = new MockApp(files);
  const provider = new ScriptedProvider(script);
  let confirmCalls = 0;
  const loop = new AgentLoop({
    app: app as never,
    provider: provider as unknown as Provider,
    getConfig: () => ({
      baseUrl: "http://test",
      apiKey: "k",
      model: "m",
      temperature: 0,
      maxTokens: 1000,
      maxSteps: 8,
      confirmAfterFiles: opts.confirmAfterFiles ?? 99,
    }),
    pluginDir: ".obsidian/plugins/local-vault-agent",
    log: LOG,
    confirm: async () => {
      confirmCalls++;
      return true;
    },
    approvals: new ApprovalStore(),
  });
  return { loop, app, provider, getConfirmCalls: () => confirmCalls };
}

const call = (id: string, name: string, args: Record<string, unknown>): ToolCall => ({ id, name, args });

test("changedFiles：写进存档，续跑后计数恢复、确认照常触发", async () => {
  const files = { "a.md": "# A\n原文\n", "b.md": "# B\n原文\n" };
  // 第一轮：改 1 个文件（阈值 1 时第一刀不触发确认）
  const phase1 = makeLoop(files, [
    { content: "", toolCalls: [call("c1", "patch_file", { path: "a.md", old: "原文", new: "改过" })] },
    { content: "第一轮完成。", toolCalls: [] },
  ], { confirmAfterFiles: 1 });
  const state = await phase1.loop.start("改一下 a", () => undefined);
  assert.equal(state.status, "done");
  assert.deepEqual(state.changedFiles, ["a.md"], "本轮改动要同步进状态");
  assert.equal(phase1.getConfirmCalls(), 0, "第一刀在阈值内，不该确认");

  // 从磁盘读回存档（证明持久化，不是内存巧合），再续跑
  const saved = await phase1.loop.loadState(state.runId);
  assert.ok(saved, "存档必须存在");
  assert.deepEqual(saved.changedFiles, ["a.md"], "changedFiles 必须落盘——不存的话续跑后计数归零");

  // 第二轮：改 b.md。如果计数恢复了，这一刀就该触发确认（size 1 >= 1）
  const phase2 = makeLoop(files, [
    { content: "", toolCalls: [call("c2", "patch_file", { path: "b.md", old: "原文", new: "也改了" })] },
    { content: "第二轮完成。", toolCalls: [] },
  ], { confirmAfterFiles: 1 });
  const state2 = await phase2.loop.resume(saved, () => undefined);
  assert.equal(state2.status, "done");
  assert.equal(phase2.getConfirmCalls(), 1, "续跑后第一刀必须确认——计数没恢复的话这里是 0");
  assert.deepEqual(state2.changedFiles, ["a.md", "b.md"], "恢复的计数和新增的文件都在");
  assert.ok(phase2.app.vault.rawContent("b.md")?.includes("也改了"), "改动本身要真的落盘");
});

// ── 4. resume 后 turnStart 重置 ──────────────────────────────────────────────

test("turnStart：续跑失败时，finalAnswer 不许把上一轮的回答捞出来", async () => {
  const phase1 = makeLoop({}, [{ content: "第一轮的回答。", toolCalls: [] }]);
  const state = await phase1.loop.start("做任务甲", () => undefined);
  assert.equal(state.status, "done");
  const oldAnswer = finalAnswer(state);
  assert.equal(oldAnswer, "第一轮的回答。", "第一轮里 finalAnswer 正常");

  // 用户补了一句新话（面板续跑时会把回答追加进消息），这轮模型却挂了
  state.messages.push({ role: "user", content: "换个思路" });
  const resumedAt = state.messages.length - 1;
  const phase2 = makeLoop({}, [new Error("网络断了")]);
  const state2 = await phase2.loop.resume(state, () => undefined);
  assert.equal(state2.status, "failed");
  assert.equal(
    state2.turnStart,
    resumedAt,
    "turnStart 必须重置到新一句的位置——否则失败后会把旧回答又显示一遍",
  );
  assert.equal(finalAnswer(state2), "", "失败的任务没有新回答，不许拿旧回答冒充");
});

// ── 5. 发送即落盘 ────────────────────────────────────────────────────────────

test("发送即落盘：用户消息先写进存档，再发模型请求", async () => {
  const USER_TEXT = "把这篇的标题改成新的";
  const app = new MockApp({});
  const provider = new ScriptedProvider([new Error("模型直接失败")]);
  const order: string[] = [];
  // 记录存档写入和模型调用的先后顺序
  const adapter = app.vault.adapter;
  const origWrite = adapter.write.bind(adapter);
  adapter.write = async (p: string, d: string) => {
    if (p.includes("/state/")) order.push(`save:${d.includes(USER_TEXT)}`);
    return origWrite(p, d);
  };
  const origChat = provider.chat.bind(provider);
  provider.chat = async (messages: unknown[]) => {
    order.push("model");
    return origChat(messages);
  };

  const loop = new AgentLoop({
    app: app as never,
    provider: provider as unknown as Provider,
    getConfig: () => ({
      baseUrl: "http://test", apiKey: "k", model: "m", temperature: 0,
      maxTokens: 1000, maxSteps: 6, confirmAfterFiles: 99,
    }),
    pluginDir: ".obsidian/plugins/local-vault-agent",
    log: LOG,
    confirm: async () => true,
    approvals: new ApprovalStore(),
  });

  const state = await loop.start(USER_TEXT, () => undefined);
  assert.equal(state.status, "failed");
  const firstSave = order.findIndex((s) => s.startsWith("save:"));
  assert.ok(firstSave >= 0, "至少有一次存档写入");
  assert.equal(order[firstSave], "save:true", "第一次存档里就必须有用户这句话");
  assert.ok(
    firstSave < order.indexOf("model"),
    `存档要先于模型调用（${JSON.stringify(order)}）`,
  );

  const saved = await loop.loadState(state.runId);
  assert.ok(saved, "失败任务的存档必须能读回来");
  assert.ok(
    saved.messages.some((m) => m.role === "user" && m.content === USER_TEXT),
    "存档里要有用户消息——任务中途被杀才恢复得出来",
  );
});

// ── 6. search 行号 ───────────────────────────────────────────────────────────

test("search：命中带真实行号（从 1 数起）", async () => {
  const app = new MockApp({
    "a.md": "# 标题\n\n第三行有关键词\n",
    "b.md": "关键词在第一行\n",
  });
  const r = await run(makeCtx(app), "search", { query: "关键词" });
  assert.equal(r.ok, true);
  const data = r.data as { count: number; hits: Array<{ path: string; line: number; preview: string }> };
  assert.equal(data.count, 2);
  const a = data.hits.find((h) => h.path === "a.md");
  const b = data.hits.find((h) => h.path === "b.md");
  assert.ok(a && b);
  assert.equal(a.line, 3, "a.md 里关键词在第三行");
  assert.equal(b.line, 1, "b.md 里关键词在第一行");
  assert.ok(a.preview.includes("关键词"), "预览要能看出上下文");
});

// ── 7. 结构化文件（.canvas/.base）JSON 校验 ──────────────────────────────────

test("create_note：.canvas 写坏 JSON 直接拒绝，合法 JSON 正常创建", async () => {
  const app = new MockApp({});
  const bad = await run(makeCtx(app), "create_note", { path: "画布.canvas", content: "{{{不是JSON" });
  assert.equal(bad.ok, false);
  assert.ok(String(bad.error).includes("画板"), `报错要说清是画板类文件：${bad.error}`);
  assert.ok(String(bad.error).includes(".canvas"));
  assert.equal(app.vault.rawContent("画布.canvas"), undefined, "坏文件不能真的写进去");

  const good = await run(makeCtx(app), "create_note", {
    path: "画布.canvas",
    content: '{"nodes":[],"edges":[]}',
  });
  assert.equal(good.ok, true, good.error);
  assert.equal(app.vault.rawContent("画布.canvas"), '{"nodes":[],"edges":[]}');
});

test("write_file：.canvas 写坏 JSON 拒绝；.base 同样受保护", async () => {
  const app = new MockApp({
    "画布.canvas": '{"nodes":[],"edges":[]}',
    "表格.base": '{"view":"table"}',
  });
  const badCanvas = await run(makeCtx(app), "write_file", { path: "画布.canvas", content: "broken" });
  assert.equal(badCanvas.ok, false);
  assert.ok(String(badCanvas.error).includes("画板"), badCanvas.error);
  assert.equal(app.vault.rawContent("画布.canvas"), '{"nodes":[],"edges":[]}', "原文件不许被写坏");

  const badBase = await run(makeCtx(app), "write_file", { path: "表格.base", content: "broken" });
  assert.equal(badBase.ok, false);
  assert.ok(String(badBase.error).includes(".base"), `.base 的报错要指明扩展名：${badBase.error}`);

  const good = await run(makeCtx(app), "write_file", {
    path: "画布.canvas",
    content: '{"nodes":[{"id":"n1"}],"edges":[]}',
  });
  assert.equal(good.ok, true, good.error);
  assert.ok(app.vault.rawContent("画布.canvas")?.includes('"id":"n1"'));
});

test("patch_file：补丁打完会产生坏 JSON 时拒绝，文件保持原样", async () => {
  const original = '{"nodes":[],"edges":[]}';
  const app = new MockApp({ "p.canvas": original });
  const ctx = makeCtx(app);
  // 补丁按整行替换（old 必须是完整行）；这一刀会把 JSON 打破
  const bad = await run(ctx, "patch_file", { path: "p.canvas", old: '{"nodes":[],"edges":[]}', new: '{"nodes":[],"edges":[}' });
  assert.equal(bad.ok, false);
  assert.ok(String(bad.error).includes("画板"), `补丁导致的坏 JSON 也要拦：${bad.error}`);
  assert.equal(app.vault.rawContent("p.canvas"), original, "拒绝后文件必须原样");

  const good = await run(ctx, "patch_file", {
    path: "p.canvas",
    old: '{"nodes":[],"edges":[]}',
    new: '{"nodes":[{"id":"n1"}],"edges":[]}',
  });
  assert.equal(good.ok, true, good.error);
  assert.ok(app.vault.rawContent("p.canvas")?.includes('"id":"n1"'), "合法补丁正常生效");
});

// ── 8. 修改记录归档 ──────────────────────────────────────────────────────────

function makeRunState(runId: string, title: string, path: string) {
  return {
    runId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "done" as const,
    step: 3,
    maxSteps: 10,
    messages: [{ role: "user" as const, content: title }],
    appliedOps: [{ tool: "patch_file", path, at: Date.now() }],
    usage: { promptTokens: 0, completionTokens: 0 },
  };
}

test("修改记录超阈值：旧内容进年度文件，主文件回到骨架；后续记录继续追加主文件", async () => {
  const year = new Date().getFullYear();
  const archive = `AI/03-修改记录-${year}.md`;
  const oldBody =
    "# AI 修改记录\n\n> 由 Local Vault Agent 自动追加。\n\n### 旧记录\nOLD-RECORD-MARKER\n" +
    "x".repeat(ARCHIVE_THRESHOLD_CHARS + 500) +
    "\n";
  const app = new MockApp({ "AI/03-修改记录.md": oldBody });

  // 第一次：超阈值 → 旧内容归档，主文件只留骨架 + 新记录
  const wrote = await appendRecord(app as never, makeRunState("run-wp5-a", "批量改十个文件", "a.md"), LOG);
  assert.equal(wrote, true);

  const main = app.vault.rawContent("AI/03-修改记录.md") ?? "";
  assert.ok(main.startsWith("# AI 修改记录"), "主文件要回到骨架");
  assert.ok(main.includes("run run-wp5-a"), "新记录在主文件里");
  assert.ok(main.length < 2000, `主文件不该再背着 40KB 旧内容：${main.length}`);
  assert.ok(!main.includes("OLD-RECORD-MARKER"), "旧内容要挪走");

  const archived = app.vault.rawContent(archive) ?? "";
  assert.ok(archived.includes("OLD-RECORD-MARKER"), "旧内容进了年度归档文件");
  assert.ok(archived.length > ARCHIVE_THRESHOLD_CHARS, "归档要完整，不是截断");

  // 第二次：主文件在阈值内 → 直接追加，不动归档
  const wrote2 = await appendRecord(app as never, makeRunState("run-wp5-b", "第二个任务", "b.md"), LOG);
  assert.equal(wrote2, true);
  const main2 = app.vault.rawContent("AI/03-修改记录.md") ?? "";
  assert.ok(main2.includes("run run-wp5-a") && main2.includes("run run-wp5-b"), "两条记录都在主文件");
  assert.ok(!(app.vault.rawContent(archive) ?? "").includes("run-wp5-b"), "归档文件不被二次追加");
});
