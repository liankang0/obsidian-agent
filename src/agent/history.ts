/**
 * 对话历史的落盘存储（按会话管理）。
 *
 * 结构：{ version: 2, current: 会话id, sessions: [{ id, runId?, updated, entries: [{role, content, at}] }] }
 * 旧版是一个平铺数组，读到就迁移成单会话，不丢历史。
 *
 * 为什么要落盘：面板重启、Obsidian 退出重进，用户希望上一次对话还在，
 * 而且「继续执行」要靠会话里存的 runId 找回存档。
 */

import type { HistoryTurn } from "./types";

export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
  at: number;
}

/** 面板列表用的会话视图（带条目，方便显示「N 条」） */
export interface ChatSession {
  id: string;
  title: string;
  runId?: string;
  updatedAt: number;
  entries: HistoryEntry[];
}

interface Session {
  id: string;
  runId?: string;
  updated: number;
  entries: HistoryEntry[];
}

interface Store {
  version: 2;
  current: string;
  sessions: Session[];
}

/** 单条内容上限：一份总结表格动辄两千字，再长对上下文没有边际价值 */
const ENTRY_MAX = 2000;
/** 单会话条目上限：超出就丢最旧的 */
const ENTRY_LIMIT = 100;
/** 标题上限（含结尾的省略号） */
const TITLE_MAX = 25;

interface LogLike {
  info?: (m: string) => void;
  warn?: (m: string) => void;
}

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 只接受 role 是 user/assistant 且有内容的条目；旧数据里有 tool、缺字段的都得滤掉 */
function sanitize(list: unknown): HistoryEntry[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter((e): e is { role: string; content: string; at?: number } =>
      !!e && typeof e === "object" && typeof (e as { content?: unknown }).content === "string",
    )
    .filter((e) => e.role === "user" || e.role === "assistant")
    .map((e) => ({
      role: e.role as "user" | "assistant",
      content: e.content.slice(0, ENTRY_MAX),
      at: typeof e.at === "number" ? e.at : 0,
    }));
}

export class ChatHistory {
  private data: Store | null = null;
  private loading: Promise<void> | null = null;

  constructor(
    private readonly adapter: { read: (p: string) => Promise<string>; write: (p: string, d: string) => Promise<void>; exists: (p: string) => Promise<boolean>; mkdir?: (p: string) => Promise<void> },
    private readonly path: string,
    private readonly log?: LogLike,
  ) {}

  // ── 读写磁盘 ─────────────────────────────────────────────

  private async ensureLoaded(): Promise<Store> {
    if (this.data) return this.data;
    if (!this.loading) this.loading = this.doLoad().then(() => undefined);
    await this.loading;
    return this.data!;
  }

  private async doLoad(): Promise<void> {
    let raw = "";
    try {
      raw = (await this.adapter.exists(this.path)) ? await this.adapter.read(this.path) : "";
    } catch {
      raw = "";
    }

    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      // 坏文件按空历史处理，别让插件起不来
      parsed = null;
    }

    if (Array.isArray(parsed)) {
      // 旧版平铺数组 → 迁成一个会话
      const entries = sanitize(parsed);
      this.data = { version: 2, current: newId(), sessions: [{ id: newId(), updated: Date.now(), entries }] };
      this.data.sessions[0].id = this.data.current;
      await this.persist();
      return;
    }

    const store = parsed as Partial<Store> | null;
    if (store && typeof store === "object" && Array.isArray(store.sessions)) {
      const sessions: Session[] = store.sessions
        .filter((s): s is Session => !!s && typeof s === "object" && typeof (s as Session).id === "string")
        .map((s) => ({
          id: s.id,
          runId: typeof s.runId === "string" ? s.runId : undefined,
          updated: typeof s.updated === "number" ? s.updated : 0,
          entries: sanitize(s.entries),
        }));
      if (sessions.length === 0) {
        const id = newId();
        this.data = { version: 2, current: id, sessions: [{ id, updated: Date.now(), entries: [] }] };
        return;
      }
      const current = sessions.some((s) => s.id === store.current) ? (store.current as string) : sessions[0].id;
      this.data = { version: 2, current, sessions };
      return;
    }

