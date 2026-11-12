import { App, TFile, TFolder, normalizePath } from "obsidian";
import type { PendingQuestion, ToolCall, ToolResult, ToolSpec } from "./types";
import { PathError, assertWritable, assertReadableSize, getTFile, globToRegExp, isSpillPath, toVaultPath } from "../util/path";
import { isSensitivePath } from "../util/sensitive";
import { explainAmbiguous, explainMismatch, findMatches, tierHint } from "../util/fuzzy";
import { checkProtected } from "./guard";
import { findSkill, readSkillBody, scanSkills, type SkillMeta } from "./skills";
import { parseChecklist, POST_CHECKLIST_PATH, PRE_CHECKLIST_PATH, recordMemory } from "./memory";
import type { ApprovalStore } from "./approvals";

/** 单次工具输出的硬上限，防止一次读取把上下文撑爆 */
const MAX_OUTPUT_CHARS = 20_000;
/** 检索类工具的结果条数上限 */
const MAX_HITS = 50;

export interface ConfirmRequest {
  tool: string;
  path?: string;
  /** 一句话说明要干什么，给用户看 */
  summary: string;
  before: string;
  after: string;
}

export interface ToolContext {
  app: App;
  log: { info(s: string): void; warn(s: string): void; error(s: string): void };
  /** 请求人工确认；返回 false 表示用户拒绝 */
  confirm(req: ConfirmRequest): Promise<boolean>;
  /** 本次 run 已修改过的文件路径，用于判断是否进入逐次确认模式 */
  changedFiles: Set<string>;
  /** 累计修改文件数超过该阈值后，所有写操作都要求确认 */
  confirmAfterFiles: number;
  /** 只读模式（隐私模式打开时禁用全部写工具） */
  readOnly: boolean;
  /** 当前 run 的 id，外溢文件按 run 分目录 */
  runId: string;
  /** 会话内审批记忆：批准过的目录不再逐次弹窗 */
  approvals: ApprovalStore;
  /** 本轮可用的 skill（渐进披露：索引已在 prompt 里，正文按需读） */
  skills?: SkillMeta[];
  /** record_memory 成功后打个标：记忆区不算「用户文件改动」，但要能消掉 Step 4 的提醒 */
  markMemory?: () => void;
  /** 请求暂停等用户回话（ask_user 用）：状态切到 awaiting_confirm，本轮不再继续 */
  requestPause?: (q: PendingQuestion) => void;
  /** 检索类工具的时间预算（毫秒），默认 8000；测试用它注入极小值制造超时降级 */
  searchTimeBudgetMs?: number;
}

interface Entry {
  spec: ToolSpec;
  run: (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;
}

const ok = (data: unknown): ToolResult => ({ ok: true, data });
/** 数据是「部分可用」时用：degraded 说明会渲染成「⚠ 本次数据不完整：…」让模型看见 */
const okDegraded = (data: unknown, degraded: string): ToolResult => ({ ok: true, data, degraded });
const err = (message: string): ToolResult => ({ ok: false, error: message });

function str(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new PathError(`参数 ${key} 必须是字符串`);
  return v;
}

function optStr(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() ? v : undefined;
}

function optNum(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function truncate(text: string, limit = MAX_OUTPUT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: text.slice(0, limit),
    truncated: true,
  };
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  return haystack.split(needle).length - 1;
}

/** .canvas / .base 是 JSON 格式：写入坏 JSON 会损坏整个文件且 Obsidian 打不开 */
const STRUCTURED_EXTS = new Set(["canvas", "base"]);

/**
 * 结构化文件（画板/数据库）写入前校验。返回错误说明，合法返回 undefined。
 * patch_file 传「打完补丁后的全文」，create/write 传将要写入的正文。
 */
function structuredFileError(path: string, resultingContent: string): string | undefined {
  const dot = path.lastIndexOf(".");
  const ext = dot >= 0 ? path.slice(dot + 1).toLowerCase() : "";
  if (!STRUCTURED_EXTS.has(ext)) return undefined;
  try {
    JSON.parse(resultingContent);
    return undefined;
  } catch (e) {
    return (
      `画板类文件（.${ext}）必须是合法 JSON，本次写入会产生坏 JSON 而损坏它：` +
      `${e instanceof Error ? e.message : String(e)}。请先 read_file 看原文，保持 JSON 结构完整。`
    );
  }
}

// ---------------------------------------------------------------------------
// 工具实现
// ---------------------------------------------------------------------------

/** 外溢文件上限放宽：那是插件自己写的中间结果，不是用户笔记 */
const SPILL_MAX_BYTES = 8 * 1024 * 1024;

function sliceLines(path: string, raw: string, args: Record<string, unknown>): ToolResult {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const total = lines.length;

  const from = Math.max(1, optNum(args, "from") ?? 1);
  const to = Math.min(total, optNum(args, "to") ?? total);
  if (from > to) throw new PathError(`行区间非法：from=${from} 大于 to=${to}`);

  const slice = lines.slice(from - 1, to).join("\n");
  const { text, truncated } = truncate(slice);

  return ok({
    path,
    totalLines: total,
    from,
    to,
    content: text,
    truncated,
    ...(truncated ? { hint: `内容已截断，请用 from/to 分段读取（共 ${total} 行）` } : {}),
  });
}

async function readFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const path = toVaultPath(args.path);

  // 外溢文件在 .obsidian/ 下，vault 索引不收录，必须直接走 adapter 读
  if (isSpillPath(path)) {
    await assertReadableSize(ctx.app, path, SPILL_MAX_BYTES);
    const raw = await ctx.app.vault.adapter.read(path);
    return sliceLines(path, raw, args);
  }

