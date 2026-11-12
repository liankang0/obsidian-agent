import { Notice, Plugin, PluginSettingTab, Setting, WorkspaceLeaf } from "obsidian";
import { finalAnswer, wantsResume } from "./agent/answer";
import { ChatHistory } from "./agent/history";
import { AgentLoop } from "./agent/loop";
import { Provider } from "./agent/provider";
import type { AgentConfig, HistoryTurn, LoopEvent, RunState } from "./agent/types";
import { ChatView, VIEW_TYPE_AGENT_CHAT } from "./ui/ChatView";
import { confirmChange } from "./ui/DiffModal";
import { pruneStates } from "./agent/states";
import { Logger } from "./util/log";
import { ApprovalStore } from "./agent/approvals";
import { runSelfTest, SELFTEST_FLAG, SELFTEST_REPORT } from "./agent/selftest";


import { configureSpillRoot, spillDir, SPILL_KEEP_DAYS } from "./agent/spill";
import { undoRun, type UndoReport } from "./agent/undo";

const SECRET_ID = "local-vault-agent-api-key";

interface AgentSettings {
  baseUrl: string;
  model: string;
  /** 兜底：SecretStorage 不可用时才用 */
  apiKey: string;
  temperature: number;
  maxTokens: number;
  maxSteps: number;
  confirmAfterFiles: number;
  /** 单次请求超时（毫秒）。非流式=整段上限；流式=无新数据的空闲上限 */
  requestTimeoutMs: number;
  /** 隐私模式：禁用全部写工具 */
  readOnly: boolean;
}

const DEFAULT_SETTINGS: AgentSettings = {
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  apiKey: "",
  temperature: 0.3,
  maxTokens: 8192,
  maxSteps: 20,
  confirmAfterFiles: 5,
  requestTimeoutMs: 90_000,
  readOnly: false,
};

export default class ObsidianAgentPlugin extends Plugin {
  settings!: AgentSettings;
  private apiKey = "";
  private provider!: Provider;
  /** 会话内审批记忆：批准过的目录不再逐次弹窗 */
  private readonly approvals = new ApprovalStore();
  private loop!: AgentLoop;
  private logger!: Logger;
  private chatView: ChatView | null = null;
  private pluginDir = "";
  /** 对话历史（落盘，重启后还在） */
  chatHistory!: ChatHistory;

