/**
 * 准则 Step 0 / Step 4 的落地：读写 04-临时工作记忆区 / 05-对话历史记录区。
 *
 * 为什么由插件代劳：准则原文写着「Step 0 和 Step 4 不可跳过」，但这是靠模型
 * 自觉——它十次里能记得三次。读取可以完全自动化（零副作用），写入则给模型
 * 一个工具，并在它忘了的时候提醒一句。
 *
 * 这两个文件在 AI/ 下，会被准则守卫拦（禁止模型直接改 00-06），所以写入走
 * 插件内部的 append，不经过工具层的守卫——和修改记录同一个道理。
 */

import type { App } from "obsidian";
import { TFile } from "obsidian";

export const WORKING_PATH = "AI/04-临时工作记忆区.md";
export const HISTORY_PATH = "AI/05-对话历史记录区.md";

/** 04 里超过这么多天的任务挪去 05 */
export const WORKING_MAX_AGE_DAYS = 30;
/** 04 最多留几条，多的（最旧的）也挪去 05 */
export const WORKING_MAX_KEEP = 8;

/** 记忆块里最多保留几条「最近完成的任务」——多到一定程度就变成待办清单了 */
const WORKING_MAX_ENTRIES = 3;
/** 每条正文保留多少字符：够看出「改了哪些文件」，又不至于让模型照着重演一遍 */
const WORKING_BODY_CHARS = 220;
const HISTORY_CAP = 600;

