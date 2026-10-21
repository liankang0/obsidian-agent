import { test } from "node:test";
import assert from "node:assert/strict";
import { compactWorking, compactWorkingFile, archivedToHistory } from "../src/agent/memory";
import { MockApp } from "./mocks/obsidian";

const entry = (title: string, when: string, body = "改了两篇") =>
  `### ${title} ✅\n**完成时间**: ${when}\n**操作内容**: ${body}\n`;

const day = 24 * 60 * 60 * 1000;
const now = new Date(2026, 9, 21, 12, 0, 0).getTime(); // 2026-10-21 12:00

test("04 清理：超过 30 天的挪走，近的留着", () => {
  const raw = `## 当前活跃任务\n\n${entry("新任务", "2026-10-21 10:00:00")}\n${entry("旧任务", "2026-08-01 10:00:00")}\n`;
  const r = compactWorking(raw, now);
  assert.equal(r.archived.length, 1);
  assert.equal(r.archived[0].title, "旧任务");
  assert.ok(r.text.includes("新任务"));
  assert.ok(!r.text.includes("### 旧任务"), "旧的应该从 04 里消失");
});

test("04 清理：超过 8 条时，旧的挪走", () => {
  const blocks = Array.from({ length: 11 }, (_, i) =>
    entry(`任务${i}`, `2026-10-${String(21 - i).padStart(2, "0")} 10:00:00`),
  ).join("\n");
  const r = compactWorking(`## 当前活跃任务\n\n${blocks}\n`, now);
  assert.equal(r.archived.length, 3, `应挪走 3 条，实际 ${r.archived.length}`);
  const kept = r.text.match(/### 任务\d/g) ?? [];
  assert.equal(kept.length, 8);
});

test("04 清理：没有完成时间的条目保留（判断不了新旧就别动）", () => {
  const raw = `## 当前活跃任务\n\n### 没时间的老条目\n**操作内容**: 早期记录\n`;
  const r = compactWorking(raw, now);
  assert.equal(r.archived.length, 0);
  assert.ok(r.text.includes("没时间的老条目"));
});

test("04 清理：自检写进来的「自检记账」直接丢掉，不进 05", () => {
  const raw = `## 当前活跃任务\n\n${entry("自检记账", "2026-10-21 15:48:43", "改 guard.md")}\n${entry("真任务", "2026-10-21 10:00:00")}\n`;
  const r = compactWorking(raw, now);
  assert.equal(r.dropped, 1);
  assert.equal(r.archived.length, 0);
  assert.ok(!r.text.includes("自检记账"));
  assert.ok(r.text.includes("真任务"));
});

test("04 清理：边界约定等其它段落原样保留", () => {
  const raw = `## 边界约定\n\n- teacher/ 不许动\n\n## 当前活跃任务\n\n${entry("旧任务", "2026-07-01 10:00:00")}\n`;
  const r = compactWorking(raw, now);
  assert.ok(r.text.includes("## 边界约定"));
  assert.ok(r.text.includes("teacher/ 不许动"));
});

test("04 清理：没东西可清时一个字都不改（幂等）", () => {
  const raw = `## 当前活跃任务\n\n${entry("新任务", "2026-10-21 10:00:00")}\n`;
  const r = compactWorking(raw, now);
  assert.equal(r.text, raw);
  assert.equal(r.archived.length, 0);
});

test("归档块：写成 05 的格式（对话时间 + 任务）", () => {
  const out = archivedToHistory([
    { title: "旧任务", when: "2026-08-01 10:00:00", whenMs: undefined, raw: entry("旧任务", "2026-08-01 10:00:00", "改了三个文件") },
  ]);
  assert.match(out, /^### 归档：旧任务/);
  assert.match(out, /\*\*对话时间\*\*: 2026-08-01 10:00:00/);
  assert.match(out, /\*\*任务\*\*: .*改了三个文件/s);
});

test("compactWorkingFile：04 变短，05 变长，内容不丢", async () => {
  const old = entry("旧任务", "2026-07-01 10:00:00", "很久以前做的事");
  const app = new MockApp({
    "AI/04-临时工作记忆区.md": `## 当前活跃任务\n\n${entry("新任务", "2026-10-21 10:00:00")}\n${old}\n`,
    "AI/05-对话历史记录区.md": "# 05\n\n## 对话历史记录区\n\n## 快速索引\n\n| 日期 |\n|---|\n",
  });
  const r = await compactWorkingFile(app as never);
  assert.equal(r.archived, 1);
  const w = await app.vault.cachedRead(app.vault.getAbstractFileByPath("AI/04-临时工作记忆区.md") as never);
  const h = await app.vault.cachedRead(app.vault.getAbstractFileByPath("AI/05-对话历史记录区.md") as never);
  assert.ok(!w.includes("### 旧任务"));
  assert.ok(h.includes("归档：旧任务"), "05 里应该有归档条目");
  assert.ok(h.indexOf("归档：旧任务") < h.indexOf("## 快速索引"), "归档要插在快速索引之前");
  assert.ok(h.includes("很久以前做的事"), "内容不能丢");
});

test("04 清理：两个区段都清（当前活跃任务 + 已完成任务）", () => {
  const raw =
    `## 边界约定\n\n- teacher/ 不许动\n\n` +
    `## 当前活跃任务\n\n${entry("新任务", "2026-10-21 10:00:00")}\n` +
    `## 已完成任务\n\n${entry("老任务A", "2026-05-14 11:23:00")}\n${entry("老任务B", "2026-06-02 14:30:00")}\n` +
    `## 待处理队列\n\n（暂无）\n`;
  const r = compactWorking(raw, now);
  assert.equal(r.archived.length, 2, `应清 2 条，实际 ${r.archived.length}`);
  assert.ok(r.text.includes("新任务"));
  assert.ok(!r.text.includes("老任务A") && !r.text.includes("老任务B"));
  assert.ok(r.text.includes("teacher/"), "边界约定不能丢");
  assert.ok(r.text.includes("## 待处理队列") && r.text.includes("（暂无）"), "后面的区段不能丢");
});

test("04 清理：清完之后再跑一次什么都不改（幂等）", () => {
  const raw = `## 当前活跃任务\n\n${entry("旧任务", "2026-01-01 10:00:00")}\n${entry("新任务", "2026-10-21 10:00:00")}\n`;
  const once = compactWorking(raw, now);
  const twice = compactWorking(once.text, now);
  assert.equal(twice.text, once.text);
  assert.equal(twice.archived.length, 0);
});
