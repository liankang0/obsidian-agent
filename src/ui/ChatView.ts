import { ItemView, Notice, WorkspaceLeaf } from "obsidian";
import { formatUsage } from "../util/format";
import { SessionModal } from "./SessionModal";
import { changeSummary, groupChanges } from "../agent/changes";
import type { AppliedOp, HistoryTurn, LoopEvent, PendingQuestion } from "../agent/types";
import type ObsidianAgentPlugin from "../main";

export const VIEW_TYPE_AGENT_CHAT = "local-vault-agent-chat";

/**
 * 会话面板。
 *
 * 手机上的取舍：
 * - 单列、无气泡尾巴、字号偏小，尽量多显示内容
 * - 输入框最多 140px，避免键盘弹出后把内容全遮挡
 * - 工具调用只显示一行状态，不展开原始 JSON（要看可以点开）
 */
/**
 * 复制文本。
 * navigator.clipboard 在部分 Android WebView 里需要安全上下文，失败时退回
 * 老的 execCommand 方案——后者虽然过时，但在 WebView 里反而更可靠。
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* 落到回退方案 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export class ChatView extends ItemView {
  private logEl!: HTMLElement;
  private statusEl!: HTMLElement;
  /** 实时 token 消耗（Mb = 百万 token） */
  private usageEl!: HTMLElement;
  private resumeEl!: HTMLElement;
  /** 流式进行中的气泡；结束时定稿成普通消息 */
  private streamEl: HTMLElement | null = null;
  private streamBody: HTMLElement | null = null;
  private lastScrollAt = 0;
  /** 等用户回话时的选项卡片（点选即发送，省掉手机上打中文） */
  private askEl: HTMLElement | null = null;
  /** 当前会话关联的未完成 runId（有值才显示「继续执行」） */
  private resumableRunId: string | null = null;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  /**
   * 跨轮次的对话历史。只存 user/assistant 的纯文本：
   * 带上 tool_calls 会牵出一堆配对问题，而「上一句说了什么」用文本就够。
   */
  private history: HistoryTurn[] = [];
  /** 历史最多带几轮，防止上下文无限膨胀 */
  private static readonly MAX_HISTORY = 12;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: ObsidianAgentPlugin
  ) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_AGENT_CHAT;
  }

  getDisplayText(): string {
    return "Local Vault Agent";
  }

  getIcon(): string {
    return "bot";
  }

  async onOpen(): Promise<void> {
    const root = this.contentEl;
    root.empty();
    root.addClass("oa-chat");

    const head = root.createDiv({ cls: "oa-head" });
    const histBtn = head.createEl("button", { cls: "oa-head__btn", text: "历史" });
    histBtn.addEventListener("click", () => this.openSessionList());
    const newBtn = head.createEl("button", { cls: "oa-head__btn", text: "新对话" });
    newBtn.addEventListener("click", () => void this.switchTo(""));

    this.logEl = root.createDiv({ cls: "oa-chat__log" });
    this.statusEl = root.createDiv({ cls: "oa-status", text: "就绪" });
    // 实时 token 消耗，独立一行右对齐，不挤状态文字
    this.usageEl = root.createDiv({ cls: "oa-usage", text: "0 Mb" });
    // 「继续执行」只在打开的会话确有未跑完的存档时出现
    this.resumeEl = root.createDiv({ cls: "oa-resume" });

    const inputRow = root.createDiv({ cls: "oa-input-row" });
    this.inputEl = inputRow.createEl("textarea", {
      cls: "oa-input",
      attr: { placeholder: "想让 AI 做什么？例如：把 读书/ 下所有笔记的 tag 统一成 #book" },
    });

    const actions = inputRow.createDiv({ cls: "oa-actions" });

    const stopBtn = actions.createEl("button", { text: "中止" });
    stopBtn.addEventListener("click", () => {
      this.plugin.abortRun();
      this.setStatus("已请求中止…");
    });

    this.sendBtn = actions.createEl("button", { text: "发送", cls: "mod-cta" });
    this.sendBtn.addEventListener("click", () => void this.submit());

    // 桌面端 Cmd/Ctrl+Enter 发送；手机上靠按钮
    this.inputEl.addEventListener("keydown", (evt) => {
      if ((evt.metaKey || evt.ctrlKey) && evt.key === "Enter") {
        evt.preventDefault();
        void this.submit();
      }
    });

    // 打开面板时把落盘的历史渲染回来：不然重启一次对话就一片空白
    void this.restoreHistory();

    const clearBtn = actions.createEl("button", { text: "清空" });
    clearBtn.addEventListener("click", () => void this.clearAll());

    this.plugin.registerChatView(this);
  }

  async onClose(): Promise<void> {
    this.plugin.registerChatView(null);
  }

  // ---------------------------------------------------------------------------

  private async submit(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    await this.sendText(text);
  }

  /** 真正的发送路径。选项卡片点一下就走到这里，等于替用户打了那句话。 */
  private async sendText(text: string): Promise<void> {
    if (!text) return;
    if (this.plugin.isRunning()) {
      this.setStatus("已有任务在运行，请先中止。");
      return;
    }
    this.askEl?.remove();
    this.askEl = null;

    this.appendMessage("user", text);
    this.setBusy(true);

    // 发送即落盘：以前这行在 runAgent 之后，任务中途被杀（手机上很常见）
    // 这轮话就从历史里消失了，恢复任务后上下文对不上。
    // 历史写失败不挡任务：内存里仍有 this.history 兜底这一轮的上下文。
    try {
      await this.plugin.chatHistory.append({ role: "user", content: text, at: Date.now() });
      this.history.push({ role: "user", content: text });
    } catch {
      /* 忽略，任务继续 */
    }

    try {
      const answer = await this.plugin.runAgent(text, (e) => this.handleEvent(e), this.history);
      // 把这一轮存进历史：模型最后那段回答（由循环返回，不信 DOM）
      // 落盘 + 内存各存一份：磁盘管「重启后还在」，内存管「这一轮传给模型」
      if (answer) {
        await this.plugin.chatHistory.append({ role: "assistant", content: answer, at: Date.now() });
        this.history.push({ role: "assistant", content: answer });
      }
      if (this.history.length > ChatView.MAX_HISTORY) {
        this.history = this.history.slice(-ChatView.MAX_HISTORY);
      }
    } catch (e) {
      this.appendMessage("error", e instanceof Error ? e.message : String(e));
    } finally {
      this.setBusy(false);
    }
  }

  handleEvent(e: LoopEvent): void {
    switch (e.type) {
      case "assistant":
        // 流式过程中已经画出来了，这里只把最终文本对齐一次（防止中途断流留下的残句）
        if (this.streamEl) this.finalizeStream(e.text);
        else this.appendMessage("assistant", e.text);
        break;
      case "assistant_delta":
        this.appendDelta(e.text);
        break;
      case "tool_start":
        this.finalizeStream();
        this.appendMessage("tool", `▸ ${e.tool}(${summarizeArgs(e.args)})`);
        break;
      case "tool_end":
        this.appendMessage(
          e.result.ok ? "tool" : "error",
          e.result.ok ? `✓ ${e.tool} 完成（${e.ms}ms）` : `✗ ${e.tool} 失败：${e.result.error ?? "未知错误"}`
        );
        break;
      case "usage":
        this.setUsage(e.usage.promptTokens, e.usage.completionTokens);
        break;

      case "status":
        this.setStatus(e.text);
        break;
      case "done":
        if (e.state.status === "awaiting_confirm") {
          // 模型用 ask_user 停了车：直接说「完成」会让用户以为活儿干完了
          this.setStatus("等你回话");
          this.setUsage(e.state.usage.promptTokens, e.state.usage.completionTokens);
          if (e.state.pendingQuestion) this.appendQuestionCard(e.state.pendingQuestion);
          else this.appendSummary("— 已暂停，等你的答复（回一句「按方案做」或给出修改意见即可继续）");
          break;
        }
        this.setStatus(`完成 · ${e.state.step} 步 · 改动 ${e.state.appliedOps.length} 个文件`);
        // 用独立样式：这行是运行汇总，不是模型说的话。
        // 之前和 assistant 共用样式，导致它被当成「上一轮的回答」混进对话历史。
        this.appendSummary(`— 运行结束，共 ${e.state.step} 步，修改 ${uniqueFiles(e.state)} 个文件`);
        this.appendChangesCard(e.state.appliedOps);
        this.setUsage(e.state.usage.promptTokens, e.state.usage.completionTokens);
        break;
      case "error":
        this.appendMessage("error", e.message);
        this.setStatus("出错");
        break;
    }
    this.scrollToBottom();
  }

  appendMessage(kind: "user" | "assistant" | "tool" | "error", text: string): void {
    const el = this.logEl.createDiv({ cls: `oa-msg oa-msg--${kind}` });
    const body = el.createDiv({ cls: "oa-msg__body", text });

    if (kind === "assistant" || kind === "user") this.attachCopy(el, body, text);
    this.scrollToBottom();
  }

  /**
   * 等用户回话时的选项卡片。
   *
   * 手机上打一句「按方案做」要切键盘、可能切输入法；点一下就等于把选项那句话发出去。
   * 只给一个选项时没有意义（一个选项等于命令），那种情况 ask_user 就不该给 options。
   */
  /**
   * 「本轮改动」卡片：手机上一段文字看不出动了什么，列成一行为一个文件。
   *
   * 标题可点折叠。这一度点不动：根因是 .oa-chat__log 少了 min-height:0，
   * 日志区不滚动而是把状态栏顶出可视范围，卡片落在状态栏底下，触摸进不去。
   * 布局修好后点得着了。
   */
  appendChangesCard(ops: AppliedOp[]): void {
    const changes = groupChanges(ops);
    if (changes.length === 0) return;
    const box = this.logEl.createDiv({ cls: "oa-changes" });
    // 用 <button>：面板里能点的东西（发送、复制、选项）都是 button
    const head = box.createEl("button", {
      cls: "oa-changes__head",
      text: `本轮改动 · ${changeSummary(changes)}`,
    });
    const body = box.createDiv({ cls: "oa-changes__body" });
    for (const c of changes) {
      const row = body.createDiv({ cls: "oa-changes__row" });
      for (const o of c.ops) {
        row.createSpan({ cls: "oa-changes__op", text: o.op });
        if (o.detail) row.createSpan({ cls: "oa-changes__detail", text: o.detail });
      }
      row.createDiv({ cls: "oa-changes__path", text: c.path });
    }
    head.addEventListener("click", () => {
      const next = !body.hasClass("is-collapsed");
      body.toggleClass("is-collapsed", next);
      head.toggleClass("is-collapsed", next);
    });
  }

  private appendQuestionCard(q: PendingQuestion): void {
    this.askEl?.remove();
    const outer = this.logEl.createDiv({ cls: "oa-ask" });
    this.askEl = outer;

    const head = outer.createDiv({ cls: "oa-ask__q" });
    head.createSpan({ cls: "oa-ask__icon", text: "?" });
    head.createSpan({ text: q.text });

    const options = q.options ?? [];
    const picked = new Set<string>();
    if (options.length > 0) {
      const row = outer.createDiv({ cls: "oa-ask__opts" });
      for (const opt of options) {
        const btn = row.createEl("button", { cls: "oa-ask__opt", text: opt });
        btn.addEventListener("click", () => {
          if (!q.multiple) {
            void this.sendText(opt);
            return;
          }
          if (picked.has(opt)) {
            picked.delete(opt);
            btn.removeClass("is-picked");
          } else {
            picked.add(opt);
            btn.addClass("is-picked");
          }
          if (!submitBtn) return;
          submitBtn.disabled = picked.size === 0;
          submitBtn.setText(picked.size === 0 ? "提交" : `提交（${picked.size}）`);
        });
      }
      let submitBtn: HTMLButtonElement | null = null;
      if (q.multiple) {
        submitBtn = outer.createEl("button", { cls: "mod-cta oa-ask__submit", text: "提交" });
        // 布尔属性只看「有没有」：setAttr("disabled","false") 依然是禁用，必须用 property
        submitBtn.disabled = true;
        submitBtn.addEventListener("click", () => {
          if (picked.size === 0) return;
          void this.sendText([...picked].join("；"));
        });
      }
    }
    outer.createDiv({
      cls: "oa-ask__hint",
      text: options.length > 0 ? "点一个就行；想改方案也可以直接在下面打字。" : "在下面回一句即可继续。",
    });
    this.scrollToBottom();
  }

  /** 手机上长按选中在 WebView 里很不稳，给一个确定的复制入口 */
  private attachCopy(el: HTMLElement, body: HTMLElement, fallback: string): void {
    const copy = el.createEl("button", { cls: "oa-msg__copy", text: "复制" });
    copy.addEventListener("click", async (evt) => {
      evt.stopPropagation();
      const text = body.textContent ?? fallback;
      const done = await copyText(text);
      copy.textContent = done ? "已复制" : "复制失败";
      new Notice(done ? `已复制 ${text.length} 字` : "复制失败，请长按选中后手动复制");
      setTimeout(() => (copy.textContent = "复制"), 2500);
    });
  }

  /** 流式增量：第一次 delta 才创建气泡，避免空泡 */
  private appendDelta(text: string): void {
    if (!this.streamEl) {
      this.streamEl = this.logEl.createDiv({ cls: "oa-msg oa-msg--assistant oa-msg--streaming" });
      this.streamBody = this.streamEl.createDiv({ cls: "oa-msg__body" });
    }
    this.streamBody?.appendText(text);
    this.scrollToBottomThrottled();
  }

  /** 流结束：把气泡定稿（补复制按钮），之后的 appendMessage 不再复用它 */
  private finalizeStream(finalText?: string): void {
    if (!this.streamEl || !this.streamBody) return;
    if (typeof finalText === "string") this.streamBody.textContent = finalText;
    this.streamEl.removeClass("oa-msg--streaming");
    this.attachCopy(this.streamEl, this.streamBody, this.streamBody.textContent ?? "");
    this.streamEl = null;
    this.streamBody = null;
  }

  private scrollToBottomThrottled(): void {
    const now = Date.now();
    if (now - this.lastScrollAt < 80) return;
    this.lastScrollAt = now;
    this.scrollToBottom();
  }

  /**
   * 渲染自检：往面板里灌一组事件，读回 DOM 验证渲染，然后清掉本次新增的节点。
   *
   * 覆盖「循环 → 面板」这一段。真实键盘输入无法用 adb 可靠模拟（中文打不进去、
   * WebView 的坐标不可信），这一段是能在设备上安全验证的最外层。
   */
  selfTestRender(): string {
    if (!this.logEl || !this.statusEl) throw new Error("面板还没渲染出容器");
    const before = this.logEl.children.length;

    this.handleEvent({ type: "assistant", text: "自检渲染标记-OK" });
    this.handleEvent({ type: "tool_start", tool: "read_file", args: { path: "自检.md" } });
    this.handleEvent({
      type: "tool_end",
      tool: "read_file",
      result: { ok: true, data: { path: "自检.md" } },
      ms: 12,
    });
    this.handleEvent({ type: "status", text: "自检中" });

    const text = this.logEl.textContent ?? "";
    if (!text.includes("自检渲染标记-OK")) throw new Error("assistant 文本没渲染出来");
    if (!text.includes("read_file")) throw new Error("工具调用行没渲染出来");
    if (!text.includes("完成")) throw new Error("工具完成行没渲染出来");
    if ((this.statusEl.textContent ?? "") !== "自检中") throw new Error("状态行没更新");

    // 只看这次新增的节点：面板里可能已经有真实历史，
    // querySelector 会拿到第一条老消息，断言就变成了「碰巧通过」（真机踩过）
    const added = Array.from(this.logEl.children).slice(before);
    const mine = added.find((el) => (el.textContent ?? "").includes("自检渲染标记-OK"));
    if (!mine) throw new Error("assistant 节点没出现在新增节点里");
    const copyBtn = mine.querySelector(".oa-msg__copy");
    if (!copyBtn) throw new Error("消息旁没有复制按钮");
    const bodyText = mine.querySelector(".oa-msg__body")?.textContent ?? "";
    if (!bodyText.includes("自检渲染标记-OK")) throw new Error("消息正文容器没包住文本");

    // 等回话的选项卡片：手机上一按即答，这里确认按钮真的渲染出来了
    this.handleEvent({
      type: "done",
      state: {
        runId: "selftest",
        createdAt: 0,
        updatedAt: 0,
        status: "awaiting_confirm",
        step: 1,
        maxSteps: 20,
        messages: [],
        appliedOps: [],
        usage: { promptTokens: 1, completionTokens: 1 },
        pendingQuestion: { text: "按哪个做？", options: ["全做", "只改名", "先改 3 个试试"] },
      },
    });
    const ask = Array.from(this.logEl.children)
      .slice(before)
      .find((el) => el.classList.contains("oa-ask"));
    if (!ask) throw new Error("等回话的选项卡片没渲染出来");
    const opts = ask.querySelectorAll(".oa-ask__opt");
    if (opts.length !== 3) throw new Error(`选项按钮应有 3 个，实际 ${opts.length}`);
    if (!ask.textContent?.includes("按哪个做？")) throw new Error("卡片里没显示问题本身");
    if (!ask.textContent?.includes("点一个就行")) throw new Error("卡片没有提示怎么操作");

    // 多选分支：要有「提交」按钮，点选项只切换选中态（不发），提交才发
    this.handleEvent({
      type: "done",
      state: {
        runId: "selftest",
        createdAt: 0,
        updatedAt: 0,
        status: "awaiting_confirm",
        step: 1,
        maxSteps: 20,
        messages: [],
        appliedOps: [],
        usage: { promptTokens: 1, completionTokens: 1 },
        pendingQuestion: { text: "做哪几项？", options: ["改名", "打标签"], multiple: true },
      },
    });
    const multi = Array.from(this.logEl.children)
      .slice(before)
      .find((el) => el.classList.contains("oa-ask"));
    if (!multi) throw new Error("多选卡片没渲染出来");
    const submit = multi.querySelector<HTMLButtonElement>(".oa-ask__submit");
    if (!submit) throw new Error("多选卡片没有「提交」按钮");
    if (!submit.disabled) throw new Error("还没选就允许提交了");
    const firstOpt = multi.querySelector<HTMLButtonElement>(".oa-ask__opt");
    firstOpt?.click();
    if (!firstOpt?.classList.contains("is-picked")) throw new Error("点了选项没进入选中态");
    if (submit.disabled) throw new Error("选了之后「提交」还是禁用的");
    if (!submit.textContent?.includes("（1）")) throw new Error(`「提交」没显示已选数：${submit.textContent}`);
    this.askEl = null;

    // 本轮改动卡片：一个文件一行，动作标签 + 说明 + 路径
    this.handleEvent({
      type: "done",
      state: {
        runId: "selftest",
        createdAt: 0,
        updatedAt: 0,
        status: "done",
        step: 2,
        maxSteps: 20,
        messages: [],
        appliedOps: [
          { tool: "patch_file", path: "自检/甲.md", at: 1, op: "改", detail: "+2 −1 行" },
          { tool: "patch_file", path: "自检/甲.md", at: 2, op: "改", detail: "+1 −0 行" },
          { tool: "create_note", path: "自检/乙.md", at: 3, op: "新建", detail: "12 字" },
        ],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    });
    const card = Array.from(this.logEl.children)
      .slice(before)
      .find((el) => el.classList.contains("oa-changes"));
    if (!card) throw new Error("「本轮改动」卡片没渲染出来");
    const rows = card.querySelectorAll(".oa-changes__row");
    if (rows.length !== 2) throw new Error(`同一文件应合并成一行，实际 ${rows.length} 行`);
    if (!card.textContent?.includes("2 个文件")) throw new Error(`标题没统计文件数：${card.textContent?.slice(0, 40)}`);
    if (!card.textContent?.includes("自检/甲.md")) throw new Error("卡片里没显示文件路径");
    if (!card.textContent?.includes("+2 −1 行")) throw new Error("卡片里没显示行数变化");
    // 点标题能折叠：布局修好（min-height:0）之前这里点不动，现在得真的验一遍
    const cardHead = card.querySelector<HTMLElement>(".oa-changes__head");
    const cardBody = card.querySelector(".oa-changes__body");
    if (!cardHead || !cardBody) throw new Error("卡片缺标题行或内容区");
    cardHead.click();
    if (!cardBody.classList.contains("is-collapsed")) throw new Error("点标题没有折叠");
    cardHead.click();
    if (cardBody.classList.contains("is-collapsed")) throw new Error("再点一次没有展开");

    const addedCount = this.logEl.children.length - before;
    while (this.logEl.children.length > before) {
      this.logEl.lastElementChild?.remove();
    }
    this.setStatus("就绪");
    return `渲染 ${addedCount} 个节点，已清理`;
  }

  /** 打开会话列表弹窗 */
  openSessionList(): void {
    const sessions = this.plugin.chatHistory.list();
    new SessionModal(
      this.app,
      sessions,
      (id) => void this.switchTo(id),
      (id) => void this.plugin.chatHistory.remove(id),
    ).open();
  }

  /**
   * 切换到某个会话；传空串表示新建。
   * 这里只负责「看」和「接着聊」，真正的续跑在「继续执行」按钮上。
   */
  async switchTo(id: string): Promise<void> {
    this.logEl.empty();
    this.history = [];
    this.setUsage(0, 0);
    this.hideResume();

    if (!id) {
      await this.plugin.chatHistory.createSession();
      this.setStatus("新对话");
      return;
    }

    const entries = await this.plugin.chatHistory.open(id);
    for (const e of entries) this.appendMessage(e.role, e.content);
    this.history = entries.slice(-ChatView.MAX_HISTORY).map((e) => ({ role: e.role, content: e.content }));
    const session = this.plugin.chatHistory.current();
    this.appendSummary(`— 会话「${session?.title ?? "未命名"}」共 ${entries.length} 条`);
    this.setStatus(entries.length > 0 ? `已载入 ${entries.length} 条` : "空会话");
    await this.refreshResume(session?.runId);
  }

  /** 打开的会话若挂着未完成的存档，显示「继续执行」 */
  async refreshResume(runId?: string): Promise<void> {
    this.resumeEl.empty();
    this.resumableRunId = null;
    if (!runId) return;
    const resumable = await this.plugin.listResumable();
    if (!resumable.some((s) => s.runId === runId)) return;

    this.resumableRunId = runId;
    const btn = this.resumeEl.createEl("button", { cls: "mod-cta", text: "继续执行上次未完成的任务" });
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.setText("继续中…");
      try {
        await this.plugin.resumeRunById(runId, (e) => this.handleEvent(e));
      } finally {
        btn.disabled = false;
        btn.setText("继续执行上次未完成的任务");
        await this.refreshResume(runId);
      }
    });
  }

  private hideResume(): void {
    this.resumableRunId = null;
    this.resumeEl?.empty();
  }

  /** 面板打开时：载入当前会话并恢复渲染 */
  async restoreHistory(): Promise<void> {
    await this.plugin.chatHistory.ensureSession();
    const entries = await this.plugin.chatHistory.load();
    if (entries.length > 0) {
      for (const e of entries) this.appendMessage(e.role, e.content);
      this.appendSummary(`— 已载入 ${entries.length} 条历史对话`);
      this.setStatus(`已载入 ${entries.length} 条历史`);
    }
    this.history = entries.slice(-ChatView.MAX_HISTORY).map((e) => ({ role: e.role, content: e.content }));
    await this.refreshResume(this.plugin.chatHistory.current()?.runId);
  }

  /** 清空当前会话（面板 + 磁盘） */
  async clearAll(): Promise<void> {
    this.history = [];
    this.logEl.empty();
    this.hideResume();
    await this.plugin.chatHistory.clear();
    this.setStatus("对话已清空");
  }

  /** 运行汇总行：和模型回答区分开，避免混进历史 */
  private appendSummary(text: string): void {
    this.logEl.createDiv({ cls: "oa-msg oa-msg--summary", text });
  }

  /** 刷新 token 显示：总量给 Mb，括号里给输入/输出拆分 */
  setUsage(promptTokens: number, completionTokens: number): void {
    if (!this.usageEl) return;
    this.usageEl.setText(formatUsage(promptTokens, completionTokens));
    this.usageEl.setAttr(
      "title",
      `输入 ${promptTokens.toLocaleString()} + 输出 ${completionTokens.toLocaleString()} = ${(promptTokens + completionTokens).toLocaleString()} tokens`,
    );
  }

  setStatus(text: string): void {
    this.statusEl.setText(text);
  }

  private setBusy(busy: boolean): void {
    this.sendBtn.disabled = busy;
    this.sendBtn.setText(busy ? "运行中…" : "发送");
  }

  private scrollToBottom(): void {
    this.logEl.scrollTop = this.logEl.scrollHeight;
  }
}

function summarizeArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    if (k === "content" || k === "old" || k === "new") {
      const s = String(v);
      parts.push(`${k}=<${s.length} 字符>`);
    } else {
      parts.push(`${k}=${String(v)}`);
    }
  }
  return parts.join(", ");
}

function uniqueFiles(state: { appliedOps: Array<{ path?: string }> }): number {
  return new Set(state.appliedOps.map((o) => o.path).filter(Boolean)).size;
}
