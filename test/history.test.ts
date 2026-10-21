import assert from "node:assert/strict";
import test from "node:test";

import { ChatHistory } from "../src/agent/history";
import { FakeVault, MockAdapter } from "./mocks/obsidian";

const PATH = ".obsidian/plugins/obsidian-agent/chat-history.json";

function make() {
  const adapter = new MockAdapter(new FakeVault());
  const h = new ChatHistory(adapter as never, PATH);
  return { adapter, h };
}

function bare() {
  return new MockAdapter(new FakeVault());
}

test("追加后能落盘，并给模型用纯文本历史", async () => {
  const { adapter, h } = make();
  await h.append({ role: "user", content: "第一句", at: 1 });
  await h.append({ role: "assistant", content: "第一答", at: 2 });

  const raw = await adapter.read(PATH);
  assert.ok(raw.includes("第一句"), "磁盘上没有内容");

  const recent = h.recent(10);
  assert.deepEqual(recent, [
    { role: "user", content: "第一句" },
    { role: "assistant", content: "第一答" },
  ]);
});

test("新实例能读回旧历史（就是重启的场景）", async () => {
  const { adapter, h } = make();
  await h.append({ role: "user", content: "重启前的对话", at: 1 });

  const fresh = new ChatHistory(adapter as never, PATH);
  const entries = await fresh.load();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].content, "重启前的对话");
  assert.deepEqual(fresh.recent(5), [{ role: "user", content: "重启前的对话" }]);
});

test("clear 之后磁盘也空了", async () => {
  const { adapter, h } = make();
  await h.append({ role: "user", content: "x", at: 1 });
  await h.clear();
  const fresh = new ChatHistory(adapter as never, PATH);
  assert.deepEqual(await fresh.load(), []);
  const raw = JSON.parse(await adapter.read(PATH));
  const cur = raw.sessions.find((x: { id: string }) => x.id === raw.current);
  assert.equal(cur.entries.length, 0, "磁盘上当前会话应是空的");
});

test("坏文件不炸，按空历史处理", async () => {
  const adapter = bare();
  await adapter.mkdir(".obsidian/plugins/obsidian-agent");
  await adapter.write(PATH, "{ 这不是 json");
  const h = new ChatHistory(adapter as never, PATH);
  assert.deepEqual(await h.load(), []);
});

test("非法条目被过滤掉", async () => {
  const adapter = bare();
  await adapter.mkdir(".obsidian/plugins/obsidian-agent");
  await adapter.write(
    PATH,
    JSON.stringify([
      { role: "user", content: "ok", at: 1 },
      { role: "tool", content: "丢掉", at: 2 },
      { role: "assistant" },
      "字符串也丢掉",
    ]),
  );
  const h = new ChatHistory(adapter as never, PATH);
  const entries = await h.load();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].content, "ok");
});

test("超长内容被截断，条目数有上限", async () => {
  const { h } = make();
  await h.append({ role: "user", content: "长".repeat(5000), at: 1 });
  assert.equal(h.recent(1)[0].content.length, 2000);

  for (let i = 0; i < 120; i++) {
    await h.append({ role: "user", content: `第 ${i} 条`, at: i });
  }
  assert.ok(h.size <= 100, `条目数应 <= 100，实际 ${h.size}`);
  assert.equal(h.recent(1)[0].content, "第 119 条");
});

test("recent(n) 只取最近 n 条", async () => {
  const { h } = make();
  for (let i = 0; i < 20; i++) await h.append({ role: "user", content: `m${i}`, at: i });
  const r = h.recent(3);
  assert.deepEqual(r.map((x) => x.content), ["m17", "m18", "m19"]);
});

test("多个会话各自独立，互不污染", async () => {
  const { adapter, h } = make();
  await h.append({ role: "user", content: "第一件事", at: 1 });
  await h.append({ role: "assistant", content: "已完成第一件事", at: 2 });

  const second = await h.createSession();
  await h.append({ role: "user", content: "第二件事", at: 3 });

  assert.equal(h.current()?.id, second.id);
  assert.equal(h.list().length, 2);
  // 最近更新的在前
  assert.equal(h.list()[0].id, second.id);
  assert.deepEqual(h.recent().map((e) => e.content), ["第二件事"]);

  const first = h.list()[1];
  const entries = await h.open(first.id);
  assert.deepEqual(entries.map((e) => e.content), ["第一件事", "已完成第一件事"]);
  assert.deepEqual(h.recent().map((e) => e.content), ["第一件事", "已完成第一件事"]);
});

test("会话标题取第一句用户消息", async () => {
  const { h } = make();
  await h.append({ role: "user", content: "把三个 _index 文件末尾的邮箱去掉", at: 1 });
  assert.equal(h.current()?.title, "把三个 _index 文件末尾的邮箱去掉");
});

test("长标题会截断，避免撑破面板", async () => {
  const { h } = make();
  await h.append({ role: "user", content: "很".repeat(80), at: 1 });
  const title = h.current()?.title ?? "";
  assert.ok(title.length <= 25, `标题过长：${title.length}`);
  assert.ok(title.endsWith("…"));
});

test("runId 绑定到会话，可用来做继续执行", async () => {
  const { adapter, h } = make();
  await h.append({ role: "user", content: "x", at: 1 });
  await h.setRunId("20261020-1500-abcd");
  assert.equal(h.current()?.runId, "20261020-1500-abcd");

  const fresh = new ChatHistory(adapter as never, PATH);
  await fresh.load();
  assert.equal(fresh.current()?.runId, "20261020-1500-abcd", "runId 必须落盘");
});

test("删除会话后自动切到别的会话", async () => {
  const { h } = make();
  await h.append({ role: "user", content: "一", at: 1 });
  const second = await h.createSession();
  await h.append({ role: "user", content: "二", at: 2 });

  await h.remove(second.id);
  assert.equal(h.list().length, 1);
  assert.ok(h.current(), "删掉当前会话后不能没有当前会话");
});

test("旧版平铺数组能迁移成会话，历史不丢", async () => {
  const { adapter } = make();
  const legacy = [
    { role: "user", content: "老消息一", at: 1000 },
    { role: "assistant", content: "老回答一", at: 2000 },
  ];
  await adapter.write(PATH, JSON.stringify(legacy));

  const h = new ChatHistory(adapter as never, PATH);
  const entries = await h.load();
  assert.equal(entries.length, 2);
  assert.equal(h.list().length, 1);
  // 迁移后应写成新格式，而不是每次读都重新迁
  const raw = JSON.parse(await adapter.read(PATH));
  assert.equal(raw.version, 2);
  assert.equal(raw.sessions.length, 1);
});
