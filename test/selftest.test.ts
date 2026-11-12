/**
 * WP7：真机自检的剧本与单测共用。
 *
 * 这份 runner 跑的就是真机自检跑的那份剧本（src/agent/selftest-scenarios.ts），
 * 一条剧本一个测试、按原顺序对同一个 MockApp 执行。改坏任何一条剧本，
 * 这里立刻红——不用等真机自检才发现。
 *
 * 真机上剧本依赖用户的真实数据（04/05 记忆、01/02 清单、skills/）；
 * 这里用等价的夹具顶上，剧本本身不关心数据从哪来。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  PLUGIN_DIR,
  SELFTEST_STEPS,
  prepareScratch,
  selftestCall,
  selftestCtx,
  selftestLoop,
  type SelftestEnv,
} from "../src/agent/selftest-scenarios";
import { MockApp } from "./mocks/obsidian";

const LOG = { info() {}, warn() {}, error() {} };

/** 真机上的对应物：AI/00-06 与 skills/ 都是用户真实文件；这里造等价夹具 */
const FIXTURES: Record<string, string> = {
  "AI/04-临时工作记忆区.md": [
    "# 04 临时工作记忆区",
    "",
    "## 边界约定",
    "",
    "- teacher/ 不许动",
    "",
    "## 当前活跃任务",
    "",
    "### 单元测试夹具任务 ✅",
    "**完成时间**: 2026-11-12 10:00:00",
    "**操作内容**: 改了 a.md",
    "",
  ].join("\n"),
  "AI/05-对话历史记录区.md": ["# 05 对话历史记录区", "", "### 夹具记录", "", "**任务**: 聊过天", "", "## 快速索引", ""].join("\n"),
  "AI/01-任务前检查清单.md": [
    "# 01 任务前检查清单",
    "",
    "### 1. 🔐 授权确认",
    "",
    "- [ ] 确认要动的目录范围",
    "- [ ] 确认是否有批量改动",
    "- [ ] 确认删除类操作走回收站",
    "",
    "### 2. 📁 路径确认",
    "",
    "- [ ] 路径相对 Vault 根目录",
    "- [ ] 不碰 .obsidian 配置",
    "",
    "## 🎯 不同任务类型的特殊检查",
    "",
    "（这段之后的内容 01 里不进 prompt）",
    "",
  ].join("\n"),
  "AI/02-任务后质量检查清单.md": [
    "# 02 任务后质量检查清单",
    "",
    "### 1. ✅ 完成度",
    "",
    "- [ ] 用户要求的每一项都做了",
    "- [ ] 没有顺手改无关内容",
    "- [ ] 新建文件放对目录",
    "- [ ] 命名符合既有习惯",
    "",
    "### 2. 🔍 质量",
    "",
    "- [ ] 改动前后 diff 合理",
    "- [ ] 双链没被弄断",
    "- [ ] YAML frontmatter 完整",
    "- [ ] 标签风格一致",
    "",
    "### 3. 📝 记账",
    "",
    "- [ ] 04 写了本次任务",
    "- [ ] 05 追加了记录",
    "- [ ] 03 修改记录由插件写入",
    "- [ ] 临时文件已清理",
    "",
  ].join("\n"),
  "skills/摘录整理.md": [
    "---",
    "name: 摘录整理",
    "description: 把剪藏的长文整理成要点",
    "---",
    "",
    "## 用法",
    "",
    "这里是 skill 的正文说明，长度超过二十个字符是肯定没问题的。",
    "",
  ].join("\n"),
  "笔记/火锅.md": "今天吃了火锅，很辣。\n",
  // 带 title frontmatter 的笔记：注意不能放 _agent-selftest/ 下——那是搜索噪音目录
  "笔记/置身事内.md": ["---", "title: 置身事内", "---", "", "第一章 从头说起。", ""].join("\n"),
  "backup/火锅副本.md": "火锅的历史备份。\n",
  "笔记/android折腾.md": "折腾记录 #android\n",
};

const app = new MockApp(FIXTURES);
const adapter = app.vault.adapter;

/** 剧本用的断言 helper（名字避开 node:assert 的 assert，剧本签名是 (cond, msg)） */
const stepAssert = (cond: boolean, msg: string) => {
  if (!cond) throw new Error(msg);
};

const env: SelftestEnv = {
  app: app as never,
  adapter: adapter as never,
  log: LOG,
  assert: stepAssert,
  ctx: () => selftestCtx(app as never, LOG),
  call: selftestCall,
  makeLoop: (script) => selftestLoop(app as never, LOG, script),
};

// 与真机 runner 完全相同的开场：清旧产物、建目录、写样例笔记
await prepareScratch(app as never, adapter as never);

// 一条剧本一个测试，按原顺序对同一个 vault 实例执行——顺序错了这里会红
for (const step of SELFTEST_STEPS) {
  test(`自检剧本：${step.name}`, async () => {
    const detail = await step.run(env);
    assert.ok(typeof detail === "string" && detail.length > 0, "剧本要返回一句话概要");
  });
}

// 真机 runner 的编排层也要能跑通：同一个 app 上跑完整 runSelfTest（含清理与报告）
test("自检编排：runSelfTest 全绿且产物清理干净", async () => {
  const { runSelfTest } = await import("../src/agent/selftest");
  const report = await runSelfTest(app as never, LOG);
  assert.equal(report.fail, 0, `失败的剧本：${report.steps.filter((s) => !s.ok).map((s) => `${s.name}：${s.detail}`).join("；")}`);
  assert.ok(report.steps.length >= SELFTEST_STEPS.length, "报告要覆盖全部剧本");
  // 编排层的清理：自检目录与外溢不留痕
  assert.equal(await adapter.exists("_agent-selftest"), false);
  assert.equal(await adapter.exists(`${PLUGIN_DIR}/selftest-sessions.json`), false);
  assert.equal(await adapter.exists(`${PLUGIN_DIR}/chat-history-selftest.json`), false);
});
