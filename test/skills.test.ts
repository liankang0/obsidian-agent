import assert from "node:assert/strict";
import test from "node:test";

import { buildSkillIndex, findSkill, parseSkillMeta, scanSkills, slugifySkillName, suggestSlug } from "../src/agent/skills";
import { MockApp } from "./mocks/obsidian";

test("有 frontmatter 时读 name/description", () => {
  const raw = ["---", "name: 分类原则", "description: 决定一篇笔记放哪个目录", "---", "", "# 正文", "内容"].join("\n");
  const meta = parseSkillMeta("skills/x.md", raw);
  assert.equal(meta.name, "分类原则");
  assert.equal(meta.description, "决定一篇笔记放哪个目录");
  assert.equal(meta.path, "skills/x.md");
});

test("没有 frontmatter 时用 H1 当名字、第一段正文当描述", () => {
  const raw = ["# Obsidian 知识管理", "", "> 引用行要跳过", "", "把散落的笔记整理成可检索的结构。", "更多内容"].join("\n");
  const meta = parseSkillMeta("skills/skill-obsidian-knowledge-management.md", raw);
  assert.equal(meta.name, "Obsidian 知识管理");
  assert.equal(meta.description, "把散落的笔记整理成可检索的结构。");
});

test("frontmatter 带引号也能解析", () => {
  const raw = ["---", 'name: "v3 流程"', "description: '五步操作流程'", "---", ""].join("\n");
  const meta = parseSkillMeta("skills/v3.md", raw);
  assert.equal(meta.name, "v3 流程");
  assert.equal(meta.description, "五步操作流程");
});

test("什么都没有时退回文件名，不会崩", () => {
  const meta = parseSkillMeta("skills/裸文件.md", "");
  assert.equal(meta.name, "裸文件");
});

test("索引只放名字和一句描述，不放正文", () => {
  const index = buildSkillIndex([
    { name: "分类原则", description: "决定放哪", path: "skills/a.md" },
    { name: "命名规范", description: "怎么起名", path: "skills/b.md" },
  ]);
  assert.ok(index.includes("分类原则"));
  assert.ok(index.includes("决定放哪"));
  assert.ok(index.includes("use_skill"), "要告诉模型用什么工具读全文");
  assert.ok(!index.includes("skills/a.md"), "索引里不该出现路径，省 token");
});

test("没有 skill 时不产生空标题", () => {
  assert.equal(buildSkillIndex([]), "");
});

test("按名字、路径、片段都能找到", () => {
  const skills = [
    { name: "分类原则", description: "", path: "skills/06-分类原则.md" },
    { name: "飞书同步", description: "", path: "skills/skill-lark.md" },
  ];
  assert.equal(findSkill(skills, "分类原则")?.path, "skills/06-分类原则.md");
  assert.equal(findSkill(skills, "skills/skill-lark")?.name, "飞书同步");
  assert.equal(findSkill(skills, "skill-lark.md")?.name, "飞书同步");
  assert.equal(findSkill(skills, "飞书")?.name, "飞书同步");
  assert.equal(findSkill(skills, "不存在"), undefined);
});

test("扫描只认 skills/ 和 AI/skills/，其他目录的 md 不算", async () => {
  const app = new MockApp({
    "skills/000-AI-框架核心.md": "# 框架核心\n\n多设备协同的核心引导。",
    "skills/sub/deep.md": "# 深层\n\n子目录里的也算。",
    "AI/skills/extra.md": "# 额外\n\nAI 目录下也认。",
    "knowledge/tech/x.md": "# 普通笔记\n\n不是 skill。",
    "AI/00-总指令.md": "# 总指令\n\n也不是 skill。",
  });
  const { skills } = await scanSkills(app as never);
  const names = skills.map((s) => s.name);
  assert.ok(names.includes("框架核心"));
  assert.ok(names.includes("深层"));
  assert.ok(names.includes("额外"));
  assert.ok(!names.includes("普通笔记"), "普通笔记被误当成 skill 了");
  assert.ok(!names.includes("总指令"), "AI 根目录的文件不是 skill");
});

test("规范布局：<目录>/SKILL.md，名字取目录名", () => {
  const raw = ["---", "name: note-titler", "description: 给笔记起标题", "---", "", "# 正文"].join("\n");
  const meta = parseSkillMeta("skills/note-titler/SKILL.md", raw);
  assert.equal(meta.name, "note-titler");
  assert.equal(meta.description, "给笔记起标题");
  assert.deepEqual(meta.warnings, []);
});

test("折叠写法（>）的 description 能读出来", () => {
  const raw = [
    "---",
    "name: note-titler",
    "description: >",
    "  给笔记起标题。",
    "  当用户说「起个标题」时用。",
    "---",
    "",
  ].join("\n");
  const meta = parseSkillMeta("skills/note-titler/SKILL.md", raw);
  assert.equal(meta.description, "给笔记起标题。 当用户说「起个标题」时用。");
});

test("可选字段 license / allowed-tools 能读到", () => {
  const raw = [
    "---",
    "name: x",
    "description: y",
    "license: MIT",
    "allowed-tools: Read, Write",
    "---",
  ].join("\n");
  const meta = parseSkillMeta("skills/x/SKILL.md", raw);
  assert.equal(meta.license, "MIT");
  assert.equal(meta.allowedTools, "Read, Write");
});

test("不符合规范的地方记进 warnings，但照样能用", () => {
  const raw = ["---", "name: 面试题复习", "description: 一题一题过", "---", ""].join("\n");
  const meta = parseSkillMeta("skills/interview-review.md", raw);
  assert.equal(meta.name, "面试题复习", "名字还得能用");
  const w = (meta.warnings ?? []).join(" ");
  assert.ok(w.includes("不符合规范"), w);
  assert.ok(w.includes("SKILL.md"), w);
});

test("name 与目录名不一致要说出来", () => {
  const raw = ["---", "name: other-name", "description: d", "---"].join("\n");
  const meta = parseSkillMeta("skills/real-name/SKILL.md", raw);
  assert.ok((meta.warnings ?? []).some((w) => w.includes("目录名")), "没提示不一致");
});

test("缺 description 要提示（规范要求必填）", () => {
  const raw = ["---", "name: note-titler", "---", "", "# 标题"].join("\n");
  const meta = parseSkillMeta("skills/note-titler/SKILL.md", raw);
  assert.ok((meta.warnings ?? []).some((w) => w.includes("description")));
});

test("slug 推导：空格、下划线、大写都归一", () => {
  assert.equal(slugifySkillName("Note Titler"), "note-titler");
  assert.equal(slugifySkillName("v3_流程"), "v3");
  assert.equal(slugifySkillName("面试题复习"), "");
});

test("索引里带上 allowed-tools 限制", () => {
  const index = buildSkillIndex([{ name: "x", description: "d", path: "skills/x/SKILL.md", allowedTools: "Read" }]);
  assert.ok(index.includes("限用工具：Read"), index);
});

test("slug 建议优先用文件名里的英文全称，不要把中文名压成一个词", () => {
  assert.equal(suggestSlug("Obsidian知识库管理", "skills/skill-obsidian-knowledge-management.md"), "obsidian-knowledge-management");
  assert.equal(suggestSlug("面试题复习", "skills/interview-review.md"), "interview-review");
  assert.equal(suggestSlug("Obsidian 到 Lark 文档导出", "skills/skill-obsidian-to-lark.md"), "obsidian-to-lark");
});
