# 09 · 主流 Agent Harness 横向解析

> 目的：给 `obsidian-agent` 找参照系，不是找模板。
> 每个 harness 都长在特定约束里（终端、IDE、桌面 App、云端），把它们的结论直接搬到一个 **WebView 沙箱里的 Obsidian 插件** 上是错的。
> 所以每节最后都有一栏「对我们的意义」，允许结论是「不抄」。

## 证据来源

本机实测 + 官方仓库直读，不靠记忆：

| harness | 版本 / 规模 | 证据 |
|---|---|---|
| DSH（deepseek-harness） | `@deepseek-ai/dsh` 0.2.0-rc.2，82 个直接依赖 | 本机 `node_modules` 全量依赖图 |
| Claude Code | `@anthropic-ai/claude-code` 2.1.304，单二进制 288,730,480 B | 本机安装 + `sdk-tools.d.ts`（168 KB 工具 JSON Schema） |
| Codex | `@openai/codex` 0.162.1，Rust，`codex-rs/` 约 130 个 crate | 本机二进制 + 仓库目录 |
| opencode | 1.17.0，单 ELF 156,924,032 B（Bun 打包），218k★ | 本机二进制 + `packages/` |
| Kimi Code CLI | TS monorepo，单二进制分发，`MoonshotAI/kimi-code` | 仓库 `packages/` `apps/` |
| Pi | TS monorepo，116k★，`earendil-works/pi` | 仓库 `packages/` + README 设计声明 |
| ZCode（智谱） | TS，8k★，Apache-2.0，v3.16.1，`zai-org/ZCode` | 仓库 `apps/` `packages/` |

补充：`MoonshotAI/kimi-cli`（Python 版，11.4k★）已归档，官方指向 `kimi-code`，本分析只谈后者。

---

## 一、七个 harness，逐个拆

### 1. DSH — 插件化内核，配置即能力

**形态**：Node CLI，`dsh <profile>` 启动一套「插件包 + 补丁层」组成的运行栈。同一个内核可以披上 TUI、Web、headless、SDK、ACP 五种外壳。

**结构**（从 82 个依赖直接读出来的分层）：

```
启动器      dsh-cmdline / app-boot / launch-environment / home-paths
内核        cordis（DI 容器）+ cordis-plugin-loader/include/timer + dsh-hmr
模型层      token-meter / compaction-basic / compaction-tool-result-pruner
会话层      session-projection / session-reference / transcript
工具层      22 个 *-tool-* 包（见下）
能力面      skill / mcp-client / plan-mode / goal / jobs / schedule / webhook
安全面      pwsh-sandbox / atomic-write / process 隔离
兼容面      hooks-claude-code / hooks-codex（直接吃对方的 hook 协议）
```

工具包全名单：`bash`、`bash-persistent`、`pwsh`、`pwsh-persistent`、`fs`、`fs-search`、`str-replace-editor`、`skill`、`subagent`、`subagent-control`、`workflow`、`todo`、`ralph`、`goal`、`jobs`、`ask-user`、`present`、`web`、`cordis`、`workspace-dependencies`。

**值得看的三个设计**：

1. **依赖注入做在架构里**。工具不是 `switch(name)` 分发的，而是注册进 cordis 容器，谁需要谁注入。好处是能按 profile 增删——`headless` 不带 UI 插件也能跑。
2. **compaction 是两层**。`compaction-basic` 处理整体摘要，`compaction-tool-result-pruner` 单独裁工具返回值。后者我认为是被严重低估的设计：长会话里 80% 的 token 是历史工具输出，摘要它们会丢信息，裁剪它们不丢。
3. **兼容层是产品策略**。`hooks-claude-code` / `hooks-codex` 让用户把已有的 hook 脚本直接搬过来。迁移成本是用户切换 harness 的最大阻力，它选择正面消解。

**对我们的意义**：profile/DI 那套太重，不抄。但 **工具结果裁剪器**必须抄——手机端上下文上限比桌面更紧，而我们的 `read_file` 一次就吐 20 KB。

---

