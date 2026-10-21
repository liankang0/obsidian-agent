/**
 * 会话列表弹窗。
 *
 * 手机上的取舍：一行一个会话，标题 + 时间 + 条数；未跑完的会话在标题前
 * 加一个圆点标记，点进去后可以直接「继续执行」。
 */

import { App, Modal } from "obsidian";

import type { ChatSession } from "../agent/history";

export class SessionModal extends Modal {
  constructor(
    app: App,
    private readonly sessions: ChatSession[],
    private readonly onPick: (id: string) => void,
    private readonly onDelete?: (id: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("oa-sessions");

    contentEl.createEl("h3", { text: "历史对话" });

    if (this.sessions.length === 0) {
      contentEl.createDiv({ cls: "oa-sessions__empty", text: "还没有历史对话。" });
      return;
    }

    const list = contentEl.createDiv({ cls: "oa-sessions__list" });
    for (const s of this.sessions) {
      const row = list.createDiv({ cls: "oa-sessions__row" });

      const main = row.createDiv({ cls: "oa-sessions__main" });
      const title = main.createDiv({ cls: "oa-sessions__title", text: s.title });
      if (s.runId) title.addClass("oa-sessions__title--live");
      main.createDiv({
        cls: "oa-sessions__meta",
        text: `${formatTime(s.updatedAt)} · ${s.entries.length} 条`,
      });

      main.addEventListener("click", () => {
        this.close();
        this.onPick(s.id);
      });

      if (this.onDelete) {
        const del = row.createEl("button", { cls: "oa-sessions__del", text: "删除" });
        del.addEventListener("click", (evt) => {
          evt.stopPropagation();
          this.onDelete?.(s.id);
          row.remove();
          if (list.childElementCount === 0) {
            list.createDiv({ cls: "oa-sessions__empty", text: "还没有历史对话。" });
          }
        });
      }
    }

    const footer = contentEl.createDiv({ cls: "oa-sessions__footer" });
    const newBtn = footer.createEl("button", { text: "新建对话", cls: "mod-cta" });
    newBtn.addEventListener("click", () => {
      this.close();
      this.onPick("");
    });
    const closeBtn = footer.createEl("button", { text: "关闭" });
    closeBtn.addEventListener("click", () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function formatTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return sameDay
    ? `${p(d.getHours())}:${p(d.getMinutes())}`
    : `${d.getMonth() + 1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
