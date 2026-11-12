/**
 * WP3 撤销本轮。
 *
 * 完成定义（doc）：一次改成 10 篇后点撤销，10 篇内容逐字节还原；
 * 中途外部改过的文件被跳过并逐条提示，不产生半撤销状态。
 * 取舍：只做内容级还原（patch/write/create），移动/删除仍由回收站负责。
 *
 * 测试全部走真实 loop（工具成功 → 撤销数据随 appliedOps 落盘）+ undoRun，
 * 不 mock 撤销本身——这样「采集」和「回放」两端任何一端断了测试都会红。
 */

import assert from "node:assert/strict";
import test from "node:test";

import { AgentLoop } from "../src/agent/loop";
import { ApprovalStore } from "../src/agent/approvals";
import { undoRun, reverseReplay, UNDO_TEXT_CAP } from "../src/agent/undo";
import type { Completion, Provider, RunState } from "../src/agent/types";
import { MockApp } from "./mocks/obsidian";

const LOG = { info() {}, warn() {}, error() {} };

class ScriptedProvider {
  constructor(private readonly script: Array<Completion | Error>) {}
  async chat(): Promise<Completion> {
    const next = this.script.shift();
    if (next instanceof Error) throw next;
    return next ?? { content: "完成。", toolCalls: [] };
  }
}

/** 跑一轮真实 loop，返回 run 结束后的 state */
async function driveRun(
  files: Record<string, string>,
  script: Completion[],
): Promise<{ app: MockApp; loop: AgentLoop; state: RunState }> {
  const app = new MockApp(files);
  const loop = new AgentLoop({
    app: app as never,
    provider: new ScriptedProvider(script) as unknown as Provider,
    getConfig: () => ({
      baseUrl: "http://test",
      apiKey: "k",
      model: "m",
      temperature: 0,
      maxTokens: 1000,
      maxSteps: 30,
      confirmAfterFiles: 99,
      requestTimeoutMs: 5000,
    }),
    pluginDir: ".obsidian/plugins/local-vault-agent",
    log: LOG,
    confirm: async () => true,
    approvals: new ApprovalStore(),
  });
  const state = await loop.start("测试任务：批量改动", () => undefined, []);
  return { app, loop, state };
}

const tc = (id: string, name: string, args: Record<string, unknown>): Completion => ({
  content: "",
  toolCalls: [{ id, name, args }],
});

// ── 完成定义：改成 10 篇后点撤销，10 篇逐字节还原 ────────────────────────────

test("撤销：改成 10 篇后一键还原，内容逐字节一致", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 10; i++) files[`笔记/第${i}篇.md`] = `# 第${i}篇\n\n原始段落 ${i}。\n`;
  const script: Completion[] = [];
  for (let i = 0; i < 10; i++) {
    script.push(tc(`c${i}`, "patch_file", { path: `笔记/第${i}篇.md`, old: `原始段落 ${i}。`, new: `统一改写 ${i}。` }));
  }

  const { app, state } = await driveRun(files, script);
  for (let i = 0; i < 10; i++) {
    assert.equal(app.vault.rawContent(`笔记/第${i}篇.md`), `# 第${i}篇\n\n统一改写 ${i}。\n`);
  }

  const report = await undoRun(app as never, state, LOG);
  assert.equal(report.skipped.length, 0, `不该有跳过：${JSON.stringify(report.skipped)}`);
  assert.equal(report.reverted.length, 10);
  for (let i = 0; i < 10; i++) {
    assert.equal(
      app.vault.rawContent(`笔记/第${i}篇.md`),
      `# 第${i}篇\n\n原始段落 ${i}。\n`,
      `第 ${i} 篇必须逐字节还原`,
    );
  }
  // 还原过的操作不再可撤：重启后再点也不会撤第二遍
  assert.ok(state.appliedOps.every((o) => o.undone && o.undo === undefined));
});

// ── 中途外部改过的文件：跳过 + 逐条提示，其余照常还原 ────────────────────────

