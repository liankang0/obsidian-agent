import type { DataAdapter } from "obsidian";

/**
 * 落盘日志。
 *
 * 手机上没有 devtools，console.log 等于扔进黑洞。
 * 所以所有关键路径都要写文件，出问题时能直接把日志捞出来。
 *
 * 注意：不记录笔记全文，不记录 API Key。
 */
export type LogLevel = "info" | "warn" | "error";

const MAX_BUFFER = 300;
const KEEP_DAYS = 7;

export class Logger {
  private buffer: string[] = [];
  private pending: string[] = [];
  private dirReady = false;
  private flushing = false;

  constructor(
    private readonly adapter: DataAdapter,
    private readonly baseDir: string
  ) {}

  private get logDir(): string {
    return `${this.baseDir}/logs`;
  }

  private stamp(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    );
  }

  private fileForToday(): string {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${this.logDir}/agent-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.log`;
  }

  push(level: LogLevel, msg: string): void {
    const line = `[${this.stamp()}] [${level.toUpperCase()}] ${this.mask(msg)}`;
    this.buffer.push(line);
    if (this.buffer.length > MAX_BUFFER) this.buffer.shift();
    this.pending.push(line);
    void this.flushSoon();
  }

  info(msg: string): void {
    this.push("info", msg);
  }

  warn(msg: string): void {
    this.push("warn", msg);
  }

  error(msg: string): void {
    this.push("error", msg);
  }

  /** 面板里展示最近日志 */
  tail(n = 100): string[] {
    return this.buffer.slice(-n);
  }

  /** 兜底打码：把形如 sk-xxxx 的串遮掉 */
  private mask(s: string): string {
    return s.replace(/\b(sk|ak)-[A-Za-z0-9_\-]{6,}/g, (_m, p1) => `${p1}-***`);
  }

  /** 合并多次写入，避免频繁 IO */
  private async flushSoon(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    // 微批：让同一次工具调用里的多行日志合并成一次写入
    await new Promise((r) => setTimeout(r, 300));
    const chunk = this.pending.join("\n") + "\n";
    this.pending = [];
    this.flushing = false;
    try {
      await this.ensureDir();
      const path = this.fileForToday();
      const exists = await this.adapter.exists(path);
      if (!exists) {
        await this.adapter.write(path, chunk);
        await this.cleanupOld();
      } else {
        await this.adapter.append(path, chunk);
      }
    } catch (e) {
      // 日志自身失败不能再抛，否则会盖掉真正的错误
      console.warn("[obsidian-agent] 写日志失败", e);
    }
  }

  private async ensureDir(): Promise<void> {
    if (this.dirReady) return;
    if (!(await this.adapter.exists(this.baseDir))) {
      await this.adapter.mkdir(this.baseDir);
    }
    if (!(await this.adapter.exists(this.logDir))) {
      await this.adapter.mkdir(this.logDir);
    }
    this.dirReady = true;
  }

  /** 清掉超过保留天数的日志 */
  private async cleanupOld(): Promise<void> {
    try {
      const listing = await this.adapter.list(this.logDir);
      const cutoff = Date.now() - KEEP_DAYS * 24 * 3600 * 1000;
      for (const f of listing.files) {
        const st = await this.adapter.stat(f);
        if (st && st.mtime < cutoff) await this.adapter.remove(f);
      }
    } catch {
      /* 清理失败无所谓 */
    }
  }

  /** 主动落盘，供「导出日志」用 */
  async flush(): Promise<void> {
    await this.flushSoon();
  }
}