### 2. Claude Code — 闭源二进制，工具面最宽

**形态**：288 MB 单可执行文件（Linux 上叫 `claude.exe`，实际是 ELF），Bun 打包的 Node 应用，未 strip。源码不可读，但**工具 schema 是公开的**：`sdk-tools.d.ts` 把每个工具的 JSON Schema 导出了。

**工具全集**（40 个，从类型定义直接枚举）：

| 类别 | 工具 |
|---|---|
| 文件 | `FileRead` `FileWrite` `FileEdit` `Glob` `Grep` `NotebookEdit` |
| 执行 | `Bash` `TaskStop` |
| 编排 | `Agent`（子代理）`TaskCreate/Get/Update/List` `Workflow` `Monitor` |
| 计划 | `EnterPlanMode` `ExitPlanMode` `ProposeGoal` `ProposeSkills` `AskUserQuestion` |
| 时间 | `CronCreate/Delete/List` `ScheduleWakeup` |
| 外部 | `WebFetch` `WebSearch` `Mcp` `ListMcpResources` `ReadMcpResource(Dir)` `RefreshMcpTools` |
| 环境 | `EnterWorktree` `ExitWorktree` `Projects` `Artifact` `ReadNotifications` `PushNotification` `RemoteTrigger` |
| 其他 | `ReportFindings` `SendFeedback` `ClaudeDesign` `OfferChromeSetup` `ShowOnboardingRolePicker` |

**能读出来的设计取向**：

- **`Workflow` 与 `Monitor` 的存在说明它已经不是一个"问答循环"**，而是可以自我调度、后台观察的长时进程。`Cron*` 更明确——支持定时唤醒。
- **Plan mode 是独立状态机**，`EnterPlanMode`/`ExitPlanMode` 是工具而不是提示词开关。这意味着"计划阶段禁止写"这条约束由运行时保证，不靠模型自觉。
- **`AskUserQuestion` 是工具**。人机澄清被建模成一次工具调用，而不是让模型在自然语言里问完就停。
- **`Artifact` + `PushNotification`**：产物与通知都被抽象成工具，说明它背后有一个会话之外的宿主。

**对我们的意义**：`AskUserQuestion` 和 `EnterPlanMode` 这两个思路立刻可抄，成本极低。`Workflow`/`Cron`/`Worktree` 全部不抄——手机上的 Obsidian 插件没有后台常驻的资格。

---

### 3. Codex — Rust 内核，沙箱是一等公民

**形态**：Rust 编译的静态二进制（musl），按平台拆分 npm 可选依赖分发。本机 `codex-rs/` 约 130 个 crate，是我见过拆分最细的 agent 工程。

**架构线索（从 crate 名读）**：

```
协议层   protocol / app-server / app-server-protocol / app-server-daemon
         exec-server / exec-server-protocol / uds / websocket-client
内核     core / core-api / core-plugins / tools / prompts / context-fragments
执行     exec / execpolicy / apply-patch / shell-command / code-mode(+host/runtime)
沙箱     sandboxing / linux-sandbox / windows-sandbox-rs / windows-sandbox-service
         bwrap / mxc-sandbox / process-hardening / network-proxy
状态     thread-store / thread-manager / rollout / history / message-history
         memories / state / agent-graph-store / agent-identity
能力     skills / hooks / mcp / plugins / worktree / file-search / file-watcher
模型     model-provider / model-provider-info / models-manager / ollama / lmstudio
         responses-api-proxy / chatgpt / cloud-client
可观测   otel / otel-trace-websocket / analytics / rollout-trace / diagnostics
```

**关键判断**：

1. **`execpolicy` 是独立 crate**。命令执行策略（哪些命令允许、哪些要审批、哪些直接拒）被做成可测试的独立模块，而不是散在权限弹窗里。这是我看到的对"该不该放行"最工程化的处理。
2. **沙箱按平台各写一套**：Linux 用 bwrap/landlock、macOS 用 seatbelt、Windows 独立 crate。它不假装能跨平台统一。
3. **`apply-patch` 独立成 crate**：模型输出的是补丁而不是整文件，落盘由专门的补丁解析器执行。这直接印证了我们 `patch_file` 的路线。
4. **`code-mode` 系列**：让模型写代码来调工具，而不是一步步发 tool call。这是"减少往返次数"的另一条路。
5. **`app-server` 与 `exec-server` 分离**：交互态与服务态是两个进程。`codex resume/fork/queue/archive` 这些子命令就是这个结构的产物——会话是一等对象，可列举、可分叉、可排队。