test("撤销：被外部改过的文件跳过并说明，其余文件正常还原，无半撤销", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 5; i++) files[`笔记/文${i}.md`] = `正文 ${i}。`;
  const script = Array.from({ length: 5 }, (_, i) =>
    tc(`p${i}`, "patch_file", { path: `笔记/文${i}.md`, old: `正文 ${i}。`, new: `改后 ${i}。` }),
  );
  const { app, state } = await driveRun(files, script);

  // 外部改动一：把改后的文本整段挪走了（patch 的 new 找不到了）
  await (app.vault.adapter as { write(p: string, c: string): Promise<void> }).write(
    "笔记/文1.md",
    "用户自己重写过这一篇。",
  );
  // 外部改动二：复制了一份改后文本（new 出现两次，无法唯一定位）
  await (app.vault.adapter as { write(p: string, c: string): Promise<void> }).write(
    "笔记/文3.md",
    "改后 3。\n\n改后 3。\n",
  );

  const report = await undoRun(app as never, state, LOG);
  assert.deepEqual(
    report.skipped.map((s) => s.path),
    ["笔记/文3.md", "笔记/文1.md"],
    `跳过的两个文件必须逐条出现：${JSON.stringify(report.skipped)}`,
  );
  assert.ok(report.skipped[1].note.includes("被外部修改"), `文1 的原因要提外部修改：${report.skipped[1].note}`);
  assert.ok(report.skipped[0].note.includes("多处"), `文3 的原因要提多处：${report.skipped[0].note}`);
  assert.equal(report.reverted.length, 3);
  // 还原的 3 篇逐字节回去
  for (const i of [0, 2, 4]) assert.equal(app.vault.rawContent(`笔记/文${i}.md`), `正文 ${i}。`);
  // 跳过的 2 篇原样不动（半撤销 = 文件里一部分被还原一部分没还原，绝不允许）
  assert.equal(app.vault.rawContent("笔记/文1.md"), "用户自己重写过这一篇。");
  assert.equal(app.vault.rawContent("笔记/文3.md"), "改后 3。\n\n改后 3。\n");
});

// ── 同一文件多次 patch：逆序回放 ────────────────────────────────────────────

test("撤销：同一文件连续多次 patch，按逆序回放还原到底", async () => {
  const original = "# 标题\n\n第一段。\n第二段。\n第三段。\n";
  const script = [
    tc("a", "patch_file", { path: "笔记/文章.md", old: "第一段。", new: "第一段改写。" }),
    tc("b", "patch_file", { path: "笔记/文章.md", old: "第一段改写。", new: "第一段再改。" }),
    tc("c", "patch_file", { path: "笔记/文章.md", old: "第三段。", new: "第三段改写。" }),
  ];
  const { app, state } = await driveRun({ "笔记/文章.md": original }, script);
  const report = await undoRun(app as never, state, LOG);
  assert.equal(report.reverted.length, 1);
  assert.equal(report.skipped.length, 0, JSON.stringify(report.skipped));
  assert.equal(app.vault.rawContent("笔记/文章.md"), original);
});

// ── create_note 的撤销：移入回收站 ──────────────────────────────────────────

test("撤销：本轮新建的笔记撤销后进回收站（可找回，不硬删）", async () => {
  const { app, state } = await driveRun({}, [tc("n", "create_note", { path: "笔记/新建.md", content: "新笔记正文。" })]);
  assert.equal(app.vault.rawContent("笔记/新建.md"), "新笔记正文。");
  const report = await undoRun(app as never, state, LOG);
  assert.equal(report.reverted.length, 1);
  assert.equal(app.vault.getAbstractFileByPath("笔记/新建.md"), null, "新建的笔记撤销后应从库中消失");
});

test("撤销：新建后又 patch 过的笔记，还原到新建内容后整体进回收站", async () => {
  const created = "新笔记正文。\n";
  const script = [
    tc("n", "create_note", { path: "笔记/链式.md", content: created }),
    tc("p", "patch_file", { path: "笔记/链式.md", old: "新笔记正文。", new: "补一句。" }),
  ];
  const { app, state } = await driveRun({}, script);
  assert.equal(app.vault.rawContent("笔记/链式.md"), "补一句。\n");
  const report = await undoRun(app as never, state, LOG);
  assert.deepEqual(report.skipped, [], JSON.stringify(report.skipped));
  assert.equal(app.vault.getAbstractFileByPath("笔记/链式.md"), null, "链式撤销的终点是回收站");
});

// ── write_file 的撤销：整篇还原 / 外部改过则跳过 ────────────────────────────