  const file = getTFile(ctx.app, args.path);
  await assertReadableSize(ctx.app, file.path);
  return sliceLines(file.path, await ctx.app.vault.cachedRead(file), args);
}


/** 批量读的硬上限：一次最多 20 个、单篇 3000 字符、总计 12000 字符 */
const BATCH_MAX_FILES = 20;
const BATCH_PER_FILE_CHARS = 3000;
const BATCH_TOTAL_CHARS = 12000;

/**
 * 一次读多篇。
 *
 * 为什么值得单独做个工具：循环每一步都要把整个上下文重发一遍，
 * 所以「读 15 个文件」不只是 15 次读取，是 15 轮全量重发。真机实测那个
 * 「统一 15 篇菜谱格式」的任务，10 步烧掉 148569 个 prompt token，其中
 * 大半是重复发送。一次拿全 = 步数从 15 压到 1，token 跟着降。
 *
 * 单篇/总量都有上限：一次塞太多会把上下文顶爆，反而更容易被截断。
 */
async function readFiles(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const raw = Array.isArray(args.paths) ? args.paths : [];
  const paths = raw
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean);
  if (paths.length === 0) return err("paths 不能为空，传相对 Vault 根目录的路径数组");
  if (paths.length > BATCH_MAX_FILES) {
    return err(`一次最多读 ${BATCH_MAX_FILES} 个文件，收到 ${paths.length} 个。分批调用。`);
  }

  const perFile = Math.min(optNum(args, "perFileChars") ?? BATCH_PER_FILE_CHARS, 8000);
  const totalBudget = Math.min(optNum(args, "totalChars") ?? BATCH_TOTAL_CHARS, 24000);

  const files: Array<{
    path: string;
    ok: boolean;
    totalLines?: number;
    content?: string;
    truncated?: boolean;
    error?: string;
  }> = [];
  let used = 0;

  for (const requested of paths) {
    if (used >= totalBudget) {
      files.push({ path: requested, ok: false, error: `未读：本次总量已到 ${totalBudget} 字符，分批调用` });
      continue;
    }
    try {
      const path = toVaultPath(requested);
      let body: string;
      let displayPath: string;
      if (isSpillPath(path)) {
        await assertReadableSize(ctx.app, path, SPILL_MAX_BYTES);
        body = await ctx.app.vault.adapter.read(path);
        displayPath = path;
      } else {
        const file = getTFile(ctx.app, requested);
        await assertReadableSize(ctx.app, file.path);
        body = await ctx.app.vault.cachedRead(file);
        displayPath = file.path;
      }
      const text = body.replace(/\r\n/g, "\n");
      const totalLines = text.split("\n").length;
      const budget = Math.max(200, Math.min(perFile, totalBudget - used));
      const cut = text.length > budget ? text.slice(0, budget) : text;
      used += cut.length;
      files.push({
        path: displayPath,
        ok: true,
        totalLines,
        content: cut,
        ...(text.length > budget
          ? { truncated: true, error: undefined }
          : {}),
      });
    } catch (e) {
      files.push({ path: requested, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  const okCount = files.filter((f) => f.ok).length;
  if (okCount === 0) {
    return err(`一个文件都没读成：${files.map((f) => `${f.path}（${f.error}）`).join("；")}`);
  }
  return ok({
    requested: paths.length,
    count: okCount,
    chars: used,
    files,
    ...(okCount < paths.length ? { hint: "没读成的看各自的 error；路径不确定先用 list_files" } : {}),
  });
}

async function listFiles(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const glob = optStr(args, "glob") ?? "**/*.md";
  const limit = Math.min(optNum(args, "limit") ?? 100, 500);
  const re = globToRegExp(glob);

  const all = ctx.app.vault.getFiles().filter((f) => !f.path.startsWith(".") && !isSensitivePath(f.path));
  const hits: string[] = [];
  for (const f of all) {
    if (hits.length >= limit) break;
    if (re.test(f.path)) hits.push(f.path);
  }

  return ok({
    count: hits.length,
    truncated: hits.length >= limit,
    files: hits,
    hint: hits.length === 0 ? "没有匹配的文件，放宽 glob（如 **/*.md）再试" : undefined,
  });
}

async function search(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const query = str(args, "query");
  const useRegex = args.regex === true;
  const limit = Math.min(optNum(args, "limit") ?? 20, MAX_HITS);
  const budget = ctx.searchTimeBudgetMs ?? 8000;

  let re: RegExp | null = null;
  if (useRegex) {
    try {
      re = new RegExp(query, "i");
    } catch (e) {
      throw new PathError(`正则表达式非法：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const needle = query.toLowerCase();
  const hits: Array<{ path: string; line: number; preview: string }> = [];
  const started = Date.now();
  let timedOut = false;

  for (const file of ctx.app.vault.getMarkdownFiles()) {
    if (hits.length >= limit) break;
    // 敏感文件不参与检索：命中片段的 preview 本身就是内容泄露
    if (isSensitivePath(file.path) || isNoisePath(file.path)) continue;
    // 单次检索的时间预算，防止大库卡死手机。
    // 超时必须让模型知道是「没搜完」而不是「没有」——静默 break 曾经让它
    // 把部分结果当成全库结论。
    if (Date.now() - started > budget) {
      timedOut = true;
      break;
    }

    let text: string;
    try {
      text = await ctx.app.vault.cachedRead(file);
    } catch {
      continue;
    }

    let idx = -1;
    if (re) {
      const m = re.exec(text);
      idx = m ? m.index : -1;
    } else {
      idx = text.toLowerCase().indexOf(needle);
    }
    if (idx < 0) continue;

    hits.push({
      path: file.path,
      // 行号从 1 开始：没有行号时模型 patch 前还得先 read_file 整篇定位，白烧一步
      line: text.slice(0, idx).split("\n").length,
      preview: text
        .slice(Math.max(0, idx - 60), idx + 140)
        .replace(/\s+/g, " ")
        .trim(),
    });
  }

  const result = {
    query,
    count: hits.length,
    truncated: hits.length >= limit,
    elapsedMs: Date.now() - started,
    hits,
  };
  return timedOut
    ? okDegraded(result, `检索在 ${budget}ms 时间预算内没有扫完全库就中止了，count 只反映已扫描的部分；没有命中不代表全库没有`)
    : ok(result);
}

async function getLinks(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const file = getTFile(ctx.app, args.path);
  const cache = ctx.app.metadataCache.getFileCache(file);
  const outgoing = (cache?.links ?? []).map((l) => ({
    link: l.link,
    resolved: ctx.app.metadataCache.getFirstLinkpathDest(l.link, file.path)?.path ?? null,
  }));
  const embeds = (cache?.embeds ?? []).map((l) => l.link);
  const tags = (cache?.tags ?? []).map((t) => t.tag);
  const headings = (cache?.headings ?? []).map((h) => `${"#".repeat(h.level)} ${h.heading}`);

  return ok({ path: file.path, outgoing, embeds, tags, headings });
}

async function getBacklinks(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const file = getTFile(ctx.app, args.path);
  // getBacklinksForFile 在部分版本上是内部 API，做个防御
  const mc = ctx.app.metadataCache as unknown as {
    getBacklinksForFile?: (f: TFile) => { data: Record<string, number> } | null;
  };
  if (typeof mc.getBacklinksForFile !== "function") {
    // 反链 API 缺失时绝不能返回空数组装作「没有引用」——那会诱导模型删除有引用的笔记
    return okDegraded(
      { path: file.path, count: null, backlinks: [] },
      "反链 API 在此版本不可用，无法统计引用；count 为 null 不代表没有反链",
    );
  }
  const res = mc.getBacklinksForFile?.(file);
  const entries = res?.data ? Object.entries(res.data) : [];

  return ok({
    path: file.path,
    count: entries.length,
    backlinks: entries.map(([path, count]) => ({ path, count })),
  });
}


/**
 * 准则守卫：在真正写之前过一道。
 * - deny 级直接抛错，没有覆盖通道
 * - confirm 级强制弹窗（不走审批记忆、不看文件数阈值），用户点接受才继续
 */
async function enforceGuard(
  ctx: ToolContext,
  path: string,
  tool: string,
  before: string,
  after: string,
): Promise<void> {
  const hit = checkProtected(path);
  if (!hit) return;
  if (hit.level === "deny") throw new PathError(hit.reason);
  const accepted = await ctx.confirm({
    tool,
    path,
    summary: `受保护文件：${path}`,
    before,
    after,
  });
  if (!accepted) throw new PathError(`用户拒绝修改受保护文件 ${path}（AI 准则：默认不许改）。`);
}

async function patchFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  // 只读前置检查必须最先做：不能因为路径不存在/参数不对就先抛别的错，
  // 那会让「为什么被拒」变成猜谜。与 create/write/move/trash 对齐。
  if (ctx.readOnly) return err("当前处于只读/隐私模式，禁止修改笔记。");
  const file = getTFile(ctx.app, args.path);
  assertWritable(file.path);

  const oldText = str(args, "old").replace(/\r\n/g, "\n");
  const newText = str(args, "new").replace(/\r\n/g, "\n");
  if (!oldText) throw new PathError("old 不能为空");
  if (oldText === newText) throw new PathError("old 与 new 相同，无需修改");

  // 只走 vault.process：手机上面板一开，笔记就不是活跃视图，
  // getActiveViewOfType(MarkdownView) 永远返回 null，editor 分支实际不可达。
  const current = (await ctx.app.vault.cachedRead(file)).replace(/\r\n/g, "\n");

  // 三级匹配：精确 → 忽略行尾空白 → 忽略首尾空白。降级但仍要求唯一。
  const match = findMatches(current, oldText);
  if (!match) {
    throw new PathError(`未找到要替换的文本（${file.path}）。\n\n${explainMismatch(current, oldText)}`);
  }
  if (match.ranges.length > 1) {
    throw new PathError(`目标文本在 ${file.path} 中出现多处。\n\n${explainAmbiguous(current, match.ranges)}`);
  }
  const range = match.ranges[0];
  // 画板类文件：校验打完补丁后的全文仍是合法 JSON，不合法就拒绝（在确认弹窗之前拦）
  const patched = current.slice(0, range.start) + newText + current.slice(range.end);
  const invalid = structuredFileError(file.path, patched);
  if (invalid) return err(invalid);
  await enforceGuard(ctx, file.path, "patch_file", oldText, newText);

  // 确认策略：该目录已被批准过就直接放行，否则累计改满 N 个文件后逐次确认
  const mustConfirm =
    ctx.readOnly === false && !ctx.approvals.isAllowed(file.path) && ctx.changedFiles.size >= ctx.confirmAfterFiles;
  if (mustConfirm) {
    const accepted = await ctx.confirm({
      tool: "patch_file",
      path: file.path,
      summary: `替换 1 处文本（${file.path}）${tierHint(match.tier) ?? ""}`,
      before: oldText,
      after: newText,
    });
    if (!accepted) return err(`用户拒绝了对 ${file.path} 的修改。请询问用户希望怎么改。`);
    ctx.approvals.allow(file.path);
  }

  let applied = false;
  await ctx.app.vault.process(file, (data) => {
    const norm = data.replace(/\r\n/g, "\n");
    // 并发保护：读到这里时内容可能已经变了，不满足唯一性就原样返回
    const again = findMatches(norm, oldText);
    if (!again || again.ranges.length !== 1) return data;
    const r = again.ranges[0];
    applied = true;
    return norm.slice(0, r.start) + newText + norm.slice(r.end);
  });
  if (!applied) {
    throw new PathError(`文件在读取后已被修改，本次替换未生效（${file.path}）。请重新 read_file 后再试。`);
  }

  ctx.changedFiles.add(file.path);
  return ok({
    path: file.path,
    matchedWith: match.tier,
    changedChars: newText.length - (range.end - range.start),
    ...(tierHint(match.tier) ? { hint: tierHint(match.tier) } : {}),
  });
}

async function createNote(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const path = toVaultPath(args.path);
  const content = typeof args.content === "string" ? args.content : "";
  const overwrite = args.overwrite === true;

  if (ctx.readOnly) return err("当前处于只读/隐私模式，禁止创建笔记。");
  const invalidCreate = structuredFileError(path, content);
  if (invalidCreate) return err(invalidCreate);
  await enforceGuard(ctx, path, "create_note", "", content.slice(0, 4000));

  const existing = ctx.app.vault.getAbstractFileByPath(path);
  if (existing) {
    if (!overwrite) {
      return err(`笔记已存在：${path}。若需修改请用 patch_file；若确实要覆盖请传 overwrite=true。`);
    }
    if (!(existing instanceof TFile)) return err(`目标是一个文件夹：${path}`);
    const accepted = ctx.approvals.isAllowed(path) || await ctx.confirm({
      tool: "create_note",
      path,
      summary: `覆盖已有笔记（${path}）`,
      before: (await ctx.app.vault.cachedRead(existing)).slice(0, 4000),
      after: content.slice(0, 4000),
    });
    if (!accepted) return err(`用户拒绝对 ${path} 的覆盖。`);
    ctx.approvals.allow(path);
    await ctx.app.vault.modify(existing, content);
    ctx.changedFiles.add(path);
    return ok({ path, created: false, overwritten: true });
  }

  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (dir && !ctx.app.vault.getAbstractFileByPath(dir)) {
    await ctx.app.vault.createFolder(normalizePath(dir));
  }

  await ctx.app.vault.create(path, content);
  ctx.changedFiles.add(path);
  return ok({ path, created: true, chars: content.length });
}

async function writeFile(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  // 只读检查最先做：不能因为路径不存在就报「找不到笔记」，让「为什么被拒」变成猜谜
  if (ctx.readOnly) return err("当前处于只读/隐私模式，禁止写文件。");
  const file = getTFile(ctx.app, args.path);
  assertWritable(file.path);

  const content = typeof args.content === "string" ? args.content : "";
  const invalidWrite = structuredFileError(file.path, content);
  if (invalidWrite) return err(invalidWrite);
  const before = await ctx.app.vault.cachedRead(file);
  await enforceGuard(ctx, file.path, "write_file", before.slice(0, 4000), content.slice(0, 4000));

  const accepted = ctx.approvals.isAllowed(file.path) || await ctx.confirm({
    tool: "write_file",
    path: file.path,
    summary: `整篇覆盖（${file.path}）`,
    before,
    after: content,
  });
  if (!accepted) return err(`用户拒绝了对 ${file.path} 的整体覆盖。`);
  ctx.approvals.allow(file.path);

  await ctx.app.vault.modify(file, content);
  ctx.changedFiles.add(file.path);
  return ok({ path: file.path, chars: content.length });
}

async function openNote(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const file = getTFile(ctx.app, args.path);
  const leaf = ctx.app.workspace.getLeaf(false);
  await leaf.openFile(file);
  return ok({ path: file.path, opened: true });
}

// ---------------------------------------------------------------------------
// 注册表
// ---------------------------------------------------------------------------

const REGISTRY = new Map<string, Entry>();

function reg(entry: Entry): void {
  REGISTRY.set(entry.spec.name, entry);
}

reg({
  spec: {
    name: "read_file",
    description:
      "读取一篇笔记的内容。默认整篇返回；超过 20000 字符会被截断，此时必须改用 from/to 分段读取。修改任何文件前都应先读它。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对 Vault 根目录的路径，如 读书/置身事内.md" },
        from: { type: "number", description: "起始行（1 开始，含）" },
        to: { type: "number", description: "结束行（含）" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  run: readFile,
});


reg({
  spec: {
    name: "read_files",
    description:
      "一次读多篇笔记（最多 20 个）。要读 3 个以上文件时用它，别一个一个 read_file——" +
      "每多一步就要把上下文重发一遍，步数就是钱。单篇超 3000 字符会截断（那篇单独用 read_file 分段读）。",
    parameters: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "相对 Vault 根目录的路径数组，如 [\"a.md\", \"b.md\"]",
        },
        perFileChars: { type: "number", description: "单篇最多返回多少字符，默认 3000" },
        totalChars: { type: "number", description: "本次总量上限，默认 12000" },
      },
      required: ["paths"],
      additionalProperties: false,
    },
  },
  run: readFiles,
});

reg({
  spec: {
    name: "list_files",
    description: "按 glob 列出 Vault 内的文件。用于确认路径或了解一个目录下有什么。",
    parameters: {
      type: "object",
      properties: {
        glob: { type: "string", description: "glob 模式，如 读书/*.md 或 **/*.md，默认 **/*.md" },
        limit: { type: "number", description: "最多返回条数，默认 100" },
      },
      additionalProperties: false,
    },
  },
  run: listFiles,
});

reg({
  spec: {
    name: "search",
    description:
      "在全部 Markdown 笔记中做关键词或正则检索，返回命中文件与上下文片段。用于「找出所有提到 X 的笔记」。",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "关键词或正则" },
        regex: { type: "boolean", description: "是否按正则解释，默认 false" },
        limit: { type: "number", description: "最多返回条数，默认 20" },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  run: search,
});

reg({
  spec: {
    name: "get_links",
    description: "读取一篇笔记的出链、嵌入、标签、标题结构。了解它引用了谁。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "相对 Vault 的路径" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  run: getLinks,
});

reg({
  spec: {
    name: "get_backlinks",
    description: "读取一篇笔记的反链。了解谁引用了它，常用于判断改动的影响面。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "相对 Vault 的路径" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  run: getBacklinks,
});

reg({
  spec: {
    name: "patch_file",
    description:
      "在笔记中做一次精确文本替换。old 必须在文件中唯一出现，否则失败（0 次或多次都会报错）。" +
      "小改动一律用它，不要用 write_file。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对 Vault 的路径" },
        old: { type: "string", description: "要被替换的原文，必须唯一，建议带上前后各一行" },
        new: { type: "string", description: "替换后的文本" },
      },
      required: ["path", "old", "new"],
      additionalProperties: false,
    },
  },
  run: patchFile,
});

reg({
  spec: {
    name: "create_note",
    description: "新建一篇笔记（自动创建父目录）。目标已存在时默认失败，避免误覆盖。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对 Vault 的路径，需含 .md" },
        content: { type: "string", description: "笔记内容" },
        overwrite: { type: "boolean", description: "已存在时是否覆盖，默认 false" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  run: createNote,
});

reg({
  spec: {
    name: "write_file",
    description:
      "整篇覆盖一篇已存在的笔记。高危：会丢失原文，必须慎用。仅在内容需要完全重写时使用，且需用户确认。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对 Vault 的路径" },
        content: { type: "string", description: "新的完整内容" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  run: writeFile,
});

reg({
  spec: {
    name: "open_note",
    description: "在界面中打开一篇笔记，让用户看到当前在讨论什么。无副作用。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "相对 Vault 的路径" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  run: openNote,
});



reg({
  spec: {
    name: "search_by_tag",
    description:
      "按标签找笔记（比全文 search 准得多）。标签不带 # 也行；查父标签 android 会同时命中 android/compose 这类子标签。",
    parameters: {
      type: "object",
      properties: {
        tag: { type: "string", description: "标签名，如 android 或 #android" },
        limit: { type: "number", description: "最多返回多少条，默认 60" },
      },
      required: ["tag"],
      additionalProperties: false,
    },
  },
  run: searchByTag,
});

reg({
  spec: {
    name: "list_by_frontmatter",
    description:
      "按 frontmatter 属性筛选笔记。只传 key 就是「哪些笔记有这个属性」；再传 value 做包含匹配。常用于找 status/难度/来源 某一类笔记。",
    parameters: {
      type: "object",
      properties: {
        key: { type: "string", description: "属性名，如 status、difficulty、source" },
        value: { type: "string", description: "可选，属性值（包含匹配）" },
        limit: { type: "number", description: "最多返回多少条，默认 60" },
      },
      required: ["key"],
      additionalProperties: false,
    },
  },
  run: listByFrontmatter,
});

reg({
  spec: {
    name: "move_note",
    description:
      "移动或重命名笔记，并且自动更新全库里指向它的 [[双链]]（这一点用 write_file 搬文件做不到）。目标存在时会被拒绝。",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "原路径" },
        to: { type: "string", description: "新路径（含新文件名）" },
      },
      required: ["from", "to"],
      additionalProperties: false,
    },
  },
  run: moveNote,
});


reg({
  spec: {
    name: "trash_note",
    description:
      "把一篇笔记移入回收站（不硬删，可恢复）。用户明确要求删除时才用；有反向链接时确认框会告警。删文件夹用 trash_folder。",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "要删的笔记路径" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  run: trashNote,
});

reg({
  spec: {
    name: "trash_folder",
    description:
      "把文件夹移入回收站。非空文件夹必须显式带 recursive: true，否则会被拒绝——避免手一滑删掉整个目录。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件夹路径" },
        recursive: { type: "boolean", description: "非空文件夹必须显式传 true" },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  run: trashFolder,
});

reg({
  spec: {
    name: "ask_user",
    description:
      "需要用户拍板时用它（批量改动的方案、有歧义的需求、要删东西前的确认）。" +
      "调用后任务立刻暂停，等用户回复，面板会显示「已暂停，等你回话」。" +
      "不要用普通文字提问——普通文字会被当成「任务完成」，用户看不到需要他回复。" +
      "能穷举出选项时一定要给 options（2-6 个，每个是一句人话）：用户在手机上点一下就能答，" +
      "省得打字。只有真正开放的问题才不给选项。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "要问用户的问题，含方案要点" },
        options: {
          type: "array",
          items: { type: "string" },
          description: "可点选的答案（2-6 个）。用户点的就是这句文字，直接当回复发回来",
        },
        multiple: { type: "boolean", description: "是否允许多选（面板会出现「提交」按钮）" },
      },
      required: ["question"],
    },
  },
  async run(ctx, args) {
    const question = typeof args.question === "string" ? args.question.trim() : "";
    if (!question) return err("question 不能为空");
    if (!ctx.requestPause) return err("当前上下文不支持暂停，请把方案直接写在回复里");
    const raw = Array.isArray(args.options) ? args.options : [];
    const options = raw
      .filter((o): o is string => typeof o === "string")
      .map((o) => o.trim())
      .filter(Boolean)
      .slice(0, 6);
    if (options.length === 1) return err("options 要么不给，要么至少 2 个（一个选项等于命令，不需要问）");
    ctx.requestPause({ text: question, options: options.length >= 2 ? options : undefined, multiple: args.multiple === true });
    return ok({ asked: true, note: "已暂停，等用户回复后再继续。" });
  },
});

reg({
  spec: {
    name: "read_checklist",
    description:
      "取准则检查清单全文：kind=pre 是任务前清单（AI/01），kind=post 是任务后质检清单（AI/02）。结束任务前逐项核对时用。",
    parameters: {
      type: "object",
      properties: { kind: { type: "string", enum: ["pre", "post"], description: "pre 或 post" } },
      additionalProperties: false,
    },
  },
  run: readChecklist,
});

reg({
  spec: {
    name: "use_skill",
    description:
      "读取某个 skill 的完整内容。system prompt 里只列了名字和一句话描述，任务匹配某个 skill 时用这个读全文再照做。",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "skill 名字或路径" } },
      required: ["name"],
      additionalProperties: false,
    },
  },
  run: useSkill,
});


/**
 * 回写记忆区（准则 Step 4）。
 *
 * 注意这里**故意不走准则守卫**：AI/04、AI/05 在 AI/ 目录下，守卫会拦模型
 * 直接改 00-06；但准则同时要求「回写 04/05」，所以这条写入必须由插件代劳，
 * 和修改记录同一个例外。写入格式是固定的字段模板，不是让模型自由发挥。
 */
async function recordMemoryTool(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (ctx.readOnly) return err("当前处于只读/隐私模式，禁止写记忆区。");
  const kind = args.kind === "history" ? "history" : "working";
  const title = str(args, "title").trim();
  const content = str(args, "content").trim();
  if (!title) throw new PathError("title 不能为空");
  if (!content) throw new PathError("content 不能为空");

  try {
    const path = await recordMemory(ctx.app, { kind, title, content });
    ctx.changedFiles.add(path);
    ctx.markMemory?.();
    return ok({ written: true, path, kind, hint: kind === "working" ? "已记入当前活跃任务" : "已追加到对话历史记录区" });
  } catch (e) {
    return err(`写记忆区失败：${e instanceof Error ? e.message : String(e)}`);
  }
}


reg({
  spec: {
    name: "record_memory",
    description:
      "回写工作记忆（准则 Step 4）。kind=working 记入 AI/04 的「当前活跃任务」，kind=history 追加到 AI/05。任务做完且修改了文件时应该调用一次。",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["working", "history"], description: "写哪个区，默认 working" },
        title: { type: "string", description: "一句话任务标题" },
        content: { type: "string", description: "做了什么、结论是什么、下一步是什么" },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
  },
  run: recordMemoryTool,
});

/** 取检查清单全文（Step 1/3 需要逐条核对时用） */
async function readChecklist(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const kind = args.kind === "post" ? "post" : "pre";
  const path = kind === "post" ? POST_CHECKLIST_PATH : PRE_CHECKLIST_PATH;
  const file = ctx.app.vault.getAbstractFileByPath(path);
  if (!(file instanceof TFile)) return err(`找不到 ${path}`);
  const raw = await ctx.app.vault.cachedRead(file);
  const sections = parseChecklist(raw);
  return ok({
    kind,
    path,
    sections: sections.map((s) => ({ section: s.title, items: s.items })),
    total: sections.reduce((n, s) => n + s.items.length, 0),
  });
}


// ---------------------------------------------------------------------------
// 删除：走回收站，不硬删
// ---------------------------------------------------------------------------

/**
 * 数一下有多少笔记链到它——准则 02 的「删除任务」要求先确认没有引用。
 * 返回 null 表示反链状态未知（API 缺失或抛错）——绝不能把「未知」当成「没有」，
 * 否则确认框会写着「没有笔记链到它」然后删出一个断链。
 */
function countBacklinks(ctx: ToolContext, file: TFile): number | null {
  try {
    const mc = ctx.app.metadataCache as unknown as {
      getBacklinksForFile?: (f: TFile) => { data: Record<string, number> } | null;
    };
    if (typeof mc.getBacklinksForFile !== "function") return null;
    const res = mc.getBacklinksForFile?.(file);
    return res?.data ? Object.keys(res.data).length : 0;
  } catch {
    return null;
  }
}

async function trashNote(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (ctx.readOnly) return err("当前处于只读/隐私模式，禁止删除。");
  const path = toVaultPath(args.path);
  const file = ctx.app.vault.getAbstractFileByPath(path);
  if (!file) throw new PathError(`找不到笔记：${path}`);
  if (!(file instanceof TFile)) return err(`${path} 是文件夹，删文件夹请用 trash_folder`);

  await enforceGuard(ctx, path, "trash_note", `删除 ${path}`, "");

  const backlinks = countBacklinks(ctx, file);
  const size = (await ctx.app.vault.cachedRead(file)).length;
  const backlinkNote =
    backlinks === null
      ? `⚠ 反链状态未知（API 不可用），无法确认是否被其他笔记引用`
      : backlinks > 0
        ? `⚠ 有 ${backlinks} 篇笔记链到它，删掉会变成断链`
        : "，没有笔记链到它";
  const accepted = await ctx.confirm({
    tool: "trash_note",
    path,
    summary: `移入回收站：${path}（${size} 字符）${backlinkNote}`,
    before: path,
    after: "回收站",
  });
  if (!accepted) return err("用户拒绝删除。");

  // 用 fileManager.trashFile：走用户在 Obsidian 里设的回收站（系统回收站或 .trash/），
  // 不是 adapter.remove 那种物理删除，删错了还能捞回来。
  await ctx.app.fileManager.trashFile(file);
  ctx.changedFiles.add(path);
  const result = {
    trashed: true,
    path,
    backlinks,
    recover: "已移入回收站，可在 Obsidian 回收站或系统回收站恢复",
  };
  return backlinks === null
    ? okDegraded(result, "删除前的反链检查没能执行（API 不可用），请留意可能产生断链")
    : ok(result);
}

async function trashFolder(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  if (ctx.readOnly) return err("当前处于只读/隐私模式，禁止删除。");
  const path = toVaultPath(args.path).replace(/\/$/, "");
  const folder = ctx.app.vault.getAbstractFileByPath(path);
  if (!folder) throw new PathError(`找不到文件夹：${path}`);
  if (!(folder instanceof TFolder)) return err(`${path} 是文件，删文件请用 trash_note`);

  const children = folder.children.length;
  const recursive = args.recursive === true;
  if (children > 0 && !recursive) {
    return err(
      `${path} 里还有 ${children} 项，不能直接删。确认要连内容一起删就带 recursive: true 重试。`,
    );
  }

  await enforceGuard(ctx, path, "trash_folder", `删除文件夹 ${path}`, "");

  const accepted = await ctx.confirm({
    tool: "trash_folder",
    path,
    summary: `移入回收站：文件夹 ${path}${children > 0 ? `（连同 ${children} 项内容）` : "（空文件夹）"}`,
    before: path,
    after: "回收站",
  });
  if (!accepted) return err("用户拒绝删除。");

  await ctx.app.fileManager.trashFile(folder);
  ctx.changedFiles.add(path);
  return ok({ trashed: true, path, items: children, recover: "已移入回收站" });
}

// ---------------------------------------------------------------------------
// 语义层：只有 Obsidian 的 metadataCache / fileManager 才做得到的事
// ---------------------------------------------------------------------------

/**
 * 这些目录里的文件不该出现在"查找"结果里：
 * - backup/ 是用户自己的历史副本，搜到会诱导模型改错文件（真机踩过：
 *   `backup/Cook/火锅食材清单-20260818.md` 抢在正本前面命中）
 * - .trash/ 是回收站，.obsidian/ 是插件自身，_agent-selftest/ 是自检产物
 */
const NOISE_PREFIXES = ["backup/", ".trash/", ".obsidian/", "_agent-selftest/"];

function isNoisePath(path: string): boolean {
  return NOISE_PREFIXES.some((p) => path.startsWith(p));
}

/** 标签统一成不带 # 的小写比较形式 */
function normTag(t: string): string {
  return t.replace(/^#/, "").trim().toLowerCase();
}

interface FrontmatterLike {
  tags?: unknown;
  [k: string]: unknown;
}

function frontmatterOf(ctx: ToolContext, file: TFile): FrontmatterLike {
  const cache = ctx.app.metadataCache.getFileCache(file) as { frontmatter?: FrontmatterLike } | null;
  return (cache?.frontmatter ?? {}) as FrontmatterLike;
}

/** frontmatter 里的 tags 可能是 []、字符串或逗号分隔串，统一成数组 */
function tagsFrom(fm: FrontmatterLike): string[] {
  const raw = fm.tags;
  if (Array.isArray(raw)) return raw.map((t) => String(t));
  if (typeof raw === "string") return raw.split(/[,，\s]+/).filter(Boolean);
  return [];
}

async function searchByTag(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const want = normTag(str(args, "tag"));
  if (!want) throw new PathError("tag 不能为空");
  const limit = Math.min(Number(args.limit) || 60, 200);

  const hits: Array<{ path: string; matched: string[] }> = [];
  for (const file of ctx.app.vault.getMarkdownFiles()) {
    if (isNoisePath(file.path)) continue;
    const cache = ctx.app.metadataCache.getFileCache(file) as
      | { tags?: Array<{ tag: string }>; frontmatter?: FrontmatterLike }
      | null;
    // metadataCache 的 tags 已经合并了正文行内标签和 frontmatter 标签
    const all = new Set<string>();
    for (const t of cache?.tags ?? []) all.add(normTag(t.tag));
    for (const t of tagsFrom((cache?.frontmatter ?? {}) as FrontmatterLike)) all.add(normTag(t));

    // 支持父标签：查 android 也能命中 android/compose
    const matched = [...all].filter((t) => t === want || t.startsWith(`${want}/`));
    if (matched.length > 0) hits.push({ path: file.path, matched });
    if (hits.length >= limit) break;
  }

  if (hits.length === 0) return ok({ tag: want, count: 0, files: [], hint: "没有笔记用这个标签，可能是标签名不对" });
  return ok({
    tag: want,
    count: hits.length,
    files: hits.map((h) => (h.matched.length > 1 ? { path: h.path, matched: h.matched } : h.path)),
  });
}

async function listByFrontmatter(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const key = str(args, "key").trim();
  if (!key) throw new PathError("key 不能为空");
  const wantValue = typeof args.value === "string" ? args.value.trim().toLowerCase() : "";
  const limit = Math.min(Number(args.limit) || 60, 200);

  const hits: Array<{ path: string; value: unknown }> = [];
  for (const file of ctx.app.vault.getMarkdownFiles()) {
    if (isNoisePath(file.path)) continue;
    const fm = frontmatterOf(ctx, file);
    if (!(key in fm)) continue;
    const value = fm[key];
    if (wantValue) {
      const flat = Array.isArray(value) ? value.map(String).join(",") : String(value ?? "");
      if (!flat.toLowerCase().includes(wantValue)) continue;
    }
    hits.push({ path: file.path, value });
    if (hits.length >= limit) break;
  }

  if (hits.length === 0) {
    return ok({ key, value: wantValue || undefined, count: 0, files: [], hint: "没有笔记带这个属性" });
  }
  return ok({ key, value: wantValue || undefined, count: hits.length, files: hits });
}

async function moveNote(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const from = toVaultPath(args.from);
  const to = toVaultPath(args.to);
  if (ctx.readOnly) return err("当前处于只读/隐私模式，禁止移动笔记。");
  if (from === to) return err("from 与 to 相同，无需移动");

  const file = ctx.app.vault.getAbstractFileByPath(from);
  if (!file) throw new PathError(`找不到笔记：${from}。先用 search 或 list_files 确认路径。`);
  if (!(file instanceof TFile)) return err(`目标是文件夹：${from}。移动文件夹请用其他方式。`);
  if (ctx.app.vault.getAbstractFileByPath(to)) {
    return err(`目标已存在：${to}。换一个位置，或先处理同名文件。`);
  }

  await enforceGuard(ctx, from, "move_note", `移动到 ${to}`, "");
  await enforceGuard(ctx, to, "move_note", "", `来自 ${from}`);

  const accepted = await ctx.confirm({
    tool: "move_note",
    path: from,
    summary: `移动笔记：${from} → ${to}（双链会自动跟着改）`,
    before: from,
    after: to,
  });
  if (!accepted) return err(`用户拒绝了这次移动。`);

  const dir = to.includes("/") ? to.slice(0, to.lastIndexOf("/")) : "";
  if (dir && !ctx.app.vault.getAbstractFileByPath(dir)) {
    await ctx.app.vault.createFolder(normalizePath(dir));
  }

  // 关键：走 fileManager.renameFile 而不是 adapter.rename——只有它会同步
  // 更新全库的 [[双链]] 和嵌入，插件自己搬文件会把链接全指空。
  try {
    await ctx.app.fileManager.renameFile(file, to);
  } catch (e) {
    return err(`移动失败：${e instanceof Error ? e.message : String(e)}`);
  }
  ctx.changedFiles.add(to);
  return ok({ moved: true, from, to, links: "已由 Obsidian 自动更新指向这篇笔记的双链" });
}

async function useSkill(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> {
  const key = str(args, "name").trim();
  if (!key) throw new PathError("name 不能为空");
  let skills: SkillMeta[];
  let scanDegraded: string | undefined;
  if (ctx.skills) {
    skills = ctx.skills;
  } else {
    const scanned = await scanSkills(ctx.app);
    skills = scanned.skills;
    scanDegraded = scanned.degraded;
  }
  const meta = findSkill(skills, key);
  if (!meta) {
    return err(
      `没有这个 skill：${key}。可用的有：${skills.map((s) => s.name).join("、") || "（无）"}` +
        (scanDegraded ? `\n⚠ 本次数据不完整：${scanDegraded}，不能据此断言库里没有这个 skill` : ""),
    );
  }
  const file = ctx.app.vault.getAbstractFileByPath(meta.path);
  if (!(file instanceof TFile)) return err(`skill 文件不见了：${meta.path}`);
  const body = await readSkillBody(ctx.app, file);
  return ok({ name: meta.name, path: meta.path, body });
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

export function getToolSpecs(ctx: ToolContext): ToolSpec[] {
  const all = [...REGISTRY.values()].map((e) => e.spec);
  if (!ctx.readOnly) return all;
  // 只读模式：只暴露不写文件的工具
  const writeTools = new Set([
    "patch_file",
    "create_note",
    "write_file",
    "move_note",
    "record_memory",
    "trash_note",
    "trash_folder",
  ]);
  return all.filter((s) => !writeTools.has(s.name));
}

export async function executeTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const entry = REGISTRY.get(call.name);
  if (!entry) {
    return err(`未知工具：${call.name}。可用工具：${[...REGISTRY.keys()].join(", ")}`);
  }

  // 模型偶尔会把参数包一层，或产生解析失败的占位参数
  if ("__parse_error__" in (call.args ?? {})) {
    return err(`工具参数不是合法 JSON：${String((call.args as Record<string, unknown>).__parse_error__).slice(0, 200)}`);
  }

  try {
    return await entry.run(ctx, call.args ?? {});
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    ctx.log.warn(`工具 ${call.name} 失败：${message}`);
    // 工具错误不抛出，交给模型自己修正
    return err(message);
  }
}

export function toolNames(): string[] {
  return [...REGISTRY.keys()];
}
