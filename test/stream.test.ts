/**
 * 流式：provider 解析 SSE、循环把 delta 转成事件、面板据此追加。
 *
 * 三个能出事的点各测一条：
 *   1. SSE 分块恰好在 JSON 中间断开（真实网络就是这样）
 *   2. 工具调用参数分散在多个 delta 里
 *   3. 循环必须先发 delta 再发最终文本，否则面板会出现两份内容
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { Provider } from "../src/agent/provider";
import { AgentLoop } from "../src/agent/loop";
import type { Completion, LoopEvent, ToolCall } from "../src/agent/types";
import { MockApp } from "./mocks/obsidian";
import { SPILL_DIR } from "../src/agent/spill";

const silentLog = { info: () => undefined, warn: () => undefined, error: () => undefined };

const cfg = {
  baseUrl: "http://test/v1",
  apiKey: "k",
  model: "m",
  temperature: 0,
  maxTokens: 100,
  maxSteps: 4,
  confirmAfterFiles: 99,
};

/** 把一串 SSE 文本包装成 fetch 的 Response */
function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(enc.encode(chunks[i++]));
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function withFakeFetch<T>(chunks: string[], fn: () => Promise<T>): Promise<T> {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => sseResponse(chunks)) as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = orig;
  });
}

function data(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

test("流式：delta 逐个回调，内容拼成完整文本", async () => {
  const p = new Provider(() => cfg);
  const seen: string[] = [];
  await withFakeFetch(
    [
      data({ choices: [{ delta: { content: "你" } }] }),
      data({ choices: [{ delta: { content: "好" } }] }),
      data({ choices: [{ delta: { content: "呀" }, finish_reason: "stop" }] }),
      data({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 3 } }),
      "data: [DONE]\n\n",
    ],
    async () => {
      const res = await p.chatStream([{ role: "user", content: "hi" }], [], (t) => seen.push(t));
      assert.deepEqual(seen, ["你", "好", "呀"]);
      assert.equal(res.content, "你好呀");
      assert.equal(res.toolCalls.length, 0);
      assert.equal(res.usage?.promptTokens, 11);
      assert.equal(res.usage?.completionTokens, 3);
      assert.equal(res.finishReason, "stop");
    },
  );
});

test("流式：SSE 分块切在 JSON 中间也能拼回来", async () => {
  const p = new Provider(() => cfg);
  const full = data({ choices: [{ delta: { content: "跨块文本" } }] }) + "data: [DONE]\n\n";
  // 每 5 个字符切一刀，必然切在 JSON 中间
  const chunks: string[] = [];
  for (let i = 0; i < full.length; i += 5) chunks.push(full.slice(i, i + 5));

  await withFakeFetch(chunks, async () => {
    const res = await p.chatStream([{ role: "user", content: "hi" }], [], () => undefined);
    assert.equal(res.content, "跨块文本");
  });
});

test("流式：工具调用参数分散在多个 delta 里能拼齐", async () => {
  const p = new Provider(() => cfg);
  const chunks = [
    data({
      choices: [
        { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "" } }] } },
      ],
    }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } }] }),
    data({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.md"}' } }] } }] }),
    data({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    "data: [DONE]\n\n",
  ];

  await withFakeFetch(chunks, async () => {
    const res = await p.chatStream([{ role: "user", content: "hi" }], [], () => undefined);
    assert.equal(res.toolCalls.length, 1);
    assert.equal(res.toolCalls[0].name, "read_file");
    assert.deepEqual(res.toolCalls[0].args, { path: "a.md" });
    assert.equal(res.toolCalls[0].id, "call_1");
  });
});

test("流式：HTTP 400 抛可读错误，不静默返回空", async () => {
  const p = new Provider(() => cfg);
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: "model not found" } }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  try {
    await assert.rejects(
      () => p.chatStream([{ role: "user", content: "hi" }], [], () => undefined),
      /端点不存在/,
    );
  } finally {
    globalThis.fetch = orig;
  }
});