**对我们的意义**：`apply-patch` 与 `execpolicy` 的思路要抄（我们是 `patch_file` + 路径护栏，方向对了，但护栏的**可测试性**不如它）。`resume/fork` 里的 `fork` 我们没做，值得加：从某个 checkpoint 分叉出另一条改法，比"改错了重来"体验好得多。

---

### 4. opencode — Client/Server 分离，多 agent 是一等对象

**形态**：单 ELF（Bun 打包的 TS），150 MB。218k★，是目前社区体量最大的开源 coding agent。

**结构**（`packages/` 26 个包）：

```
服务端   server / protocol / schema / sdk / client / httpapi-codegen / http-recorder
内核     core / ai / session-ui / effect-drizzle-sqlite
外壳     tui / cli / app / desktop / web / console / ui / theme
扩展     plugin / plugin-browser / gui-extensions / codemode
其它     containers / identity / stats / simulation / storybook / latex / merman
```

**两个明说的设计**：

- **内置两个 agent**：`build`（全权限）与 `plan`（只读），Tab 键切换。另有一个 `general` 子代理干重活。
- **`effect-drizzle-sqlite`**：状态层是 Effect（函数式副作用）+ Drizzle ORM + SQLite。会话、消息、part 全部落库，不是内存数组。

**对我的意义**：**"只读 agent / 可写 agent"作为两个预设，比一个 agent 加一堆开关清晰得多**。我们现在的「隐私模式」是个 toggle，方向对但表达弱——用户理解"切到 plan 模式"比理解"打开只读开关"容易。

`client/server` 分离在移动端插件里做不到（没有独立进程），不抄。

---

### 5. Kimi Code CLI — TS 单仓，把 TUI 当成产品

**形态**：TypeScript monorepo，`pnpm` workspace，但**分发为单二进制**，装完不需要 Node。

**结构**：

```
apps      kimi-code / kimi-inspect / vis / vscode
packages  agent-core-v2 / kosong / klient / pi-tui / acp-server / kap-server
          node-sdk / oauth / remote-control / telemetry / transcript
          tree-sitter-bash / minidb / migration-legacy
```

**读得出的取舍**：

- **`pi-tui` 在它的包列表里**——直接复用 Pi 的 TUI 实现。跨项目复用 UI 层，说明它们的 TUI 抽象做对了。
- **`agent-core-v2`**：版本号写进包名，意味着这是一次不兼容重写，且允许旧包并存。工程上很务实。
- **`tree-sitter-bash`**：解析 bash 语法而不是纯字符串匹配。为了"看懂命令在干什么"，它上了语法分析。
- **`minidb`**：自己塞了个嵌入式数据库，而不是依赖 better-sqlite3 的原生模块。单二进制分发逼出来的选择。
- **`acp-server` / `kap-server` / `remote-control`**：对外暴露协议，能被编辑器/远程客户端驱动。
- 产品面：视频输入、`/mcp-config` 对话式配 MCP、`/login` 支持 OAuth。

**对我们的意义**：`tree-sitter-bash` 不适用（我们没有 shell）。但 **"单二进制 / 零依赖安装" 这条产品直觉值得记住**——我们的对应物是 `deploy.sh` 一次推三个文件，已经是最接近的形态。

---

### 6. Pi — 极简内核，明确"不做"

**形态**：TS monorepo，116k★。自我定位一句话：**"a minimal, extensible agent harness that you can make your own"**。

**结构**（10 个包，克制得惊人）：

```
agent         agent loop
ai            统一 LLM API 抽象
coding-agent  CLI / TUI / 会话 / 工具装配
tui           终端 UI
mcp / env / telemetry / evals / codemode / durable / chord
```

