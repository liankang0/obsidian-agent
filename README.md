# Obsidian Agent

在 Obsidian 内运行的本地 AI Agent（harness）。目标场景：**手机上用 Obsidian 时，让模型直接读写整个 Vault 干活**，而不是复制粘贴到聊天框里。

> 状态：**脚手架阶段（v0.0.1）**。
> 已完成：11 篇设计文档 + 可编译的代码骨架（`tsc -noEmit` 通过、esbuild 产出 `main.js` 53 KB、`npm test` 206 个用例通过（含 49 个集成用例）、`obsidian` 类型 1.14.4）。
> 已修复：工具调用配对断裂、截断时误执行工具、敏感文件读取泄露、`patch_file` 空白差异匹配、重复弹窗、大结果硬切丢失。见 [11 篇 §8](docs/11-深读-循环与持久化.md)。
> **未完成：真机验证。** 也就是说代码「能编译」，但「能不能在手机上把活干对」还完全未知。

## 为什么做成插件

做独立 Android App 要解决「怎么拿到整个 Vault 的读写权限」：分区存储下只有两条路——`MANAGE_EXTERNAL_STORAGE`（要用户手动去设置页授权、上架要申报）或 SAF（拿不到真实路径，得自己写一层 VFS）。做成 Obsidian 插件，这层问题**直接不存在**：

- 宿主已经拿到 Vault 访问权，插件通过 `app.vault.adapter` 读写
- `metadataCache` 免费提供 frontmatter / 标签 / 双链 / 反链，不用自己解析 Markdown
- `workspace` / `editor` API 可以做原地编辑和 diff 预览
- 一套代码同时覆盖 Android、iOS、桌面

代价是没有 Node.js：不能起 shell、不能 `git`、不能 `ripgrep`。详见 [架构设计](docs/02-架构设计.md)。

## 核心设计

| 关注点 | 决策 |
|---|---|
| 运行位置 | 全部在插件内（agent 循环、检索、工具执行）；只有推理请求打到模型 API |
| 模型接入 | OpenAI 兼容协议，`requestUrl` 直连；默认适配 DeepSeek / Kimi 等国内直连端点 |
| 写回方式 | **候选 + diff 预览 + 人工确认**，不静默覆盖 |
| 改文件 | 优先 `patch_file`（精确替换），而非整篇重写 |
| 长任务 | 每步落 checkpoint，被杀后可续跑 |
| 检索 | v0 用关键词/结构检索；向量检索留接口，不在手机上建全库索引 |
| 记忆 | 4 类有界记忆文件（Profile / Style / WorkMode / Vault），借鉴 Mobie CC |
| 隐私 | 不整库上传；提供「隐私模式」一键关掉所有工具 |

## 目录

```
obsidian-agent/
├── README.md
├── manifest.json            # 插件清单（isDesktopOnly: false）
├── package.json
├── tsconfig.json
├── esbuild.config.mjs
├── styles.css
├── deploy.sh                # 构建 + 推送到 Vault 插件目录
├── docs/
│   ├── 01-需求与场景.md
│   ├── 02-架构设计.md
│   ├── 03-工具集设计.md
│   ├── 04-移动端约束与对策.md
│   ├── 05-竞品分析与取舍.md
│   ├── 06-路线图.md
│   ├── 07-风险与开放问题.md
│   ├── 08-ADR.md
│   ├── 09-Agent-Harness-横向解析.md  # 外部形态：依赖图 / 二进制 / README
│   ├── 10-源码级横向分析.md          # 内核源码：循环 / 权限 / 压缩 / 外溢
│   └── 11-深读-循环与持久化.md       # 函数体级：turn loop / step gate / durable
└── src/
    ├── main.ts              # 插件入口：视图 / 命令 / 设置
    ├── agent/
    │   ├── types.ts         # 消息、工具、运行状态
    │   ├── provider.ts      # OpenAI 兼容客户端
    │   ├── tools.ts         # 工具注册表 + 护栏
    │   └── loop.ts          # agent 循环 + checkpoint
    ├── ui/
    │   ├── ChatView.ts      # 侧栏会话面板
    │   └── DiffModal.ts     # 改动确认
    └── util/
        ├── log.ts           # 落盘日志（手机没有 devtools）
        └── path.ts          # 路径规范化与越界拦截
```

## 快速开始（开发）

```bash
cd ~/projects/obsidian-agent
npm install        # esbuild / typescript / obsidian 类型（已实测可装）
npm run build      # tsc 类型检查 + 打包出 main.js
npm test           # 单元测试（esbuild 打包到 /tmp 后用 node --test 跑）
```

