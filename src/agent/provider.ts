import { requestUrl } from "obsidian";
import type { AgentConfig, ChatMessage, Completion, ToolCall, ToolSpec, Usage } from "./types";

/**
 * OpenAI 兼容的 Chat Completions 客户端。
 *
 * 两条通道：
 * - `chat()` 用 Obsidian 的 requestUrl：走宿主进程，不受 WebView 的 CORS 限制，
 *   移动端最稳；代价是拿不到流式（只能等整段返回）。
 * - `chatStream()` 用 fetch + SSE：字一个个蹦出来，但受 CORS 约束。
 *
 * 所以流式是"能流则流"：fetch 不通（CORS / 无 body）就自动退回 requestUrl，
 * 用户看到的是"没有流式"，而不是"发不出去"。
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** 值得重试（限流、5xx、网络抖动） */
    readonly retryable = false
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface RawToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

export class Provider {
  constructor(private readonly getConfig: () => AgentConfig) {}

  /** 拼 endpoint，容忍用户把 baseUrl 写成 https://api.x.com 或 https://api.x.com/v1 */
  private endpoint(): string {
    const base = this.getConfig().baseUrl.trim().replace(/\/+$/, "");
    if (!base) throw new ApiError("未配置 API Base URL，请先到设置页填写。");
    if (base.endsWith("/chat/completions")) return base;
    return `${base}/chat/completions`;
  }

  async chat(messages: ChatMessage[], tools: ToolSpec[]): Promise<Completion> {
    const cfg = this.getConfig();
    if (!cfg.apiKey) {
      throw new ApiError("未配置 API Key。请在 设置 → Obsidian Agent 中填写。");
    }

    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: messages.map(toApiMessage),
      temperature: cfg.temperature,
      max_tokens: cfg.maxTokens,
      stream: false,
    };

    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }

    const json = await this.post(body);
    return parseCompletion(json);
  }


  /** 流式版本：每个 delta 回调一次，返回拼好的完整结果 */
  async chatStream(
    messages: ChatMessage[],
    tools: ToolSpec[],
    onDelta: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<Completion> {
    const cfg = this.getConfig();
    if (!cfg.apiKey) throw new ApiError("未配置 API Key。请在 设置 → Obsidian Agent 中填写。");

    const run = (maxTokens: number): Promise<Completion> =>
      this.streamOnce(messages, tools, onDelta, signal, maxTokens);

    // 空回复 + finish_reason=length：思考型模型把额度全花在 reasoning 上，正文一个字没吐
    // （真机证据：一次调用 completion_tokens 近 2000，正文只有 12 个字符）。
    // 此时还没向用户显示任何字，放大额度重发不会重复，所以逐级放大最多试到 4 倍。
    let tokens = cfg.maxTokens;
    let last = await run(tokens);
    for (let i = 0; i < 2; i++) {
      if (last.content !== "" || last.toolCalls.length > 0 || last.finishReason !== "length") break;
      const bigger = Math.min(tokens * 2, 32768);
      if (bigger <= tokens) break;
      tokens = bigger;
      last = await run(tokens);
    }
    return last;
  }

  /** 发一次流式请求并读完 SSE（重试时重新发，不能复用已锁定的响应体） */
  private async streamOnce(
    messages: ChatMessage[],
    tools: ToolSpec[],
    onDelta: (text: string) => void,
    signal: AbortSignal | undefined,
    maxTokens: number,
  ): Promise<Completion> {
    const cfg = this.getConfig();
    const body: Record<string, unknown> = {
      model: cfg.model,
      messages: messages.map(toApiMessage),
      temperature: cfg.temperature,
      max_tokens: maxTokens,
      stream: true,
      // 让服务端在最后一个 chunk 里带 usage，否则面板的 token 计数在流式下会一直是 0
      stream_options: { include_usage: true },
    };
    if (tools.length > 0) {
      body.tools = tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = "auto";
    }

    let res: Response;
    try {
      res = await fetch(this.endpoint(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      // fetch 在 WebView 里被 CORS 拦下时抛的是 TypeError，这里退回非流式
      const msg = e instanceof Error ? e.message : String(e);
      throw new ApiError(`流式请求失败：${msg}`, undefined, true);
    }

    if (res.status >= 400) {
      const text = await res.text().catch(() => "");
      throw classifyHttpError(res.status, text);
    }
    if (!res.body) throw new ApiError("服务端没有返回可读流", undefined, true);

    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let content = "";
    let reasoningChars = 0;
    let seenError: string | undefined;
    let finishReason: string | undefined;
    let usage: Usage | undefined;
    const calls = new Map<number, { id?: string; name?: string; args: string }>();

    const handleChunk = (raw: string): boolean => {
      const payloads = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      for (const payload of payloads) {
        if (!payload) continue;
        if (payload === "[DONE]") return true;
        let j: {
          choices?: Array<{
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              tool_calls?: RawToolCallDelta[];
            };
            finish_reason?: string;
          }>;
          usage?: UsageWire;
          error?: { message?: string } | string;
        };
        try {
          j = JSON.parse(payload);
        } catch {
          continue; // 心跳或非 JSON 行
        }
        // 网关会在流里塞 error 事件；以前直接跳过，表现为"模型返回空内容"，查无可查
        if (j.error) {
          seenError = typeof j.error === "string" ? j.error : (j.error.message ?? "流中返回错误");
          return true;
        }
        if (j.usage) {
          usage = {
            promptTokens: j.usage.prompt_tokens ?? 0,
            completionTokens: j.usage.completion_tokens ?? 0,
            cachedTokens: readCached(j.usage),
          };
        }
        const choice = j.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta ?? {};
        if (delta.reasoning_content) reasoningChars += delta.reasoning_content.length;
        if (delta.content) {
          content += delta.content;
          onDelta(delta.content);
        }
        for (const tc of delta.tool_calls ?? []) {
          const i = tc.index ?? 0;
          const cur = calls.get(i) ?? { args: "" };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name = tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          calls.set(i, cur);
        }
        if (choice.finish_reason) finishReason = choice.finish_reason;
      }
      return false;
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf("\n\n");
      while (idx >= 0) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        if (handleChunk(chunk)) {
          idx = -1;
          break;
        }
        idx = buf.indexOf("\n\n");
      }
    }
    if (buf.trim()) handleChunk(buf);

    if (seenError) throw new ApiError(`模型返回错误：${seenError}`);

    const toolCalls: ToolCall[] = [...calls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, c], i) => ({
        id: c.id ?? `call_${Date.now()}_${i}`,
        name: c.name ?? "",
        args: safeParseArgs(c.args),
      }))
      .filter((tc) => tc.name);

    return {
      content: content.trim(),
      toolCalls,
      usage,
      finishReason,
      reasoningChars,
      maxTokensUsed: maxTokens,
    };
  }

  /** 设置页的「测试连接」：发一句最小请求，验证地址 / Key / 模型名 */
  async testConnection(): Promise<string> {
    const res = await this.chat([{ role: "user", content: "回复两个字：正常" }], []);
    return res.content.trim() || "(模型返回了空内容)";
  }

  private async post(body: unknown): Promise<unknown> {
    const cfg = this.getConfig();
    let res;
    try {
      res = await requestUrl({
        url: this.endpoint(),
        method: "POST",
        contentType: "application/json",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
        throw: false,
      });
    } catch (e) {
      // 网络层错误（DNS / 超时 / 连接被拒）
      const msg = e instanceof Error ? e.message : String(e);
      throw new ApiError(`请求失败：${msg}`, undefined, true);
    }

    if (res.status >= 400) {
      throw classifyHttpError(res.status, res.text ?? "");
    }

    try {
      return res.json;
    } catch {
      const snippet = (res.text ?? "").slice(0, 300);
      throw new ApiError(`响应不是合法 JSON（前 300 字）：${snippet}`);
    }
  }
}

