/**
 * AI 准则的硬边界。
 *
 * 来源：vault 里的 `AI/00-总指令.md`（禁止操作清单）。这类规则以前只写在
 * prompt 里，模型读得到但会忘；下沉到代码才叫"禁止"。
 *
 * 两级：
 *   - "deny"    绝对禁止，不给覆盖通道（准则原文：禁止修改/删除）
 *   - "confirm" 默认拦，但用户明确同意后可以改（准则原文：除非用户明确要求）
 *
 * WP3：00-06 禁写规则从 AI 目录名派生（自定义工作区目录同样受保护）；
 * 内置 confirm 清单之外，设置里的「额外保护路径」可以追加条款。
 */

import { DEFAULT_AI_DIR } from "./workspace";

export type GuardLevel = "deny" | "confirm";

export interface GuardHit {
  level: GuardLevel;
  /** 给模型看的拒绝理由，要说清依据哪条准则 */
  reason: string;
}

export interface GuardOpts {
  /**
   * AI 工作区目录（派生 00-06 禁写规则）。
   * 不传 = 旧默认 "AI"；传空串 = 工作区未启用，跳过这组规则。
   */
  aiDir?: string;
  /** 额外禁写的 skill 目录（如 AI/skills/、自定义目录） */
  skillDirs?: string[];
  /** 用户配置的额外保护路径（confirm 级） */
  extraConsent?: string[];
}

interface Rule {
  test: RegExp;
  why: string;
}

/** 准则写的是「除非用户明确要求」：需要一次性确认（内置清单） */
const BUILTIN_CONSENT: Rule[] = [
  { test: /^首页\.md$/, why: "知识库首页" },
  { test: /^知识地图\.md$/, why: "全局导航" },
  { test: /^📋 任务看板\.md$/, why: "任务看板" },
  { test: /^templates\//, why: "笔记模板目录" },
];

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function canonDir(dir: string): string {
  return dir.trim().replace(/\\/g, "/").replace(/\/+$/, "");
}

function buildRules(opts: GuardOpts): { absolute: Rule[]; consent: Rule[] } {
  const absolute: Rule[] = [];
  // 不传 = 旧行为（守卫 AI/00-06）；显式空串 = 工作区未启用，但这组规则
  // 仍然按默认目录保留：库里真有 AI/00-总指令.md 时不能因为开关关了就裸奔
  const aiDir = opts.aiDir === undefined ? DEFAULT_AI_DIR : canonDir(opts.aiDir) || DEFAULT_AI_DIR;
  const d = escapeRe(aiDir);
  absolute.push({ test: new RegExp(`^${d}/0[0-6][-.]`), why: "AI 准则配置文件（00-06）" });
  absolute.push({ test: new RegExp(`^${d}/0[0-6]\\.md$`, "i"), why: "AI 准则配置文件（00-06）" });
  absolute.push({ test: /^skills\//, why: "skills/ 目录（MiClaude 自动同步）" });
  // 工作区自带的 skills/ 也禁写：它和根级 skills/ 一样是「流程规范」，模型改了
  // 就等于改自己的操作手册。随 aiDir 派生，调用方不传 skillDirs 也成立
  absolute.push({ test: new RegExp(`^${d}/skills/`), why: `skill 目录（${aiDir}/skills/）` });
  for (const raw of opts.skillDirs ?? []) {
    const dir = canonDir(raw);
    if (dir) absolute.push({ test: new RegExp(`^${escapeRe(dir)}/`), why: `skill 目录（${dir}/）` });
  }

  const consent = [...BUILTIN_CONSENT];
  for (const raw of opts.extraConsent ?? []) {
    const t = raw.trim();
    const dir = canonDir(t);
    if (!dir) continue;
    // 以 / 结尾 = 整个目录前缀；否则按确切文件名匹配
    consent.push(
      t.endsWith("/")
        ? { test: new RegExp(`^${escapeRe(dir)}/`), why: "用户配置的保护路径" }
        : { test: new RegExp(`^${escapeRe(dir)}$`), why: "用户配置的保护路径" },
    );
  }
  return { absolute, consent };
}

function normalize(path: string): string {
  return path.replace(/^\/+/, "").replace(/\s+$/, "");
}

/**
 * 解析设置项「额外保护路径」：逗号分隔（支持中文逗号）；
 * 以 / 结尾表示整个目录，否则按确切文件名匹配。
 */
export function parseProtectedPaths(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 返回命中的准则条款，未命中返回 null。
 * 只在「模型发起的写操作」上调用；插件自己的内部写入（如修改记录）不走这里。
 */
export function checkProtected(rawPath: string, opts: GuardOpts = {}): GuardHit | null {
  const path = normalize(rawPath);
  const { absolute, consent } = buildRules(opts);

  for (const rule of absolute) {
    if (rule.test.test(path)) {
      return {
        level: "deny",
        reason:
          `拒绝写入 ${path}：命中 AI 准则的禁止清单（${rule.why}）。` +
          "该文件只能由你本人手动修改；如果确实要改，请让用户自己动手或先在对话里明确解除这条限制。",
      };
    }
  }

  for (const rule of consent) {
    if (rule.test.test(path)) {
      return {
        level: "confirm",
        reason: `注意：${path} 属于 AI 准则里的「${rule.why}」，默认不许改，需要用户明确同意。`,
      };
    }
  }

  return null;
}
