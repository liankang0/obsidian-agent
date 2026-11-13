/**
 * Doc2-WP3 可移植性解耦：
 * 空 vault 安装后绝不凭空创建 AI/ 目录、不注入空记忆块、不产生日志噪音；
 * 指定/自定义目录时所有路径跟着布局走；守卫与 skill 目录按设置派生。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveLayout, type WorkspaceSettings } from "../src/agent/workspace";
import { checkProtected, parseProtectedPaths } from "../src/agent/guard";
import { scanSkills } from "../src/agent/skills";
import { appendRecord } from "../src/agent/changelog";
import { buildMemoryBlock, readMemory } from "../src/agent/memory";
import { AgentLoop } from "../src/agent/loop";
import { executeTool, type ToolContext } from "../src/agent/tools";
import { ApprovalStore } from "../src/agent/approvals";
import { MockApp } from "./mocks/obsidian";
import type { Completion } from "../src/agent/provider";

const LOG = { info() {}, warn() {}, error() {} };

const noOpts = (): WorkspaceSettings => ({ aiDir: "", skillDirs: "", protectedPaths: "" });

const SKELETON = "# 04 · 临时工作记忆区\n\n## 当前活跃任务\n\n";

function makeLoop(app: MockApp, script: Completion[], warns: string[], opts?: WorkspaceSettings) {
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
    ...(opts ? { getLayoutOpts: () => opts } : {}),
  });
}

function makeCtx(app: MockApp, layout?: ToolContext["layout"], protectedPaths?: string[]) {
  const confirmCalls: Array<{ tool: string; path?: string }> = [];
  const ctx: ToolContext = {
    app: app as never,
    log: LOG,
    confirm: async (req) => {
      confirmCalls.push(req);
      return false; // 测试守卫时默认拒绝
    },
    changedFiles: new Set<string>(),
    confirmAfterFiles: 99,
    readOnly: false,
    runId: "wp3-test",
    approvals: new ApprovalStore(),
    ...(layout ? { layout } : {}),
    ...(protectedPaths ? { protectedPaths } : {}),
  };
  return { ctx, confirmCalls };
}

const call = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, args });

const step = (id: string, name: string, args: Record<string, unknown>): Completion => ({
  content: "",
  toolCalls: [{ id, name, args }],
});

function runState(appliedPaths: string[]) {
  return {
    runId: "wp3-run-1",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    status: "done",
    step: 2,
    messages: [{ role: "user", content: "改个文件" }],
    appliedOps: appliedPaths.map((p) => ({
      tool: "patch_file",
      path: p,
      at: Date.now(),
      op: "patch",
      detail: "改了一行",
    })),
    usage: { promptTokens: 0, completionTokens: 0 },
  } as never;
}

// ── ① 布局解析 ────────────────────────────────────────────────────────────

test("resolveLayout：库里有 AI/ 才自动启用；空 vault 与幽灵目录都不启用", () => {
  const bare = new MockApp({});
  const auto = resolveLayout(bare, noOpts());
  assert.equal(auto.aiEnabled, false, "空 vault 不该启用");
  assert.equal(auto.changelogPath, "", "未启用时路径必须为空，不能还挂着 AI/03");

  const ghost = resolveLayout(bare, { ...noOpts(), aiDir: "幽灵目录" });
  assert.equal(ghost.aiEnabled, false, "指定的目录不存在就不能启用");

  const withAi = new MockApp({ "AI/04-临时工作记忆区.md": SKELETON });
  const detected = resolveLayout(withAi, noOpts());
  assert.equal(detected.aiEnabled, true, "库里有 AI/ 应自动启用（老用户零配置）");
  assert.equal(detected.changelogPath, "AI/03-修改记录.md");
  assert.equal(detected.workingPath, "AI/04-临时工作记忆区.md");
  assert.deepEqual(detected.skillDirs, ["skills/", "AI/skills/"]);
});

test("resolveLayout：显式目录存在时全路径挂过去，skill 目录跟着走", () => {
  const app = new MockApp({ "笔记/AI/04-临时工作记忆区.md": SKELETON });
  const l = resolveLayout(app, { aiDir: "笔记/AI", skillDirs: "自定义skills", protectedPaths: "" });
  assert.equal(l.aiEnabled, true);
  assert.equal(l.aiDir, "笔记/AI");
  assert.equal(l.changelogPath, "笔记/AI/03-修改记录.md");
  assert.equal(l.historyPath, "笔记/AI/05-对话历史记录区.md");
  assert.equal(l.preChecklistPath, "笔记/AI/01-任务前检查清单.md");
  assert.deepEqual(l.skillDirs, ["skills/", "笔记/AI/skills/", "自定义skills/"]);
});

// ── ② 空 vault：不写、不提醒、无噪音 ──────────────────────────────────────

test("空 vault：loop 不创建 AI 目录、不提醒 Step 4、prompt 去掉原则 9、日志无报错", async () => {
  const warns: string[] = [];
  const app = new MockApp({ "a.md": "旧内容\n" });
  const script: Completion[] = [
    step("c1", "patch_file", { path: "a.md", old: "旧内容", new: "新内容" }),
    { content: "改好了", toolCalls: [] },
  ];
  const loop = makeLoop(app, script, warns);
  const state = await loop.start("改 a.md", () => undefined);

  assert.equal(state.status, "done");
  assert.ok(!app.vault.getAbstractFileByPath("AI"), "空 vault 不该长出 AI/ 目录");
  assert.equal(warns.filter((w) => w.includes("准则 Step 4")).length, 0, "没有 04/05 就不该提醒 Step 4");
  const joined = warns.join("\n");
  assert.ok(!joined.includes("找不到"), `不该有「找不到」类报错：${joined}`);
  assert.ok(!joined.includes("写修改记录失败"), `不该有写记录失败噪音：${joined}`);

  const sys = String((state.messages[0] as { content: string }).content);
  assert.ok(!sys.includes("不要自己改"), "工作区未启用时 prompt 不该留着「不要自己改 03」的原则 9");
});

test("空 vault：record_memory 返回 written:false 说明，且不建任何目录", async () => {
  const app = new MockApp({});
  const layout = resolveLayout(app, noOpts());
  const { ctx } = makeCtx(app, layout);

  const res = await executeTool(call("m1", "record_memory", { title: "任务", content: "内容" }), ctx);
  assert.equal(res.ok, true, "未启用不该算错误，只是跳过");
  const data = res.data as { written: boolean; note?: string };
  assert.equal(data.written, false, "必须明确告知没写");
  assert.ok((data.note ?? "").includes("未启用"), `说明里要点明原因：${data.note}`);
  assert.ok(!app.vault.getAbstractFileByPath("AI"), "record_memory 不许凭空建 AI/ 目录");
});

test("有 AI 目录：loop 正常记 03，prompt 保留原则 9", async () => {
  const warns: string[] = [];
  const app = new MockApp({
    "a.md": "旧内容\n",
    "AI/04-临时工作记忆区.md": SKELETON,
  });
  const script: Completion[] = [
    step("c1", "patch_file", { path: "a.md", old: "旧内容", new: "新内容" }),
    { content: "改好了", toolCalls: [] },
  ];
  const loop = makeLoop(app, script, warns);
  const state = await loop.start("改 a.md", () => undefined);

  assert.equal(state.status, "done");
  const log = app.vault.rawContent("AI/03-修改记录.md") ?? "";
  assert.ok(log.includes("run "), "有工作区时修改记录照旧自动写入");
  assert.equal(warns.filter((w) => w.includes("准则 Step 4")).length, 1, "没记记忆该提醒一次");
  const sys = String((state.messages[0] as { content: string }).content);
  assert.ok(sys.includes("不要自己改 `AI/03-修改记录.md`"), "原则 9 应按实际路径回来");
});

// ── ③ 自定义目录：一切跟着布局走 ──────────────────────────────────────────

test("自定义 aiDir：loop 的修改记录与 record_memory 都进新目录，AI/ 不再生", async () => {
  const warns: string[] = [];
  const app = new MockApp({
    "笔记/正文.md": "旧内容\n",
    "笔记/AI/04-临时工作记忆区.md": SKELETON,
  });
  const opts: WorkspaceSettings = { aiDir: "笔记/AI", skillDirs: "", protectedPaths: "" };
  const script: Completion[] = [
    step("c1", "patch_file", { path: "笔记/正文.md", old: "旧内容", new: "新内容" }),
    step("c2", "record_memory", { kind: "working", title: "改了正文", content: "换成新内容" }),
    { content: "都完成了", toolCalls: [] },
  ];
  const loop = makeLoop(app, script, warns, opts);
  const state = await loop.start("改正文", () => undefined);

  assert.equal(state.status, "done");
  const rec = app.vault.rawContent("笔记/AI/03-修改记录.md") ?? "";
  assert.ok(rec.includes("run "), "修改记录应写进自定义目录");
  assert.ok(!app.vault.getAbstractFileByPath("AI"), "不该退回默认 AI/ 目录");
  const working = app.vault.rawContent("笔记/AI/04-临时工作记忆区.md") ?? "";
  assert.ok(working.includes("改了正文"), "record_memory 应写进自定义 04");
});

test("指定目录不存在：loop 不启用、日志点名目录、不建任何东西", async () => {
  const warns: string[] = [];
  const app = new MockApp({ "a.md": "旧内容\n" });
  const opts: WorkspaceSettings = { aiDir: "幽灵目录", skillDirs: "", protectedPaths: "" };
  const script: Completion[] = [
    step("c1", "patch_file", { path: "a.md", old: "旧内容", new: "新内容" }),
    { content: "改好了", toolCalls: [] },
  ];
  const loop = makeLoop(app, script, warns, opts);
  const state = await loop.start("改 a.md", () => undefined);

  assert.equal(state.status, "done");
  assert.ok(!app.vault.getAbstractFileByPath("幽灵目录"), "配置错误也不许替用户建目录");
  assert.ok(!app.vault.getAbstractFileByPath("AI"));
  const joined = warns.join("\n");
  assert.ok(joined.includes("幽灵目录") && joined.includes("不存在"), `配置错误必须说出口：${joined}`);
  assert.equal(warns.filter((w) => w.includes("准则 Step 4")).length, 0);
});

// ── ④ 守卫按布局派生 ──────────────────────────────────────────────────────

test("守卫：00-06 禁写规则跟着 aiDir 派生，旧默认仍保护 AI/", () => {
  assert.equal(checkProtected("笔记/AI/00-总指令.md", { aiDir: "笔记/AI" })?.level, "deny");
  assert.equal(checkProtected("笔记/AI/03-修改记录.md", { aiDir: "笔记/AI" })?.level, "deny");
  assert.equal(checkProtected("AI/00-总指令.md", { aiDir: "笔记/AI" }), null, "自定义目录时旧 AI/ 不再套用这组规则");
  assert.equal(checkProtected("AI/00-总指令.md")?.level, "deny", "不传 aiDir 保持旧默认");
  assert.equal(checkProtected("skills/x.md")?.level, "deny", "根级 skills/ 永远禁写");
  assert.equal(checkProtected("笔记/AI/skills/x.md", { aiDir: "笔记/AI" })?.level, "deny", "工作区 skills/ 也禁写");
});

test("守卫：设置里的额外保护路径（文件与目录前缀）", () => {
  assert.equal(checkProtected("索引.md", { extraConsent: ["索引.md"] })?.level, "confirm");
  assert.equal(checkProtected("归档/a.md", { extraConsent: ["归档/"] })?.level, "confirm");
  assert.equal(checkProtected("普通.md", { extraConsent: ["索引.md", "归档/"] }), null);
  assert.deepEqual(parseProtectedPaths("索引.md， 归档/ , ,"), ["索引.md", "归档/"]);
});

test("loop：额外保护路径拦在写之前（用户拒绝则文件不动）", async () => {
  const warns: string[] = [];
  const app = new MockApp({ "保护.md": "原样内容\n" });
  const confirmCalls: Array<{ path?: string }> = [];
  const opts: WorkspaceSettings = { aiDir: "", skillDirs: "", protectedPaths: "保护.md" };
  const script: Completion[] = [
    step("c1", "patch_file", { path: "保护.md", old: "原样内容", new: "被改了" }),
    { content: "好的", toolCalls: [] },
  ];
  class P {
    i = 0;
    async chat(): Promise<Completion> {
      return script[this.i++] ?? { content: "完", toolCalls: [] };
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
      confirmAfterFiles: 99,
    }),
    pluginDir: "/tmp",
    log: { info() {}, warn: (m: string) => warns.push(m), error() {} },
    confirm: async (req) => {
      confirmCalls.push(req);
      return false; // 用户拒绝
    },
    approvals: { isApproved: () => false, isAllowed: () => true, approve: () => undefined } as never,
    getLayoutOpts: () => opts,
  });
  await loop.start("改保护文件", () => undefined);

  assert.equal(confirmCalls.length, 1, "受保护路径必须先弹确认");
  assert.equal(confirmCalls[0]?.path, "保护.md");
  assert.equal(app.vault.rawContent("保护.md"), "原样内容\n", "拒绝后文件必须原样");
});

// ── ⑤ skill 目录按设置扫描 ────────────────────────────────────────────────

test("skillDirs：自定义目录被扫描，默认名单扫不到", async () => {
  const app = new MockApp({
    "自定义skills/demo/SKILL.md": "---\nname: demo\ndescription: 演示用\n---\n正文",
  });
  const def = await scanSkills(app as never);
  assert.equal(def.skills.length, 0, "默认名单不该扫到自定义目录");

  const custom = await scanSkills(app as never, ["自定义skills/"]);
  assert.equal(custom.skills.length, 1);
  assert.equal(custom.skills[0]?.name, "demo");
});

test("loop：skillDirs 设置进布局并注入 system prompt", async () => {
  const warns: string[] = [];
  const app = new MockApp({
    "自定义skills/demo/SKILL.md": "---\nname: demo\ndescription: 演示用\n---\n正文",
  });
  const opts: WorkspaceSettings = { aiDir: "", skillDirs: "自定义skills", protectedPaths: "" };
  const loop = makeLoop(app, [{ content: "好", toolCalls: [] }], warns, opts);
  const state = await loop.start("你好", () => undefined);
  const sys = String((state.messages[0] as { content: string }).content);
  assert.ok(sys.includes("demo"), "自定义 skill 应进 prompt 索引");
});

// ── ⑥ 记账函数接受自定义路径 ──────────────────────────────────────────────

test("appendRecord：自定义路径写进指定文件，缺省仍是 AI/03", async () => {
  const app = new MockApp({ "笔记/a.md": "x" });
  const wrote = await appendRecord(app as never, runState(["笔记/a.md"]), LOG, {
    changelogPath: "笔记/AI/03-修改记录.md",
  });
  assert.equal(wrote, true);
  assert.ok(app.vault.rawContent("笔记/AI/03-修改记录.md")?.includes("run wp3-run-1"));
  assert.ok(!app.vault.getAbstractFileByPath("AI"), "自定义路径不该顺带创建默认 AI/ 目录");

  const wrote2 = await appendRecord(app as never, runState(["笔记/a.md"]), LOG);
  assert.equal(wrote2, true, "缺省参数保持旧行为");
  assert.ok(app.vault.rawContent("AI/03-修改记录.md")?.includes("run wp3-run-1"));
});

test("readMemory：按自定义路径读，记忆块标注实际来源", async () => {
  const app = new MockApp({
    "记忆/AI/04-临时工作记忆区.md": [
      "# 04",
      "",
      "## 当前活跃任务",
      "",
      "### 整理菜谱 ✅",
      "**完成时间**: 2026-11-01 10:00:00",
      "**操作内容**: 把 cooking 统一了格式",
      "",
    ].join("\n"),
  });
  const mem = await readMemory(app as never, {
    working: "记忆/AI/04-临时工作记忆区.md",
    history: "记忆/AI/05-对话历史记录区.md",
  });
  const block = buildMemoryBlock(mem);
  assert.ok(block.includes("整理菜谱"), "活跃任务没读出来");
  assert.ok(block.includes("记忆/AI/04-临时工作记忆区.md"), "prompt 应标注实际路径，不能写死 AI/04");
});