test("流式不可用时循环退回非流式，不丢任务", async () => {
  const events: LoopEvent[] = [];
  class NoStreamProvider {
    streamCalls = 0;
    async chatStream(): Promise<Completion> {
      this.streamCalls++;
      throw new Error("TypeError: Failed to fetch");
    }
    async chat(): Promise<Completion> {
      return { content: "退回来的回答", toolCalls: [] };
    }
  }
  const provider = new NoStreamProvider();
  const app = new MockApp({ "a.md": "# a\n" });
  const loop = new AgentLoop({
    app: app as never,
    provider: provider as never,
    getConfig: () => cfg,
    pluginDir: SPILL_DIR.split("/").slice(0, 3).join("/"),
    log: silentLog,
    confirm: async () => true,
    approvals: { isApproved: () => false, approve: () => undefined } as never,
  });
  const state = await loop.start("读一下 a.md", (e) => events.push(e));
  assert.equal(state.status, "done");
  assert.equal(provider.streamCalls, 1);
  const said = events.filter((e) => e.type === "assistant" && e.text.includes("退回来的回答"));
  assert.equal(said.length, 1, "必须把非流式的回答报给面板");
});

test("循环：先 delta 后 assistant，且 delta 拼起来等于最终文本", async () => {
  const events: LoopEvent[] = [];
  class StreamingProvider {
    private done = false;
    async chatStream(
      _m: unknown[],
      _t: unknown,
      onDelta: (s: string) => void,
    ): Promise<Completion> {
      if (this.done) return { content: "", toolCalls: [] as ToolCall[] };
      this.done = true;
      onDelta("第一段");
      onDelta("第二段");
      return { content: "第一段第二段", toolCalls: [] };
    }
  }
  const app = new MockApp({ "a.md": "# a\n" });
  const loop = new AgentLoop({
    app: app as never,
    provider: new StreamingProvider() as never,
    getConfig: () => cfg,
    pluginDir: SPILL_DIR.split("/").slice(0, 3).join("/"),
    log: silentLog,
    confirm: async () => true,
    approvals: { isApproved: () => false, approve: () => undefined } as never,
  });
  await loop.start("随便说点", (e) => events.push(e));

  const deltas = events.filter((e) => e.type === "assistant_delta").map((e) => (e as { text: string }).text);
  assert.deepEqual(deltas, ["第一段", "第二段"]);
  const final = events.find((e) => e.type === "assistant") as { text: string } | undefined;
  assert.equal(final?.text, "第一段第二段");

  // delta 必须全部出现在最终文本之前，否则面板会先有整段再重复追加
  const iDelta = events.findIndex((e) => e.type === "assistant_delta");
  const iFinal = events.findIndex((e) => e.type === "assistant");
  assert.ok(iDelta < iFinal, "delta 事件必须在 assistant 之前");
});

test("中止：流式中途按中止，连接被掐断而不是等它读完", async () => {
  const p = new Provider(() => cfg);
  const orig = globalThis.fetch;
  let sawAbort = false;
  globalThis.fetch = ((_url: string, init: RequestInit) => {
    const signal = init.signal as AbortSignal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(data({ choices: [{ delta: { content: "开始" } }] })));
        // 之后不再产出，装成服务端还在慢慢想
        signal.addEventListener("abort", () => {
          sawAbort = true;
          controller.error(new DOMException("aborted", "AbortError"));
        });
      },
    });
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as typeof fetch;

  try {
    const controller = new AbortController();
    const done = p.chatStream([{ role: "user", content: "hi" }], [], () => undefined, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await assert.rejects(done);
    assert.equal(sawAbort, true, "signal 必须真的传到 fetch");
  } finally {
    globalThis.fetch = orig;
  }
});

test("真实路径：start() 必须在 system prompt 里带上检查清单（回归：只有 resume 读过）", async () => {
  // 这条守着一个真机上漏掉的 bug：start() 曾经不调 readChecklists，
  // 于是真实任务的 prompt 里清单块是空的，而自检走了另一条路全绿。
  const files = {
    "AI/01-任务前检查清单.md": [
      "# 任务前",
      "",
      "### 1. 🚀 开始任务前",  // 解析器只认 ### 级标题（真机文件也是这个层级）
      "- [ ] 先读 04 了解现状",
      "- [ ] 确认目录规范",
      "",
      "## 🎯 不同任务类型的特殊检查",
      "- [ ] 删除任务是否已确认",
    ].join("\n"),
    "AI/02-任务后质量检查清单.md": [
      "# 任务后",
      "",
      "### 1. 📁 基础规范",
      "- [ ] 文件命名符合规范",
      "- [ ] 位置正确",
    ].join("\n"),
    "AI/04-临时工作记忆区.md": "## 当前活跃任务\n\n### 在做的活\n**下一步** 继续\n",
  };

  let seenSystem = "";
  class Recorder {
    async chatStream(messages: Array<{ role: string; content?: string }>): Promise<Completion> {
      if (messages[0]?.role === "system") seenSystem = messages[0].content ?? "";
      return { content: "好了", toolCalls: [] };
    }
    async chat(messages: Array<{ role: string; content?: string }>): Promise<Completion> {
      if (messages[0]?.role === "system") seenSystem = messages[0].content ?? "";
      return { content: "好了", toolCalls: [] };
    }
  }

  const loop = new AgentLoop({
    app: new MockApp(files) as never,
    provider: new Recorder() as never,
    getConfig: () => cfg,
    pluginDir: SPILL_DIR.split("/").slice(0, 3).join("/"),
    log: silentLog,
    confirm: async () => true,
    approvals: { isApproved: () => false, approve: () => undefined } as never,
  });

  await loop.start("随便做点什么", () => undefined);

  assert.ok(seenSystem.includes("任务开始前逐项确认"), "清单的前置部分没进 prompt");
  assert.ok(seenSystem.includes("Step 1"), "没标明这是准则第几步");
  assert.ok(seenSystem.includes("read_checklist"), "没告诉模型怎么取 02 全文");
  assert.ok(!seenSystem.includes("删除任务是否已确认"), "任务类型专属段落不该注入");
  assert.ok(seenSystem.includes("当前活跃任务"), "工作记忆也没带进来");
});

