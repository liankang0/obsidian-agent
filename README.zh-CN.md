# Local Vault Agent

[English](README.md) | 简体中文

一个运行在 Obsidian 里的本地 AI Agent（harness）。目标场景只有一个：**在手机上用 Obsidian 时，让模型直接读写整个 Vault 干活**——而不是把文字复制粘贴到聊天框里。

> 状态：早期发布版（v0.1.0）。已在 Android 真机（44 项自检）与桌面端验证。所有写入都经过 diff 确认弹窗，由你拍板。

## 为什么做成插件，而不是独立 App

独立 Android App 要为拿到 Vault 访问权苦苦挣扎（分区存储、SAF、拿不到真实路径）。做成 Obsidian 插件，这一整层问题直接消失：

- 宿主 App 已有 Vault 访问权，插件通过 `app.vault.adapter` 读写
- `metadataCache` 免费提供 frontmatter / 标签 / 双链 / 反链
- `workspace` / `editor` API 支持原地编辑与 diff 预览
- 一套代码覆盖 Android、iOS 与桌面端

代价是插件内没有 Node.js——不能起 shell、不能用 `git`、不能用 `ripgrep`。见[架构设计](docs/02-架构设计.md)（中文）。

## 核心能力

| 关注点 | 做法 |
|---|---|
| 运行位置 | 全部在插件内（agent 循环、检索、工具执行）；只有推理请求发往模型 API |
| 模型接入 | OpenAI 兼容协议，`requestUrl` 直连；适配 DeepSeek、Kimi 等直连端点 |
| 写入 | **候选 + diff 预览 + 人工确认**——绝不静默覆盖 |
| 改文件 | 优先 `patch_file`（精确替换），而非整篇重写 |
| 长任务 | 每步落 checkpoint，被杀后可续跑 |
| 检索 | v0 用关键词/结构检索；向量检索有意后置 |
| 记忆 | 有界记忆文件（工作记忆 / 对话日志），注入系统提示 |
| 隐私 | 只读模式一键禁用所有写工具 |

工具清单：`read_file` / `read_files`（批量）/ `list_files` / `search` / `search_by_tag` / `list_by_frontmatter` / `get_links` / `get_backlinks` / `patch_file` / `create_note` / `write_file` / `move_note` / `trash_note` / `trash_folder` / `open_note` / `ask_user`（可暂停，带可点选项）/ `record_memory` / `use_skill` / `read_checklist`。

安全护栏：敏感文件（`.env`、密钥、凭据）读写一律拒绝；`.obsidian/` 禁写；删除只进回收站，绝不硬删；改动文件数超过可配置阈值后，每次写入都需单独确认；连续工具失败触发熔断。

## 网络请求披露

这个插件会发起网络请求，你应该确切知道什么会出网：

- **去哪里**：只发往你在插件设置里配置的 OpenAI 兼容端点，默认 `https://api.deepseek.com`。插件不带任何内置服务商，你不填 API Key 之前，它不会向任何地方发送任何东西。
- **发什么**：任务执行中，读到的笔记（或摘录）、文件名、工具结果会作为模型提示的一部分发往该端点——模型就是这样干活的。对话历史也会发送，agent 需要回看之前的轮次。
- **不发什么**：没有遥测、没有崩溃上报、没有分析统计，也不会请求你配置的端点之外的任何主机。API Key 存在 Obsidian 的 SecretStorage 里（含文档说明的本地设置降级方案），绝不上传。
- **本地产物**：run checkpoint、日志、超长工具结果都写在你 Vault 内的 `.obsidian/plugins/local-vault-agent/` 下，除非你自己的同步服务去复制它们，否则不会离开你的设备。

在设置里打开**只读（隐私）模式**会禁用所有写工具，但不改变上述网络行为——推理始终需要端点。

## 快速开始

1. 安装（从 release 资产把 `main.js`、`manifest.json`、`styles.css` 放进 `<vault>/.obsidian/plugins/local-vault-agent/`；等待进入社区插件目录期间可用 BRAT）
2. 在 Obsidian 里启用插件（手机端 `isDesktopOnly` 为 `false`，列表里才可见）
3. 设置 → Local Vault Agent：填 Base URL + API Key，点「测试连接」
4. 从侧边栏 ribbon 打开 Agent 面板，下达任务，例如「列出所有带 #book 标签的笔记」

## 开发

需要 Node.js 22（见 `.nvmrc`；`nvm use` 会自动识别）。依赖已锁定——用 `npm ci`，保证每个克隆都从同一套版本构建：

```bash
npm ci
npm run build      # 类型检查 + 打包出 main.js
npm test           # 单元与集成测试
```

44 项真机自检（不调模型、不花 token）：在插件目录放一个 `selftest.flag` 文件并重载插件即可触发，报告落在 `selftest-report.json`。

设计文档（中文）在 [`docs/`](docs/01-需求与场景.md)：需求与场景、架构、工具集、移动端约束、竞品取舍、路线图、风险与 ADR。

## 许可证

[MIT](LICENSE)
