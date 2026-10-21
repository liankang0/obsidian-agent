import assert from "node:assert/strict";
import test from "node:test";

import { pruneStates } from "../src/agent/states";
import { FakeVault } from "./mocks/obsidian";

const DAY = 86_400_000;

function state(files: Record<string, string>, ages: Record<string, number> = {}) {
  const vault = new FakeVault(files);
  for (const [path, days] of Object.entries(ages)) vault.touch(path, Date.now() - days * DAY);
  return vault.adapter;
}

function done(id: string): string {
  return JSON.stringify({ runId: id, status: "done" });
}

test("只留最近 50 个：多出来的删掉", async () => {
  const files: Record<string, string> = {};
  const ages: Record<string, number> = {};
  // 60 个都是今天的，越早写的越老
  for (let i = 0; i < 60; i++) {
    const p = `state/r${String(i).padStart(3, "0")}.json`;
    files[p] = done(p);
    ages[p] = i * 0.01;
  }
  const adapter = state(files, ages);
  const r = await pruneStates(adapter, "state", { keepFiles: 50 });
  assert.equal(r.removed, 10, `应删 10 个，实际 ${r.removed}`);
  assert.equal(r.kept, 50);
});

test("超过 7 天的删掉，哪怕没到 50 个", async () => {
  const files = { "state/old.json": done("old"), "state/new.json": done("new") };
  const adapter = state(files, { "state/old.json": 9 });
  const r = await pruneStates(adapter, "state");
  assert.equal(r.removed, 1);
  assert.equal(await adapter.exists("state/old.json"), false);
  assert.equal(await adapter.exists("state/new.json"), true);
});

test("没做完的活永远不删——哪怕它很老、哪怕超出配额", async () => {
  const files = {
    "state/running.json": JSON.stringify({ status: "running" }),
    "state/confirm.json": JSON.stringify({ status: "awaiting_confirm" }),
    "state/done.json": done("done"),
  };
  const adapter = state(files, { "state/running.json": 30, "state/confirm.json": 30, "state/done.json": 30 });
  const r = await pruneStates(adapter, "state");
  assert.equal(r.resumable, 2);
  assert.equal(r.removed, 1, "只该删 done 那条");
  assert.equal(await adapter.exists("state/running.json"), true);
  assert.equal(await adapter.exists("state/confirm.json"), true);
});

test("坏 JSON 当普通文件处理，可以清", async () => {
  const files = { "state/broken.json": "{ 不是 json" };
  const adapter = state(files, { "state/broken.json": 10 });
  const r = await pruneStates(adapter, "state");
  assert.equal(r.removed, 1);
});

test("目录不存在时不报错", async () => {
  const adapter = state({});
  const r = await pruneStates(adapter, "没有这个目录");
  assert.deepEqual(r, { removed: 0, kept: 0, resumable: 0 });
});

test("非 json 文件一律不碰", async () => {
  const files = { "state/note.md": "别删我" };
  const adapter = state(files, { "state/note.md": 100 });
  await pruneStates(adapter, "state");
  assert.equal(await adapter.exists("state/note.md"), true);
});

test("保留下来的确实是最近的那批", async () => {
  const files: Record<string, string> = {};
  const ages: Record<string, number> = {};
  for (let i = 0; i < 6; i++) {
    const p = `state/r${i}.json`;
    files[p] = done(p);
    ages[p] = i; // r0 最新
  }
  const adapter = state(files, ages);
  await pruneStates(adapter, "state", { keepFiles: 3 });
  assert.equal(await adapter.exists("state/r0.json"), true);
  assert.equal(await adapter.exists("state/r2.json"), true);
  assert.equal(await adapter.exists("state/r3.json"), false);
  assert.equal(await adapter.exists("state/r5.json"), false);
});

test("未完成存档也有上限：留最新 10 个，其余清掉", async () => {
  const files: Record<string, string> = {};
  const ages: Record<string, number> = {};
  for (let i = 0; i < 14; i++) {
    const p = `state/q${i}.json`;
    files[p] = JSON.stringify({ status: "awaiting_confirm" });
    ages[p] = 8 + i; // q0 最新；都超过 7 天，所以要靠"未完成上限"来兜
  }
  const adapter = state(files, ages);
  const r = await pruneStates(adapter, "state", { keepResumableFiles: 10 });
  assert.equal(r.resumable, 10, `应留 10 个未完成，实际 ${r.resumable}`);
  assert.equal(r.removed, 4);
  assert.equal(await adapter.exists("state/q0.json"), true);
  assert.equal(await adapter.exists("state/q13.json"), false);
});

test("未完成存档超过 30 天也清——那已经不是能续跑的活了", async () => {
  const files = { "state/ancient.json": JSON.stringify({ status: "awaiting_confirm" }) };
  const adapter = state(files, { "state/ancient.json": 40 });
  const r = await pruneStates(adapter, "state");
  assert.equal(r.removed, 1);
});
