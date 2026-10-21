/**
 * 设备自检：在没有 UI、没有模型的情况下，直接驱动工具层跑一组剧本。
 *
 * 触发方式：把 `selftest.flag` 放进插件目录，重载插件。
 * 为什么不用 adb 模拟点击：Obsidian 是 WebView 应用，`input text` 打不了中文，
 * 无障碍树里的 bounds 还经常是错的。自检不碰 UI，确定性和覆盖率都更高。
 *
 * 全部操作都在 `<插件目录>/selftest/` 下，不碰用户笔记。
 */

import type { App } from "obsidian";

import { checkProtected } from "./guard";
import { buildSkillIndex, scanSkills } from "./skills";
import { capTurn, slimHistory } from "./trim";
import { pruneOldToolResults, shouldPrune, worthPruning } from "./prune";
import {
  buildChecklistBlock,
  buildMemoryBlock,
  compactWorking,
  HISTORY_PATH,
  readChecklists,
  readMemory,
  WORKING_PATH,
} from "./memory";
import { buildSystemPrompt } from "./loop";
import { buildRecord, CHANGELOG_PATH } from "./changelog";
import { formatUsage } from "../util/format";
import { ChatHistory } from "./history";
import { AgentLoop } from "./loop";
import { ApprovalStore } from "./approvals";
import { serializeToolResult } from "./serialize";
import { SPILL_DIR } from "./spill";
import { executeTool, type ToolContext } from "./tools";
import type { Completion, RunState, ToolCall, ToolResult } from "./types";

/** 插件目录（.obsidian/plugins/obsidian-agent） */
const PLUGIN_DIR = SPILL_DIR.split("/").slice(0, 3).join("/");

/**
 * 自检的临时笔记必须放在 vault 里被索引的位置——
 * `.obsidian/` 下的文件 `getTFile` 找不到，patch_file 就没法跑。
 */
const SCRATCH_DIR = "_agent-selftest";

export const SELFTEST_FLAG = `${PLUGIN_DIR}/selftest.flag`;
export const SELFTEST_REPORT = `${PLUGIN_DIR}/selftest-report.json`;

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SelfTestReport {
  startedAt: string;
  finishedAt: string;
  pass: number;
  fail: number;
  steps: StepResult[];
}

// 真实设备的排版：YAML frontmatter + 标题 + 引用行
const NOTE = [
  "---",
  "title: 自检样例",
  "tags:",
  '  - "#selftest"',
  "---",
  "",
  "# 🗺️ 知识地图",
  "",
  "> 第二大脑的导航中心，所有笔记的总索引",
  "",
  "## 小节",
].join("\n");

function makeCtx(app: App, log: ToolContext["log"]): ToolContext {
  return {
    app,
    log,
    // 自检一律自动接受，避免卡在等待人工确认
    confirm: async () => true,
    changedFiles: new Set<string>(),
    // 设成 0：让每次写都走确认分支，从而验证「确认后写盘」这条路
    confirmAfterFiles: 0,
    readOnly: false,
    runId: "selftest",
    approvals: new ApprovalStore(),
  };
}

async function call(ctx: ToolContext, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const call: ToolCall = { id: `st-${name}-${Math.random().toString(36).slice(2, 7)}`, name, args };
  return executeTool(call, ctx);
}

function dataOf(r: ToolResult): Record<string, unknown> {
  return (r.data ?? {}) as Record<string, unknown>;
}

