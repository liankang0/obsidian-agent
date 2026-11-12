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

/**
 * 高熵判定（WP4 打码兜底层）：唯一字符够多且至少混了两种字符类。
 * 随机密钥天然满足；单词、路径段、重复串达不到「唯一字符 ≥ 12」或只有一类。
 */
function isHighEntropy(token: string): boolean {
  const unique = new Set(token).size;
  if (unique < 12) return false;
  let classes = 0;
  if (/[a-z]/.test(token)) classes++;
  if (/[A-Z]/.test(token)) classes++;
  if (/\d/.test(token)) classes++;
  if (/[+/_=-]/.test(token)) classes++;
  return classes >= 2;
}

export class Logger {
  private buffer: string[] = [];
  private pending: string[] = [];
  private dirReady = false;
  private flushing = false;
  /** 当前配置的密钥来源：打码的「字面替换」层数据（WP4） */
  private getSecrets: () => string[] = () => [];

  constructor(
    private readonly adapter: DataAdapter,
    private readonly baseDir: string
  ) {}

  /**
   * 注入当前密钥（WP4）：日志目录在用户的库里、可能被同步到云端，
   * 所以打码不能只靠猜格式——配置里的密钥不管长什么样，出现过就遮。
   * 用 getter 是因为 key 可能在运行中被改（SecretStorage / 设置页）。
   */
  setSecrets(get: () => string[]): void {
    this.getSecrets = get;
  }

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

  /**
   * 两层打码（WP4，取代原先「只猜 sk- 前缀」的正则）：
   * ① 配置中的密钥字面替换——不管格式，出现过就遮（≥6 字符才认，防止误伤普通词）；
   * ② 高熵串兜底——≥20 字符、字符集够杂（唯一字符 ≥12 且至少两类）的 token，
   *    真正的密钥/令牌几乎都长这样；普通中文与文件路径达不到门槛，不受影响。
   * ③ sk-/ak- 前缀的老规则保留：特别短的 key 逃过高熵判定时还有一道网。
   */
  private mask(s: string): string {
    let out = s;
    for (const secret of this.getSecrets()) {
      const v = secret.trim();
      if (v.length >= 6 && out.includes(v)) out = out.split(v).join("***");
    }
    out = out.replace(/[A-Za-z0-9+/_=-]{20,}/g, (m) => (isHighEntropy(m) ? `${m.slice(0, 3)}***` : m));
    return out.replace(/\b(sk|ak)-[A-Za-z0-9_\-]{6,}/g, (_m, p1) => `${p1}-***`);
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
      console.warn("[local-vault-agent] 写日志失败", e);
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