**它明确声明的"不做"**（README 原文要点）：

- **不做 sub-agents**，**不做 plan mode**。理由不是做不到，是"想要就自己装个包/让 Pi 写一个"。
- **不内置权限系统**。"Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default it runs with the permissions of the user and process that launched it."——把隔离交给容器（它提供 `Permissions & Containerization` 一节讲怎么用容器兜）。
- 扩展方式是**四件套**：extensions、skills、prompt templates、themes，可打包成 npm/git 包分发。
- 四种驱动方式：交互、print/JSON、**RPC**、**TypeScript SDK**。

**对我们的意义**：这是七个里和 `obsidian-agent` 最像的一个——**都是"把 harness 塞进别人的宿主进程里"**，都没有自己的沙箱，都得靠宿主给的权限。差别在于它的宿主是终端（用户自担风险），我们的宿主是 Obsidian（用户以为很安全）。所以：

- **不抄它的"无权限系统"**。移动端用户对"插件能改我全部笔记"没有心理预期，护栏必须内建。
- **要抄它的"内核可当库用"**。`packages/agent` 能脱离 CLI 被 SDK 调用。我们的 `AgentLoop` 现在强绑 `App`，应该能用手工 mock 的 `ToolContext` 单测。这是我最想改的一处。

---

### 7. ZCode（智谱）— 工作台派，三端一内核

**形态**：TypeScript，Apache-2.0，`apps/` + `packages/`，桌面应用 + 浏览器 + 终端 Agent 共用一套内核。仓库带 `architecture-policy.yaml`、`dependency-graph.mmd`、`specs/`、`skills-lock.json`、`CONTEXT.md`、`DESIGN.md`。

**结构**：

```
apps      zcode-cli / dev-docs
packages  server / zcode-server-cli / rpc / provider / provider-node
          client / ui / web / web-share / share-ui / stream-animate
          desktop / android / shared / services
          zcode-cua / model-option-map / formal-proof / e2e-report
```

**能读出来的**：

- **`rpc` + `server` + `provider` 三层**：模型 provider 被 Node 侧独占（`provider-node`），客户端只走 RPC。这样 API Key 不进客户端。
- **`android` 包**：智谱在做 Android 端。这和我们的场景直接相邻，值得记一笔。
- **`zcode-cua`**：Computer-Use Agent，能操作 GUI。这和"改文件"是两个层级的能力。
- **`stream-animate`**：流式输出的动画层单独成包，说明它对"打字机效果"的流畅度有产品级要求。
- **`architecture-policy.yaml` + `dependency-graph.mmd`**：架构约束写进仓库并被 CI 检查。这个做法比写一份架构文档然后腐烂强得多。
- 生态：`zcode-plugins`（官方插件市场）、`GLM-skills`（官方 skill 集）。

**对我们的意义**：架构策略文件化这条值得抄——把「不许 `..`、不许写 `.obsidian/`、不许 shell」写成可被脚本检查的规则，而不是只写在文档里。我们已经有护栏代码，但缺一个"新加的代码是否违反护栏"的检查。

---

## 二、横向矩阵

