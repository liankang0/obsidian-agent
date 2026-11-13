/**
 * AI 工作区的布局解析（WP3 可移植性解耦）。
 *
 * 以前 AI/03/04/05、01/02 清单、skill 目录全部写死在各自模块的常量里，
 * 「空 vault 装上插件」会凭空创建 AI/ 目录、注入空块、写失败报错——对一个
 * 发布到社区Marketplace 的插件来说，这是把作者自己的库结构强加给了所有用户。
 *
 * 现在收敛成一个 WorkspaceLayout：
 *   - 设置里指定了目录且目录真实存在 → 启用，所有路径挂在该目录下；
 *   - 设置留空 → 自动探测：库里有 `AI/` 目录才启用（老用户零配置升级）；
 *   - 都没有 → aiEnabled=false，loop 不注入记忆块、不写 03/04/05、不提醒
 *     Step 4，record_memory 返回 written:false 的说明而不是写失败。
 *
 * defaultLayout() 返回旧的硬编码布局，供不经过 loop 的直接调用（工具层
 * 单测、自检剧本）保持原行为——只有 loop 级的解析才会得出「未启用」。
 */

import type { App } from "obsidian";
import { TFolder } from "obsidian";

/** 自动探测的默认目录（作者库的既有布局） */
export const DEFAULT_AI_DIR = "AI";
/** 根级 skill 目录：与 AI 工作区无关，永远扫描/禁写 */
export const ROOT_SKILL_DIR = "skills/";

const CHANGELOG_FILE = "03-修改记录.md";
const WORKING_FILE = "04-临时工作记忆区.md";
const HISTORY_FILE = "05-对话历史记录区.md";
const PRE_CHECKLIST_FILE = "01-任务前检查清单.md";
const POST_CHECKLIST_FILE = "02-任务后质量检查清单.md";

export interface WorkspaceLayout {
  /** false 时所有路径为空串，loop 跳过记忆/清单/修改记录的一切读写 */
  aiEnabled: boolean;
  /** AI 工作区目录；未启用时为 "" */
  aiDir: string;
  changelogPath: string;
  workingPath: string;
  historyPath: string;
  preChecklistPath: string;
  postChecklistPath: string;
  /** skill 扫描目录（含尾斜杠）；守卫按同一名单禁写 */
  skillDirs: string[];
}

/** 来自设置页的原始配置（loop 每次 run 通过 getLayoutOpts 热读取） */
export interface WorkspaceSettings {
  /** AI 工作区目录；空串 = 自动探测 */
  aiDir: string;
  /** 额外 skill 目录，逗号分隔 */
  skillDirs: string;
  /** 额外保护路径（confirm 级），逗号分隔；目录以 / 结尾 */
  protectedPaths: string;
}

/** 逗号分隔的目录列表 → 规范化成含尾斜杠的目录（支持中文逗号、反斜杠） */
export function parseDirList(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((s) => s.trim().replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter(Boolean)
    .map((s) => `${s}/`);
}

function isFolder(app: App, dir: string): boolean {
  try {
    return app.vault.getAbstractFileByPath(dir) instanceof TFolder;
  } catch {
    return false;
  }
}

function buildLayout(aiDir: string, extraSkillDirs: string[]): WorkspaceLayout {
  return {
    aiEnabled: true,
    aiDir,
    changelogPath: `${aiDir}/${CHANGELOG_FILE}`,
    workingPath: `${aiDir}/${WORKING_FILE}`,
    historyPath: `${aiDir}/${HISTORY_FILE}`,
    preChecklistPath: `${aiDir}/${PRE_CHECKLIST_FILE}`,
    postChecklistPath: `${aiDir}/${POST_CHECKLIST_FILE}`,
    skillDirs: [...new Set([ROOT_SKILL_DIR, `${aiDir}/skills/`, ...extraSkillDirs])],
  };
}

function disabledLayout(extraSkillDirs: string[]): WorkspaceLayout {
  return {
    aiEnabled: false,
    aiDir: "",
    changelogPath: "",
    workingPath: "",
    historyPath: "",
    preChecklistPath: "",
    postChecklistPath: "",
    skillDirs: [...new Set([ROOT_SKILL_DIR, ...extraSkillDirs])],
  };
}

/** 旧硬编码布局：AI/ 下全套文件。工具层直接调用（没有 ctx.layout）时兜底用它。 */
export function defaultLayout(): WorkspaceLayout {
  return buildLayout(DEFAULT_AI_DIR, []);
}

/**
 * 按 vault 实况解析工作区布局。
 * 显式指定 > 自动探测；两者都要求目录真实存在——不存在就不启用，
 * 宁可功能关闭也绝不凭空创建目录（Doc2-WP3：缺失目录时不写失败）。
 */
export function resolveLayout(app: App, settings?: WorkspaceSettings): WorkspaceLayout {
  const wanted = (settings?.aiDir ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "");
  const extras = parseDirList(settings?.skillDirs ?? "");
  if (wanted) {
    return isFolder(app, wanted) ? buildLayout(wanted, extras) : disabledLayout(extras);
  }
  if (isFolder(app, DEFAULT_AI_DIR)) return buildLayout(DEFAULT_AI_DIR, extras);
  return disabledLayout(extras);
}