test("撤销：write_file 整篇覆盖后能还原改前全文", async () => {
  const before = "# 原稿\n\n第一版内容，很长。\n";
  const { app, state } = await driveRun(
    { "笔记/稿子.md": before },
    [tc("w", "write_file", { path: "笔记/稿子.md", content: "# 重写\n\n全新的内容。\n" })],
  );
  assert.equal(app.vault.rawContent("笔记/稿子.md"), "# 重写\n\n全新的内容。\n");
  const report = await undoRun(app as never, state, LOG);
  assert.deepEqual(report.skipped, [], JSON.stringify(report.skipped));
  assert.equal(app.vault.rawContent("笔记/稿子.md"), before);
});

test("撤销：write_file 覆盖后又被外部改过 → 跳过并说明", async () => {
  const { app, state } = await driveRun(
    { "笔记/稿子.md": "原稿。" },
    [tc("w", "write_file", { path: "笔记/稿子.md", content: "覆盖稿。" })],
  );
  await (app.vault.adapter as { write(p: string, c: string): Promise<void> }).write("笔记/稿子.md", "用户手改版。");
  const report = await undoRun(app as never, state, LOG);
  assert.equal(report.reverted.length, 0);
  assert.equal(report.skipped.length, 1);
  assert.ok(report.skipped[0].note.includes("被外部修改"), report.skipped[0].note);
  assert.equal(app.vault.rawContent("笔记/稿子.md"), "用户手改版。");
});

// ── create_note 覆盖已有文件：undo 走 write 分支还原原文 ────────────────────

test("撤销：create_note overwrite=true 覆盖后还原被覆盖的原文", async () => {
  const original = "这是用户的原稿，一个字都不能丢。\n";
  const { app, state } = await driveRun(
    { "笔记/旧文.md": original },
    [tc("o", "create_note", { path: "笔记/旧文.md", content: "直接盖掉。", overwrite: true })],
  );
  assert.equal(app.vault.rawContent("笔记/旧文.md"), "直接盖掉。");
  const report = await undoRun(app as never, state, LOG);
  assert.deepEqual(report.skipped, [], JSON.stringify(report.skipped));
  assert.equal(app.vault.rawContent("笔记/旧文.md"), original);
});

// ── 移动/删除不走撤销，但要逐条交代 ─────────────────────────────────────────

test("撤销：本轮删除过的文件不还原内容（回收站负责），并逐条说明", async () => {
  const script = [
    tc("p", "patch_file", { path: "笔记/被删.md", old: "正文。", new: "改后。" }),
    tc("t", "trash_note", { path: "笔记/被删.md" }),
  ];
  const { app, state } = await driveRun({ "笔记/被删.md": "正文。" }, script);
  assert.equal(app.vault.getAbstractFileByPath("笔记/被删.md"), null);
  const report = await undoRun(app as never, state, LOG);
  assert.equal(report.reverted.length, 0);
  assert.equal(report.skipped.length, 1);
  assert.ok(report.skipped[0].note.includes("删除"), `说明要提到删除：${report.skipped[0].note}`);
  assert.ok(report.skipped[0].note.includes("回收站"), `说明要指向回收站：${report.skipped[0].note}`);
  assert.equal(app.vault.getAbstractFileByPath("笔记/被删.md"), null, "文件不能被悄悄复活");
});

test("撤销：本轮移动过的文件跳过并说明（元数据还原不做）", async () => {
  const script = [
    tc("p", "patch_file", { path: "笔记/原名.md", old: "正文。", new: "改后。" }),
    tc("m", "move_note", { from: "笔记/原名.md", to: "笔记/改名.md" }),
  ];
  const { app, state } = await driveRun({ "笔记/原名.md": "正文。" }, script);
  const report = await undoRun(app as never, state, LOG);
  assert.equal(report.reverted.length, 0);
  assert.equal(report.skipped.length, 1);
  assert.ok(report.skipped[0].note.includes("移动"), `说明要提到移动：${report.skipped[0].note}`);
  // 文件保持移动后的状态，没有被改动
  assert.equal(app.vault.rawContent("笔记/改名.md"), "改后。");
  assert.equal(app.vault.getAbstractFileByPath("笔记/原名.md"), null);
});

// ── 撤销数据的持久化：checkpoint 里带着，重启后可用 ─────────────────────────