test("流式：网关在流里塞 error 时要抛出来，而不是变成空回复", async () => {
  const p = new Provider(() => cfg);
  await withFakeFetch(
    [data({ error: { message: "context length exceeded" } }), "data: [DONE]\n\n"],
    async () => {
      await assert.rejects(
        () => p.chatStream([{ role: "user", content: "hi" }], [], () => undefined),
        /context length exceeded/,
      );
    },
  );
});

test("流式：空内容且 finish_reason=length 时自动放大额度重试一次", async () => {
  const p = new Provider(() => cfg); // maxTokens=100
  const calls: number[] = [];
  const orig = globalThis.fetch;
  globalThis.fetch = ((_u: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body.max_tokens);
    const chunks =
      body.max_tokens === 100
        ? [
            // 第一次：全花在思考上，被 length 截断
            data({ choices: [{ delta: { reasoning_content: "想了很久" } }] }),
            data({ choices: [{ delta: {}, finish_reason: "length" }] }),
            "data: [DONE]\n\n",
          ]
        : [data({ choices: [{ delta: { content: "这次有正文了" }, finish_reason: "stop" }] }), "data: [DONE]\n\n"];
    return Promise.resolve(sseResponse(chunks));
  }) as typeof fetch;

  try {
    const res = await p.chatStream([{ role: "user", content: "hi" }], [], () => undefined);
    assert.deepEqual(calls, [100, 200], "应该带 200 重试一次");
    assert.equal(res.content, "这次有正文了");
    assert.equal(res.maxTokensUsed, 200);
  } finally {
    globalThis.fetch = orig;
  }
});

test("流式：有正文就不该因为 finish_reason=length 重发", async () => {
  const p = new Provider(() => cfg);
  const orig = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (() => {
    n++;
    return Promise.resolve(
      sseResponse([data({ choices: [{ delta: { content: "半句话" }, finish_reason: "length" }] }), "data: [DONE]\n\n"]),
    );
  }) as typeof fetch;
  try {
    const res = await p.chatStream([{ role: "user", content: "hi" }], [], () => undefined);
    assert.equal(n, 1, "已经有内容了，重发会让用户看到两遍");
    assert.equal(res.content, "半句话");
  } finally {
    globalThis.fetch = orig;
  }
});

test("ask_user：调了它任务就停下等回话，而不是显示「已完成」", async () => {
  const events: LoopEvent[] = [];
  const script: Completion[] = [
    { content: "我先给你方案：1) 改名 2) 统一标签", toolCalls: [{ id: "a1", name: "ask_user", args: { question: "按这个方案做吗？" } }] },
    // 如果循环没停，会接着走这句
    { content: "不该走到这里", toolCalls: [] },
  ];
  class P {
    i = 0;
    async chat(): Promise<Completion> {
      return script[this.i++] ?? { content: "完", toolCalls: [] };
    }
  }
  const loop = new AgentLoop({
    app: new MockApp({ "a.md": "# a\n" }) as never,
    provider: new P() as never,
    getConfig: () => cfg,
    pluginDir: SPILL_DIR.split("/").slice(0, 3).join("/"),
    log: silentLog,
    confirm: async () => true,
    approvals: { isApproved: () => false, approve: () => undefined } as never,
  });
  const state = await loop.start("统一格式", (e) => events.push(e));
  assert.equal(state.status, "awaiting_confirm", "状态必须是等回话，不是 done");
  const done = events.find((e) => e.type === "done") as { state: { status: string } } | undefined;
  assert.equal(done?.state.status, "awaiting_confirm");
  assert.ok(
    events.some((e) => e.type === "status" && e.text.includes("等你回话")),
    "面板得告诉用户在等回话",
  );
});

