/**
 * skill 加载器：把 vault 里的流程规范按需喂给模型。
 *
 * 准则、分类原则、命名规范、v3 流程这些都是"知识"，不该硬编码进 prompt，
 * 也不该做成工具。做成 skill 的好处是：用户改 md 就生效，插件不用重编译。
 *
 * 渐进披露：prompt 里只放 name + description（一两百 token），正文等模型
 * 判断确实需要时用 use_skill 再读。全量塞进去会撑爆上下文，而且大多数轮次
 * 根本用不上。
 */

import type { App, TFile } from "obsidian";

import { DEFAULT_AI_DIR, ROOT_SKILL_DIR } from "./workspace";

export interface SkillMeta {
  name: string;
  description: string;
  path: string;
  /** agentskills.io 的可选字段：许可证 */
  license?: string;
  /** agentskills.io 的可选字段：这个 skill 只该用哪些工具 */
  allowedTools?: string;
  /** 不符合规范的地方（照样能用，只是记一笔） */
  warnings?: string[];
}

/** 旧默认的扫描目录（直接调用兜底）；loop 驱动时由 layout.skillDirs 传参 */
export const SKILL_DIRS = [ROOT_SKILL_DIR, `${DEFAULT_AI_DIR}/skills/`];
const MAX_SKILLS = 40;
const HEAD_BYTES = 2000;
const MAX_BODY_CHARS = 12000;

function inSkillDir(path: string, dirs: string[]): boolean {
  return dirs.some((d) => path.startsWith(d));
}

/** 规范布局的 SKILL.md 可以放在 skills/ 下任意层目录里 */
function isSkillDoc(path: string, dirs: string[]): boolean {
  return inSkillDir(path, dirs) && path.toLowerCase().endsWith(".md");
}

/** frontmatter 的原始文本（不含两行 ---），没有就返回 undefined */
function frontmatterBlock(raw: string): string | undefined {
  if (!raw.startsWith("---")) return undefined;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return undefined;
  return raw.slice(3, end);
}

/**
 * 解析 frontmatter 的 YAML 子集。
 *
 * 只覆盖 skill 文件里真正会出现的写法：`key: 值`、带引号的值、`|` / `>` 块
 * （description 写长了几乎一定会用折叠写法）、行内数组。不引 YAML 库——
 * 手机上多一个依赖就是多一份体积，这里够用。
 */
export function parseFrontmatter(raw: string): Record<string, string> {
  const block = frontmatterBlock(raw);
  if (block === undefined) return {};
  const out: Record<string, string> = {};
  const lines = block.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    let value = m[2].trim();
    // `|` 和 `>`：后面缩进的行都算值，`>` 把换行变空格
    if (value === "|" || value === ">") {
      const folded = value === ">";
      const buf: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === "")) {
        i++;
        buf.push(lines[i].replace(/^\s+/, ""));
      }
      value = buf.join(folded ? " " : "\n").trim();
    }
    if (value.startsWith("[") && value.endsWith("]")) {
      value = value
        .slice(1, -1)
        .split(",")
        .map((x) => x.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean)
        .join(", ");
    }
    out[key] = value.replace(/^["']|["']$/g, "").trim();
  }
  return out;
}

/** 取一个 frontmatter 字段（兼容旧调用） */
function pickFrontmatter(raw: string, key: string): string | undefined {
  const v = parseFrontmatter(raw)[key];
  return v && v.length > 0 ? v : undefined;
}

/** 是否是规范里的布局：<目录>/SKILL.md */
export function isSkillManifest(path: string): boolean {
  return /(^|\/)SKILL\.md$/i.test(path);
}

/** 规范要求 name 只含小写字母、数字、连字符 */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 从名字推一个规范 slug（中文等无法转写的情况会退化，交给 warnings 说明） */
export function slugifySkillName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[_\s]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function stripFrontmatter(raw: string): string {
  if (!raw.startsWith("---")) return raw;
  const end = raw.indexOf("\n---", 3);
  if (end < 0) return raw;
  return raw.slice(end + 4).replace(/^\s*\n/, "");
}

/**
 * 从文件内容解析 name/description。
 * 没有 frontmatter 时退化：H1 当名字，第一段正文当描述——用户手写的
 * skill 大多没有 frontmatter，不能因此失效。
 */
/**
 * 给不规范的 skill 建议一个 slug。
 *
 * 光从 name 转写会把「Obsidian知识库管理」变成 `obsidian`——信息全丢了。
 * 文件名里通常有英文全称（skill-obsidian-knowledge-management），取更完整的那个。
 */
export function suggestSlug(name: string, path: string): string {
  const fromName = slugifySkillName(name);
  // 文件名常带排序前缀（000-）和 skill- 前缀，都不是名字的一部分
  const base = (path.split("/").pop() ?? "").replace(/\.md$/i, "").replace(/^skill-/, "").replace(/^\d+-/, "");
  const fromFile = slugifySkillName(base);
  const better = fromFile.length > fromName.length ? fromFile : fromName;
  return better;
}

