import type { App } from "obsidian";
import { ApprovalStore } from "./approvals";
import { CHANGELOG_PATH, appendRecord } from "./changelog";
import { describeChange } from "./changes";
import { buildSkillIndex, scanSkills, type SkillMeta } from "./skills";
import { HISTORY_TURN_CAP } from "./budgets";
import { slimHistory } from "./trim";
import {
  buildChecklistBlock,
  buildMemoryBlock,
  compactWorkingFile,
  HISTORY_PATH,
  readChecklists,
  readMemory,
  WORKING_PATH,
  type MemoryBundle,
} from "./memory";
import { repairToolPairing } from "./pairing";
import { contextSize, pruneOldToolResults, shouldPrune, worthPruning } from "./prune";
import { interruptedReminder, systemReminder } from "./reminder";
import { serializeToolResult } from "./serialize";
import { ApiError, Provider } from "./provider";
import { executeTool, getToolSpecs, toolNames, type ToolContext } from "./tools";
import { AWAITING_HINT } from "./types";
import type { AgentConfig, ChatMessage, Completion, HistoryTurn, LoopEvent, RunState, ToolCall, Usage } from "./types";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 写文件类工具，用于统计「这次 run 动了哪些文件」 */
/**
 * 「改动了 Vault」的工具。移动和删除也算——它们改的是目录结构，
 * 漏掉的话 AI/03 修改记录里会少一半事实（真机踩过：11 次 move_note 一条没记）。
 *
 * record_memory 故意不在里面：写 04/05 是插件的记账行为，不是用户的文件改动，
 * 混进来会让「改动 N 个文件」虚高。它用 state.memoryWritten 单独表示。
 */
const WRITE_TOOLS = new Set([
  "patch_file",
  "create_note",
  "write_file",
  "move_note",
  "trash_note",
  "trash_folder",
]);

export function buildSystemPrompt(app: App, skillBlock = "", memoryBlock = "", checklistBlock = ""): string {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const vaultName = (app.vault as unknown as { getName?: () => string }).getName?.() ?? "当前库";

  return `你是运行在 Obsidian 手机端里的文件助手。用户用自然语言下达指令，你通过工具直接读写这个 Vault。

今天日期：${date}
Vault 名称：${vaultName}
可用工具：${toolNames().join("、")}

${memoryBlock ? `${memoryBlock}\n` : ""}${checklistBlock ? `${checklistBlock}\n` : ""}

## 工作原则（必须遵守）

1. **先读后改**。修改任何文件前，先用 read_file 看原文。不要凭印象改。
2. **最小改动**。只改用户要求的部分，不要顺手重排格式、改标点、补内容。
3. **优先 patch_file**。它做精确替换，安全且省 token。只有当内容需要整体重写时才用 write_file。**old 必须是从行首到行尾的完整一行（或多行连续完整行），不能只写半句**——只写半句永远匹配不上。
4. **路径必须真实存在**。不确定路径就先 list_files 或 search，不要猜。
5. **路径用相对形式**，如 \`读书/置身事内.md\`。不要用绝对路径，不要用 \`..\`。
6. **不要碰 \`.obsidian/\`**。那是插件配置目录，改了会破坏用户的 Obsidian。
7. **密钥类文件会被拒绝**。文件名含 .env / credentials / id_rsa / *.pem 等的文件一律拒绝访问（包括读取），这是有意为之，不要换路径重试，也不要猜内容。
8. **一次只做一件事**。用户的指令包含多步时，按顺序做，每步做完再做下一步。
9. **不要自己改 \`AI/03-修改记录.md\`**。任务结束由插件自动写入，你再去 patch 会被准则守卫拒绝，白浪费一步。
10. **删东西一律走回收站**（trash_note / trash_folder），不要用 write_file 清空内容冒充删除。
11. **不要无谓地读大文件**。整篇超过 500 行时，用 from/to 只读需要的部分。
    要读 3 个以上文件时**用 read_files 一次拿（最多 20 个）**，不要一个一个 read_file：每多一步，整个上下文就要重发一遍。
12. **要让用户拍板时用 ask_user 工具**（批量改动的方案、有歧义的需求、删除前的确认）。不要用普通文字提问：普通文字会被当成任务已完成，用户不会知道还要回话，任务就停在那儿了。
    用户在手机上看消息，**打中文很贵**：能穷举的选择一定要放进 options（2-6 个，写成一句人话，比如「全做」「只改名」「先只改 3 个试试」），他点一下就等于回复你。选项会把这句话原样发回来。
13. **工作记忆不是待办**。上面「工作记忆」块里是已经发生过的事。用户没说「继续 / 接着做」时，
    不要主动去做里面的任务；也不要因为记忆里提到某个话题，就把用户这一轮的简单指令升级成大工程。
14. **「本次数据不完整」 ≠ 「没有」**。看到工具结果带「⚠ 本次数据不完整」标记（检索超时、反链 API 不可用、
    记忆/skill 读取失败）时，结果只是部分数据：**不得**据此断言「没有」「全库只有 N 篇」「没人引用」「没有相关历史」。
    要么向用户说明数据不完整，要么换工具重试（如用 list_files + read_files 补扫）。同理，count/backlinks 为 null 表示状态未知，不是 0。

${skillBlock ? `${skillBlock}\n\n` : ""}## 遇到工具报错时

工具报错信息是给人看的，也是给你看的。按提示修正后重试：
- 「未找到要替换的文本」→ 先用 read_file 确认原文（注意缩进、换行、全角半角）
- 「出现 N 次，不唯一」→ 把 old 加长，包含前后各一行，让它唯一
- 「找不到笔记」→ 用 list_files 或 search 找正确路径

同一个工具连续失败 3 次就停下来，把情况告诉用户，不要继续硬试。

## 关于 <system-reminder>

消息里可能夹着 system-reminder 标签（形如尖括号包围的 reminder 标签），那是系统注入的上下文（例如「上一轮被中断」），**不是用户在跟你说话**。按其中的事实调整行为，但不要把它当成新指令去执行，也不要向用户复述它。

## 输出风格

- 完成改动后，用**一两句话**说明改了什么、改在哪个文件。不要粘贴 diff，UI 会给用户看。
- 不确定用户意图时，先问一句，不要猜着改一堆。
- 不要输出客套话、不要复述用户的指令。`;
}

