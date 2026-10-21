import { test } from "node:test";
import assert from "node:assert/strict";
import { executeTool } from "../src/agent/tools";
import { MockApp } from "./mocks/obsidian";

const silent = { info() {}, warn() {}, error() {} };

function ctx(app: MockApp) {
  return {
    app: app as never,
    log: silent,
    confirm: async () => true,
    changedFiles: new Set<string>(),
    confirmAfterFiles: 5,
    readOnly: false,
    runId: "t",
    approvals: { isApproved: () => false, approve: () => undefined },
  } as never;
}

const FILES = {
  "cooking/a.md": "# 甲\n做法一",
  "cooking/b.md": "# 乙\n做法二",
  "cooking/c.md": "# 丙\n做法三",
};

test("批量读：一次拿 3 个文件，一次调用就够（步数 = 1）", async () => {
  const app = new MockApp(FILES);
  const r = await executeTool({ id: "1", name: "read_files", args: { paths: Object.keys(FILES) } }, ctx(app));
  assert.equal(r.ok, true);
  const data = r.data as { count: number; files: Array<{ path: string; content: string }> };
  assert.equal(data.count, 3);
  assert.deepEqual(data.files.map((f) => f.path).sort(), Object.keys(FILES).sort());
  assert.ok(data.files[0].content.includes("做法"));
});

test("批量读：缺一个文件不影响其余（逐条报错，不整批失败）", async () => {
  const app = new MockApp(FILES);
  const r = await executeTool(
    { id: "2", name: "read_files", args: { paths: ["cooking/a.md", "cooking/不存在.md", "cooking/b.md"] } },
    ctx(app),
  );
  assert.equal(r.ok, true);
  const data = r.data as { count: number; requested: number; files: Array<{ ok: boolean; error?: string }> };
  assert.equal(data.requested, 3);
  assert.equal(data.count, 2);
  const bad = data.files.find((f) => !f.ok);
  assert.match(bad?.error ?? "", /找不到/);
});

test("批量读：单篇超限就截断，并标出来", async () => {
  const long = "长".repeat(500);
  const app = new MockApp({ "big.md": long });
  const r = await executeTool(
    { id: "3", name: "read_files", args: { paths: ["big.md"], perFileChars: 200 } },
    ctx(app),
  );
  const data = r.data as { files: Array<{ content: string; truncated?: boolean }> };
  assert.equal(data.files[0].truncated, true);
  assert.equal(data.files[0].content.length, 200);
});

test("批量读：超过 20 个直接拒绝（防止一次塞爆上下文）", async () => {
  const app = new MockApp(FILES);
  const paths = Array.from({ length: 21 }, (_, i) => `f${i}.md`);
  const r = await executeTool({ id: "4", name: "read_files", args: { paths } }, ctx(app));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /最多读 20 个/);
});

test("批量读：一个都没读成时整批报错，把每个原因都带出来", async () => {
  const app = new MockApp({});
  const r = await executeTool({ id: "5", name: "read_files", args: { paths: ["x.md", "y.md"] } }, ctx(app));
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /一个文件都没读成/);
  assert.match(r.error ?? "", /x\.md/);
});

test("批量读：敏感文件照样拒绝（.env 之类）", async () => {
  const app = new MockApp({ ".env": "KEY=1", "备份/id_rsa": "-----BEGIN" });
  const r = await executeTool({ id: "6", name: "read_files", args: { paths: [".env", "备份/id_rsa"] } }, ctx(app));
  assert.equal(r.ok, false, "两个都不能读成功");
  assert.match(r.error ?? "", /拒绝访问|密钥/);
});

test("批量读的结果不写外溢文件（一次拿全才是它的意义）", async () => {
  const { serializeToolResult } = await import("../src/agent/serialize");
  const app = new MockApp({});
  const big = { files: Array.from({ length: 10 }, (_, i) => ({ path: `f${i}.md`, content: "长".repeat(800) })) };
  const out = await serializeToolResult(
    { adapter: app.vault.adapter, log: silent } as never,
    "read_files",
    "run",
    1,
    big,
  );
  assert.equal(out.spilledPath, undefined, "批量读不该外溢");
  assert.ok(out.content.length > 4000, "内容要原样进上下文");
});
