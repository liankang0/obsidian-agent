/**
 * WP2 网络层：超时与中止。
 *
 * 真机踩过的问题：
 *   · 服务端不回包时 requestUrl 一直挂着，任务永远停在「思考中」，只能杀进程
 *     → 非流式加整段超时（竞速实现，requestUrl 本身不支持中止）
 *   · 流式在服务端断流/网络黑洞时 reader.read() 永远 pending
 *     → 加「无新数据」空闲超时（数据还在流就允许长生成）
 *   · 用户点中止后，晚到的 delta 还渲染到面板上；可重试错误还会自动重发请求
 *     → 晚到 delta 丢弃；中止状态下不再重试
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError, Provider } from "../src/agent/provider";
import { AgentLoop } from "../src/agent/loop";
import { ApprovalStore } from "../src/agent/approvals";
import type { Completion, LoopEvent, Provider as ProviderType } from "../src/agent/types";
import { __requestUrlHook, MockApp } from "./mocks/obsidian";

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

const baseCfg = {
  baseUrl: "http://test/v1",
  apiKey: "k",
  model: "m",
  temperature: 0,
  maxTokens: 100,
  maxSteps: 4,
  confirmAfterFiles: 99,
};

function withCfg(over: Partial<typeof baseCfg>) {
  return { ...baseCfg, ...over };
}

// ── 非流式：requestUrl 竞速超时 ──────────────────────────────────────────────

test("非流式：requestUrl 挂死时按配置超时，错误可重试且提示可操作", async () => {
  const p = new Provider(() => withCfg({ requestTimeoutMs: 50 }));
  __requestUrlHook.fn = () => new Promise(() => undefined); // 永不返回
  const started = Date.now();
  try {
    await assert.rejects(
      () => p.chat([{ role: "user", content: "hi" }], []),
      (e: unknown) => {
        assert.ok(e instanceof ApiError, `应抛 ApiError：${e}`);
        assert.ok((e as ApiError).retryable, "超时应该被标记为可重试");
        assert.match((e as ApiError).message, /超时/);
        return true;
      },
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 5000, `应在超时后很快返回，实际 ${elapsed}ms`);
  } finally {
    __requestUrlHook.fn = async () => {
      throw new Error("mock: requestUrl 不应被调用");
    };
  }
});

test("非流式：正常响应不受超时影响，completion 正常解析", async () => {
  const p = new Provider(() => withCfg({ requestTimeoutMs: 50 }));
  __requestUrlHook.fn = async () => ({
    status: 200,
    text: "",
    json: {
      choices: [{ message: { content: "正常" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    },
  });
  try {
    const res = await p.chat([{ role: "user", content: "hi" }], []);
    assert.equal(res.content, "正常");
    assert.equal(res.usage?.promptTokens, 5);
  } finally {
    __requestUrlHook.fn = async () => {
      throw new Error("mock: requestUrl 不应被调用");
    };
  }
});

test("非流式：未配置 requestTimeoutMs 时用默认 90s（不会立刻超时）", async () => {
  const p = new Provider(() => withCfg({}));
  __requestUrlHook.fn = async () => ({
    status: 200,
    json: { choices: [{ message: { content: "ok" }, finish_reason: "stop" }] },
  });
  try {
    const res = await p.chat([{ role: "user", content: "hi" }], []);
    assert.equal(res.content, "ok");
  } finally {
    __requestUrlHook.fn = async () => {
      throw new Error("mock: requestUrl 不应被调用");
    };
  }
});

// ── 流式：空闲超时 ───────────────────────────────────────────────────────────

/** 永不 enqueue 也永不 close 的流：模拟服务端断流/网络黑洞 */
function hangingStream(): Response {
  const body = new ReadableStream<Uint8Array>({
    pull() {
      /* 什么都不给 */
    },
  });
  return new Response(body, { status: 200 });
}