| 维度 | DSH | Claude Code | Codex | opencode | Kimi Code | Pi | ZCode |
|---|---|---|---|---|---|---|---|
| 语言 | TS | TS→Bun 二进制 | Rust | TS→Bun 二进制 | TS→单二进制 | TS | TS |
| 分发体积 | npm 包群 | 288 MB | ~200 MB/平台 | 150 MB | 单二进制 | npm | 桌面安装包 |
| 进程模型 | 单进程 + profile | 单进程 | app-server + exec-server | client/server | 单进程 + ACP | 单进程 | server + rpc + 三端 |
| 工具数 | 22 包 | 40 | ~15 crate 组 | 多 agent | 未知 | 精简 | 未知 |
| 子代理 | ✅ | ✅ `Agent` | ✅ agent-roles | ✅ `general` | ✅ | ❌ 明确不做 | ✅ |
| 计划模式 | ✅ plan-mode | ✅ 工具化 | ✅ collaboration-mode | ✅ `plan` agent | ? | ❌ 明确不做 | ? |
| 沙箱 | pwsh-sandbox | 权限弹窗 | 平台各一套 | 权限 | ? | ❌ 交给容器 | ? |
| 上下文压缩 | ✅ 两层 | ✅ autocompact | ✅ | ✅ | ? | ? | ? |
| 持久化 | session-projection | 会话文件 | thread-store/rollout | SQLite | minidb | durable | server 端 |
| 可恢复 | ✅ | ✅ resume | ✅ resume/fork/queue | ✅ | ? | ✅ durable | ? |
| 扩展方式 | cordis 插件 | MCP + Skills | plugins + skills + hooks | plugin | 插件生态 | extensions/skills/包 | 插件市场 |
| 可当库用 | ✅ SDK profile | ✅ SDK | ✅ app-server | ✅ SDK | ✅ node-sdk | ✅ 一等公民 | ✅ rpc |
| 开源 | ✅ | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## 三、抽象出来的通用骨架

七个实现细节天差地别，但拆完发现**都在解同一组问题**，且位置几乎一致：

```
          ┌─────────────────────────────────────────┐
          │  外壳：TUI / Web / IDE / 桌面 / 插件 UI   │  ← 可替换
          └──────────────────┬──────────────────────┘
          ┌──────────────────▼──────────────────────┐
          │  会话：消息数组 / 线程 / 可列举可恢复     │
          └──────────────────┬──────────────────────┘
   ┌─────────────┬───────────▼───────────┬──────────────┐
   │  循环       │  上下文管理            │  工具注册表   │
   │  loop       │  compaction/pruner     │  registry    │
   └─────────────┴───────────┬───────────┴──────────────┘
          ┌──────────────────▼──────────────────────┐
          │  执行面：文件 / shell / 搜索 / web / 子代理│
          └──────────────────┬──────────────────────┘
          ┌──────────────────▼──────────────────────┐
          │  安全面：审批 / 策略 / 沙箱 / 路径护栏     │
          └──────────────────┬──────────────────────┘
          ┌──────────────────▼──────────────────────┐
          │  模型层：provider 抽象 / 流式 / 重试 / 计费│
          └─────────────────────────────────────────┘
```

**六个必备件**（少任何一个都会在真实使用中出问题）：

| # | 子系统 | 缺了会怎样 | 各家的代表实现 |
|---|---|---|---|
| 1 | 循环 + 步数上限 | 死循环烧钱 | 全都有 |
| 2 | 工具注册表 + schema | 加工具要改核心 | DSH cordis / Codex crate |
| 3 | 上下文压缩 | 长任务中途爆上下文 | DSH 两层 / Claude autocompact |
| 4 | 权限/护栏 | 一次误操作毁掉工作区 | Codex execpolicy / Claude 弹窗 |
| 5 | 持久化 + 恢复 | 进程一死前功尽弃 | Codex rollout / Pi durable |
| 6 | 可编程外壳（SDK/RPC） | 只能人肉用，无法集成 | 七家全有 |

注意第 6 条：**七家都提供了"被别的程序驱动"的能力**。这是 2026 年的共识——harness 不是一个 App，是一个可嵌入的运行时。

---

## 四、四种架构流派

| 流派 | 代表 | 赌注 | 代价 |
|---|---|---|---|
| **原生内核派** | Codex、Claude Code | 启动快、沙箱硬、能防逆向 | 不可改，扩展全靠外部协议 |
| **插件化内核派** | DSH、opencode、Kimi | 能力可组合，配置即产品 | 抽象成本高，调试链路长 |
| **极简 SDK 派** | Pi | 把复杂度推给用户，内核极稳 | 默认体验朴素，要自己搭 |
| **工作台派** | ZCode | 三端一致 + 市场生态 | 仓库巨大，单人难以维护 |

