/**
 * AI 准则的硬边界。
 *
 * 来源：vault 里的 `AI/00-总指令.md`（禁止操作清单）。这类规则以前只写在
 * prompt 里，模型读得到但会忘；下沉到代码才叫"禁止"。
 *
 * 两级：
 *   - "deny"    绝对禁止，不给覆盖通道（准则原文：禁止修改/删除）
 *   - "confirm" 默认拦，但用户明确同意后可以改（准则原文：除非用户明确要求）
 */

export type GuardLevel = "deny" | "confirm";

export interface GuardHit {
  level: GuardLevel;
  /** 给模型看的拒绝理由，要说清依据哪条准则 */
  reason: string;
}

/** AI/00-00 到 AI/06 的配置文件 + 全局 skills 目录：绝对禁止 */
const ABSOLUTE: Array<{ test: RegExp; why: string }> = [
  { test: /^AI\/0[0-6][-.]/, why: "AI 准则配置文件（00-06）" },
  { test: /^AI\/0[0-6]\.md$/i, why: "AI 准则配置文件（00-06）" },
  { test: /^skills\//, why: "skills/ 目录（MiClaude 自动同步）" },
];

/** 准则写的是「除非用户明确要求」：需要一次性确认 */
const CONSENT: Array<{ test: RegExp; why: string }> = [
  { test: /^首页\.md$/, why: "知识库首页" },
  { test: /^知识地图\.md$/, why: "全局导航" },
  { test: /^📋 任务看板\.md$/, why: "任务看板" },
  { test: /^templates\//, why: "笔记模板目录" },
];

function normalize(path: string): string {
  return path.replace(/^\/+/, "").replace(/\s+$/, "");
}

/**
 * 返回命中的准则条款，未命中返回 null。
 * 只在「模型发起的写操作」上调用；插件自己的内部写入（如修改记录）不走这里。
 */
export function checkProtected(rawPath: string): GuardHit | null {
  const path = normalize(rawPath);

  for (const rule of ABSOLUTE) {
    if (rule.test.test(path)) {
      return {
        level: "deny",
        reason:
          `拒绝写入 ${path}：命中 AI 准则的禁止清单（${rule.why}）。` +
          "该文件只能由你本人手动修改；如果确实要改，请让用户自己动手或先在对话里明确解除这条限制。",
      };
    }
  }

  for (const rule of CONSENT) {
    if (rule.test.test(path)) {
      return {
        level: "confirm",
        reason: `注意：${path} 属于 AI 准则里的「${rule.why}」，默认不许改，需要用户明确同意。`,
      };
    }
  }

  return null;
}
