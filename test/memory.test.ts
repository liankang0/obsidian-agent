/**
 * 工作记忆：准则 Step 0（读）与 Step 4（回写）。
 * 这里最关键的不是"能读能写"，而是"读的位置对、写的位置对"——
 * 04/05 是用户手工维护的，插错地方会破坏他们的格式。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  buildChecklistBlock,
  buildMemoryBlock,
  parseChecklist,
  readChecklists,
  readMemory,
  recordMemory,
} from "../src/agent/memory";
import { MockApp } from "./mocks/obsidian";

const WORKING = [
  "---", "title: 临时工作记忆区", "---", "",
  "# 临时工作记忆区", "",
  "## 当前活跃任务", "",
  "### 最新任务 ✅", "**完成时间**: 2026-09-09", "**操作内容**: 做完了", "",
  "### 旧任务 ✅", "**完成时间**: 2026-05-14", "",
  "---", "",
  "## 待处理队列", "", "（暂无）", "",
].join("\n");

const HISTORY = [
  "# 对话历史记录区", "",
  "### 较早的一条", "**对话时间**: 2026-08-01", "", "**任务**: 旧事", "",
  "### 最近的一条", "**对话时间**: 2026-09-09", "", "**任务**: 新事", "",
  "---", "",
  "## 快速索引", "",
  "| 日期 | 主题 |", "| --- | --- |", "| 2026-09-09 | 新事 |", "",
].join("\n");

test("读 04 只拿「当前活跃任务」，不带走待处理队列", async () => {
  const app = new MockApp({ "AI/04-临时工作记忆区.md": WORKING });
  const mem = await readMemory(app as never);
  assert.ok(mem.working.includes("最新任务"));
  assert.ok(!mem.working.includes("待处理队列"), "待处理队列不该被注入，白花 token");
});

test("读 05 只拿最后一条，不带走快速索引表", async () => {
  const app = new MockApp({ "AI/05-对话历史记录区.md": HISTORY });
  const mem = await readMemory(app as never);
  assert.ok(mem.history.includes("最近的一条"));
  assert.ok(!mem.history.includes("较早的一条"), "只要最后一条");
  assert.ok(!mem.history.includes("快速索引"), "表格不该进 prompt");
});

test("文件不存在时返回空，不报错", async () => {
  const mem = await readMemory(new MockApp({}) as never);
  assert.equal(mem.working, "");
  assert.equal(mem.history, "");
});

test("超长的「当前活跃任务」不再整段注入（只取前几条、每条有上限）", async () => {
  const entry = (n: number) =>
    `### 任务${n} ✅\n**完成时间**: 2026-10-2${n} 10:00:00\n**操作内容**: ${"很长的正文".repeat(200)}\n`;
  const long = `## 当前活跃任务\n\n${[1, 2, 3, 4, 5].map(entry).join("\n")}`;
  const app = new MockApp({ "AI/04-临时工作记忆区.md": long });
  const mem = await readMemory(app as never);
  const block = buildMemoryBlock(mem);
  assert.ok(block.includes("任务1"), "最新一条要在");
  assert.ok(!block.includes("任务4"), "超过 3 条的旧记录不该再占 prompt");
  assert.ok(block.length < 1600, `记忆块太长：${block.length}`);
});

test("prompt 块标明「背景不是待办」，空的就不占位", () => {
  const working = "### 任务甲 ✅\n**完成时间**: 2026-10-21 10:00:00\n**操作内容**: 改了两篇\n";
  const block = buildMemoryBlock({ working, history: "对话乙" });
  assert.ok(block.includes("AI/04"));
  assert.ok(block.includes("AI/05"));
  assert.ok(block.includes("背景资料，不是待办"), "必须说清楚这不是待办");
  assert.ok(block.includes("继续"), "要告诉模型只有用户说「继续」才接着做");
  assert.ok(block.includes("任务甲"), "标题要进去");
  assert.equal(buildMemoryBlock({ working: "", history: "" }), "");
  assert.equal(buildMemoryBlock({ working: "没有 ### 记录的散文", history: "" }), "", "解析不出条目就当空");
});

test("回写 working 插在「当前活跃任务」标题下，新的在上", async () => {
  const app = new MockApp({ "AI/04-临时工作记忆区.md": WORKING });
  await recordMemory(app as never, { kind: "working", title: "新任务", content: "改了三个文件" });
  const text = await app.vault.adapter.read("AI/04-临时工作记忆区.md");
  const newIdx = text.indexOf("### 新任务");
  const oldIdx = text.indexOf("### 最新任务");
  assert.ok(newIdx > 0 && newIdx < oldIdx, "新记录应在最上面");
  assert.ok(text.includes("**完成时间**"));
  assert.ok(text.includes("改了三个文件"));
  assert.ok(text.includes("## 待处理队列"), "原有结构不能被破坏");
});

test("回写 history 插在「快速索引」之前", async () => {
  const app = new MockApp({ "AI/05-对话历史记录区.md": HISTORY });
  await recordMemory(app as never, { kind: "history", title: "本次对话", content: "整理了三篇笔记" });
  const text = await app.vault.adapter.read("AI/05-对话历史记录区.md");
  assert.ok(text.indexOf("### 本次对话") < text.indexOf("## 快速索引"), "新记录必须在索引表之前");
  assert.ok(text.includes("**对话时间**"));
  assert.ok(text.includes("**任务**: 整理了三篇笔记"));
});

test("记忆区被删掉时补骨架，而不是让 Step 4 永远失败", async () => {
  const app = new MockApp({});
  const path = await recordMemory(app as never, { kind: "working", title: "t", content: "c" });
  assert.equal(path, "AI/04-临时工作记忆区.md");
  const file = app.vault.getAbstractFileByPath(path);
  assert.ok(file, "文件应该被创建出来");
  const raw = await app.vault.cachedRead(file as never);
  assert.match(raw, /## 当前活跃任务/, "骨架里要有插入用的标题");
  assert.match(raw, /### t ✅/, "内容要真的写进去");
});

// ── 检查清单 ────────────────────────────────────────────────────────────────

const PRE = [
  "# ✅ 任务前检查清单", "",
  "## 开始任何任务前，必须逐项检查确认", "",
  "### 1. 🔐 授权确认",
  "- [ ] 用户是否明确授权执行此操作？",
  "- [ ] 操作范围是否在用户指令范围内？", "",
  "### 2. 📖 规范学习",
  "- [ ] 是否已阅读 `00-总指令.md`？", "",
  "## 🎯 不同任务类型的特殊检查", "",
  "### 删除任务",
  "- [ ] 用户是否明确要求删除？", "",
].join("\n");

const POST = [
  "# ✅ 任务后质量检查清单", "",
  "### 1. 📝 基础规范检查",
  "- [ ] 所有新文件是否有完整的 frontmatter？", "",
  "### 6. 📜 修改记录检查",
  "- [ ] 是否已在 `03-修改记录.md` 记录本次变更？", "",
].join("\n");

test("解析清单：去掉序号和 emoji，保留分组与条目", () => {
  const sections = parseChecklist(PRE, "## 🎯 不同任务类型的特殊检查");
  assert.equal(sections.length, 2);
  assert.equal(sections[0].title, "授权确认");
  assert.equal(sections[0].items.length, 2);
  assert.ok(sections[0].items[0].includes("明确授权"));
});

test("01 只取「开始前」那段，任务类型专属项不注入", () => {
  const sections = parseChecklist(PRE, "## 🎯 不同任务类型的特殊检查");
  const titles = sections.map((s) => s.title);
  assert.ok(!titles.includes("删除任务"), "任务类型专属清单会误导所有任务");
});

test("prompt 块：01 逐条、02 只给分组名", () => {
  const block = buildChecklistBlock({
    pre: parseChecklist(PRE, "## 🎯 不同任务类型的特殊检查"),
    post: parseChecklist(POST),
  });
  assert.ok(block.includes("Step 1"));
  assert.ok(block.includes("授权确认"));
  assert.ok(block.includes("用户是否明确授权"), "01 的条目要能看到");
  assert.ok(block.includes("修改记录检查"), "02 的分组名要有");
  assert.ok(block.includes("read_checklist"), "要告诉模型怎么取全文");
  assert.ok(!block.includes("所有新文件是否有完整的 frontmatter"), "02 细则不该全塞，省 token");
});

test("清单文件缺失时不产生空标题", async () => {
  const lists = await readChecklists(new MockApp({}) as never);
  assert.equal(lists.pre.length, 0);
  assert.equal(buildChecklistBlock(lists), "");
});

test("真实两份清单能读出条目数", async () => {
  const app = new MockApp({
    "AI/01-任务前检查清单.md": PRE,
    "AI/02-任务后质量检查清单.md": POST,
  });
  const lists = await readChecklists(app as never);
  assert.equal(lists.pre.reduce((n, s) => n + s.items.length, 0), 3);
  assert.equal(lists.post.length, 2);
});