export function parseSkillMeta(path: string, raw: string): SkillMeta {
  const fm = parseFrontmatter(raw);
  const dirName = path.split("/").slice(-2, -1)[0] ?? "";
  const warnings: string[] = [];

  // 规范布局里名字应等于目录名；两者都没有时才退回 H1/文件名
  let name = fm.name ?? "";
  if (!name) {
    if (isSkillManifest(path) && dirName) {
      name = dirName;
    } else {
      name = raw.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? path.split("/").pop()!.replace(/\.md$/i, "");
      warnings.push("frontmatter 缺 name（规范要求必填）");
    }
  }
  if (!SKILL_NAME_RE.test(name)) {
    const sug = suggestSlug(name, path);
    warnings.push(
      `name「${name}」不符合规范（只允许小写字母、数字、连字符）` +
        (sug ? `，建议改成 ${sug}` : "，建议改成英文 slug"),
    );
  }
  if (!isSkillManifest(path)) {
    warnings.push("建议改成 <目录>/SKILL.md 布局（agentskills.io 规范）");
  }
  if (isSkillManifest(path) && dirName && name !== dirName) {
    warnings.push(`name「${name}」与目录名「${dirName}」不一致`);
  }

  let description = fm.description ?? "";
  if (!description) {
    const body = stripFrontmatter(raw)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("---") && !l.startsWith(">"));
    description = (body[0] ?? "").replace(/^[-*]\s*/, "");
  }

  if (!fm.description) warnings.push("frontmatter 缺 description（规范要求必填）");
  if (description.length > 1024) {
    description = description.slice(0, 1024);
    warnings.push("description 超过 1024 字符，已截断");
  }

  return {
    name: name.slice(0, 60),
    // 索引里只放一句，正文在 use_skill 里读；这里留 200 字符给 prompt
    description: description.slice(0, 200),
    path,
    license: fm.license,
    allowedTools: fm["allowed-tools"] ?? fm.allowedTools,
    warnings,
  };
}

export interface SkillScan {
  skills: SkillMeta[];
  /** 扫描失败/部分失败时的说明——空数组可能是「没有 skill」也可能是「没扫成」，必须让调用方区分 */
  degraded?: string;
}

/** 扫描可用的 skill；读不出来的跳过，不让一个坏文件拖垮整轮 */
export async function scanSkills(app: App, dirs: string[] = SKILL_DIRS): Promise<SkillScan> {
  let files;
  try {
    files = app.vault
      .getMarkdownFiles()
      .filter((f) => isSkillDoc(f.path, dirs))
      .slice(0, MAX_SKILLS);
  } catch (e) {
    // 整体扫描失败：绝不能返回空数组装作「库里没有 skill」
    return {
      skills: [],
      degraded: `skill 目录扫描失败：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const out: SkillMeta[] = [];
  let failed = 0;
  for (const f of files) {
    try {
      const raw = await app.vault.cachedRead(f);
      out.push(parseSkillMeta(f.path, raw.slice(0, HEAD_BYTES)));
    } catch {
      /* 单个文件读失败不影响其他 */
      failed++;
    }
  }
  return failed > 0
    ? { skills: out, degraded: `有 ${failed}/${files.length} 个 skill 文件读取失败，以下索引可能不全` }
    : { skills: out };
}

/**
 * 注入 system prompt 的索引；没扫到就返回空串（prompt 不留空标题）。
 * 扫描降级时不能静默返回空串——模型会把「没列出来」当成「库里没有 skill」。
 */
export function buildSkillIndex(skills: SkillMeta[], degraded?: string): string {
  if (skills.length === 0) {
    return degraded
      ? `## 可用的 skill（按需加载）\n\n⚠ 本次数据不完整：${degraded}。不要断言库里没有 skill；需要时用 list_files 查 skills/ 目录。`
      : "";
  }
  const degradedNote = degraded ? `\n\n⚠ 本次数据不完整：${degraded}` : "";
  const lines = skills.map(
    (s) =>
      `- \`${s.name}\`${s.description ? `：${s.description}` : ""}` +
      (s.allowedTools ? `（限用工具：${s.allowedTools}）` : ""),
  );
  return `## 可用的 skill（按需加载）

用户把流程规范写在本库的 \`skills/\` 目录里。下面只有名字和一句话描述，**只有任务确实匹配时才用 use_skill 读全文**，不要凭名字猜内容。

${lines.join("\n")}${degradedNote}`;
}

/** 按名字或路径找 skill */
export function findSkill(skills: SkillMeta[], key: string): SkillMeta | undefined {
  const k = key.trim().replace(/\.md$/i, "").toLowerCase();
  return (
    skills.find((s) => s.name.toLowerCase() === k) ??
    skills.find((s) => s.path.replace(/\.md$/i, "").toLowerCase() === k) ??
    skills.find((s) => s.path.split("/").slice(-2, -1)[0]?.toLowerCase() === k) ??
    skills.find((s) => s.name.toLowerCase().includes(k)) ??
    skills.find((s) => s.path.toLowerCase().includes(k))
  );
}

/** 读正文（去掉 frontmatter），过长由调用方截断或外溢 */
export async function readSkillBody(app: App, file: TFile): Promise<string> {
  const raw = await app.vault.cachedRead(file);
  return stripFrontmatter(raw).slice(0, MAX_BODY_CHARS);
}
