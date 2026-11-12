# 更新日志

**版本号以 [manifest.json](manifest.json) 为唯一来源**；`package.json` / `versions.json` 由 `npm run release -- <x.y.z>` 一次性对齐，不要手动改版本号。

格式参考 Keep a Changelog；已发布版本倒序排列。

## [0.1.0] — 2026-11-12

首个公开发布版本（此前的内部迭代不单独记账，里程碑沿革见 docs/06-路线图）。

### 新增

- **工具集**：read_file / read_files（批量）/ patch_file / write_file / create_note / move_note / trash_note / trash_folder、search / search_by_tag / list_by_frontmatter、get_links / get_backlinks、read_checklist / record_memory / use_skill、ask_user（任务暂停等用户拍板）
- **断点续跑**：每步落 checkpoint，杀后台不丢状态；崩溃恢复自动补齐工具调用配对；「继续」接着跑
- **撤销本轮**：改动记录携带改前/改后文本（各 50k 字符内），面板一键按逆序回放逐字节还原；外部改过的文件跳过并逐条说明，不产生半撤销；移动/删除仍由回收站负责（见 docs/08-ADR.md ADR-010）
- **护栏**：敏感文件（.env / 密钥类）拒绝访问、越界路径拦截、`.obsidian/` 禁写、受保护文件强制确认、连续失败熔断、单次输出截断与大结果外溢
- **流式输出**：打字机式增量显示；流不可用自动回退非流式；请求超时（可配置）与流空闲超时分开处理；中止后不重试、晚到的增量丢弃
- **结果可信度**：四种静默降级（反链 API 缺失、检索超时、记忆读取失败、skill 扫描失败）改为模型可见的「⚠ 本次数据不完整」标记
- **一致性**：只读检查前置、changedFiles 跨轮持久化、`.canvas` / `.base` 坏 JSON 写入拦截、修改记录超阈值自动归档
- **上下文预算单点**：五个预算常量集中到 `src/agent/budgets.ts`
- **工程基线**：CI（类型检查 / 测试 / 构建 / 产物大小断言）、真机自检剧本与单测共用、决策记录补齐
- **安全收口**：日志打码两层化（配置密钥字面替换 + 高熵串兜底，取代猜 `sk-` 前缀）；工具失败诊断只回给模型，日志只记无内容摘要；`read_file` / `read_files` 的正文按「数据非指令」包裹；隐私模式开关即时生效（同一次会话内，无需重载）；破坏性操作单轮配额——3 次逐个确认后改一次清单式确认（见 docs/08-ADR.md ADR-011）

### 结构

- 插件 id：`local-vault-agent`（此前 `obsidian-agent`）；名称 Local Vault Agent
- 许可：MIT；README 含 Network use 披露（请求只发往用户配置的模型端点）

## [0.0.x] — 内部迭代（2026-09 ~ 2026-11）

未公开发布，按里程碑推进：M0 止血（读写与护栏）→ M1 日常可用（续跑、批量、记忆区）→ 结构收口。细节见 docs/06-路线图 与 git 历史。
