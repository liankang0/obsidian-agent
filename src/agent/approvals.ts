/**
 * 会话内审批记忆。
 *
 * 问题：现在的策略是「累计改满 N 个文件后，每次写都弹窗」。用户在同一个
 * 目录里连续改十篇，就要点十次确认——第二次之后他就不看了，闭眼点「接受」。
 * 那比不弹更糟：它训练用户忽略 diff。
 *
 * 做法（借 Kimi 的 session-approval-history）：**批准一次，记住那个目录**，
 * 同一个 run 内下次直接放行。粒度选目录而不是单个文件，因为用户的真实意图
 * 通常是「这个文件夹你随便改」，而不是「这一篇」。想彻底关掉有隐私模式。
 */

export class ApprovalStore {
  private readonly dirs = new Set<string>();

  /** 记住 path 所在目录（根目录记为 ""） */
  allow(path: string): void {
    this.dirs.add(dirOf(path));
  }

  isAllowed(path: string): boolean {
    return this.dirs.has(dirOf(path));
  }

  /** 已记住的目录数，用于状态显示 */
  get size(): number {
    return this.dirs.size;
  }

  clear(): void {
    this.dirs.clear();
  }

  /** 仅测试/调试用 */
  snapshot(): string[] {
    return [...this.dirs];
  }
}

function dirOf(path: string): string {
  const clean = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const i = clean.lastIndexOf("/");
  return i < 0 ? "" : clean.slice(0, i);
}