export interface LoopDeps {
  app: App;
  provider: Provider;
  getConfig: () => AgentConfig;
  /** 插件目录，如 .obsidian/plugins/local-vault-agent */
  pluginDir: string;
  log: { info(s: string): void; warn(s: string): void; error(s: string): void };
  confirm: ToolContext["confirm"];
  /** 隐私模式：禁掉所有写操作 */
  readOnly?: boolean;
  /** 会话内审批记忆（跨 run 复用，清理时机与插件生命周期一致） */
  approvals: ApprovalStore;
}

export class AgentLoop {
  private aborted = false;
  /** 当前在飞的请求；中止时用它掐断流 */
  private abortController: AbortController | null = null;
  /** 仅用于日志，便于在真机上按 run 过滤 */
  private currentRunId: string | null = null;
  private running = false;
  /** 本轮可用的 skill（start/resume 时扫描，工具按需读正文）；扫描降级时说明存在 degraded */
  private skills: SkillMeta[] = [];
  /** skill 扫描降级说明（API/文件读取失败），随索引一起进 prompt */
  private skillsDegraded = "";
  /** 上一次记下的 skill 规范清单，用来去重 */
  private lastSkillWarning = "";
  /** 本轮注入 prompt 的工作记忆（04 活跃任务 + 05 最近一条） */
  private memory: MemoryBundle = { working: "", history: "" };
  /** Step 1/3 的检查清单（解析后压缩，不塞全文） */
  private checklists: Awaited<ReturnType<typeof readChecklists>> = { pre: [], post: [] };

  constructor(private readonly deps: LoopDeps) {}

  get isRunning(): boolean {
    return this.running;
  }

  abort(): void {
    this.aborted = true;
    // 流式请求正在读 SSE，光设标志要等它读完；这里直接掐断连接
    this.abortController?.abort();
    this.abortController = null;
  }

  // -------------------------------------------------------------------------
  // 入口
  // -------------------------------------------------------------------------