  /** 清理过期的外溢文件（大工具结果的落盘副本） */
  private async pruneSpill(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      const spill = spillDir();
      if (!(await adapter.exists(spill))) return;
      const { folders } = await adapter.list(spill);
      const cutoff = Date.now() - SPILL_KEEP_DAYS * 86_400_000;
      let removed = 0;
      for (const dir of folders) {
        const stat = await adapter.stat(dir);
        if (stat && stat.mtime < cutoff) {
          await adapter.rmdir(dir, true);
          removed++;
        }
      }
      if (removed > 0) this.logger.info(`清理过期外溢文件 ${removed} 个目录`);
    } catch (e) {
      this.logger.warn(`清理外溢文件失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 存档清理：每跑一个任务写一个 state/*.json，之前从不清理。
   * 真机上攒到 93 个 / 1.7 MB，而 listResumable() 每次打开面板要把整个目录读一遍，
   * 文件越多面板越慢。没做完的活永远保留，只清"已经结束且够老"的。
   */
  private async pruneStates(): Promise<void> {
    try {
      const r = await pruneStates(this.app.vault.adapter, `${this.pluginDir}/state`);
      if (r.removed > 0) {
        this.logger.info(
          `存档清理：删 ${r.removed} 个，留 ${r.kept} 个（其中未完成 ${r.resumable} 个）`,
        );
      }
    } catch (e) {
      this.logger.warn(`存档清理失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /**
   * 设备自检入口。用「放标志文件 → 重载插件 → 读报告」的方式触发，
   * 不依赖 UI 点击、不依赖模型、不花 token。
   */
  private async maybeSelfTest(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(SELFTEST_FLAG))) return;
      await adapter.remove(SELFTEST_FLAG);
      this.logger.info("开始设备自检");
      const report = await runSelfTest(this.app, this.logger);

      // 再补一步「循环 → 面板」的渲染自检
      try {
        await this.activateView();
        const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_AGENT_CHAT)[0];
        const view = leaf?.view as ChatView | undefined;
        const detail = view ? view.selfTestRender() : "没有找到面板实例";
        // 自检把节点都清掉了，这里把真实历史重新载回面板：
        // 一是验证「从磁盘恢复」这条路径，二是让 UI 自动化有东西可点
        await view?.restoreHistory();
        report.steps.push({ name: "面板渲染（事件 → DOM）", ok: view !== undefined, detail });
        if (view) report.pass += 1;
        else report.fail += 1;
      } catch (e) {
        report.steps.push({
          name: "面板渲染（事件 → DOM）",
          ok: false,
          detail: e instanceof Error ? e.message : String(e),
        });
        report.fail += 1;
      }
      await adapter.write(SELFTEST_REPORT, JSON.stringify(report, null, 2));
      this.logger.info(`设备自检完成：${report.pass} 通过 / ${report.fail} 失败`);
      new Notice(`自检完成：${report.pass} 通过 / ${report.fail} 失败（详见 ${SELFTEST_REPORT}）`, 10000);
    } catch (e) {
      this.logger.error(`自检异常：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async onload(): Promise<void> {
    await this.loadSettings();

    // 插件目录：<vault>/.obsidian/plugins/local-vault-agent
    this.pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    // 外溢目录跟着真实插件目录走，不再写死 id（改名/换目录时不用改代码）
    configureSpillRoot(`${this.pluginDir}/spill`);

    this.logger = new Logger(this.app.vault.adapter, this.pluginDir);
    // WP4：日志目录会随库同步到云端，当前密钥必须字面打码（高熵串另有兜底层）
    this.logger.setSecrets(() => (this.apiKey ? [this.apiKey] : []));
    this.chatHistory = new ChatHistory(this.app.vault.adapter, `${this.pluginDir}/chat-history.json`, this.logger);
    this.apiKey = await this.loadApiKey();

    this.provider = new Provider(() => this.agentConfig());

    // 外溢文件只保留最近几天，顺手清理
    void this.pruneSpill();
    // 存档同理：跑过的任务留个近期快照就够，没做完的永远留
    void this.pruneStates();

    // 设备自检：插件目录里出现 selftest.flag 就跑一遍工具层剧本（见 selftest.ts）
    void this.maybeSelfTest();

    this.loop = new AgentLoop({
      app: this.app,
      provider: this.provider,
      getConfig: () => this.agentConfig(),
      pluginDir: this.pluginDir,
      log: this.logger,
      // 记一笔：弹窗到底出没出、用户点了什么。之前这块完全没痕迹，
      // 出事只能靠猜（「改了文件但不知道有没有弹窗」）。
      confirm: async (req) => {
        this.logger.info(`等待确认：${req.tool} ${req.path}（${req.summary}）`);
        const accepted = await confirmChange(this.app, req);
        this.logger.info(`确认结果：${accepted ? "接受" : "拒绝"} ${req.path}`);
        return accepted;
      },
      // WP4：隐私模式热读取——设置页切换后，同一次会话的下一次工具调用就生效，
      // 不再要求重载插件
      getReadOnly: () => this.settings.readOnly,
      approvals: this.approvals,
    });

    this.registerView(VIEW_TYPE_AGENT_CHAT, (leaf) => new ChatView(leaf, this));

    const ribbon = this.addRibbonIcon("bot", "Local Vault Agent", () => void this.activateView());
    ribbon.addClass("oa-ribbon");

    // 上次关着面板、这次重启后手动点开很烦：只要上次开过（leaf 还在），就自动展开
    this.app.workspace.onLayoutReady(() => {
      if (this.app.workspace.getLeavesOfType(VIEW_TYPE_AGENT_CHAT).length > 0) {
        void this.activateView();
      }
    });

    this.addCommand({
      id: "open-agent-chat",
      name: "打开 Agent 面板",
      callback: () => void this.activateView(),
    });

    this.addCommand({
      id: "resume-last-run",
      name: "继续未完成的任务",
      callback: () => void this.resumeLatest(),
    });

    this.addCommand({
      id: "export-logs",
      name: "导出最近日志到剪贴板",
      callback: async () => {
        await this.logger.flush();
        const text = this.logger.tail(200).join("\n");
        await navigator.clipboard.writeText(text || "(暂无日志)");
        new Notice("日志已复制到剪贴板");
      },
    });

    this.addSettingTab(new AgentSettingTab(this.app, this));

    this.logger.info("插件已加载");
    this.app.workspace.onLayoutReady(() => void this.warnResumable());
  }

  onunload(): void {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_AGENT_CHAT);
    void this.logger?.flush();
  }

  // ---------------------------------------------------------------------------
  // 对外能力（供 ChatView 调用）
  // ---------------------------------------------------------------------------

  registerChatView(view: ChatView | null): void {
    this.chatView = view;
  }

  isRunning(): boolean {
    return this.loop?.isRunning ?? false;
  }

  abortRun(): void {
    this.loop?.abort();
  }

  /** 跑一轮；返回模型最后的回答文本（供面板存入对话历史） */
  async runAgent(text: string, onEvent: (e: LoopEvent) => void, history: HistoryTurn[] = []): Promise<string> {
    if (!this.apiKey) {
      new Notice("请先在 设置 → Local Vault Agent 中填写 API Key");
      return "";
    }

    // 用户直接说「继续上个任务」时，应该真的接上存档，而不是开一个什么都不知道的新任务。
    // 之前这里只认命令面板里的「继续未完成的任务」，聊天里说一句就白说。
    if (wantsResume(text)) {
      const resumable = await this.loop.listResumable();
      if (resumable.length > 0) {
        const state = resumable[0];
        new Notice(`接上未完成的任务 ${state.runId}（第 ${state.step} 步）`);
        onEvent({ type: "status", text: `接上未完成的任务：第 ${state.step} 步` });
        const resumed = await this.loop.resume(state, onEvent);
        return finalAnswer(resumed);
      }
    }

    const state = await this.loop.start(text, onEvent, history);
    await this.chatHistory.setRunId(state.runId).catch(() => undefined);
    if (state.status === "failed") {
      new Notice(`任务失败：${state.error ?? "未知原因"}`);
    }
    return finalAnswer(state);
  }

  /** 面板用：有哪些任务还能继续 */
  listResumable(): Promise<RunState[]> {
    return this.loop.listResumable();
  }

  /**
   * 面板「撤销本轮」（WP3）：按修改记录逆向回放该 run 的内容级改动。
   * undoRun 会摘掉已还原操作的撤销数据；这里随后落盘存档，
   * 保证重启之后再次点击也不会把同一批操作撤第二遍。
   */
  async undoLastRun(state: RunState): Promise<UndoReport> {
    if (this.loop?.isRunning) throw new Error("有任务正在运行，请先中止再撤销");
    const report = await undoRun(this.app, state, this.logger);
    await this.loop.saveState(state).catch(() => undefined);
    return report;
  }

  /**
   * 面板用：按 runId 恢复某个任务。
   * 和「继续未完成的任务」命令的区别是不取最新一条，而是取用户点开的那个会话绑定的任务。
   */
  async resumeRunById(runId: string, onEvent: (e: LoopEvent) => void): Promise<string> {
    const list = await this.loop.listResumable();
    const state = list.find((s) => s.runId === runId);
    if (!state) {
      new Notice("这个任务已经结束了，直接接着聊就行");
      return "";
    }
    new Notice(`继续任务 ${state.runId}（第 ${state.step} 步）`);
    const resumed = await this.loop.resume(state, onEvent);
    await this.chatHistory.setRunId(resumed.runId).catch(() => undefined);
    return finalAnswer(resumed);
  }

  private async resumeLatest(): Promise<void> {
    const list = await this.loop.listResumable();
    if (list.length === 0) {
      new Notice("没有可继续的任务");
      return;
    }
    const state = list[0];
    await this.activateView();
    new Notice(`继续任务 ${state.runId}（第 ${state.step} 步）`);
    await this.loop.resume(state, (e) => this.chatView?.handleEvent(e));
  }

  private async warnResumable(): Promise<void> {
    try {
      const list = await this.loop.listResumable();
      if (list.length > 0) {
        new Notice(
          `有 ${list.length} 个未完成的任务，可用命令「继续未完成的任务」恢复`,
          8000
        );
      }
    } catch {
      /* 忽略 */
    }
  }

  async activateView(): Promise<void> {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_AGENT_CHAT)[0] ?? null;

    if (!leaf) {
      // 手机上右侧栏常被折叠，用 split 会挤；优先在当前活跃 leaf 旁开
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf(true);
      await leaf.setViewState({ type: VIEW_TYPE_AGENT_CHAT, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  // ---------------------------------------------------------------------------
  // 配置
  // ---------------------------------------------------------------------------

  agentConfig(): AgentConfig {
    return {
      baseUrl: this.settings.baseUrl,
      apiKey: this.apiKey,
      model: this.settings.model,
      temperature: this.settings.temperature,
      maxTokens: this.settings.maxTokens,
      maxSteps: this.settings.maxSteps,
      confirmAfterFiles: this.settings.confirmAfterFiles,
      requestTimeoutMs: this.settings.requestTimeoutMs,
    };
  }

  private async loadApiKey(): Promise<string> {
    const ss = (this.app as unknown as { secretStorage?: { getSecret?: (id: string) => string | null } })
      .secretStorage;
    if (ss?.getSecret) {
      try {
        const v = await Promise.resolve(ss.getSecret(SECRET_ID));
        if (typeof v === "string" && v) return v;
      } catch {
        /* 降级到本地配置 */
      }
    }
    return this.settings.apiKey ?? "";
  }

  async saveApiKey(key: string): Promise<void> {
    this.apiKey = key;
    const ss = (this.app as unknown as { secretStorage?: { setSecret?: (id: string, v: string) => void } })
      .secretStorage;
    if (ss?.setSecret) {
      try {
        ss.setSecret(SECRET_ID, key);
        return;
      } catch {
        /* 降级 */
      }
    }
    // 兜底：存进 data.json（README 里已提示风险）
    this.settings.apiKey = key;
    await this.saveSettings();
  }

  async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }
}

// -----------------------------------------------------------------------------
// 设置页
// -----------------------------------------------------------------------------

class AgentSettingTab extends PluginSettingTab {
  constructor(
    app: ObsidianAgentPlugin["app"],
    private readonly plugin: ObsidianAgentPlugin
  ) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: "模型" });

    new Setting(containerEl)
      .setName("API Base URL")
      .setDesc("OpenAI 兼容端点。DeepSeek 填 https://api.deepseek.com；Kimi 填 https://api.moonshot.cn/v1")
      .addText((t) =>
        t
          .setPlaceholder("https://api.deepseek.com")
          .setValue(this.plugin.settings.baseUrl)
          .onChange(async (v) => {
            this.plugin.settings.baseUrl = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("模型名")
      .setDesc("必须支持工具调用（function calling）")
      .addText((t) =>
        t
          .setPlaceholder("deepseek-chat")
          .setValue(this.plugin.settings.model)
          .onChange(async (v) => {
            this.plugin.settings.model = v.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("优先存入 Obsidian SecretStorage；不可用时才会落到 data.json")
      .addText((t) => {
        t.inputEl.type = "password";
        t.setPlaceholder("sk-...")
          .setValue(this.plugin.settings.apiKey)
          .onChange(async (v) => {
            await this.plugin.saveApiKey(v.trim());
          });
      });

    new Setting(containerEl)
      .setName("测试连接")
      .setDesc("发一次最小请求，验证地址 / Key / 模型名")
      .addButton((b) =>
        b.setButtonText("测试").onClick(async () => {
          b.setDisabled(true);
          b.setButtonText("测试中…");
          try {
            const reply = await new Provider(() => this.plugin.agentConfig()).testConnection();
            new Notice(`连接正常，模型回复：${reply.slice(0, 50)}`);
          } catch (e) {
            new Notice(`失败：${e instanceof Error ? e.message : String(e)}`, 10000);
          } finally {
            b.setDisabled(false);
            b.setButtonText("测试");
          }
        })
      );

    containerEl.createEl("h3", { text: "行为" });

    new Setting(containerEl)
      .setName("温度")
      .setDesc("改文件建议低一些，0.2 ~ 0.4")
      .addSlider((s) =>
        s
          .setLimits(0, 1, 0.1)
          .setValue(this.plugin.settings.temperature)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.temperature = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("单次回复上限（max_tokens）")
      .setDesc(
        "思考型模型（glm、deepseek-r1、qwen-thinking 等）会先用掉大量 token 想事情，" +
          "额度给小了正文会是空的。这类模型建议 16000 以上。",
      )
      .addSlider((s) =>
        s
          .setLimits(1024, 32768, 1024)
          .setValue(this.plugin.settings.maxTokens)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxTokens = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("最大步数")
      .setDesc("单次任务最多允许的模型轮次，防止失控长跑")
      .addSlider((s) =>
        s
          .setLimits(5, 50, 1)
          .setValue(this.plugin.settings.maxSteps)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.maxSteps = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("改几个文件后开始逐次确认")
      .setDesc("批量改动时的安全阀。达到阈值后，每一次写入都要弹窗确认")
      .addSlider((s) =>
        s
          .setLimits(1, 30, 1)
          .setValue(this.plugin.settings.confirmAfterFiles)
          .setDynamicTooltip()
          .onChange(async (v) => {
            this.plugin.settings.confirmAfterFiles = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("请求超时（秒）")
      .setDesc("等模型响应的上限。非流式是整段上限；流式指「连续这么久没有新内容」才算超时。网络差可调大")
      .addText((t) =>
        t
          .setValue(String(Math.round(this.plugin.settings.requestTimeoutMs / 1000)))
          .onChange(async (v) => {
            const sec = Number(v);
            // 只在输入合法时落盘；非法输入保留旧值，避免存进 0/NaN 让超时彻底失效
            if (Number.isFinite(sec) && sec >= 10 && sec <= 600) {
              this.plugin.settings.requestTimeoutMs = Math.round(sec * 1000);
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("隐私模式")
      .setDesc("开启后禁用所有写工具，只允许读取与检索。切换即时生效，无需重载")
      .addToggle((t) =>
        t.setValue(this.plugin.settings.readOnly).onChange(async (v) => {
          this.plugin.settings.readOnly = v;
          await this.plugin.saveSettings();
          new Notice("隐私模式已" + (v ? "开启" : "关闭") + "，下一次工具调用起生效");
        })
      );

    containerEl.createEl("h3", { text: "关于" });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text:
        "单次任务失败时会保留 checkpoint，可用命令「继续未完成的任务」恢复。" +
        "所有写操作都会先展示 diff，拒绝后文件保持不变。",
    });
  }
}
