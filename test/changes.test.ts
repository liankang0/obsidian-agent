import { test } from "node:test";
import assert from "node:assert/strict";

import { changeSummary, describeChange, groupChanges } from "../src/agent/changes";
import type { AppliedOp } from "../src/agent/types";

test("动作标签：改 / 新建 / 写入 / 移动 / 删除 分得清", () => {
  assert.equal(describeChange("patch_file", { old: "a\nb", new: "a\nb\nc" }).op, "改");
  assert.equal(describeChange("create_note", {}).op, "新建");
  assert.equal(describeChange("write_file", {}).op, "写入");
  assert.equal(describeChange("move_note", {}).op, "移动");
  assert.equal(describeChange("trash_note", {}).op, "删除");
});

test("patch_file 说行数变化，比说字符数直观", () => {
  const d = describeChange("patch_file", { old: "一行", new: "一行\n两行\n三行" });
  assert.equal(d.detail, "+3 −1 行");
});

test("移动要说清从哪到哪", () => {
  const d = describeChange("move_note", { from: "inbox/a.md", to: "knowledge/a.md" });
  assert.equal(d.detail, "inbox/a.md → knowledge/a.md");
});

test("删除类统一说「移入回收站」（不是真删，别吓人）", () => {
  assert.equal(describeChange("trash_note", {}).detail, "移入回收站");
  assert.equal(describeChange("trash_folder", {}).detail, "移入回收站");
});

test("同一文件被改多次只出现一行，但动作都留着", () => {
  const ops: AppliedOp[] = [
    { tool: "patch_file", path: "a.md", at: 1, op: "改", detail: "+1 −1 行" },
    { tool: "patch_file", path: "a.md", at: 2, op: "改", detail: "+2 −0 行" },
    { tool: "create_note", path: "b.md", at: 3, op: "新建", detail: "12 字" },
  ];
  const g = groupChanges(ops);
  assert.equal(g.length, 2);
  assert.equal(g[0].path, "a.md");
  assert.equal(g[0].ops.length, 2);
});

test("标题把动作按类别统计", () => {
  const ops: AppliedOp[] = [
    { tool: "patch_file", path: "a.md", at: 1, op: "改" },
    { tool: "create_note", path: "b.md", at: 2, op: "新建" },
    { tool: "patch_file", path: "c.md", at: 3, op: "改" },
  ];
  const s = changeSummary(groupChanges(ops));
  assert.ok(s.includes("3 个文件"), s);
  assert.ok(s.includes("改 2") && s.includes("新建 1"), s);
});

test("没有改动时标题说人话", () => {
  assert.equal(changeSummary([]), "本轮没有改动文件");
});