  async start(userText: string, onEvent: (e: LoopEvent) => void, history: HistoryTurn[] = []): Promise<RunState> {
    if (this.running) throw new Error("已有任务在运行，请先中止或等待完成。");
    const slimmed = slimHistory(history);
    if (slimmed.dropped > 0 || history.some((h) => h.content.length > HISTORY_TURN_CAP)) {
      this.deps.log.info(
        `历史瘦身：${history.length} 条 → ${slimmed.turns.length} 条，保留 ${slimmed.chars} 字符` +
          `（丢 ${slimmed.dropped} 条最旧的${history.some((h) => h.content.length > HISTORY_TURN_CAP) ? "，长的已截断" : ""}）`,
      );
    }
    this.aborted = false;
    this.running = true;
    await this.refreshContext();

    const state: RunState = {
      runId: makeRunId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      status: "running",
      step: 0,
      maxSteps: this.deps.getConfig().maxSteps,
      messages: [
        { role: "system", content: buildSystemPrompt(
            this.deps.app,
            buildSkillIndex(this.skills, this.skillsDegraded || undefined),
            buildMemoryBlock(this.memory),
            buildChecklistBlock(this.checklists),
          ) },
        // 上一轮说过的话带进来，否则「把它改成…」里的「它」无处可指。
        // 按字符预算瘦身：条数上限挡不住「一条就是两千字表格」的情况
        ...slimmed.turns.map((h) => ({ role: h.role, content: h.content })),
        { role: "user", content: userText },
      ],
      appliedOps: [],
      usage: { promptTokens: 0, completionTokens: 0 },
    };
    // messages 的最后一条就是用户这句；本轮回答只在这里之后找
    state.turnStart = state.messages.length - 1;

    // 发送即落盘：以前第一次存档要等到第一个工具调用前，任务在最开始的
    // 模型调用期间被杀，checkpoint 里连「用户要什么」都没有，续跑无从谈起。
    await this.saveState(state).catch(() => undefined);

    try {
      await this.drive(state, onEvent);
    } finally {
      this.running = false;
    }
    return state;
  }

