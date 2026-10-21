/**
 * `obsidian` 模块的最小可用替身。
 *
 * 目的：在没有 Obsidian 的环境里驱动真实插件代码，做集成测试。
 * 只实现插件实际用到的 API，行为尽量贴近：
 *   · `.obsidian/` 下的文件**不会**出现在 vault 索引里（这正是昨天
 *     「外溢文件读不回来」那个 bug 的根因，必须在 mock 里如实还原）
 *   · vault.process 是读-改-写，返回内容没变就不落盘
 */

export function normalizePath(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
  return p === "." ? "" : p;
}

interface FileEntry {
  type: "file";
  path: string;
  content: string;
  mtime: number;
}

interface FolderEntry {
  type: "folder";
  path: string;
  mtime: number;
}

type Entry = FileEntry | FolderEntry;

export class TAbstractFile {
  constructor(public path: string) {}
}

export class TFile extends TAbstractFile {
  get name(): string {
    return this.path.slice(this.path.lastIndexOf("/") + 1);
  }
  get basename(): string {
    const n = this.name;
    const i = n.lastIndexOf(".");
    return i < 0 ? n : n.slice(0, i);
  }
  get extension(): string {
    const n = this.name;
    const i = n.lastIndexOf(".");
    return i < 0 ? "" : n.slice(i + 1);
  }
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

/** 供测试直接操作的对象 */
export class FakeVault {
  private entries = new Map<string, Entry>();
  private fileCache = new Map<string, TFile>();
  readonly adapter: MockAdapter;

  constructor(initial: Record<string, string> = {}) {
    this.adapter = new MockAdapter(this);
    for (const [path, content] of Object.entries(initial)) this.writeRaw(path, content);
  }

  // --- 内部 ---
  private ensureParents(path: string): void {
    const segs = path.split("/");
    segs.pop();
    let cur = "";
    for (const seg of segs) {
      cur = cur ? `${cur}/${seg}` : seg;
      if (!this.entries.has(cur)) this.entries.set(cur, { type: "folder", path: cur, mtime: Date.now() });
    }
  }

  /** 测试用：直接拿原始内容 */
  rawContent(path: string): string | undefined {
    const e = this.entries.get(normalizePath(path));
    return e && e.type === "file" ? (e as { content?: string }).content : undefined;
  }

  deleteRaw(path: string): void {
    this.entries.delete(normalizePath(path));
    this.fileCache.delete(normalizePath(path));
  }

  writeRaw(path: string, content: string): void {
    const p = normalizePath(path);
    this.ensureParents(p);
    this.entries.set(p, { type: "file", path: p, content, mtime: Date.now() });
  }

  /** 测试用：改文件的修改时间（模拟老存档） */
  touch(path: string, mtime: number): void {
    const e = this.entries.get(normalizePath(path));
    if (e) e.mtime = mtime;
  }

  readRaw(path: string): string | undefined {
    const e = this.entries.get(normalizePath(path));
    return e?.type === "file" ? e.content : undefined;
  }

  /** `.obsidian/` 不被索引——与真实 Obsidian 一致 */
  private indexed(path: string): boolean {
    return !path.startsWith(".obsidian/");
  }

  statOf(path: string) {
    return this.entries.get(normalizePath(path));
  }

  listDir(path: string): { files: string[]; folders: string[] } {
    const p = normalizePath(path);
    const prefix = p ? `${p}/` : "";
    const files: string[] = [];
    const folders: string[] = [];
    for (const [k, v] of this.entries) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (!rest || rest.includes("/")) continue;
      if (v.type === "file") files.push(k);
      else folders.push(k);
    }
    return { files, folders };
  }

  delete(path: string): void {
    const p = normalizePath(path);
    for (const k of [...this.entries.keys()]) {
      if (k === p || k.startsWith(p + "/")) this.entries.delete(k);
    }
  }

  // --- vault API ---
  getAbstractFileByPath(path: string): TAbstractFile | null {
    const p = normalizePath(path);
    if (!this.indexed(p)) return null; // 关键：模拟真实行为
    const e = this.entries.get(p);
    if (!e) return null;
    if (e.type === "folder") {
      // 真机里 children 是真实子项；mock 里按路径前缀还原，否则 trash_folder 的
      // 「非空必须 recursive」这条规则根本测不到
      const folder = new TFolder(p);
      const prefix = `${p}/`;
      for (const [childPath, child] of this.entries) {
        if (!childPath.startsWith(prefix)) continue;
        if (childPath.slice(prefix.length).includes("/")) continue; // 只要直接子项
        folder.children.push(child.type === "folder" ? new TFolder(childPath) : new TFile(childPath));
      }
      return folder;
    }
    let f = this.fileCache.get(p);
    if (!f) {
      f = new TFile(p);
      this.fileCache.set(p, f);
    }
    return f;
  }

  async cachedRead(file: TFile): Promise<string> {
    const c = this.readRaw(file.path);
    if (c === undefined) throw new Error(`ENOENT: ${file.path}`);
    return c;
  }

  async read(file: TFile): Promise<string> {
    return this.cachedRead(file);
  }

  async process(file: TFile, fn: (data: string) => string): Promise<string> {
    const before = await this.cachedRead(file);
    const after = fn(before);
    if (after !== before) this.writeRaw(file.path, after);
    return after;
  }

  async create(path: string, content: string): Promise<TFile> {
    const p = normalizePath(path);
    if (this.entries.has(p)) throw new Error(`File already exists: ${p}`);
    this.writeRaw(p, content);
    return new TFile(p);
  }