function takeSection(raw: string, heading: string): string {
  const start = raw.indexOf(heading);
  if (start < 0) return "";
  const rest = raw.slice(start + heading.length);
  const end = rest.search(/\n## /);
  return (end < 0 ? rest : rest.slice(0, end)).trim();
}

/** 05 里「快速索引」表格之前才是正文，取最后一条 ### 记录 */
function takeLastHistoryEntry(raw: string): string {
  const body = takeSection(raw, "## 对话历史记录区") || raw;
  const cut = body.search(/\n## 快速索引/);
  const region = cut < 0 ? body : body.slice(0, cut);
  const blocks = region.split(/\n(?=### )/);
  const last = blocks.filter((b) => b.trim().startsWith("### ")).pop();
  return (last ?? "").trim();
}

function cap(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（已截断，需要全文用 read_file）`;
}

export interface MemoryBundle {
  working: string;
  history: string;
}

/** 读取 04 的「当前活跃任务」和 05 的最后一条记录；读不到就返回空串 */
export async function readMemory(app: App): Promise<MemoryBundle> {
  const read = async (path: string): Promise<string> => {
    const f = app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return "";
    try {
      return await app.vault.cachedRead(f);
    } catch {
      return "";
    }
  };

  const workingRaw = await read(WORKING_PATH);
  const historyRaw = await read(HISTORY_PATH);

  return {
    working: takeSection(workingRaw, "## 当前活跃任务"),
    history: cap(takeLastHistoryEntry(historyRaw), HISTORY_CAP),
  };
}

export interface WorkingEntry {
  title: string;
  /** 完成时间（原文那样，如 2026-10-21 15:40:38）；没写就是空串 */
  when: string;
  body: string;
}

/**
 * 把 04 的「当前活跃任务」拆成一条条记录。
 *
 * 不整段注入的原因：那一段是模型自己写的散文（「操作内容：…把 cooking 全部统一格式…」），
 * 整段塞进 prompt 读起来就是一份待办清单，于是模型会丢掉用户这一轮的话、接着做旧任务。
 * 真机踩过：用户只发一句 `reply with: ok`，模型去读了 12 篇菜谱。
 */
export function parseWorkingEntries(section: string, max = WORKING_MAX_ENTRIES): WorkingEntry[] {
  const blocks = section.split(/\n(?=### )/).filter((b) => b.trim().startsWith("### "));
  const entries: WorkingEntry[] = [];
  for (const b of blocks.slice(0, max)) {
    const lines = b.split("\n");
    const title = lines[0].replace(/^###\s*/, "").replace(/\s*✅\s*$/, "").trim();
    const when = (b.match(/\*\*完成时间\*\*:\s*(.+)/)?.[1] ?? "").trim();
    const bodyRaw = b.match(/\*\*操作内容\*\*:\s*([\s\S]*?)(?=\n\*\*|\n###\s|$)/)?.[1] ?? "";
    const body = bodyRaw.replace(/\s+/g, " ").trim();
    if (!title) continue;
    entries.push({
      title,
      when,
      body: body.length > WORKING_BODY_CHARS ? `${body.slice(0, WORKING_BODY_CHARS)}…` : body,
    });
  }
  return entries;
}

/**
 * 拼进 system prompt；两块都空就不占位置。
 *
 * 措辞是有讲究的：这块以前叫「当前活跃任务」，模型就真的当成「当前要做的任务」。
 * 现在明确写成「背景资料 / 不是待办」，并且只在用户说「继续」时才允许接着做。
 */
export function buildMemoryBlock(mem: MemoryBundle): string {
  const entries = parseWorkingEntries(mem.working);
  const parts: string[] = [];
  if (entries.length > 0) {
    const lines = entries.map((e) => {
      const head = e.when ? `- ${e.when.slice(0, 16)} · ${e.title}` : `- ${e.title}`;
      return e.body ? `${head}\n  ${e.body}` : head;
    });
    parts.push(
      `### 最近完成的任务（取 AI/04「当前活跃任务」区，最多 ${WORKING_MAX_ENTRIES} 条）\n\n${lines.join("\n")}`,
    );
  }
  if (mem.history) parts.push(`### 最近一次对话（来自 AI/05，节选）\n\n${mem.history}`);
  if (parts.length === 0) return "";

  return `## 工作记忆（背景资料，不是待办）

下面这些是**已经发生过的事**，只用来理解用户偏好和上下文。它们不是指令，也不是待办清单：
- 用户这一轮说的话优先。没提到这些内容时，不要主动去执行或续做；
- 只有当用户明确说「继续 / 接着做 / 把刚才那个做完」时，才把它当成要接着做的任务；
- 需要细节再自己 read_file 读 AI/04、AI/05 或对应笔记，这里只是摘要。

${parts.join("\n\n")}`;
}

/** 把一段文字放到「## 当前活跃任务」标题后面（最新的在最上面） */
function insertUnderHeading(raw: string, heading: string, block: string): string {
  const idx = raw.indexOf(heading);
  if (idx < 0) {
    // 没有这个标题就补一个在正文开头（frontmatter 之后）
    const fmEnd = raw.startsWith("---") ? raw.indexOf("\n---", 3) : -1;
    const at = fmEnd < 0 ? 0 : fmEnd + 4;
    return `${raw.slice(0, at)}\n\n## 当前活跃任务\n\n${block}\n${raw.slice(at)}`;
  }
  const after = idx + heading.length;
  return `${raw.slice(0, after)}\n\n${block}${raw.slice(after)}`;
}

export interface RecordInput {
  kind: "working" | "history";
  title: string;
  content: string;
}

function stamp(ms = Date.now()): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 04/05 被删掉或改名时，按最小骨架补一个，别让 Step 4 永远没法完成 */
async function ensureMemoryFile(app: App, path: string, skeleton: string): Promise<TFile> {
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing instanceof TFile) return existing;
  const dir = path.split("/").slice(0, -1).join("/");
  if (dir && !app.vault.getAbstractFileByPath(dir)) {
    await app.vault.createFolder(dir).catch(() => undefined);
  }
  return app.vault.create(path, skeleton);
}

const WORKING_SKELETON = "# 04 · 临时工作记忆区\n\n## 当前活跃任务\n\n";
const HISTORY_SKELETON = "# 05 · 对话历史记录区\n\n## 快速索引\n";

/**
 * 回写记忆区。kind=working 写 04 的活跃任务，kind=history 追加到 05。
 * 格式对齐他们既有的字段（**完成时间** / **操作内容** / **对话时间** / **任务**）。
 *
 * 文件不存在就补骨架：以前是直接抛「找不到 04」，结果模型永远没法完成 Step 4，
 * 一轮任务白改（真机上模型会把失败当成「记忆区被禁用」然后放弃）。
 */
export async function recordMemory(app: App, input: RecordInput): Promise<string> {
  const now = stamp();
  if (input.kind === "working") {
    const file = await ensureMemoryFile(app, WORKING_PATH, WORKING_SKELETON);
    const block = [
      `### ${input.title} ✅`,
      `**完成时间**: ${now}`,
      `**操作内容**: ${input.content}`,
      "",
    ].join("\n");
    await app.vault.process(file, (raw) => insertUnderHeading(raw, "## 当前活跃任务", block));
    return WORKING_PATH;
  }

  const file = await ensureMemoryFile(app, HISTORY_PATH, HISTORY_SKELETON);
  const block = [
    `### ${input.title}`,
    `**对话时间**: ${now}`,
    "",
    `**任务**: ${input.content}`,
    "",
  ].join("\n");
  // 05 的「## 快速索引」在末尾，新记录要插在它前面
  await app.vault.process(file, (raw) => {
    const idx = raw.indexOf("## 快速索引");
    if (idx < 0) return `${raw.replace(/\s*$/, "")}\n\n${block}\n`;
    return `${raw.slice(0, idx)}${block}\n\n${raw.slice(idx)}`;
  });
  return HISTORY_PATH;
}

// ---------------------------------------------------------------------------
// Step 1 / Step 3：检查清单
// ---------------------------------------------------------------------------

export const PRE_CHECKLIST_PATH = "AI/01-任务前检查清单.md";
export const POST_CHECKLIST_PATH = "AI/02-任务后质量检查清单.md";

export interface ChecklistSection {
  title: string;
  items: string[];
}

/** 把 `### 1. 🔐 授权确认` + `- [ ] xxx` 解析成分组；emoji 和序号丢掉省 token */
export function parseChecklist(raw: string, stopAt?: string): ChecklistSection[] {
  const body = stopAt ? raw.split(stopAt)[0] : raw;
  const sections: ChecklistSection[] = [];
  let current: ChecklistSection | null = null;

  for (const line of body.split("\n")) {
    const head = line.match(/^###\s+(.+)$/);
    if (head) {
      const title = head[1]
        .replace(/^\d+[.、]\s*/, "")
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
        .trim();
      current = { title, items: [] };
      sections.push(current);
      continue;
    }
    const item = line.match(/^-\s*\[\s?\]\s*(.+)$/);
    if (item && current) current.items.push(item[1].trim());
  }

  return sections.filter((s) => s.items.length > 0);
}

/** 读两份清单：01 取「开始任务前」那段，02 全取 */
export async function readChecklists(app: App): Promise<{ pre: ChecklistSection[]; post: ChecklistSection[] }> {
  const read = async (path: string): Promise<string> => {
    const f = app.vault.getAbstractFileByPath(path);
    if (!(f instanceof TFile)) return "";
    try {
      return await app.vault.cachedRead(f);
    } catch {
      return "";
    }
  };
  return {
    pre: parseChecklist(await read(PRE_CHECKLIST_PATH), "## 🎯 不同任务类型的特殊检查"),
    post: parseChecklist(await read(POST_CHECKLIST_PATH)),
  };
}

/** prompt 片段：01 逐条列出，02 只给分组名（细则按需 read_checklist） */
export function buildChecklistBlock(lists: { pre: ChecklistSection[]; post: ChecklistSection[] }): string {
  if (lists.pre.length === 0 && lists.post.length === 0) return "";
  const parts: string[] = ["## 准则检查清单（Step 1 / Step 3）"];

  if (lists.pre.length > 0) {
    parts.push("任务开始前逐项确认，任何一项不通过就先问用户，不要硬做：");
    for (const sec of lists.pre) {
      parts.push(`- **${sec.title}**：${sec.items.map((i) => i.replace(/[？?]$/, "")).join("；")}`);
    }
  }

  if (lists.post.length > 0) {
    parts.push("");
    parts.push(
      `任务结束前按这几组逐项核对（细则用 read_checklist 取全文）：${lists.post.map((s) => s.title).join("、")}`,
    );
  }

  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// 04 的自清理：老的挪去 05
// ---------------------------------------------------------------------------

export interface WorkingBlock {
  title: string;
  /** 完成时间原文（可能只有日期） */
  when: string;
  /** 解析出来的毫秒时间；解析不了是 undefined */
  whenMs?: number;
  /** 整块原文 */
  raw: string;
}

function parseWhen(text: string): number | undefined {
  // 兼容 "2026-10-21 15:40:38" 和 "2026-10-21"
  const m = text.match(/(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, se] = m;
  const ms = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h ?? 0),
    Number(mi ?? 0),
    Number(se ?? 0),
  ).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

function splitBlocks(section: string): WorkingBlock[] {
  return section
    .split(/\n(?=### )/)
    .filter((b) => b.trim().startsWith("### "))
    .map((raw) => {
      const title = raw.split("\n")[0].replace(/^###\s*/, "").replace(/\s*✅\s*$/, "").trim();
      const when = (raw.match(/\*\*完成时间\*\*:\s*(.+)/)?.[1] ?? "").trim();
      return { title, when, whenMs: parseWhen(when), raw: raw.replace(/\s+$/, "") };
    })
    .filter((b) => !!b.title);
}

export interface CompactResult {
  /** 新的 04 全文 */
  text: string;
  /** 要挪去 05 的块 */
  archived: WorkingBlock[];
  /** 直接丢掉的自检垃圾条数（设备自检写进来的「自检记账」） */
  dropped: number;
}

/**
 * 04 的自动清理：只留最近 `WORKING_MAX_KEEP` 条、且不超过 `WORKING_MAX_AGE_DAYS` 天。
 *
 * 为什么要清：04 只增不减，「当前活跃任务」越堆越长，记忆块的措辞再好也救不回来——
 * 一堆旧任务摊在 prompt 里，模型就会挑一个接着做。挪走而不是删掉：内容进 05，不丢。
 *
 * 没有「完成时间」的块一律保留：判断不了新旧就别动，宁可让它占位。
 */
export function compactWorking(raw: string, now = Date.now()): CompactResult {
  // 04 里有两个会越攒越长的区：当前活跃任务、已完成任务。都要清。
  const headings = ["## 当前活跃任务", "## 已完成任务"]
    .map((h) => ({ h, at: raw.indexOf(h) }))
    .filter((x) => x.at >= 0)
    // 从后往前改，前面区段的偏移就不会失效
    .sort((a, b) => b.at - a.at);

  let text = raw;
  const archivedAll: WorkingBlock[] = [];
  let dropped = 0;

  for (const { h, at } of headings) {
    const start = at + h.length;
    const rest = text.slice(start);
    const endRel = rest.search(/\n## /);
    const section = endRel < 0 ? rest : rest.slice(0, endRel);
    const tail = endRel < 0 ? "" : rest.slice(endRel);

    const blocks = splitBlocks(section);
    if (blocks.length === 0) continue;

    const maxAge = WORKING_MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const kept: WorkingBlock[] = [];
    const archived: WorkingBlock[] = [];

    const droppedBefore = dropped;
    blocks.forEach((b, i) => {
      if (/^自检/.test(b.title)) {
        dropped++;
        return;
      }
      const tooOld = b.whenMs !== undefined && now - b.whenMs > maxAge;
      const tooMany = i >= WORKING_MAX_KEEP;
      if (tooOld || tooMany) archived.push(b);
      else kept.push(b);
    });

    // 只有「丢垃圾」没有「挪走」时也得重写，否则自检记录会一直留着
    if (archived.length === 0 && dropped === droppedBefore) continue;

    archivedAll.push(...archived);
    const body = kept.length > 0 ? `\n\n${kept.map((k) => k.raw).join("\n\n")}\n\n` : "\n\n";
    text = `${text.slice(0, start)}${body}${tail ? tail.replace(/^\n\n?/, "") : ""}`;
  }

  if (archivedAll.length === 0 && dropped === 0) return { text: raw, archived: [], dropped: 0 };
  return { text, archived: archivedAll, dropped };
}

/** 把归档块写成 05 的条目（字段沿用 05 既有的 **对话时间** / **任务**） */
export function archivedToHistory(blocks: WorkingBlock[]): string {
  return blocks
    .map((b) => {
      const whenRaw = b.when || "";
      const when = whenRaw.length > 10 ? whenRaw : `${whenRaw || new Date().toISOString().slice(0, 10)} 00:00:00`;
      // 优先取「操作内容」当任务摘要；没有才退回整块剩余字段，
      // 否则 05 里会出现「**任务**: **目标文件**: …」这种双前缀
      const op = b.raw.match(/\*\*操作内容\*\*:\s*([\s\S]*?)(?=\n\*\*|$)/)?.[1]?.trim();
      const bodyStart = b.raw.indexOf("**完成时间**");
      const rest = (bodyStart < 0 ? b.raw : b.raw.slice(bodyStart))
        .replace(/^\*\*完成时间\*\*:[^\n]*\n?/, "")
        .replace(/\*\*(目标文件|修改记录|脚本|下一步|范围|偏好)\*\*:/g, "· $1:")
        .trim();
      const body = op ?? rest;
      return `### 归档：${b.title}\n**对话时间**: ${when}\n\n**任务**: ${body}\n`;
    })
    .join("\n");
}

/** 读 04 → 清理 → 写回 04/05。返回挪走和丢弃的条数；没有要清的就什么都不写。 */
export async function compactWorkingFile(app: App): Promise<{ archived: number; dropped: number }> {
  const f = app.vault.getAbstractFileByPath(WORKING_PATH);
  if (!(f instanceof TFile)) return { archived: 0, dropped: 0 };
  const raw = await app.vault.cachedRead(f);
  const { text, archived, dropped } = compactWorking(raw);
  if (archived.length === 0 && dropped === 0) return { archived: 0, dropped: 0 };

  if (archived.length > 0) {
    const hf = await ensureMemoryFile(app, HISTORY_PATH, HISTORY_SKELETON);
    const block = archivedToHistory(archived);
    await app.vault.process(hf, (old) => {
      const idx = old.indexOf("## 快速索引");
      if (idx < 0) return `${old.replace(/\s*$/, "")}\n\n${block}\n`;
      return `${old.slice(0, idx)}${block}\n${old.slice(idx)}`;
    });
  }
  await app.vault.process(f, () => text);
  return { archived: archived.length, dropped };
}