  /**
   * 每次任务开始/恢复都重新读一遍注入材料。
   *
   * 曾经这里只有 start() 读了 skills 和 memory，checklists 只在 resume() 里读——
   * 结果真实任务跑起来时清单块是空的，自检却因为走了另一条路全绿。
   * 三份材料必须同进同出，所以收成一个函数。
   */
  private async refreshContext(): Promise<void> {
    // 用户可能刚改过 skills/ 里的 md，每轮重新扫
    const scan = await scanSkills(this.deps.app);
    this.skills = scan.skills;
    this.skillsDegraded = scan.degraded ?? "";
    const dirtySkills = this.skills.filter((s) => (s.warnings ?? []).length > 0);
    // 规范检查只记一次：用户改完 skill 之后能知道哪里不合 agentskills.io 的规矩
    if (dirtySkills.length > 0) {
      const msg =
        `skill 规范检查：${dirtySkills.length}/${this.skills.length} 个待整理 — ` +
        dirtySkills.map((s) => `${s.name}（${(s.warnings ?? [])[0]}）`).join("；");
      // 同一份清单只记一次：refreshContext 每轮都跑，重复写日志等于噪音
      if (msg !== this.lastSkillWarning) {
        this.lastSkillWarning = msg;
        this.deps.log.warn(msg);
      }
    }
    // 先把 04 里老的清进 05，再读——否则模型看到的还是那堆越攒越长的旧任务
    if (this.deps.readOnly !== true) {
      try {
        const { archived, dropped } = await compactWorkingFile(this.deps.app);
        if (archived > 0 || dropped > 0) {
          this.deps.log.info(
            `04 清理：挪 ${archived} 条老任务到 05${dropped > 0 ? `，丢掉 ${dropped} 条自检记录` : ""}`,
          );
        }
      } catch (e) {
        this.deps.log.warn(`04 清理失败（不影响任务）：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.memory = await readMemory(this.deps.app);
    this.checklists = await readChecklists(this.deps.app);
  }

  /** 从 checkpoint 继续。注意：绝不自动调用，必须由用户确认。 */
  async resume(state: RunState, onEvent: (e: LoopEvent) => void): Promise<RunState> {
    if (this.running) throw new Error("已有任务在运行。");
    this.aborted = false;
    this.running = true;
    await this.refreshContext();
    state.status = "running";
    state.pendingToolCall = undefined;
    // 用户已经答过了，旧问题不能留在 checkpoint 里，否则面板会再弹一次
    state.pendingQuestion = undefined;
    state.error = undefined;
    // 本轮起点重置到当前消息末尾：不重置的话 finalAnswer 会把暂停前的
    // 旧回答又取一遍，用户看到「任务失败」却附着一整段上轮的回复
    state.turnStart = state.messages.length - 1;
    try {
      await this.drive(state, onEvent);
    } finally {
      this.running = false;
    }
    return state;
  }

  // -------------------------------------------------------------------------
  // 主循环
  // -------------------------------------------------------------------------

  private async drive(state: RunState, onEvent: (e: LoopEvent) => void): Promise<void> {
    this.currentRunId = state.runId;
    const ctx = this.makeToolContext(state);
    ctx.requestPause = (q) => {
      state.status = "awaiting_confirm";
      state.pendingQuestion = q;
    };
    ctx.markMemory = () => {
      state.memoryWritten = true;
    };
    const tools = getToolSpecs(ctx);
    let consecutiveFailures = 0;

    while (true) {
      if (this.aborted) {
        state.status = "aborted";
        onEvent({ type: "status", text: "已中止" });
        break;
      }
      if (state.step >= state.maxSteps) {
        state.status = "failed";
        state.error = `达到最大步数 ${state.maxSteps}，已停止。任务可能只做了一半——说「继续」可以接着跑。`;
        onEvent({
          type: "status",
          text: `已达 ${state.maxSteps} 步上限，任务可能未完成；说「继续」可接着跑`,
        });
        break;
      }

      state.step++;
      onEvent({ type: "status", text: `第 ${state.step} 步：思考中…` });

      // 发请求前修一次配对：恢复的 checkpoint 可能本身就是从中间断的
      const repaired = repairToolPairing(state.messages);
      if (repaired.report.synthesized > 0 || repaired.report.dropped > 0) {
        state.messages = repaired.messages;
        this.deps.log.warn(
          `[${state.runId}] 修复工具调用配对：补 ${repaired.report.synthesized} 条，删 ${repaired.report.dropped} 条`,
        );
        // 用旁路通道告诉模型「那些调用没生效」，不要塞进 user 消息冒充用户指令
        if (repaired.report.synthesized > 0) {
          state.messages.push(interruptedReminder(repaired.report.synthesized));
        }
      }

      // 上下文瘦身：读过的文件全文不必每轮重发（真机实测 9 步能省掉三分之二）
      const ctxChars = contextSize(state.messages);
      if (shouldPrune(ctxChars, state.messages.length)) {
        const r = pruneOldToolResults(state.messages);
        if (worthPruning(r)) {
          state.messages = r.messages;
          this.deps.log.info(
            `[${state.runId}] 上下文瘦身：${r.pruned} 条工具结果改成占位，省 ${r.savedChars} 字符（上下文 ${ctxChars}）`,
          );
        }
      }

      let completion: Completion;
      try {
        completion = await this.callModel(state.messages, tools, onEvent);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        state.status = "failed";
        state.error = msg;
        this.deps.log.error(`[${state.runId}] 模型调用失败：${msg}`);
        onEvent({ type: "error", message: msg });
        break;
      }

      accumulateUsage(state, completion.usage);
      // 实时上报：面板据此刷新消耗，不必等任务结束
      onEvent({ type: "usage", usage: state.usage });

      if (completion.content) {
        onEvent({ type: "assistant", text: completion.content });
      }

      if (completion.toolCalls.length === 0) {
        // 空回复（既无文字也无工具调用）不是「完成」，是模型掉线或输出被吞。
        // 以前直接标 done，用户看到的是「修改 0 个文件」的静默失败。
        const empty = completion.content.trim() === "";
        if (empty && (state.emptyReplies ?? 0) < 1) {
          state.emptyReplies = (state.emptyReplies ?? 0) + 1;
          state.messages.push({ role: "assistant", content: "（空回复）" });
          state.messages.push(
            systemReminder(
              "你上一条回复是空的：既没有文字，也没有调用任何工具。请继续完成任务；如果任务已经做完，请明确说明做了什么。",
            ),
          );
          onEvent({ type: "status", text: "模型返回空内容，正在重试…" });
          continue;
        }
        if (empty) {
          state.status = "failed";
          state.error =
            `模型连续两次返回空内容。已消耗的 token：${state.usage.completionTokens}。` +
            "如果是思考型模型，多半是 token 预算被推理占满——去设置里把 maxTokens 调大（比如 16000），或把任务拆小。";
          onEvent({ type: "error", message: state.error });
          break;
        }
        state.status = "done";
        state.messages.push({ role: "assistant", content: completion.content });
        break;
      }

      state.messages.push({
        role: "assistant",
        content: completion.content,
        tool_calls: completion.toolCalls,
      });

      // 输出被长度上限截断时，工具参数是不完整的 JSON。执行它等于掷骰子，
      // 而且模型会把「参数缺失」误判成路径写错，白烧几轮。整批判失败更诚实。
      // OpenAI 系返回 "length"，Anthropic 兼容层可能返回 "max_tokens"。
      const truncated = completion.finishReason === "length" || completion.finishReason === "max_tokens";

      for (const call of completion.toolCalls) {
        if (this.aborted) break;

        // 先落盘再执行：这样即使执行到一半被杀，也能看到「打算做什么」
        state.pendingToolCall = call;
        await this.saveState(state).catch(() => undefined);

        onEvent({ type: "tool_start", tool: call.name, args: call.args });
        const startedAt = Date.now();
        let result: { ok: boolean; data?: unknown; error?: string };
        if (truncated) {
          result = {
            ok: false,
            error: "模型输出被长度上限截断，该工具参数不完整，本次未执行。请减少单次输出量，或把操作拆成多次。",
          };
        } else {
          try {
            result = await executeTool(call, ctx);
          } catch (e) {
            // executeTool 内部已兜住，这里只是最后一道保险
            result = { ok: false, error: e instanceof Error ? e.message : String(e) };
          }
        }
        // changedFiles 同步进存档：续跑时安全阀的计数从这里恢复，不跟着清零
        state.changedFiles = [...ctx.changedFiles];
        const ms = Date.now() - startedAt;

        state.messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: await this.serializeForModel(call.name, state, result),
        });

        if (result.ok && WRITE_TOOLS.has(call.name)) {
          // 不同工具的路径参数名不一样：move_note 用 from/to，删除类用 path。
          // 取不到就会在 AI/03 里留下 `undefined`，所以这里按工具兜底。
          const p = firstString(call.args.path, call.args.from, call.args.to);
          const d = describeChange(call.name, call.args);
          state.appliedOps.push({ tool: call.name, path: p, at: Date.now(), op: d.op, detail: d.detail });
          consecutiveFailures = 0;
        } else if (!result.ok) {
          consecutiveFailures++;
        }

        onEvent({ type: "tool_end", tool: call.name, result, ms });

        if (consecutiveFailures >= 3) {
          state.status = "failed";
          state.error = "连续 3 次工具调用失败，已停止。请检查指令或路径。";
          onEvent({ type: "status", text: state.error });
          break;
        }
      }

      // 本批工具跑完（或被中止/失败提前 break）后立刻补齐配对，
      // 让落盘的 checkpoint 始终自洽——否则下次 resume 必然 400。
      if (completion.toolCalls.length > 0) {
        const after = repairToolPairing(state.messages);
        if (after.report.synthesized > 0) {
          state.messages = after.messages;
          this.deps.log.warn(
            `[${state.runId}] 中断导致 ${after.report.synthesized} 个工具调用没有结果，已补桩`,
          );
        }
      }

      state.pendingToolCall = undefined;
      await this.saveState(state).catch(() => undefined);

      if (state.status === "failed") break;
      if (state.status === "awaiting_confirm") {
        onEvent({ type: "status", text: AWAITING_HINT });
        break;
      }
    }

    state.updatedAt = Date.now();
    await this.saveState(state).catch(() => undefined);

    if (state.status === "done" || state.status === "awaiting_confirm") {
      this.deps.log.info(
      `[${state.runId}] 任务结束：${state.status}，${state.step} 步，改动 ${state.appliedOps.length} 个文件，` +
        `token ${state.usage.promptTokens}+${state.usage.completionTokens}` +
        (state.error ? `，原因：${state.error}` : ""),
    );
    // 准则 Step 4：改了文件就得回写 04/05。插件不代替模型编内容，但必须提醒。
    if (state.appliedOps.length > 0) {
      const touched = new Set(state.appliedOps.map((op) => op.path));
      // 注意：record_memory 写的也是 04/05，但它不进 appliedOps（记账不算文件改动），
      // 所以必须靠 memoryWritten 这个标，否则每轮都会误报「没回写 04/05」。
      const wroteMemory = state.memoryWritten === true;
      if (!wroteMemory && !touched.has(WORKING_PATH) && !touched.has(HISTORY_PATH)) {
        const msg = `改了 ${touched.size} 个文件，但没回写 04/05（准则 Step 4）。需要的话用 record_memory 补一条。`;
        this.deps.log.warn(`[${state.runId}] ${msg}`);
        onEvent({ type: "status", text: msg });
      }
    }

    // 准则第 4 条：改过就记一笔。一次任务一条，不是一次写入一条。
    if (state.appliedOps.length > 0) {
      const wrote = await appendRecord(this.deps.app, state, this.deps.log);
      if (wrote) this.deps.log.info(`[${state.runId}] 已记入 ${CHANGELOG_PATH}`);
    }

    onEvent({ type: "done", state });
    } else if (state.status === "failed" && state.error) {
      onEvent({ type: "error", message: state.error });
    }
  }

  // -------------------------------------------------------------------------
  // 模型调用（带重试）
  // -------------------------------------------------------------------------

  /** 工具结果 → 消息内容（超长时外溢到磁盘，失败退回截断） */
  private async serializeForModel(tool: string, state: RunState, result: unknown): Promise<string> {
    const out = await serializeToolResult(
      { adapter: this.deps.app.vault.adapter, log: this.deps.log },
      tool,
      state.runId,
      state.messages.length,
      result,
    );
    return out.content;
  }

  private async callModel(
    messages: ChatMessage[],
    tools: ReturnType<typeof getToolSpecs>,
    onEvent: (e: LoopEvent) => void,
  ): Promise<Completion> {
    let attempt = 0;
    for (;;) {
      let gotDelta = false;
      // E2 实验（07 文档）需要每次调用的真实 RTT；只有完成时刻没法算耗时
      const startedAt = Date.now();
      try {
        const p = this.deps.provider as {
          chatStream?: (
            m: ChatMessage[],
            t: ReturnType<typeof getToolSpecs>,
            onDelta: (s: string) => void,
            signal?: AbortSignal,
          ) => Promise<Completion>;
          chat: (m: ChatMessage[], t: ReturnType<typeof getToolSpecs>) => Promise<Completion>;
        };
        if (typeof p.chatStream !== "function") {
          const r = await p.chat(messages, tools);
          this.deps.log.info(
            `[${this.currentRunId ?? "-"}] 非流式调用成功：${r.content.length} 字符 / ` +
              `token ${r.usage?.promptTokens ?? 0}+${r.usage?.completionTokens ?? 0} / 耗时 ${Date.now() - startedAt}ms`,
          );
          return r;
        }
        const controller = new AbortController();
        this.abortController = controller;
        try {
          const streamed = await p.chatStream(
            messages,
            tools,
            (text) => {
              // 中止后晚到的字不能再往面板送：abort() 掐断流和 rejection 之间
              // 有一个窗口，这期间的 delta 会渲染在「已中止」的面板上
              if (this.aborted) return;
              gotDelta = true;
              onEvent({ type: "assistant_delta", text });
            },
            controller.signal,
          );
          this.deps.log.info(
            `[${this.currentRunId ?? "-"}] 流式调用成功：${streamed.content.length} 字符` +
              (streamed.toolCalls.length > 0 ? ` / ${streamed.toolCalls.length} 个工具调用` : "") +
              ` / finish=${streamed.finishReason ?? "-"}` +
              ` / 耗时 ${Date.now() - startedAt}ms` +
              (streamed.reasoningChars ? ` / 思考 ${streamed.reasoningChars} 字符` : "") +
              ` / token ${streamed.usage?.promptTokens ?? 0}+${streamed.usage?.completionTokens ?? 0}` +
              (streamed.usage?.cachedTokens ? `（缓存命中 ${streamed.usage.cachedTokens}）` : "") +
              (streamed.maxTokensUsed ? ` / max_tokens ${streamed.maxTokensUsed}` : ""),
          );
          return streamed;
        } catch (streamErr) {
          if (this.aborted) throw new ApiError("已中止", undefined, false);
          // 已经吐过字就不能再退回非流式重发，否则用户会看到内容重复一遍
          if (gotDelta) throw streamErr;
          this.deps.log.warn(
            `流式不可用，退回非流式：${streamErr instanceof Error ? streamErr.message : streamErr}`,
          );
          return await p.chat(messages, tools);
        } finally {
          this.abortController = null;
        }
      } catch (e) {
        // 用户已经中止：绝不能再发起新请求（中止后自动重试等于不听话）
        if (this.aborted) throw e;
        const retryable = e instanceof ApiError && e.retryable;
        if (!retryable || attempt >= 2) throw e;
        const wait = attempt === 0 ? 1000 : 3000;
        attempt++;
        this.deps.log.warn(`模型调用失败，${wait}ms 后重试（第 ${attempt} 次）：${e instanceof Error ? e.message : e}`);
        await sleep(wait);
        if (this.aborted) throw e;
      }
    }
  }

  // -------------------------------------------------------------------------
  // 工具上下文
  // -------------------------------------------------------------------------

  private makeToolContext(state: RunState): ToolContext {
    return {
      app: this.deps.app,
      log: this.deps.log,
      confirm: this.deps.confirm,
      // 续跑时从存档恢复：不恢复的话计数归零，改满 N 个才确认的安全阀重新从 0 数起
      changedFiles: new Set(state.changedFiles ?? []),
      confirmAfterFiles: this.deps.getConfig().confirmAfterFiles,
      readOnly: this.deps.readOnly ?? false,
      runId: state.runId,
      approvals: this.deps.approvals,
      skills: this.skills,
    };
  }

  // -------------------------------------------------------------------------
  // Checkpoint
  // -------------------------------------------------------------------------

  private get stateDir(): string {
    return `${this.deps.pluginDir}/state`;
  }

  private statePath(runId: string): string {
    return `${this.stateDir}/${runId}.json`;
  }

  private async ensureStateDir(): Promise<void> {
    const adapter = this.deps.app.vault.adapter;
    if (!(await adapter.exists(this.stateDir))) {
      await adapter.mkdir(this.stateDir);
    }
  }

  async saveState(state: RunState): Promise<void> {
    await this.ensureStateDir();
    state.updatedAt = Date.now();
    await this.deps.app.vault.adapter.write(this.statePath(state.runId), JSON.stringify(state, null, 2));
  }

  async loadState(runId: string): Promise<RunState | null> {
    const path = this.statePath(runId);
    const adapter = this.deps.app.vault.adapter;
    if (!(await adapter.exists(path))) return null;
    try {
      return JSON.parse(await adapter.read(path)) as RunState;
    } catch {
      return null;
    }
  }

  /** 找出可以续跑的任务（running / awaiting_confirm） */
  async listResumable(): Promise<RunState[]> {
    const adapter = this.deps.app.vault.adapter;
    if (!(await adapter.exists(this.stateDir))) return [];
    const listing = await adapter.list(this.stateDir);
    const out: RunState[] = [];
    for (const f of listing.files) {
      if (!f.endsWith(".json")) continue;
      try {
        const s = JSON.parse(await adapter.read(f)) as RunState;
        if (s.status === "running" || s.status === "awaiting_confirm") out.push(s);
      } catch {
        /* 坏文件跳过 */
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async discard(runId: string): Promise<void> {
    const adapter = this.deps.app.vault.adapter;
    const path = this.statePath(runId);
    if (await adapter.exists(path)) await adapter.remove(path);
  }
}

function makeRunId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}-` +
    Math.random().toString(36).slice(2, 6)
  );
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.trim()) return v;
  return undefined;
}

/** 仅供测试：累加逻辑值得单独钉住（缓存命中字段漏加会静默失真） */
export const accumulateUsageForTest = accumulateUsage;

function accumulateUsage(state: RunState, usage?: Usage): void {
  if (!usage) return;
  state.usage.promptTokens += usage.promptTokens;
  state.usage.completionTokens += usage.completionTokens;
  if (usage.cachedTokens) state.usage.cachedTokens = (state.usage.cachedTokens ?? 0) + usage.cachedTokens;
}
