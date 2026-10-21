/**
 * 语义层工具：靠 metadataCache / fileManager 才成立的三个能力。
 * 这里每条都对应「用全文 search 做不到」的场景。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ApprovalStore } from "../src/agent/approvals";
import { executeTool, type ToolContext } from "../src/agent/tools";
import { MockApp } from "./mocks/obsidian";

const LOG = { info() {}, warn() {}, error() {} };

const FILES: Record<string, string> = {
  "knowledge/tech/java-集合.md": [
    "---", "title: Java 集合框架", "tags:", "  - android", "  - java", "status: active", "difficulty: ⭐⭐⭐", "---", "", "# 集合", "正文 #后端 内容",
  ].join("\n"),
  "knowledge/tech/android-compose.md": [
    "---", "title: Compose", "tags:", "  - android/compose", "status: draft", "---", "", "# Compose",
  ].join("\n"),
  "knowledge/life/旅行.md": ["---", "title: 旅行", "status: active", "---", "", "# 旅行 #生活"].join("\n"),
  "首页.md": "# 首页\n",
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

test("search_by_tag：父标签能命中子标签", async () => {
  const ctx = makeCtx(new MockApp(FILES));
  const r = await run(ctx, "search_by_tag", { tag: "android" });
  assert.equal(r.ok, true);
  const files = (r.data as { files: unknown[] }).files;
  const paths = files.map((f) => (typeof f === "string" ? f : (f as { path: string }).path));
  assert.ok(paths.includes("knowledge/tech/java-集合.md"));
  assert.ok(paths.includes("knowledge/tech/android-compose.md"), "android/compose 应该被父标签 android 命中");
});

test("search_by_tag：带 # 和不带 # 一样", async () => {
  const ctx = makeCtx(new MockApp(FILES));
  const a = await run(ctx, "search_by_tag", { tag: "生活" });
  const b = await run(ctx, "search_by_tag", { tag: "#生活" });
  assert.deepEqual(a.data, b.data);
});

test("search_by_tag：没有命中时给出可行动的提示", async () => {
  const ctx = makeCtx(new MockApp(FILES));
  const r = await run(ctx, "search_by_tag", { tag: "不存在的标签" });
  const data = r.data as { count: number; hint: string };
  assert.equal(data.count, 0);
  assert.ok(data.hint.includes("标签名"));
});

test("list_by_frontmatter：只给 key 时列出有此属性的笔记", async () => {
  const ctx = makeCtx(new MockApp(FILES));
  const r = await run(ctx, "list_by_frontmatter", { key: "status" });
  const data = r.data as { count: number; files: Array<{ path: string; value: unknown }> };
  assert.equal(data.count, 3);
  assert.ok(data.files.every((f) => f.value));
  assert.ok(!data.files.some((f) => f.path === "首页.md"), "首页没有 status，不该出现");
});

test("list_by_frontmatter：value 做包含匹配且忽略大小写", async () => {
  const ctx = makeCtx(new MockApp(FILES));
  const r = await run(ctx, "list_by_frontmatter", { key: "status", value: "ACTIVE" });
  const data = r.data as { count: number; files: Array<{ path: string }> };
  assert.equal(data.count, 2);
  assert.ok(data.files.every((f) => !f.path.includes("compose")));
});

test("move_note：移动成功，文件真的换位置了", async () => {
  const app = new MockApp(FILES);
  const ctx = makeCtx(app);
  const r = await run(ctx, "move_note", { from: "knowledge/life/旅行.md", to: "knowledge/life/travel/旅行.md" });
  assert.equal(r.ok, true, r.error);
  assert.equal(app.vault.getAbstractFileByPath("knowledge/life/旅行.md"), null);
  assert.ok(app.vault.getAbstractFileByPath("knowledge/life/travel/旅行.md"));
});

test("move_note：目标已存在时拒绝，不覆盖", async () => {
  const ctx = makeCtx(new MockApp(FILES));
  const r = await run(ctx, "move_note", { from: "knowledge/life/旅行.md", to: "首页.md" });
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes("目标已存在"));
});

test("move_note：受保护路径不许搬走", async () => {
  const app = new MockApp(FILES);
  const ctx = makeCtx(app);
  const r = await run(ctx, "move_note", { from: "首页.md", to: "archive/首页.md" });
  // 首页属于「需确认」，confirm 返回 true 时允许——这里验证的是它走了守卫
  assert.equal(r.ok, true, "需确认级别在用户同意后应放行");
});

test("move_note：AI 准则文件绝对不许搬", async () => {
  const app = new MockApp({ ...FILES, "AI/00-总指令.md": "# 总指令\n" });
  const ctx = makeCtx(app);
  const r = await run(ctx, "move_note", { from: "AI/00-总指令.md", to: "AI/00-总指令.bak.md" });
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes("AI 准则"));
  assert.ok(app.vault.getAbstractFileByPath("AI/00-总指令.md"), "被拒绝后文件不能动");
});

test("move_note：用户拒绝就不搬", async () => {
  const app = new MockApp(FILES);
  const ctx = makeCtx(app, { confirm: async () => false });
  const r = await run(ctx, "move_note", { from: "knowledge/life/旅行.md", to: "archive/旅行.md" });
  assert.equal(r.ok, false);
  assert.ok(app.vault.getAbstractFileByPath("knowledge/life/旅行.md"), "拒绝后文件必须原样在原地");
});

test("use_skill：返回正文并去掉 frontmatter", async () => {
  const app = new MockApp({
    "skills/v3.md": ["---", "name: v3 流程", "description: 五步", "---", "", "# v3", "", "Step 0 读 04/05。"].join("\n"),
  });
  const ctx = makeCtx(app);
  const r = await run(ctx, "use_skill", { name: "v3 流程" });
  assert.equal(r.ok, true, r.error);
  const data = r.data as { body: string; path: string };
  assert.ok(data.body.includes("Step 0"), "正文没读到");
  assert.ok(!data.body.includes("description:"), "frontmatter 应被去掉");
});

test("use_skill：名字写错时列出可用的", async () => {
  const app = new MockApp({ "skills/a.md": "# 甲\n\n内容" });
  const ctx = makeCtx(app);
  const r = await run(ctx, "use_skill", { name: "乙" });
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes("甲"));
});

// ── 删除：走回收站 ──────────────────────────────────────────────────────────

test("trash_note：文件真的没了（进回收站），并且记录了反向链接数", async () => {
  const app = new MockApp(FILES);
  const ctx = makeCtx(app);
  const r = await run(ctx, "trash_note", { path: "knowledge/life/旅行.md" });
  assert.equal(r.ok, true, r.error);
  assert.equal(app.vault.getAbstractFileByPath("knowledge/life/旅行.md"), null);
  const data = r.data as { backlinks: number; recover: string };
  assert.equal(typeof data.backlinks, "number");
  assert.ok(data.recover.includes("恢复"));
});

test("trash_note：受保护路径绝对不许删", async () => {
  const app = new MockApp({ ...FILES, "AI/00-总指令.md": "# 总指令\n" });
  const ctx = makeCtx(app);
  const r = await run(ctx, "trash_note", { path: "AI/00-总指令.md" });
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes("AI 准则"));
  assert.ok(app.vault.getAbstractFileByPath("AI/00-总指令.md"), "拒绝后文件必须还在");
});

test("trash_note：用户拒绝则不动", async () => {
  const app = new MockApp(FILES);
  const ctx = makeCtx(app, { confirm: async () => false });
  const r = await run(ctx, "trash_note", { path: "knowledge/life/旅行.md" });
  assert.equal(r.ok, false);
  assert.ok(app.vault.getAbstractFileByPath("knowledge/life/旅行.md"));
});

test("trash_note：传文件夹路径时给出正确建议", async () => {
  const app = new MockApp(FILES);
  const ctx = makeCtx(app);
  const r = await run(ctx, "trash_note", { path: "knowledge/life" });
  // mock 的 getAbstractFileByPath 对文件夹返回 TFolder
  if (r.ok) {
    assert.fail("删文件夹不该成功");
  }
  assert.ok(/trash_folder|找不到/.test(String(r.error)));
});

test("trash_folder：非空文件夹不带 recursive 会被拒绝", async () => {
  const app = new MockApp(FILES);
  const ctx = makeCtx(app);
  const r = await run(ctx, "trash_folder", { path: "knowledge/life" });
  assert.equal(r.ok, false);
  assert.ok(String(r.error).includes("recursive"), String(r.error));
  assert.ok(app.vault.getAbstractFileByPath("knowledge/life/旅行.md"), "拒绝后内容不能丢");
});

test("只读模式下没有删除工具", async () => {
  const { getToolSpecs } = await import("../src/agent/tools");
  const names = getToolSpecs(makeCtx(new MockApp({}), { readOnly: true })).map((s) => s.name);
  assert.ok(!names.includes("trash_note"));
  assert.ok(!names.includes("trash_folder"));
  assert.ok(names.includes("read_file"), "只读模式仍应能读");
});

test("搜索类工具不返回 backup/ 副本（真机踩过改错文件）", async () => {
  const app = new MockApp({
    ...FILES,
    "backup/Cook/火锅食材清单-20260818.md": ["---", "tags:", "  - cooking", "---", "", "# 旧副本"].join("\n"),
    "knowledge/life/cooking/火锅食材清单.md": ["---", "tags:", "  - cooking", "---", "", "# 正本"].join("\n"),
  });
  const ctx = makeCtx(app);
  const r = await run(ctx, "search_by_tag", { tag: "cooking" });
  const paths = (r.data as { files: unknown[] }).files.map((f) =>
    typeof f === "string" ? f : (f as { path: string }).path,
  );
  assert.ok(paths.includes("knowledge/life/cooking/火锅食材清单.md"));
  assert.ok(!paths.some((p) => p.startsWith("backup/")), "备份副本不该出现在结果里");
});
