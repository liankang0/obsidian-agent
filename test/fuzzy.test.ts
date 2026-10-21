/**
 * 三级模糊匹配测试。
 * 样本取自真实 vault 的排版：中文正文、Markdown 列表、缩进。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { explainAmbiguous, explainMismatch, findMatches } from "../src/util/fuzzy";

const doc = [
  "# 标题",
  "",
  "- [ ] 写周报 📅 2026-10-20",
  "- [ ] 整理笔记",
  "",
  "## 小节",
  "正文内容。",
].join("\n");

test("精确命中：返回 exact 与正确偏移", () => {
  const r = findMatches(doc, "- [ ] 整理笔记");
  assert.equal(r?.tier, "exact");
  assert.equal(r?.ranges.length, 1);
  const range = r!.ranges[0];
  assert.equal(doc.slice(range.start, range.end), "- [ ] 整理笔记");
});

test("行尾多出空格：降级到 trailing", () => {
  const r = findMatches(doc, "- [ ] 整理笔记   ");
  assert.equal(r?.tier, "trailing");
});

test("缩进用了全角空格：降级到 trimmed", () => {
  const withIndent = ["# 标题", "　　- [ ] 子任务"].join("\n");
  const r = findMatches(withIndent, "    - [ ] 子任务");
  assert.equal(r?.tier, "trimmed");
  // 替换区间必须覆盖原文（含全角空格），否则会留下残渣
  const range = r!.ranges[0];
  assert.equal(withIndent.slice(range.start, range.end), "　　- [ ] 子任务");
});

test("多行片段跨行命中", () => {
  const r = findMatches(doc, "- [ ] 写周报 📅 2026-10-20\n- [ ] 整理笔记");
  assert.equal(r?.ranges.length, 1);
  assert.equal(doc.slice(r!.ranges[0].start, r!.ranges[0].end), "- [ ] 写周报 📅 2026-10-20\n- [ ] 整理笔记");
});

test("出现两次就报歧义（不猜）", () => {
  const dup = "- [ ] 重复\n- [ ] 重复";
  const r = findMatches(dup, "- [ ] 重复");
  assert.equal(r?.ranges.length, 2);
});

test("同一档里唯一的，不会被低档的命中干扰", () => {
  const text = ["a", "b", " a "].join("\n");
  const r = findMatches(text, "a");
  assert.equal(r?.tier, "exact"); // 第 1 行精确命中，不应降级去匹配第 3 行
  assert.equal(r?.ranges.length, 1);
  assert.equal(r!.ranges[0].start, 0);
});

test("找不到就返回 null", () => {
  assert.equal(findMatches(doc, "根本不存在的一段话"), null);
});

test("空 needle 返回 null", () => {
  assert.equal(findMatches(doc, ""), null);
});

test("needle 末尾多一个换行也能匹配", () => {
  const r = findMatches(doc, "- [ ] 整理笔记\n");
  assert.equal(r?.tier, "exact");
  assert.equal(r?.ranges.length, 1);
});

test("用返回区间做替换，结果是预期的", () => {
  const r = findMatches(doc, "- [ ] 整理笔记");
  const range = r!.ranges[0];
  const out = doc.slice(0, range.start) + "- [x] 整理笔记 ✅ 2026-10-20" + doc.slice(range.end);
  assert.ok(out.includes("- [x] 整理笔记 ✅ 2026-10-20"));
  assert.ok(out.includes("- [ ] 写周报 📅 2026-10-20")); // 其他行没被碰
});

// ---------------------------------------------------------------------------
// 回归：真实设备上失败的那次（手机端 glm-5.3-flash，知识地图.md）
// ---------------------------------------------------------------------------
const realDoc = [
  "---",
  "title: 知识地图",
  "created: 2026-04-30",
  "tags:",
  '  - "#map"',
  "---",
  "",
  "# 🗺️ 知识地图",
  "",
  "> 第二大脑的导航中心，所有笔记的总索引",
  "",
  "---",
  "",
  "## 📚 读书笔记",
].join("\n");

test("回归：old 把整行截成半句时，诊断要念出实际那一行", () => {
  const needle = "# 🗺️ 知识地图\n\n> 第二大脑的导航中心";
  assert.equal(findMatches(realDoc, needle), null); // 行级匹配确实失败

  const msg = explainMismatch(realDoc, needle);
  assert.match(msg, /第 10 行/);            // 指到真正对不上的那一行
  assert.match(msg, /所有笔记的总索引/);      // 念出文件里的完整内容
  assert.match(msg, /完整一行/);              // 给出可执行的纠正方法
});

test("回归：模型以为文件从标题开始，诊断要暴露 frontmatter", () => {
  const msg = explainMismatch(realDoc, "# 🗺️ 完全不存在的标题\n\n正文");
  assert.match(msg, /文件共 14 行/);
  assert.match(msg, /title: 知识地图/); // 让它看见 frontmatter
});

test("歧义诊断：列出命中位置与行号", () => {
  const doc2 = "- [ ] 重复任务\n正文\n- [ ] 重复任务";
  const r = findMatches(doc2, "- [ ] 重复任务")!;
  const msg = explainAmbiguous(doc2, r.ranges);
  assert.match(msg, /第 1 行/);
  assert.match(msg, /第 3 行/);
  assert.match(msg, /唯一/);
});