test("撤销：appliedOps 的撤销数据随 checkpoint 落盘，loadState 后仍可撤销", async () => {
  const { app, loop, state } = await driveRun(
    { "笔记/持久.md": "原文。" },
    [tc("p", "patch_file", { path: "笔记/持久.md", old: "原文。", new: "改后。" })],
  );
  await loop.saveState(state);
  const loaded = await loop.loadState(state.runId);
  assert.ok(loaded, "存档要能读回来");
  const op = loaded!.appliedOps.find((o) => o.path === "笔记/持久.md");
  const undo = op?.undo;
  if (!undo || undo.kind !== "patch") {
    throw new Error(`落盘的 appliedOps 必须带 patch 撤销数据：${JSON.stringify(op)}`);
  }
  assert.equal(undo.old, "原文。");
  assert.equal(undo.new, "改后。");

  // 用读回来的 state 撤销（模拟「杀后台重启后再点撤销」）
  const report = await undoRun(app as never, loaded!, LOG);
  assert.deepEqual(report.skipped, [], JSON.stringify(report.skipped));
  assert.equal(app.vault.rawContent("笔记/持久.md"), "原文。");
  // 撤完落盘：再读回来不应再有可撤数据
  await loop.saveState(loaded!);
  const again = await loop.loadState(state.runId);
  assert.ok(again!.appliedOps.every((o) => !o.undo));
});

// ── 超上限：宁可不可撤销，也不拿截断文本还原 ────────────────────────────────

test("撤销：超过留存上限的 patch 成功执行但不留撤销数据，撤销时跳过并说明", async () => {
  // old 必须唯一命中（整篇就是那一块），同时长度超上限——「成功执行但不可撤」
  const big = "X".repeat(UNDO_TEXT_CAP + 1);
  const { app, state } = await driveRun(
    { "笔记/大.md": big },
    [tc("p", "patch_file", { path: "笔记/大.md", old: big, new: "改写后。" })],
  );
  assert.equal(app.vault.rawContent("笔记/大.md"), "改写后。", "patch 本身要成功");
  const op = state.appliedOps.find((o) => o.path === "笔记/大.md");
  assert.ok(op, "成功的 patch 必须留下 appliedOp");
  assert.equal(op!.undo, undefined, "超上限的操作不能带撤销数据");
  const report = await undoRun(app as never, state, LOG);
  assert.equal(report.reverted.length, 0);
  assert.ok(report.skipped[0].note.includes("留存上限"), report.skipped[0].note);
  assert.equal(app.vault.rawContent("笔记/大.md"), "改写后。", "文件保持改后状态，绝不用半份数据去还原");
});

// ── 记账与幂等 ──────────────────────────────────────────────────────────────

test("撤销：撤销动作记入 AI/03，重复撤销不重复记账", async () => {
  const { app, state } = await driveRun(
    { "笔记/记账.md": "原文。" },
    [tc("p", "patch_file", { path: "笔记/记账.md", old: "原文。", new: "改后。" })],
  );
  await undoRun(app as never, state, LOG);
  const log1 = app.vault.rawContent("AI/03-修改记录.md") ?? "";
  assert.ok(log1.includes("撤销本轮"), "撤销要在 AI/03 留痕");
  // 第二次撤销：没有可撤的操作，报告为空，也不追加记录
  const report2 = await undoRun(app as never, state, LOG);
  assert.equal(report2.reverted.length, 0);
  assert.equal(report2.skipped.length, 0);
  const log2 = app.vault.rawContent("AI/03-修改记录.md") ?? "";
  assert.equal(log2.split("撤销本轮").length - 1, log1.split("撤销本轮").length - 1, "记账不能重复");
});

// ── reverseReplay 纯函数：边界 ──────────────────────────────────────────────

test("reverseReplay：找不到/多处替换都整体失败，不给出部分还原结果", () => {
  const ok = reverseReplay("a中b中c", [{ kind: "patch", old: "X", new: "中" }]);
  assert.ok(!ok.ok);
  if (!ok.ok) assert.ok(ok.note.includes("多处"));
  const missing = reverseReplay("abc", [{ kind: "patch", old: "X", new: "中" }]);
  assert.ok(!missing.ok);
  const fine = reverseReplay("aXb", [{ kind: "patch", old: "Y", new: "X" }]);
  assert.deepEqual(fine, { ok: true, next: "aYb" });
});