function classifyHttpError(status: number, text: string): ApiError {
  const snippet = extractErrorMessage(text);
  if (status === 401 || status === 403) {
    return new ApiError(`鉴权失败（${status}）：API Key 无效或无权限。${snippet}`, status, false);
  }
  if (status === 404) {
    return new ApiError(`端点不存在（404）：请检查 Base URL 是否包含 /v1。${snippet}`, status, false);
  }
  if (status === 429) {
    return new ApiError(`被限流（429），稍后重试。${snippet}`, status, true);
  }
  if (status >= 500) {
    return new ApiError(`服务端错误（${status}），可重试。${snippet}`, status, true);
  }
  // 400：最常见的是模型不支持工具调用，或上下文超长
  return new ApiError(`请求被拒绝（${status}）：${snippet}`, status, false);
}

function extractErrorMessage(text: string): string {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message ?? j?.message ?? j?.error;
    if (typeof m === "string") return m.slice(0, 300);
  } catch {
    /* 不是 JSON，直接截断 */
  }
  return (text ?? "").slice(0, 300);
}

function toApiMessage(m: ChatMessage): Record<string, unknown> {
  const out: Record<string, unknown> = { role: m.role };
  if (m.role === "tool") {
    out.tool_call_id = m.tool_call_id;
    out.content = m.content ?? "";
    return out;
  }
  if (m.role === "assistant" && m.tool_calls?.length) {
    out.content = m.content ?? null;
    out.tool_calls = m.tool_calls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    }));
    return out;
  }
  out.content = m.content ?? "";
  return out;
}

function parseCompletion(json: unknown): Completion {
  const data = json as {
    choices?: Array<{
      message?: { content?: string | null; tool_calls?: RawToolCall[] };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  };

  if (!data?.choices?.length) {
    const m = data?.error?.message;
    throw new ApiError(m ? `模型返回错误：${m}` : "响应里没有 choices 字段，可能不是 OpenAI 兼容端点。");
  }

  const choice = data.choices[0];
  const msg = choice.message ?? {};

  const toolCalls: ToolCall[] = (msg.tool_calls ?? [])
    .map((tc, i) => ({
      id: tc.id ?? `call_${Date.now()}_${i}`,
      name: tc.function?.name ?? "",
      args: safeParseArgs(tc.function?.arguments),
    }))
    .filter((tc) => tc.name);

  const usage: Usage | undefined = data.usage
    ? {
        promptTokens: data.usage.prompt_tokens ?? 0,
        completionTokens: data.usage.completion_tokens ?? 0,
        cachedTokens: readCached(data.usage),
      }
    : undefined;

  return {
    content: (msg.content ?? "").trim(),
    toolCalls,
    usage,
    finishReason: choice.finish_reason,
  };
}

/** 服务端 usage 里可能的缓存命中字段：OpenAI/DeepSeek 与 Anthropic 两种写法 */
type UsageWire = {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  cache_read_input_tokens?: number;
};

/** 命中提示缓存的 token 数。没报就返回 undefined，别拿 0 冒充「未命中」 */
function readCached(u: UsageWire): number | undefined {
  const n = u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens;
  return typeof n === "number" && n > 0 ? n : undefined;
}

function safeParseArgs(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    // 模型偶尔会吐出带尾逗号/裸换行的 JSON，这里不尝试修复，交给工具层报错
    return { __parse_error__: raw };
  }
}