  async createFolder(path: string): Promise<void> {
    const p = normalizePath(path);
    this.ensureParents(`${p}/x`);
    if (!this.entries.has(p)) this.entries.set(p, { type: "folder", path: p, mtime: Date.now() });
  }

  async modify(file: TFile, content: string): Promise<void> {
    this.writeRaw(file.path, content);
  }

  getFiles(): TFile[] {
    return [...this.entries.values()]
      .filter((e): e is FileEntry => e.type === "file" && this.indexed(e.path))
      .map((e) => {
        let f = this.fileCache.get(e.path);
        if (!f) {
          f = new TFile(e.path);
          this.fileCache.set(e.path, f);
        }
        return f;
      });
  }

  getMarkdownFiles(): TFile[] {
    return this.getFiles().filter((f) => f.extension === "md");
  }
}

export class MockAdapter {
  constructor(private vault: FakeVault) {}

  async exists(path: string): Promise<boolean> {
    return this.vault.statOf(path) !== undefined;
  }

  async stat(path: string) {
    const e = this.vault.statOf(path);
    if (!e) return null;
    return {
      type: e.type,
      size: e.type === "file" ? e.content.length : 0,
      mtime: e.mtime,
      ctime: e.mtime,
    };
  }

  async read(path: string): Promise<string> {
    const c = this.vault.readRaw(path);
    if (c === undefined) throw new Error(`ENOENT: ${path}`);
    return c;
  }

  async write(path: string, data: string): Promise<void> {
    this.vault.writeRaw(path, data);
  }

  async mkdir(path: string): Promise<void> {
    const p = normalizePath(path);
    if (!this.vault.statOf(p)) this.vault.writeRaw(`${p}/.keep`, "");
  }

  async list(path: string) {
    return this.vault.listDir(path);
  }

  async remove(path: string): Promise<void> {
    if (!this.vault.statOf(path)) throw new Error(`ENOENT: ${path}`);
    this.vault.deleteRaw(path);
  }

  async rmdir(path: string, recursive: boolean): Promise<void> {
    if (!recursive) return;
    this.vault.delete(path);
  }
}

/** 给 App 用的最小外壳 */
export class MockApp {
  vault: FakeVault;
  workspace: {
    getActiveViewOfType: () => null;
    getLeaf: () => { openFile: () => Promise<void> };
    getLeavesOfType: () => unknown[];
  };
  metadataCache: {
    getBacklinksForFile?: () => null;
    getFileCache: (file: { path: string }) => unknown;
  };
  fileManager: {
    renameFile: (file: unknown, to: string) => Promise<void>;
    trashFile: (file: unknown) => Promise<void>;
  };

  constructor(initial: Record<string, string> = {}) {
    this.vault = new FakeVault(initial);
    this.workspace = {
      getActiveViewOfType: () => null,
      getLeaf: () => ({ openFile: async () => undefined }),
      getLeavesOfType: () => [],
    };
    // 简化版 frontmatter 解析：够测 tags / 自定义属性
    this.metadataCache = {
      getFileCache: (file: { path: string }) => {
        const raw = this.vault.rawContent(file.path);
        if (raw == null) return null;
        const fm = parseFrontmatter(raw);
        const tags: Array<{ tag: string }> = [...(fm.tagsArray ?? [])].map((tag) => ({ tag }));
        for (const m of raw.matchAll(/(?:^|\s)#([\w\u4e00-\u9fa5/-]+)/g)) tags.push({ tag: `#${m[1]}` });
        return { frontmatter: fm.data, tags };
      },
    };
    this.fileManager = {
      trashFile: async (file: unknown) => {
        // 真机里进回收站，mock 里直接消失就够验证行为了
        this.vault.deleteRaw((file as { path: string }).path);
      },
      renameFile: async (file: unknown, to: string) => {
        const from = (file as { path: string }).path;
        const content = this.vault.rawContent(from) ?? "";
        this.vault.writeRaw(to, content);
        this.vault.deleteRaw(from);
        // 真机里 Obsidian 会顺带改双链；mock 里只搬文件，链接行为由专门的用例覆盖
      },
    };
  }
}

/** 插件里只把它当类型用，但这个模块必须导出同名符号 */
export class App {}
export class MarkdownView {}
export class Plugin {}
export class PluginSettingTab {}
export class Notice {
  constructor(public message: string) {}
}

/** 集成测试里不应真的发请求；provider 被替换成了脚本替身 */
export async function requestUrl(): Promise<never> {
  throw new Error("mock: requestUrl 不应被调用");
}


/** 极简 frontmatter 解析（只为测试 metadataCache 用） */
export function parseFrontmatter(raw: string): {
  data: Record<string, unknown>;
  tagsArray?: string[];
} {
  if (!raw.startsWith("---")) return { data: {} };
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return { data: {} };
  const block = raw.slice(3, end);
  const data: Record<string, unknown> = {};
  let tagsArray: string[] | undefined;
  let currentKey: string | null = null;

  for (const line of block.split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (kv) {
      const [, key, val] = kv;
      currentKey = key;
      const v = val.trim().replace(/^["']|["']$/g, "");
      if (v) data[key] = v;
      continue;
    }
    const item = line.match(/^\s*-\s*(.+)$/);
    if (item && currentKey) {
      const v = item[1].trim().replace(/^["']|["']$/g, "");
      const prev = data[currentKey];
      if (Array.isArray(prev)) prev.push(v);
      else data[currentKey] = [v];
      if (currentKey === "tags") {
        tagsArray = tagsArray ?? [];
        tagsArray.push(v);
      }
    }
  }
  return { data, tagsArray };
}