test("ask_user：只读模式下也提供（它不写文件）", async () => {
  const { getToolSpecs } = await import("../src/agent/tools");
  const specs = getToolSpecs({ readOnly: true } as never).map((s) => s.name);
  assert.ok(specs.includes("ask_user"));
  assert.ok(specs.includes("read_file"));
  assert.ok(!specs.includes("trash_note"));
});

test("ask_user：给了选项就存进 pendingQuestion，面板才能渲染成可点的按钮", async () => {
  const events: LoopEvent[] = [];
  const script: Completion[] = [
    {
      content: "方案我列好了",
      toolCalls: [
        {
          id: "a1",
          name: "ask_user",
          args: { question: "按哪个做？", options: ["全做", "只改名", "先改 3 个试试"] },
        },
      ],
    },
  ];
  class P {
    i = 0;
    async chat(): Promise<Completion> {
      return script[this.i++] ?? { content: "完", toolCalls: [] };
    }
  }
  const loop = new AgentLoop({
    app: new MockApp({ "a.md": "# a\n" }) as never,
    provider: new P() as never,
    getConfig: () => cfg,
    pluginDir: SPILL_DIR.split("/").slice(0, 3).join("/"),
    log: silentLog,
    confirm: async () => true,
    approvals: { isApproved: () => false, approve: () => undefined } as never,
  });
  const state = await loop.start("统一格式", (e) => events.push(e));
  assert.equal(state.status, "awaiting_confirm");
  assert.deepEqual(state.pendingQuestion, {
    text: "按哪个做？",
    options: ["全做", "只改名", "先改 3 个试试"],
    multiple: false,
  });
});

test("ask_user：只给一个选项算错误（一个选项等于命令，不该问）", async () => {
  const { executeTool } = await import("../src/agent/tools");
  let paused = false;
  const ctx = {
    app: new MockApp({}) as never,
    log: silentLog,
    confirm: async () => true,
    changedFiles: new Set<string>(),
    confirmAfterFiles: 5,
    readOnly: false,
    runId: "t",
    approvals: { isApproved: () => false, approve: () => undefined },
    requestPause: () => {
      paused = true;
    },
  };
  const bad = await executeTool(
    { id: "x", name: "ask_user", args: { question: "做吗", options: ["做"] } },
    ctx as never,
  );
  assert.equal(bad.ok, false);
  assert.match(bad.error ?? "", /至少 2 个/);
  assert.equal(paused, false, "参数不合法时不能停下任务");

  const good = await executeTool(
    { id: "y", name: "ask_user", args: { question: "做吗", options: ["做", "不做"], multiple: true } },
    ctx as never,
  );
  assert.equal(good.ok, true);
  assert.equal(paused, true);
});

test("缓存命中：服务端报了 cached_tokens 就记下来并进日志（决定要不要做假设）", async () => {
  const seen: string[] = [];
  const log = { info: (s: string) => seen.push(s), warn() {}, error() {} };
  const p = new Provider(() => cfg);
  const body = [
    `data: {"choices":[{"delta":{"content":"好"}}]}`,
    `data: {"choices":[],"usage":{"prompt_tokens":900,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":768}}}`,
    `data: [DONE]`,
    ``,
  ].join("\n\n");
  const res = new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  (globalThis as unknown as { fetch: typeof fetch }).fetch = async () => res;
  const c = await p.chatStream([{ role: "user", content: "hi" }], [], () => undefined);
  assert.equal(c.usage?.cachedTokens, 768);
  assert.equal(c.usage?.promptTokens, 900);

  // 累加 + 日志
  const { accumulateUsageForTest } = await import("../src/agent/loop");
  const state = { usage: { promptTokens: 0, completionTokens: 0 } } as never;
  accumulateUsageForTest(state, c.usage);
  accumulateUsageForTest(state, { promptTokens: 900, completionTokens: 10, cachedTokens: 100 });
  assert.deepEqual(state.usage, { promptTokens: 1800, completionTokens: 20, cachedTokens: 868 });
  assert.ok(log);
});
