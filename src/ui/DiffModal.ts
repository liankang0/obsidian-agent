import { App, Modal } from "obsidian";
import type { ConfirmRequest } from "../agent/tools";

type LineKind = "add" | "del" | "ctx";

interface DiffLine {
  kind: LineKind;
  text: string;
}

/** 行数超过这个量就不做 LCS，直接前后对照，避免卡死手机 */
const LCS_LIMIT = 400;

/**
 * 极简行级 diff。
 * 不做 Myers，用 LCS 就够——改动通常只有几行，输入也被限制在几百行内。
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");

  if (a.length > LCS_LIMIT || b.length > LCS_LIMIT) {
    return [
      ...a.map((text) => ({ kind: "del" as LineKind, text })),
      ...b.map((text) => ({ kind: "add" as LineKind, text })),
    ];
  }

  // dp[i][j] = a[i..] 与 b[j..] 的最长公共子序列长度
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ kind: "ctx", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: "del", text: a[i] });
      i++;
    } else {
      out.push({ kind: "add", text: b[j] });
      j++;
    }
  }
  while (i < a.length) out.push({ kind: "del", text: a[i++] });
  while (j < b.length) out.push({ kind: "add", text: b[j++] });

  return out;
}

/**
 * 改动确认弹窗。
 * 设计要点：单列展示（手机屏幕放不下并排 diff），底部固定大按钮。
 */
export class DiffModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly req: ConfirmRequest,
    private readonly settle: (accepted: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("oa-diff-modal");

    contentEl.createEl("div", { text: this.req.summary, cls: "oa-diff__head" });
    if (this.req.path) {
      contentEl.createEl("div", { text: this.req.path, cls: "oa-status" });
    }

    const box = contentEl.createDiv({ cls: "oa-diff" });
    const lines = diffLines(this.req.before, this.req.after);

    // 上下文太多时折叠：只保留改动行前后各 3 行
    const keep = new Set<number>();
    lines.forEach((l, idx) => {
      if (l.kind !== "ctx") {
        for (let k = Math.max(0, idx - 3); k <= Math.min(lines.length - 1, idx + 3); k++) keep.add(k);
      }
    });

    let skipped = false;
    lines.forEach((line, idx) => {
      if (keep.size > 0 && !keep.has(idx)) {
        if (!skipped) {
          box.createDiv({ text: "…", cls: "oa-diff__line oa-diff__line--ctx" });
          skipped = true;
        }
        return;
      }
      skipped = false;
      const prefix = line.kind === "add" ? "+ " : line.kind === "del" ? "- " : "  ";
      box.createDiv({
        text: prefix + line.text,
        cls: `oa-diff__line oa-diff__line--${line.kind}`,
      });
    });

    if (lines.every((l) => l.kind === "ctx")) {
      box.createDiv({ text: "（无差异）", cls: "oa-diff__line oa-diff__line--ctx" });
    }

    const actions = contentEl.createDiv({ cls: "oa-actions" });

    const reject = actions.createEl("button", { text: "拒绝" });
    reject.addEventListener("click", () => this.finish(false));

    const accept = actions.createEl("button", { text: "接受并写入", cls: "mod-cta" });
    accept.addEventListener("click", () => this.finish(true));
  }

  onClose(): void {
    this.contentEl.empty();
    // 用户点遮罩 / 按返回键直接关掉 → 视为拒绝
    this.finish(false);
  }

  private finish(accepted: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.settle(accepted);
    this.close();
  }
}

/** 便捷入口：返回用户是否接受 */
export function confirmChange(app: App, req: ConfirmRequest): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    new DiffModal(app, req, resolve).open();
  });
}
