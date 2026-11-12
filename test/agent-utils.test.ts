/**
 * 审批记忆与旁路提醒通道测试。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ApprovalStore } from "../src/agent/approvals";
import { interruptedReminder, isReminder, systemReminder } from "../src/agent/reminder";
import { isSpillPath, SPILL_DIR, spillFilePath, spillNotice } from "../src/agent/spill";

test("批准一个文件，同目录其他文件直接放行", () => {
  const s = new ApprovalStore();
  s.allow("日记/2026-10-06-日记.md");
  assert.equal(s.isAllowed("日记/2026-10-06-日记.md"), true);
  assert.equal(s.isAllowed("日记/2026-10-07-日记.md"), true);
  assert.equal(s.isAllowed("knowledge/tech/a.md"), false);
});

test("库根目录单独记", () => {
  const s = new ApprovalStore();
  s.allow("首页.md");
  assert.equal(s.isAllowed("知识地图.md"), true);
  assert.equal(s.isAllowed("日记/a.md"), false);
});

test("反斜杠路径归一化", () => {
  const s = new ApprovalStore();
  s.allow("日记\\a.md");
  assert.equal(s.isAllowed("日记/b.md"), true);
});

test("clear 之后重新要求审批", () => {
  const s = new ApprovalStore();
  s.allow("a/b.md");
  s.clear();
  assert.equal(s.isAllowed("a/b.md"), false);
  assert.equal(s.size, 0);
});

test("提醒消息用固定标签包起来", () => {
  const m = systemReminder("现在是只读模式");
  assert.equal(m.role, "user");
  assert.match(String(m.content), /^<system-reminder>/);
  assert.match(String(m.content), /<\/system-reminder>$/);
  assert.equal(isReminder(m), true);
});

test("普通用户消息不会被误判成提醒", () => {
  assert.equal(isReminder({ role: "user", content: "帮我把这篇改一下" }), false);
  assert.equal(isReminder({ role: "assistant", content: "<system-reminder>x</system-reminder>" }), false);
});

test("中断提醒里带数量", () => {
  const m = interruptedReminder(3);
  assert.match(String(m.content), /3 个工具调用/);
  assert.equal(isReminder(m), true);
});

test("外溢路径落在插件自己的目录下并按 run 分文件夹", () => {
  const p = spillFilePath("run-123", "search", 7);
  assert.equal(p, `${SPILL_DIR}/run-123/07-search.txt`);
});

test("外溢路径过滤非法字符，避免拼出奇怪的目录", () => {
  const p = spillFilePath("../../etc/passwd", "read/file", 1);
  assert.ok(!p.includes(".."));
  assert.ok(p.startsWith(`${SPILL_DIR}/`));
});

test("外溢说明里带字数、行数、落点与分段读取示例", () => {
  const text = spillNotice(9000, `${SPILL_DIR}/r/01-search.txt`, "开头一段", 120);
  assert.match(text, /9000 字符/);
  assert.match(text, /120 行/);
  assert.match(text, /read_file/);
  assert.match(text, /开头一段/);
});

test("外溢路径判定：命中目录本身与子文件，不误伤同名前缀", () => {
  assert.equal(isSpillPath(`${SPILL_DIR}/run-1/01-search.txt`), true);
  assert.equal(isSpillPath(SPILL_DIR), true);
  assert.equal(isSpillPath(`.obsidian/plugins/local-vault-agent/spillx/a.txt`), false);
  assert.equal(isSpillPath("knowledge/tech/a.md"), false);
  // 反斜杠形式（模型偶尔会给）
  assert.equal(isSpillPath(`${SPILL_DIR}\\run-1\\a.txt`), true);
});