export async function runSelfTest(app: App, log: ToolContext["log"]): Promise<SelfTestReport> {
  const adapter = app.vault.adapter;
  const dir = SCRATCH_DIR;
  const notePath = `${dir}/note.md`;
  const steps: StepResult[] = [];

  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      const detail = await fn();
      steps.push({ name, ok: true, detail });
      log.info(`[自检] ✓ ${name}：${detail}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      steps.push({ name, ok: false, detail: msg });
      log.error(`[自检] ✗ ${name}：${msg}`);
    }
  };

  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  /** 每步都新建 ctx：避免 changedFiles/审批状态在步骤间串味 */
  const ctx = () => makeCtx(app, log);

  const startedAt = new Date().toISOString();

  try {
    // 0. 准备：清空并重建自检目录
    await adapter.rmdir(dir, true).catch(() => undefined);
    await adapter.rmdir(`${SPILL_DIR}/selftest`, true).catch(() => undefined);
    await app.vault.createFolder(dir);
    await adapter.write(notePath, NOTE);

    await check("建目录与写文件", async () => {
      assert((await adapter.exists(notePath)) === true, "文件没建成");
      const raw = await adapter.read(notePath);
      assert(raw === NOTE, "写进去的内容和预期不一致");
      return `${NOTE.length} 字符`;
    });

    await check("read_file 读整篇", async () => {
      const r = await call(ctx(), "read_file", { path: notePath });
      assert(r.ok === true, `工具返回失败：${JSON.stringify(r.error ?? r)}`);
      const d = dataOf(r);
      assert(typeof d.content === "string" && d.content.includes("所有笔记的总索引"), "内容里没有预期文本");
      assert(d.totalLines === 11, `总行数应为 11，实际 ${d.totalLines}`);
      return `${d.totalLines} 行全部读出`;
    });

    await check("read_file 分段读取", async () => {
      const r = await call(ctx(), "read_file", { path: notePath, from: 7, to: 9 });
      assert(r.ok === true, `工具返回失败：${JSON.stringify(r.error ?? r)}`);
      const d = dataOf(r);
      assert(String(d.content).includes("# 🗺️ 知识地图"), "第 7 行应该是标题");
      assert(!String(d.content).includes("## 小节"), "不该包含区间外的内容");
      return `第 7–9 行：${String(d.content).replace(/\n/g, "⏎").slice(0, 40)}`;
    });

    await check("patch_file 精确替换并落盘", async () => {
      const r = await call(ctx(), "patch_file", { path: notePath, old: "# 🗺️ 知识地图", new: "# 🗺️ 知识地图（改）" });
      assert(r.ok === true, `工具返回失败：${JSON.stringify(r.error ?? r)}`);
      assert(dataOf(r).matchedWith === "exact", `应是 exact，实际 ${dataOf(r).matchedWith}`);
      const raw = await adapter.read(notePath);
      assert(raw.includes("# 🗺️ 知识地图（改）"), "文件里没有改动");
      return `matchedWith=exact`;
    });

    await check("patch_file 行尾空格降级匹配", async () => {
      const r = await call(ctx(), "patch_file", {
        path: notePath,
        old: "## 小节   ", // 多两个空格
        new: "## 小节（改）",
      });
      assert(r.ok === true, `工具返回失败：${JSON.stringify(r.error ?? r)}`);
      assert(dataOf(r).matchedWith === "trailing", `应是 trailing，实际 ${dataOf(r).matchedWith}`);
      return `matchedWith=trailing`;
    });

    await check("patch_file 半句 old 给出诊断（回归）", async () => {
      const r = await call(ctx(), "patch_file", {
        path: notePath,
        old: "# 🗺️ 知识地图（改）\n\n> 第二大脑的导航中心", // 故意截断
        new: "# x",
      });
      assert(r.ok === false, "半句 old 居然匹配成功了");
      const msg = String(r.error ?? "");
      assert(msg.includes("文件第"), `报错里没有行号：${msg.slice(0, 80)}`);
      assert(msg.includes("所有笔记的总索引"), `报错里没有实际内容：${msg.slice(0, 80)}`);
      return "报错含行号与实际原文";
    });

    await check("patch_file 拒绝改到不存在的行", async () => {
      const r = await call(ctx(), "patch_file", { path: notePath, old: "这段文字不存在于文件里", new: "x" });
      assert(r.ok === false, "不存在的文本居然匹配成功了");
      return "正确拒绝";
    });

    await check("外溢目录可读回（回归 .obsidian 不被索引）", async () => {
      const spillFile = `${SPILL_DIR}/selftest/01-list_files.txt`;
      await adapter.mkdir(`${SPILL_DIR}/selftest`).catch(() => undefined);
      const big = JSON.stringify({ files: Array.from({ length: 80 }, (_, i) => `很长的文件名-${i}.md`) });
      await adapter.write(spillFile, big);
      const r = await call(ctx(), "read_file", { path: spillFile, from: 1, to: 2 });
      assert(r.ok === true, `读外溢文件失败：${JSON.stringify(r.error ?? r)}`);
      assert(String(dataOf(r).content).includes("很长的文件名-0.md"), "外溢内容没读到");
      return `从 .obsidian 下读回 ${big.length} 字符中的前 2 行`;
    });

    await check("敏感文件被拒绝", async () => {
      const r = await call(ctx(), "read_file", { path: "selfcheck/.env" });
      assert(r.ok === false, "敏感路径居然放行了");
      return "已拦截 .env";
    });

    await check("写越界路径被拒绝", async () => {
      const r = await call(ctx(), "write_file", { path: "../outside.md", content: "x" });
      assert(r.ok === false, "越界路径居然放行了");
      return "已拦截 ../";
    });
    await check("序列化：小结果原样内联", async () => {
      const out = await serializeToolResult({ adapter, log }, "search", "selftest", 1, { ok: true, data: "短" });
      assert(out.content === JSON.stringify({ ok: true, data: "短" }), "短结果被改动了");
      assert(out.spilledPath === undefined, "短结果不该外溢");
      return `${out.content.length} 字符，未外溢`;
    });

    await check("序列化：大结果外溢并真实落盘", async () => {
      const big = { files: Array.from({ length: 300 }, (_, i) => `一篇名字很长的笔记-${i}.md`) };
      const out = await serializeToolResult({ adapter, log }, "list_files", "selftest-run", 7, big);
      assert(out.spilledPath !== undefined, "没有外溢");
      assert(out.content.includes("已完整存到"), "提示里没有落点");
      assert((await adapter.exists(out.spilledPath!)) === true, "外溢文件没落盘");
      const raw = await adapter.read(out.spilledPath!);
      assert(raw.length === JSON.stringify(big).length, "落盘内容长度不一致");
      return `${raw.length} 字符 → ${out.spilledPath}`;
    });

    await check("序列化：read_file 不参与外溢", async () => {
      const big = { content: "x".repeat(20_000) };
      const out = await serializeToolResult({ adapter, log }, "read_file", "selftest-run", 8, big);
      assert(out.spilledPath === undefined, "read_file 不该外溢");
      assert(out.content.length > 19_000, "内容被截了");
      return "20k 正文原样保留";
    });

    // --- 循环层：用脚本化 provider 跑真机 AgentLoop，不走网络 ---
    const cfg = {
      baseUrl: "http://selftest.invalid",
      apiKey: "selftest",
      model: "selftest",
      temperature: 0,
      maxTokens: 512,
      maxSteps: 6,
      confirmAfterFiles: 0,
    };

    const makeLoop = (script: Completion[]) =>
      new AgentLoop({
        app,
        // 脚本化 provider：只实现 chat，不发真实请求
        provider: {
          chat: async () => script.shift() ?? { content: "完成。", toolCalls: [] },
        } as never,
        getConfig: () => cfg,
        pluginDir: PLUGIN_DIR,
        log,
        confirm: async () => true,
        readOnly: false,
        approvals: new ApprovalStore(),
      });

    await check("循环层：一轮完整执行（读 → 改 → 收尾）", async () => {
      await adapter.write(notePath, NOTE);
      const loop = makeLoop([
        { content: "", toolCalls: [{ id: "l1", name: "read_file", args: { path: notePath } }] },
        {
          content: "",
          toolCalls: [{ id: "l2", name: "patch_file", args: { path: notePath, old: "## 小节", new: "## 小节（循环改）" } }],
        },
        { content: "改好了。", toolCalls: [] },
      ]);
      const state = await loop.start("自检：把笔记里的小节标题改一下", () => undefined);
      assert(state.status === "done", `状态是 ${state.status}：${state.error ?? ""}`);
      const raw = await adapter.read(notePath);
      assert(raw.includes("## 小节（循环改）"), "文件没被改");
      assert(state.appliedOps.length === 1, `appliedOps 应为 1，实际 ${state.appliedOps.length}`);

      // 注入材料必须真的进了 prompt——曾经 start() 只读 skills/memory，
      // 清单块是空的，而自检走的另一条路让它全绿
      const sys = state.messages[0].content ?? "";
      assert(sys.includes("任务开始前逐项确认"), "start() 的 prompt 里没有检查清单");
      assert(sys.includes("可用的 skill"), "start() 的 prompt 里没有 skill 索引");
      assert(sys.includes("当前活跃任务"), "start() 的 prompt 里没有工作记忆");
      assert((await adapter.exists(`${PLUGIN_DIR}/state/${state.runId}.json`)) === true, "状态文件没落盘");
      await adapter.remove(`${PLUGIN_DIR}/state/${state.runId}.json`).catch(() => undefined);
      return `3 轮 / 状态 done / 存档 ${state.runId}`;
    });

    await check("上下文瘦身：16000 就动手，省得少就不动", async () => {
      assert(!shouldPrune(15000, 10), "15000 不该动手");
      assert(shouldPrune(16500, 10), "16500 该动手了");
      const mk = (n: number, size: number) => ({ role: "tool" as const, content: `第${n}个${"x".repeat(size)}` });
      const many: Array<{ role: "assistant" | "tool"; content: string }> = [];
      for (let i = 0; i < 8; i++) {
        many.push({ role: "assistant", content: "" });
        many.push(mk(i, 3000));
      }
      const r = pruneOldToolResults(many as never);
      assert(r.pruned === 6, `应剪 6 条（保护最近两批），实际 ${r.pruned}`);
      assert(worthPruning(r), "省得多却不做");
      // 只剪得掉最早一批、省 760 字符：不值得做
      const few = [
        { role: "assistant" as const, content: "" }, mk(0, 1000),
        { role: "assistant" as const, content: "" }, mk(1, 1000),
        { role: "assistant" as const, content: "" }, mk(2, 1000),
      ];
      assert(!worthPruning(pruneOldToolResults(few as never)), "省得太少却做了");
      return `省 ${r.savedChars} 字符`;
    });

    await check("历史瘦身：超预算丢最旧的，长回答头尾保留", async () => {
      const long = `${"开头".repeat(400)}…${"结尾".repeat(200)}`;
      const turns = [
        { role: "user" as const, content: "老问题" },
        { role: "assistant" as const, content: long },
        { role: "user" as const, content: "新问题" },
        { role: "assistant" as const, content: "新回答" },
      ];
      // 预算压到 700：长回答截断后仍有 ~1130 字符，一定放不下，才能验证「丢最旧的」
      const r = slimHistory(turns, 700);
      assert(r.chars <= 700, `超预算：${r.chars}`);
      assert(r.turns[r.turns.length - 1].content === "新回答", "最新一条必须在");
      assert(r.dropped > 0, "应该丢掉最旧的");
      const capped = capTurn(long);
      assert(capped.length <= 1200, `单条截断不生效：${capped.length}`);
      assert(capped.includes("中间省略"), "截断没留标记");
      return `${turns.length} 条 → ${r.turns.length} 条 / ${r.chars} 字符`;
    });

    await check("04 自动清理：老任务挪去 05、自检垃圾丢掉、其它段落不动", async () => {
      const mk = (title: string, when: string) => `### ${title} ✅\n**完成时间**: ${when}\n**操作内容**: x\n`;
      const nowMs = new Date(2026, 9, 21, 12, 0, 0).getTime();
      const raw =
        `## 边界约定\n\n- teacher/ 不许动\n\n## 当前活跃任务\n\n` +
        mk("自检记账", "2026-10-21 10:00:00") +
        mk("新任务", "2026-10-21 10:00:00") +
        mk("旧任务", "2026-06-01 10:00:00");
      const r = compactWorking(raw, nowMs);
      assert(r.archived.length === 1 && r.archived[0].title === "旧任务", `归档异常：${JSON.stringify(r.archived.map((a) => a.title))}`);
      assert(r.dropped === 1, `自检垃圾没丢：${r.dropped}`);
      assert(r.text.includes("teacher/ 不许动"), "边界约定被误删");
      assert(!r.text.includes("### 旧任务"), "旧任务还在 04 里");
      assert(!r.text.includes("自检记账"), "自检记账还在 04 里");
      return `归档 1 / 丢弃 1 / 保留新任务`;
    });

    await check("记忆块写明「背景不是待办」，且只取最近 3 条", async () => {
      const section = `### 甲 ✅\n**完成时间**: 2026-10-21 10:00:00\n**操作内容**: ${"很长".repeat(200)}\n\n` +
        `### 乙 ✅\n**完成时间**: 2026-10-20 10:00:00\n**操作内容**: 短\n\n` +
        `### 丙 ✅\n**完成时间**: 2026-10-19 10:00:00\n**操作内容**: 短\n\n` +
        `### 丁 ✅\n**完成时间**: 2026-10-18 10:00:00\n**操作内容**: 短\n`;
      const block = buildMemoryBlock({ working: section, history: "聊过天" });
      assert(block.includes("背景资料，不是待办"), "没说清这不是待办");
      assert(block.includes("「继续"), "没告诉模型只有「继续」才接着做");
      assert(block.includes("甲") && !block.includes("丁"), "应只保留最近 3 条");
      assert(block.length < 1600, `记忆块太长：${block.length}`);
      return `${block.length} 字符 / 3 条`;
    });

    // 自检绝不能在用户真实的 04/05 上留垃圾——先备份，跑完原样写回。
    // （曾经就是这么把 3 条「自检记账」写进用户记忆区的）
    const backupMem = async (path: string): Promise<string | null> => {
      const f = app.vault.getAbstractFileByPath(path);
      if (!f) return null;
      return await app.vault.cachedRead(f as never).catch(() => null);
    };
    const restoreMem = async (path: string, raw: string | null) => {
      if (raw === null) {
        await app.vault.adapter.remove(path).catch(() => undefined);
        return;
      }
      await app.vault.adapter.write(path, raw).catch(() => undefined);
    };

    await check("准则 Step 4：record_memory 之后不再误报「没回写 04/05」", async () => {
      const memBackup = await backupMem(WORKING_PATH);
      const histBackup = await backupMem(HISTORY_PATH);
      try {
      const warnLog: string[] = [];
      const spyLog = {
        info: () => undefined,
        warn: (m: string) => warnLog.push(m),
        error: () => undefined,
      } as typeof log;
      const note2 = `${dir}/guard.md`;
      await adapter.write(note2, "# 守卫\n\n正文\n");
      // 脚本必须提到外面：写在 chat() 里会每次调用都重建，永远是第一句
      const script: Completion[] = [
        { content: "", toolCalls: [{ id: "g1", name: "patch_file", args: { path: note2, old: "正文", new: "正文（改）" } }] },
        {
          content: "",
          toolCalls: [{ id: "g2", name: "record_memory", args: { kind: "working", title: "自检记账", content: "改 guard.md" } }],
        },
        { content: "做完了。", toolCalls: [] },
      ];
      const loop = new AgentLoop({
        app,
        provider: {
          chat: async () => script.shift() ?? { content: "完成。", toolCalls: [] },
        } as never,
        getConfig: () => cfg,
        pluginDir: PLUGIN_DIR,
        log: spyLog,
        confirm: async () => true,
        readOnly: false,
        approvals: new ApprovalStore(),
      });
      const state = await loop.start("自检：改文件并记账", () => undefined);
      assert(state.memoryWritten === true, "record_memory 没打上 memoryWritten 标");
      const falseAlarm = warnLog.filter((w) => w.includes("准则 Step 4"));
      assert(falseAlarm.length === 0, `又误报了：${falseAlarm.join(" / ")}`);
      return `memoryWritten=${state.memoryWritten}`;
      } finally {
        await restoreMem(WORKING_PATH, memBackup);
        await restoreMem(HISTORY_PATH, histBackup);
      }
    });

    await check("循环层：崩溃后恢复（孤儿 tool_call 自动补桩）", async () => {
      // 复刻手机上真实发生的场景：一轮 2 个调用，只回了 1 个，然后进程被杀
      const broken: RunState = {
        runId: "selftest-recovery",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: "running",
        step: 1,
        maxSteps: 6,
        messages: [
          { role: "system", content: "（自检用系统提示）" },
          { role: "user", content: "自检：读两次笔记" },
          {
            role: "assistant",
            content: "",
            tool_calls: [
              { id: "r1", name: "read_file", args: { path: notePath } },
              { id: "r2", name: "read_file", args: { path: notePath } },
            ],
          },
          { role: "tool", tool_call_id: "r1", content: '{"ok":true,"data":{"content":"x"}}' },
          // r2 的结果丢了 —— 真实崩溃就是这样
        ],
        appliedOps: [],
        usage: { promptTokens: 0, completionTokens: 0 },
      };

      const loop = makeLoop([{ content: "恢复后跑完了。", toolCalls: [] }]);
      const state = await loop.resume(broken, () => undefined);
      assert(state.status === "done", `恢复后状态是 ${state.status}`);

      const toolIds = state.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
      assert(toolIds.includes("r2"), "丢失的 r2 没有被补桩");
      const reminder = state.messages.find(
        (m) => m.role === "user" && String(m.content).includes("system-reminder"),
      );
      assert(reminder !== undefined, "没有注入 system-reminder");
      assert(String(reminder!.content).includes("中断"), "提醒内容不对");
      await adapter.remove(`${PLUGIN_DIR}/state/${state.runId}.json`).catch(() => undefined);
      return "补桩 1 条 + 注入 1 条提醒";
    });

    await check("面板：token 用量实时上报并格式化成 Mb", async () => {
      const seen: string[] = [];
      const loop = new AgentLoop({
        app,
        provider: {
          chat: async () => ({ content: "好。", toolCalls: [], usage: { promptTokens: 1_200_000, completionTokens: 34_000 } }),
        } as never,
        getConfig: () => cfg,
        pluginDir: PLUGIN_DIR,
        log,
        confirm: async () => true,
        readOnly: false,
        approvals: new ApprovalStore(),
      });
      const state = await loop.start("自检：用量显示", (e) => {
        if (e.type === "usage") seen.push(formatUsage(e.usage.promptTokens, e.usage.completionTokens));
      });
      assert(seen.length === 1, `应上报 1 次，实际 ${seen.length}`);
      assert(seen[0].includes("Mb"), `格式里应有 Mb：${seen[0]}`);
      assert(seen[0].startsWith("1.23 Mb"), `1_234_000 token 应显示 1.23 Mb，实际 ${seen[0]}`);
      await adapter.remove(`${PLUGIN_DIR}/state/${state.runId}.json`).catch(() => undefined);
      return seen[0];
    });

    await check("工作记忆：真实 04/05 能读出来并注入 prompt", async () => {
      const mem = await readMemory(app);
      assert(mem.working.length > 0, "04 的当前活跃任务没读到");
      assert(!mem.working.includes("待处理队列"), "注入范围超了，会把队列也塞进 prompt");
      const block = buildMemoryBlock(mem);
      assert(block.includes("AI/04"), "prompt 块没标来源");
      assert(block.length < 3000, `注入太长：${block.length}`);
      // 真正拼进 system prompt 才算接上了，不然只是模块能跑
      const prompt = buildSystemPrompt(app, "SKILL-BLOCK", block);
      assert(prompt.includes("SKILL-BLOCK"), "skill 块没进 system prompt");
      assert(prompt.includes("当前活跃任务"), "记忆块没进 system prompt");
      return `工作记忆 ${mem.working.length} 字符 / 历史 ${mem.history.length} 字符`;
    });

    await check("检查清单：01 逐条注入、02 只给分组名", async () => {
      const lists = await readChecklists(app);
      const preItems = lists.pre.reduce((n, s) => n + s.items.length, 0);
      const postItems = lists.post.reduce((n, s) => n + s.items.length, 0);
      assert(preItems >= 5, `01 条目太少：${preItems}`);
      assert(postItems >= 5, `02 条目太少：${postItems}`);

      const block = buildChecklistBlock(lists);
      assert(block.includes("Step 1"), "没标明这是准则哪一步");
      assert(block.includes("read_checklist"), "没告诉模型怎么取 02 全文");
      // 02 的细则是「省 token 的关键」：只给分组名，不给条目
      assert(block.length < preItems * 120 + 600, `清单块太长：${block.length}`);

      const prompt = buildSystemPrompt(app, "", "", block);
      assert(prompt.includes("任务开始前逐项确认"), "检查清单没进 system prompt");
      assert(prompt.includes("Step 3"), "02 的 Step 3 提示丢了");
      return `前 ${preItems} 条 / 后 ${postItems} 条，注入 ${block.length} 字符`;
    });

    await check("暂停：ask_user 会让任务停在「等你回话」", async () => {
      const loop = makeLoop([
        { content: "方案：1) 改名 2) 统一标签", toolCalls: [{ id: "au1", name: "ask_user", args: { question: "按这个做吗？" } }] },
        { content: "不该走到这里", toolCalls: [] },
      ]);
      const state = await loop.start("自检：要用户拍板", () => undefined);
      assert(state.status === "awaiting_confirm", `状态是 ${state.status}，应为 awaiting_confirm`);
      return `状态 ${state.status} / ${state.step} 步`;
    });

    await check("上下文瘦身：老的大结果换成占位，最近几条不动", async () => {
      const { contextSize, pruneOldToolResults, shouldPrune } = await import("./prune");
      const big = `{"ok":true,"data":{"content":"${"菜谱内容".repeat(1000)}"}}`;
      // 真实转录是「assistant 发起调用 → tool 结果」交替的；一串连续 tool 消息算同一批，都会被保护
      const msgs: Array<{ role: "assistant" | "tool"; content: string; tool_call_id?: string }> = [];
      for (let i = 0; i < 8; i++) {
        msgs.push({ role: "assistant", content: "" });
        msgs.push({ role: "tool", tool_call_id: `t${i}`, content: big });
      }
      const ctx = contextSize(msgs as never);
      assert(ctx === 8 * big.length, `contextSize 算错了：${ctx}`);
      assert(shouldPrune(ctx, msgs.length), `8 条大结果应触发瘦身，ctx=${ctx}`);
      const r = pruneOldToolResults(msgs as never);
      assert(r.messages.length === msgs.length, "一条消息都不能删（删了工具配对就断）");
      assert(r.pruned === 6, `应瘦身 6 条（保护最近两批），实际 ${r.pruned}`);
      assert(String(r.messages[1].content).includes("已省略"), "占位标记没写进去");
      assert(r.messages[15].content === msgs[15].content, "最近一条必须原样");
      return `省 ${r.savedChars} 字符`;
    });

    await check("批量读：一次调用拿 3 篇，缺一篇不整批失败", async () => {
      const base = `${dir}/批量`;
      await adapter.mkdir(base).catch(() => undefined);
      for (const n of ["a", "b", "c"]) {
        await adapter.write(`${base}/${n}.md`, `# ${n}\n做法${n}`);
      }
      const r = await call(makeCtx(app, log), "read_files", {
        paths: [`${base}/a.md`, `${base}/不存在.md`, `${base}/b.md`],
      });
      assert(r.ok, `批量读整体失败：${r.error}`);
      const d = dataOf(r) as { count: number; requested: number; files: Array<{ ok: boolean }> };
      assert(d.requested === 3, `requested=${d.requested}`);
      assert(d.count === 2, `应读到 2 篇，实得 ${d.count}`);
      assert(d.files.filter((f) => !f.ok).length === 1, "缺失的那篇要单独报错");
      return `3 请求 → ${d.count} 篇`;
    });

    await check("检查清单：read_checklist 能取到 02 全部条目", async () => {
      const r = await call(ctx(), "read_checklist", { kind: "post" });
      assert(r.ok, `read_checklist 失败：${r.error}`);
      const data = dataOf(r);
      assert(Number(data.total) >= 10, `02 条目数不对：${data.total}`);
      return `02 共 ${data.total} 条、${(data.sections as unknown[]).length} 组`;
    });

    await check("skill 加载器：真实 skills/ 目录能扫出索引", async () => {
      const skills = await scanSkills(app);
      assert(skills.length > 0, "一个 skill 都没扫到");
      const index = buildSkillIndex(skills);
      assert(index.includes("use_skill"), "索引里没告诉模型怎么读全文");
      // 索引必须是「名字+一句话」，不能把正文塞进 prompt
      assert(index.length < skills.length * 200, `索引太长（${index.length} 字符），可能混进正文了`);
      // 真扫到的名字必须出现在索引里，否则等于没告诉模型
      assert(index.includes(skills[0].name), `索引里没有 ${skills[0].name}`);
      return `${skills.length} 个 skill，索引 ${index.length} 字符`;
    });

    await check("skill 规范（agentskills.io）：SKILL.md 布局、折叠描述、不合规只警告", async () => {
      const { parseSkillMeta, isSkillManifest } = await import("./skills");
      // 规范布局
      const ok = parseSkillMeta(
        "skills/note-titler/SKILL.md",
        ["---", "name: note-titler", "description: >", "  给笔记起标题，", "  用户说「起个标题」时用。", "---", ""].join(
          "\n",
        ),
      );
      assert(isSkillManifest(ok.path), "SKILL.md 没被认成规范布局");
      assert(ok.name === "note-titler", `name 读错了：${ok.name}`);
      assert(ok.description.includes("起个标题"), `折叠描述读错了：${ok.description}`);
      assert((ok.warnings ?? []).length === 0, `合规的写法不该有警告：${(ok.warnings ?? []).join("；")}`);
      // 旧布局 + 中文名字：照样能用，但要有警告
      const legacy = parseSkillMeta("skills/面试复习.md", ["---", "name: 面试复习", "description: 一题一题过", "---"].join("\n"));
      assert(legacy.name === "面试复习", "旧布局的名字读不出来");
      assert((legacy.warnings ?? []).length >= 2, `旧布局应至少两条警告：${(legacy.warnings ?? []).join("；")}`);
      // 真实库里的 skill 全部列出警告（不改文件，只报告）
      const real = await scanSkills(app);
      const dirty = real.filter((s) => (s.warnings ?? []).length > 0);
      return `规范 ${real.length - dirty.length} / 待整理 ${dirty.length}`;
    });

    await check("skill 加载器：use_skill 能读回真实正文", async () => {
      const skills = await scanSkills(app);
      const r = await call(ctx(), "use_skill", { name: skills[0].name });
      assert(r.ok, `use_skill 失败：${r.error}`);
      const body = String(dataOf(r).body ?? "");
      assert(body.length > 20, `正文太短：${body.length}`);
      assert(!body.startsWith("---"), "frontmatter 应被去掉");
      return `${skills[0].name}：${body.length} 字符`;
    });

    await check("语义层：按标签找笔记（真实库）", async () => {
      const r = await call(ctx(), "search_by_tag", { tag: "android", limit: 200 });
      assert(r.ok, `search_by_tag 失败：${r.error}`);
      const data = dataOf(r);
      assert(typeof data.count === "number", "缺 count");
      return `android 标签命中 ${data.count} 篇`;
    });

    await check("语义层：按 frontmatter 找笔记（真实库）", async () => {
      const r = await call(ctx(), "list_by_frontmatter", { key: "title", limit: 200 });
      assert(r.ok, `list_by_frontmatter 失败：${r.error}`);
      const data = dataOf(r);
      assert(Number(data.count) > 0, "真实库里带 title 的笔记不该是 0");
      return `带 title 的笔记 ${data.count} 篇`;
    });

    await check("语义层：移动笔记（真机 fileManager 路径）", async () => {
      // 必须放在 vault 索引范围内：.obsidian/ 不被索引，fileManager 拿不到 TFile
      const dir = "_selftest-tmp";
      const from = `${dir}/move-a.md`;
      const to = `${dir}/move-b.md`;
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      await adapter.write(from, "# 自检\n\n移动测试。");
      // fileManager 走的是 vault 索引，刚写的文件需要等索引刷新
      await new Promise((r) => setTimeout(r, 300));
      const r = await call(ctx(), "move_note", { from, to });
      assert(r.ok, `move_note 失败：${r.error}`);
      assert(await adapter.exists(to), "目标文件不存在");
      assert(!(await adapter.exists(from)), "原文件还在");
      await adapter.remove(to).catch(() => undefined);
      await adapter.remove(from).catch(() => undefined);
      await adapter.rmdir(dir, true).catch(() => undefined);
      return "移动并改名成功";
    });

    await check("删除：走回收站，空目录/非空目录规则正确", async () => {
      const dir = "_selftest-tmp";
      if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
      const one = `${dir}/trash-me.md`;
      const two = `${dir}/trash-me-2.md`;
      await adapter.write(one, "# 待删\n");
      await adapter.write(two, "# 待删\n");
      await new Promise((r) => setTimeout(r, 300));

      const r1 = await call(ctx(), "trash_note", { path: one });
      assert(r1.ok, `trash_note 失败：${r1.error}`);
      assert(!(await adapter.exists(one)), "文件还在");

      // 非空文件夹必须拒绝
      const r2 = await call(ctx(), "trash_folder", { path: dir });
      assert(!r2.ok, "非空文件夹不该允许直接删");
      assert(String(r2.error).includes("recursive"), "错误提示应指明 recursive");

      const r3 = await call(ctx(), "trash_folder", { path: dir, recursive: true });
      assert(r3.ok, `recursive 删除失败：${r3.error}`);
      assert(!(await adapter.exists(dir)), "文件夹还在");
      return "文件与文件夹都进回收站";
    });

    await check("搜索：backup/ 里的副本不进结果", async () => {
      const r = await call(ctx(), "search", { query: "火锅" });
      assert(r.ok, `search 失败：${r.error}`);
      const files = (dataOf(r).hits ?? []) as Array<{ path: string }>;
      const bad = files.filter((h) => h.path.startsWith("backup/"));
      assert(bad.length === 0, `backup/ 混进结果：${bad.map((b) => b.path).join(",")}`);
      return `${files.length} 条命中，无 backup/ 噪音`;
    });

    await check("准则守卫：AI 配置与 skills 绝对禁止，首页类需确认", async () => {
      const denied = ["AI/00-总指令.md", "AI/03-修改记录.md", "skills/000-AI-框架核心.md"];
      for (const p of denied) {
        assert(checkProtected(p)?.level === "deny", `${p} 应绝对禁止`);
      }
      const consent = ["首页.md", "知识地图.md", "📋 任务看板.md", "templates/模板.md"];
      for (const p of consent) {
        assert(checkProtected(p)?.level === "confirm", `${p} 应需确认`);
      }
      assert(checkProtected("knowledge/tech/java/_index.md") === null, "普通笔记不该被拦");
      return `${denied.length} 禁止 / ${consent.length} 需确认`;
    });

    await check("修改记录：一次任务记一条，含时间与影响文件", async () => {
      const fake = {
        runId: "selftest-run",
        step: 2,
        messages: [{ role: "user", content: "自检任务" }],
        appliedOps: [
          { tool: "patch_file", path: "a.md", at: 1 },
          { tool: "patch_file", path: "a.md", at: 2 },
        ],
      } as never;
      const text = buildRecord(fake, Date.now());
      assert(text.includes("自检任务"), "缺任务名");
      assert(text.includes("改动 1 个文件"), "影响文件没去重");
      assert(text.includes("selftest-run"), "缺 runId");
      assert(CHANGELOG_PATH === "AI/03-修改记录.md", "记录路径不对");
      return "字段齐全";
    });

    await check("会话：新建/切换/标题/删除都没串味", async () => {
      const h = new ChatHistory(adapter, `${PLUGIN_DIR}/selftest-sessions.json`, log);
      await h.createSession();
      await h.append({ role: "user", content: "自检会话甲", at: Date.now() });
      const second = await h.createSession();
      await h.append({ role: "user", content: "自检会话乙", at: Date.now() });

      assert(h.list().length >= 2, "应有多个会话");
      assert(h.current()?.id === second.id, "当前会话不对");
      assert(h.current()?.title === "自检会话乙", `标题不对：${h.current()?.title}`);

      const firstId = h.list().find((s) => s.id !== second.id)!.id;
      await h.open(firstId);
      assert(h.recent()[0].content === "自检会话甲", "切换后内容串味了");

      await h.setRunId("selftest-run-2");
      await h.remove(second.id);
      await adapter.remove(`${PLUGIN_DIR}/selftest-sessions.json`).catch(() => undefined);
      return `${h.list().length} 个会话`;
    });

    await check("对话历史：落盘后新实例能读回（重启场景）", async () => {
      const path = `${PLUGIN_DIR}/chat-history-selftest.json`;
      const store = new ChatHistory(adapter, path, log);
      await store.append({ role: "user", content: "自检第一句", at: Date.now() });
      await store.append({ role: "assistant", content: "自检第一答", at: Date.now() });
      assert((await adapter.exists(path)) === true, "历史文件没落盘");

      const fresh = new ChatHistory(adapter, path, log);
      const entries = await fresh.load();
      assert(entries.length === 2, `读回 ${entries.length} 条，应为 2`);
      assert(entries[0].content === "自检第一句", "内容不一致");
      const recent = fresh.recent(5);
      assert(recent.length === 2 && recent[1].content === "自检第一答", "recent 不对");

      await adapter.remove(path).catch(() => undefined);
      return "2 条历史写入 → 新实例读回一致";
    });

    await check("循环层：空回复会重试而不是静默完成", async () => {
      const script: Completion[] = [
        { content: "", toolCalls: [] }, // 第一次空
        { content: "这次说清楚了。", toolCalls: [] },
      ];
      const loop = new AgentLoop({
        app,
        provider: { chat: async () => script.shift() ?? { content: "兜底", toolCalls: [] } } as never,
        getConfig: () => cfg,
        pluginDir: PLUGIN_DIR,
        log,
        confirm: async () => true,
        readOnly: false,
        approvals: new ApprovalStore(),
      });
      const state = await loop.start("自检：空回复重试", () => undefined);
      assert(state.status === "done", `状态是 ${state.status}`);
      assert(state.emptyReplies === 1, `应记录重试 1 次，实际 ${state.emptyReplies}`);
      await adapter.remove(`${PLUGIN_DIR}/state/${state.runId}.json`).catch(() => undefined);
      return "空一次 → 重试 → 完成";
    });

    await check("循环层：连续两次空回复判定失败", async () => {
      const loop = new AgentLoop({
        app,
        provider: { chat: async () => ({ content: "  ", toolCalls: [] }) } as never,
        getConfig: () => cfg,
        pluginDir: PLUGIN_DIR,
        log,
        confirm: async () => true,
        readOnly: false,
        approvals: new ApprovalStore(),
      });
      const state = await loop.start("自检：连续空回复", () => undefined);
      assert(state.status === "failed", `不能把空回复当完成，实际 ${state.status}`);
      assert(String(state.error ?? "").includes("空内容"), `原因应说清：${state.error}`);
      await adapter.remove(`${PLUGIN_DIR}/state/${state.runId}.json`).catch(() => undefined);
      return "两次空 → 明确失败";
    });

    await check("循环层：多轮上下文被带进 prompt", async () => {
      let seen: Array<{ role: string; content?: string }> = [];
      const loop = new AgentLoop({
        app,
        provider: {
          chat: async (messages: Array<{ role: string; content?: string }>) => {
            seen = messages.map((m) => ({ ...m }));
            return { content: "记得。", toolCalls: [] };
          },
        } as never,
        getConfig: () => cfg,
        pluginDir: PLUGIN_DIR,
        log,
        confirm: async () => true,
        readOnly: false,
        approvals: new ApprovalStore(),
      });
      const state = await loop.start(
        "第二句：它是什么？",
        () => undefined,
        [
          { role: "user", content: "第一句：帮我看看 知识地图" },
          { role: "assistant", content: "它是你的导航中心。" },
        ],
      );
      assert(state.status === "done", `状态是 ${state.status}`);
      const roles = seen.map((m) => m.role);
      assert(
        JSON.stringify(roles) === JSON.stringify(["system", "user", "assistant", "user"]),
        `消息顺序不对：${roles.join(",")}`,
      );
      assert(String(seen[3].content).includes("第二句"), "当前输入不在最后");
      assert(String(seen[1].content).includes("第一句"), "历史没带进来");
      await adapter.remove(`${PLUGIN_DIR}/state/${state.runId}.json`).catch(() => undefined);
      return `${roles.length} 条消息，历史已带入`;
    });

    await check("循环层：工具连续失败 3 次会熔断", async () => {
      const bad = { content: "", toolCalls: [{ id: "f1", name: "read_file", args: { path: "不存在的笔记.md" } }] };
      // 每次都返回同一个失败调用
      const loop = new AgentLoop({
        app,
        provider: { chat: async () => bad } as never,
        getConfig: () => cfg,
        pluginDir: PLUGIN_DIR,
        log,
        confirm: async () => true,
        readOnly: false,
        approvals: new ApprovalStore(),
      });
      const state = await loop.start("自检：故意失败", () => undefined);
      assert(state.status === "failed", `应该失败，实际 ${state.status}`);
      assert(String(state.error ?? "").includes("3 次"), `错误信息不对：${state.error}`);
      await adapter.remove(`${PLUGIN_DIR}/state/${state.runId}.json`).catch(() => undefined);
      return `熔断生效：${state.error}`;
    });

  } finally {
    // 清理：自检产物不留痕
    await adapter.rmdir(dir, true).catch(() => undefined);
    await adapter.rmdir(`${SPILL_DIR}/selftest`, true).catch(() => undefined);
    const report: SelfTestReport = {
      startedAt,
      finishedAt: new Date().toISOString(),
      pass: steps.filter((s) => s.ok).length,
      fail: steps.filter((s) => !s.ok).length,
      steps,
    };
    try {
      await adapter.write(SELFTEST_REPORT, JSON.stringify(report, null, 2));
    } catch (e) {
      log.error(`[自检] 写报告失败：${e instanceof Error ? e.message : String(e)}`);
    }
    return report;
  }
}