    const id = newId();
    this.data = { version: 2, current: id, sessions: [{ id, updated: Date.now(), entries: [] }] };
  }

  private async persist(): Promise<void> {
    if (!this.data) return;
    try {
      const dir = this.path.split("/").slice(0, -1).join("/");
      if (dir && this.adapter.mkdir && !(await this.adapter.exists(dir))) {
        await this.adapter.mkdir(dir).catch(() => undefined);
      }
      await this.adapter.write(this.path, JSON.stringify(this.data, null, 2));
    } catch (e) {
      this.log?.warn?.(`对话历史落盘失败：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── 查询 ────────────────────────────────────────────────

  /** 会话的「最近更新」时间必须单调递增：同一毫秒内新建再写入，列表顺序会乱 */
  private touch(store: Store, s: Session): void {
    const max = store.sessions.reduce((m, x) => Math.max(m, x.updated ?? 0), 0);
    s.updated = Math.max(Date.now(), max + 1);
  }

  private cur(store: Store): Session {
    return store.sessions.find((s) => s.id === store.current) ?? store.sessions[0];
  }

  private titleOf(s: Session): string {
    const first = s.entries.find((e) => e.role === "user");
    const text = (first?.content ?? "").replace(/\s+/g, " ").trim();
    if (!text) return "新会话";
    return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
  }

  /** 当前会话的条目数 */
  get size(): number {
    if (!this.data) return 0;
    return this.cur(this.data).entries.length;
  }

  async load(): Promise<HistoryEntry[]> {
    const store = await this.ensureLoaded();
    return [...this.cur(store).entries];
  }

  /** 给模型用的纯文本历史（去掉 at） */
  recent(n = Number.POSITIVE_INFINITY): HistoryTurn[] {
    if (!this.data) return [];
    const entries = this.cur(this.data).entries;
    const take = n === Number.POSITIVE_INFINITY ? entries : entries.slice(-n);
    return take.map((e) => ({ role: e.role, content: e.content }));
  }

  private view(s: Session): ChatSession {
    return {
      id: s.id,
      title: this.titleOf(s),
      runId: s.runId,
      updatedAt: s.updated,
      entries: [...s.entries],
    };
  }

  list(): ChatSession[] {
    if (!this.data) return [];
    return [...this.data.sessions]
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))
      .map((s) => this.view(s));
  }

  current(): ChatSession | undefined {
    if (!this.data) return undefined;
    return this.view(this.cur(this.data));
  }

  // ── 修改 ────────────────────────────────────────────────

  async ensureSession(): Promise<string> {
    const store = await this.ensureLoaded();
    if (store.sessions.length === 0) {
      const id = newId();
      store.sessions.push({ id, updated: Date.now(), entries: [] });
      store.current = id;
      await this.persist();
    }
    return store.current;
  }

  async createSession(): Promise<ChatSession> {
    const store = await this.ensureLoaded();
    const id = newId();
    const session: Session = { id, updated: 0, entries: [] };
    this.touch(store, session);
    store.sessions.push(session);
    store.current = id;
    await this.persist();
    return { id, title: "新会话", updatedAt: session.updated, entries: [] };
  }

  async append(entry: { role: "user" | "assistant"; content: string; at?: number }): Promise<void> {
    const store = await this.ensureLoaded();
    await this.ensureSession();
    const s = this.cur(store);
    s.entries.push({
      role: entry.role,
      content: (entry.content ?? "").slice(0, ENTRY_MAX),
      at: typeof entry.at === "number" ? entry.at : Date.now(),
    });
    if (s.entries.length > ENTRY_LIMIT) s.entries = s.entries.slice(-ENTRY_LIMIT);
    this.touch(store, s);
    await this.persist();
  }

  async open(id: string): Promise<HistoryEntry[]> {
    const store = await this.ensureLoaded();
    if (store.sessions.some((s) => s.id === id)) {
      store.current = id;
      await this.persist();
    }
    return this.load();
  }

  async setRunId(runId: string): Promise<void> {
    const store = await this.ensureLoaded();
    await this.ensureSession();
    this.cur(store).runId = runId;
    await this.persist();
  }

  async remove(id: string): Promise<void> {
    const store = await this.ensureLoaded();
    store.sessions = store.sessions.filter((s) => s.id !== id);
    if (store.sessions.length === 0) {
      const nid = newId();
      store.sessions.push({ id: nid, updated: Date.now(), entries: [] });
      store.current = nid;
    } else if (!store.sessions.some((s) => s.id === store.current)) {
      // 删掉的正是当前会话：切到最近更新的那个
      const next = [...store.sessions].sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0))[0];
      store.current = next.id;
    }
    await this.persist();
  }

  async clear(): Promise<void> {
    const store = await this.ensureLoaded();
    await this.ensureSession();
    const s = this.cur(store);
    s.entries = [];
    s.runId = undefined;
    this.touch(store, s);
    await this.persist();
  }
}