function withFakeFetch(fetchImpl: typeof fetch, fn: () => Promise<unknown>): Promise<unknown> {
  const orig = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

test("流式：断流（一直无新数据）按空闲超时中断", async () => {
  const p = new Provider(() => withCfg({ requestTimeoutMs: 50 }));
  await withFakeFetch((async () => hangingStream()) as typeof fetch, async () => {
    await assert.rejects(
      () => p.chatStream([{ role: "user", content: "hi" }], [], () => undefined),
      (e: unknown) => {
        assert.ok(e instanceof ApiError, `应抛 ApiError：${e}`);
        assert.match((e as ApiError).message, /超时|没有新数据/);
        return true;
      },
    );
  });
});

test("流式：数据还在流就不超时（慢速长生成是合法的）", async () => {
  const p = new Provider(() => withCfg({ requestTimeoutMs: 120 }));
  const enc = new TextEncoder();
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    // 每 20ms 才给一块（慢速生成）：空闲超时只看「距上一个 chunk 过了多久」，
    // 20ms 间隔远小于 120ms，所以 10 块共 200ms 的慢流必须活下来
    async pull(controller) {
      await new Promise((r) => setTimeout(r, 20));
      if (sent >= 10) {
        controller.enqueue(enc.encode("data: [DONE]\n\n"));
        controller.close();
        return;
      }
      sent++;
      controller.enqueue(
        enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`),
      );
    },
  });
  await withFakeFetch(
    (async () => new Response(body, { status: 200 })) as typeof fetch,
    async () => {
      const res = await p.chatStream([{ role: "user", content: "hi" }], [], () => undefined);
      assert.equal(res.content, "xxxxxxxxxx", `应收齐 10 块，实际：${res.content}`);
    },
  );
});

// ── 中止语义 ─────────────────────────────────────────────────────────────────

function makeLoop(provider: unknown, maxSteps = 4) {
  const app = new MockApp({ "a.md": "# A\n" });
  const loop = new AgentLoop({
    app: app as never,
    provider: provider as ProviderType,
    getConfig: () => withCfg({ maxSteps }),
    pluginDir: ".obsidian/plugins/local-vault-agent",
    log: silentLog,
    confirm: async () => true,
    approvals: new ApprovalStore(),
  });
  return loop;
}

test("中止后可重试错误不再自动重试（中止必须真的停）", async () => {
  let calls = 0;
  class RetryableFailingProvider {
    async chat(): Promise<Completion> {
      calls++;
      throw new ApiError("被限流（429），稍后重试。", 429, true);
    }
  }
  const loop = makeLoop(new RetryableFailingProvider());
  // 请求失败 5ms 后用户点中止；此时 loop 正在 1s 的重试等待里
  const anyProvider = loop as unknown as { deps: { provider: RetryableFailingProvider } };
  const origChat = anyProvider.deps.provider.chat.bind(anyProvider.deps.provider);
  anyProvider.deps.provider.chat = async (...args: Parameters<typeof origChat>) => {
    const r = origChat(...args);
    setTimeout(() => loop.abort(), 5);
    return r;
  };

  const state = await loop.start("测试", () => undefined);
  assert.equal(calls, 1, `中止后不应重试，实际调了 ${calls} 次`);
  assert.equal(state.status, "failed");
  assert.match(String(state.error), /限流/, `应保留原始错误而不是中止占位：${state.error}`);
});

test("中止后晚到的 delta 不再转发给面板", async () => {
  class LateDeltaProvider {
    async chat(): Promise<Completion> {
      return { content: "", toolCalls: [] };
    }
    async chatStream(
      _m: unknown,
      _t: unknown,
      onDelta: (s: string) => void,
    ): Promise<Completion> {
      onDelta("前面的字");
      // 模拟 abort() 到 rejection 之间的窗口里还在吐字
      setTimeout(() => onDelta("晚到的字"), 1);
      await new Promise((r) => setTimeout(r, 30));
      throw new ApiError("已中止", undefined, false);
    }
  }
  const loop = makeLoop(new LateDeltaProvider());
  const deltas: string[] = [];
  const events: LoopEvent[] = [];
  // 在 delta 事件外再挂一个钩子触发 abort：第一个 delta 后立刻中止
  const anyLoop = loop as unknown as { aborted: boolean };
  const state = await loop.start("测试", (e) => {
    events.push(e);
    if (e.type === "assistant_delta") {
      deltas.push(e.text);
      if (!anyLoop.aborted) loop.abort();
    }
  });
  assert.ok(deltas.includes("前面的字"), `第一个 delta 应该正常转发：${deltas.join("|")}`);
  assert.ok(!deltas.includes("晚到的字"), "中止后晚到的 delta 不许渲染");
  assert.notEqual(state.status, "done");
});

test("非流式挂死时用户仍可中止：中止后结果即使晚到也不再执行工具", async () => {
  class HangingChatProvider {
    async chat(): Promise<Completion> {
      // 挂 50ms 后返回一个「危险」工具调用；用户在 10ms 时已中止
      await new Promise((r) => setTimeout(r, 50));
      return {
        content: "",
        toolCalls: [{ id: "t1", name: "create_note", args: { path: "不该创建.md", content: "x" } }],
      };
    }
  }
  const loop = makeLoop(new HangingChatProvider());
  setTimeout(() => loop.abort(), 10);
  const state = await loop.start("测试", () => undefined);
  assert.equal(state.status, "aborted", `状态应为 aborted：${state.status}`);
  const app = (
    loop as unknown as { deps: { app: { vault: { readRaw(p: string): string | undefined } } } }
  ).deps.app;
  assert.equal(app.vault.readRaw("不该创建.md"), undefined, "中止后晚到的工具调用不许执行");
});
