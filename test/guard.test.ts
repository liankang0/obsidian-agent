import assert from "node:assert/strict";
import test from "node:test";

import { checkProtected } from "../src/agent/guard";

test("AI 准则配置文件绝对禁止（00-06）", () => {
  for (const p of [
    "AI/00-总指令.md",
    "AI/02-任务后质量检查清单.md",
    "AI/03-修改记录.md",
    "AI/06-分类原则.md",
  ]) {
    const hit = checkProtected(p);
    assert.ok(hit, `${p} 应被拦`);
    assert.equal(hit.level, "deny", `${p} 应是绝对禁止`);
    assert.ok(hit.reason.includes("AI 准则"), "理由要说明依据");
  }
});

test("skills 目录绝对禁止", () => {
  const hit = checkProtected("skills/000-AI-框架核心.md");
  assert.equal(hit?.level, "deny");
});

test("首页/知识地图/任务看板/模板 需要明确同意", () => {
  for (const p of ["首页.md", "知识地图.md", "📋 任务看板.md", "templates/笔记模板.md"]) {
    const hit = checkProtected(p);
    assert.equal(hit?.level, "confirm", `${p} 应是需确认`);
  }
});

test("普通笔记放行", () => {
  for (const p of [
    "knowledge/tech/java/_index.md",
    "日记/2026-10-20.md",
    "AI-README.md",
    "AI/07-新文件.md",
    "skills-notes/x.md",
  ]) {
    assert.equal(checkProtected(p), null, `${p} 不该被拦`);
  }
});

test("带前导斜杠或尾部空格的路径也能识别", () => {
  assert.equal(checkProtected("/AI/00-总指令.md")?.level, "deny");
  assert.equal(checkProtected("知识地图.md  ")?.level, "confirm");
});