**没有第五种：插件跑在别人宿主里的形态。** 这就是 `obsidian-agent` 的位置——它是第八个，但只有 Pi 的一半自由度和 ZCode 的零分之一资源。这个定位必须认清，否则会照着 Codex 的架构图画一张永远实现不完的图。

---

## 五、对我们这个项目的判决

### 抄（成本低、收益直接）

| 借鉴点 | 出处 | 我们的落地方式 |
|---|---|---|
| 补丁而非整文件 | Codex `apply-patch`、DSH `str-replace-editor`、Claude `FileEdit` | 已有 `patch_file`，方向正确 |
| 工具结果裁剪 | DSH `compaction-tool-result-pruner` | **待做**：给 `read_file`/`search` 的返回加二次裁剪 |
| 人机澄清作为工具 | Claude `AskUserQuestion`、DSH `tool-ask-user` | **待做**：加 `ask_user`，比让模型在正文里发问可靠 |
| 计划模式独立状态 | Claude `EnterPlanMode`、opencode `plan` agent | **待做**：从「只读开关」升级成「只读 agent」 |
| 会话分叉 | Codex `fork` | **待做**：从 checkpoint 分叉出另一种改法 |
| 架构约束可检查 | ZCode `architecture-policy.yaml` | **待做**：护栏规则写成可执行的检查脚本 |
| 内核可当库 | Pi `packages/agent` | **待做**：解耦 `AgentLoop` 与 `App`，让工具层可单测 |

### 不抄（约束不允许，或收益比太差）

| 不抄 | 理由 |
|---|---|
| shell / bash 工具 | Obsidian 移动端没有 `child_process`，也没有可写的 PATH |
| 子代理 | 手机内存与 API 费用都不允许并发多路推理 |
| 沙箱（bwrap/seatbelt） | 插件没有创建进程的能力，沙箱应由宿主提供 |
| client/server 分离 | 插件里没有独立进程可起 |
| MCP | 每个 MCP server 都是一次连接 + 一份 schema，移动端启动成本高；等 M2 有需要再说 |
| 云端任务 / 定时唤醒 | 移动端插件不保证常驻，定时器会被系统杀掉 |
| 插件市场 | 自用项目，没有分发需求 |

### 改（现有设计需要修正的地方）

1. **`AgentLoop` 与 `App` 耦合过紧**。现在 `LoopDeps.app` 直通 `App`，工具层也直接用 `app.vault`。应抽出 `VaultPort` 接口（`read/write/list/stat`），让 `tools.ts` 只依赖这个接口。理由：Pi 的 `packages/agent` 能脱离 CLI 存在，正是因为它不 import 终端相关的东西；我们至少要做到能用手工 mock 单测 `patch_file`。
2. **确认策略应分级，而不是按次数**。现在是「改满 N 个文件后每次都要确认」，这是计数的思路。Codex `execpolicy` 是规则的思路：**路径敏感度 × 操作危险度** 决定要不要问。比如「改 `日报/` 下的新文件」和「整篇覆盖 `读书/置身事内.md`」不该是同一档。
3. **缺工具结果裁剪**。`read_file` 上限 20 KB，一次就吃掉小模型大半上下文。应加一层：超过 N 字符时只回「首 2 KB + 尾 1 KB + 中间省略行数」。
4. **缺 `ask_user`**。用户说"帮我整理一下"这种指令时，模型现在只能猜或直接动手。有 `ask_user` 就能问一句"整理成什么结构：按主题合并 / 按时间归档 / 只修错别字"。
5. **checkpoint 只存了消息，没存"当时的文件状态"**。现在 `state/<runId>.json` 有消息和 appliedOps，但没有快照。恢复时若文件已被用户改过，续跑结果是不可预期的。要么存快照，要么在恢复前强制校验文件 mtime。

---

## 六、一句话总结

> 这七个 harness 的分歧在**外壳和沙箱**，共识在**内核六件套**。
> 对我们最有价值的三条：**工具结果要裁剪**、**澄清要变成工具**、**护栏要能被执行而不是被阅读**。
> 最没价值的模仿对象：Codex 的分层——那是一个 130 crate 的 Rust 工程，我们连一个独立的进程都没有。
