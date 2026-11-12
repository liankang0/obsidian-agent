/**
 * Agent 的公共类型。
 * 消息结构刻意贴近 OpenAI Chat Completions，减少一层无意义的转换。
 */

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  /** assistant 可能只返回工具调用，此时 content 为空 */
  content?: string;
  /** 仅 assistant */
  tool_calls?: ToolCall[];
  /** 仅 tool，对应哪次调用 */
  tool_call_id?: string;
}

export interface JsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  /**
   * 降级说明：工具只拿到了部分数据（检索超时、反链 API 不可用等），
   * 结果可用但不完整。序列化时会渲染成「⚠ 本次数据不完整：…」让模型看见，
   * 防止它把空结果当成「没有」而断言出错误结论。
   */
  degraded?: string;
}

export interface Usage {
  /** 命中提示缓存的 prompt token（服务端没报就是 0/null）——省钱与否就看它 */
  cachedTokens?: number;
  promptTokens: number;
  completionTokens: number;
}

/** 一次模型调用的归一化结果 */
export interface Completion {
  /** 思考型模型的推理内容长度（只用于诊断，不回灌上下文） */
  reasoningChars?: number;
  /** 实际使用的 max_tokens，便于判断是否被截断 */
  maxTokensUsed?: number;
  content: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  finishReason?: string;
}

export type RunStatus = "running" | "awaiting_confirm" | "done" | "failed" | "aborted";

export const AWAITING_HINT = "已暂停，等你回话";

export interface AppliedOp {
  tool: string;
  path?: string;
  at: number;
  /** 动作标签：改 / 新建 / 写入 / 移动 / 删除（面板的「本轮改动」用） */
  op?: string;
  /** 一句话说明：+3 −1 / a.md → b.md / 移入回收站 */
  detail?: string;
}

/** 落盘到 state/<runId>.json 的运行状态 */
export interface RunState {
  runId: string;
  createdAt: number;
  updatedAt: number;
  status: RunStatus;
  step: number;
  maxSteps: number;
  messages: ChatMessage[];
  pendingToolCall?: ToolCall;
  appliedOps: AppliedOp[];
  usage: Usage;
  error?: string;
  /** 已经因「空回复」重试过几次（防止模型静默掉线被当成完成） */
  emptyReplies?: number;
  /**
   * 本轮用户那句话在 messages 里的下标。
   * 有了它，取「模型最后说了什么」时就不会从注入的历史里捞答案——
   * 曾经因为扫全表，把上上轮的回答当成这轮的回答又存一遍，历史里出现三份一样的。
   */
  turnStart?: number;
  /** 本次任务是否已经写过 04/05（record_memory）——「准则 Step 4」提醒靠它判断 */
  memoryWritten?: boolean;
  /** ask_user 提出的待答问题：面板把它渲染成可点的选项，手机上一按就答 */
  pendingQuestion?: PendingQuestion;
}

/** 等用户回话时带着的问题（选项可点，省掉手机上打中文） */
export interface PendingQuestion {
  text: string;
  options?: string[];
  /** 允许多选：面板显示「提交」按钮而不是点一下就发 */
  multiple?: boolean;
}

/** Loop 往外抛的事件，UI 靠它增量渲染 */
export type LoopEvent =
  | { type: "assistant"; text: string }
  | { type: "assistant_delta"; text: string }
  | { type: "tool_start"; tool: string; args: Record<string, unknown> }
  | { type: "tool_end"; tool: string; result: ToolResult; ms: number }
  | { type: "status"; text: string }
  /** 每一轮模型调用后实时上报累计用量，供面板显示 token 消耗 */
  | { type: "usage"; usage: Usage }
  | { type: "done"; state: RunState }
  | { type: "error"; message: string };

export interface AgentConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  maxSteps: number;
  /** 单次 run 内累计改几个文件后开始逐次确认 */
  confirmAfterFiles: number;
  /**
   * 单次请求超时（毫秒）。非流式是「等整段返回」的上限；流式是「无新数据」的空闲上限
   * （只要数据还在流就允许长生成）。默认 90000。不填用默认值。
   */
  requestTimeoutMs?: number;
}

/** 跨轮次传给模型的对话历史（只保留 user/assistant 文本，不带工具细节） */
export interface HistoryTurn {
  role: "user" | "assistant";
  content: string;
}