部署到设备（Vault 与手机通过 Syncthing 同步时最省事）：

```bash
./deploy.sh /path/to/your/vault
```

它会构建并把 `main.js` / `manifest.json` / `styles.css` 推到
`<vault>/.obsidian/plugins/obsidian-agent/`。

开发期热更新用 `npm run dev`（watch 模式，持续产出 `main.js`）。

在 Obsidian 里 `设置 → 第三方插件 → 重新载入`，启用 **Obsidian Agent**。

手机端注意：`manifest.json` 必须是 `isDesktopOnly: false`，否则列表里直接看不到。

## 现在该做什么（M0 剩下的）

代码能编译 ≠ 能用。下一步按这个顺序，不要跳：

1. `./deploy.sh <桌面 vault 路径>`，在桌面 Obsidian 里启用插件
2. 设置页填 Base URL + API Key，点「测试连接」——这一步过了才说明模型和网络没问题
3. **先只验证读路径**：发「搜索所有提到 `#book` 的笔记，列出路径」，确认 `search` 能用
4. **再验证写路径**：「把 读书/ 下第一篇笔记的 tags 改成 #book」，确认 diff 弹窗正常、拒绝后文件不变
5. 把失败点记进 [07 文档](docs/07-风险与开放问题.md) 的 E1～E7 实验表

第 3 步是关键。**先读通，再写**——反过来就是在拿笔记做赌注。

已知未验证项（都在 07 文档里）：手机端 `requestUrl` 的实际耗时与稳定性、`SecretStorage` 是否真的可用（已实现降级到 data.json）。`editor.transaction` 已确认在移动端不可达并删除。

## 设备自检（真机自动化）

不开 UI、不调模型、不花 token，直接在你手机上跑一遍工具层剧本。

```bash
# 1. 放标志文件
adb push /dev/null <vault>/.obsidian/plugins/obsidian-agent/selftest.flag
# 2. 重启 Obsidian（或重载插件），onload 检测到标志就跑
adb shell am force-stop md.obsidian && adb shell am start -n md.obsidian/.MainActivity
# 3. 取报告
adb shell cat <vault>/.obsidian/plugins/obsidian-agent/selftest-report.json
```

覆盖 40 项，分九层：

| 层 | 项数 | 内容 |
|---|---|---|
| 工具层 | 10 | 读写整篇/分段、精确与降级匹配、半句 old 的诊断、不存在的文本、外溢目录读回（`.obsidian` 不被索引的回归）、敏感文件拦截、路径越界拦截 |
| 序列化层 | 3 | 小结果内联、大结果外溢并真实落盘、`read_file` 不参与外溢 |
| 循环层 | 6 | 脚本化 provider 跑完整一轮、**崩溃后恢复**（孤儿 tool_call 补桩 + `system-reminder` 注入）、连续失败 3 次熔断、多轮上下文带入、**空回复重试**、连续空回复判失败 |
| 历史层 | 1 | 对话落盘后新实例读回（重启场景） |
| 用量层 | 1 | 每轮上报 token，按量级显示成 K / M |
| 准则层 | 2 | 受保护路径拦截、修改记录格式与去重 |
| 会话层 | 1 | 多会话新建/切换/标题/删除不串味 |
| 语义层 | 3 | 按标签找、按 frontmatter 找、移动笔记（真机） |
| skill 层 | 2 | 真实 skills/ 扫描出索引、use_skill 读回正文 |
| 记忆层 | 1 | 真实 04/05 读出并确认拼进 system prompt |
| 清单层 | 2 | 01/02 解析与注入、read_checklist 取全文 |
| 删除层 | 2 | 回收站删除、非空文件夹必须 recursive、backup/ 不进搜索 |
| 渲染层 | 1 | 事件 → DOM，读回面板文本后清理现场 |

全程不调模型、不花 token、约 1–2 秒。所有临时产物（`_agent-selftest/`、外溢文件、状态存档、标志文件）跑完自动清理，已逐个验证无残留。

实现见 [`src/agent/selftest.ts`](src/agent/selftest.ts)。

## 参考

- [Mobie CC](https://github.com/bravekingzhang/mobie-cc-releases) —— 同形态的闭源商业插件，本项目的对照物
- [Obsidian 插件 API 文档](https://docs.obsidian.md/)
- Obsidian 官方 changelog（移动端 widget / 版本能力变化）<https://obsidian.md/changelog/>
