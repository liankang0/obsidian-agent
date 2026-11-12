/**
 * 把工具结果变成发给模型的内容。
 *
 * 单独抽出来是为了能在真机上直接测：它同时涉及序列化、落盘、路径和降级，
 * 是「大结果会不会丢」的唯一收口。放在 Loop 私有方法里就只能靠 mock 测。
 */

import type { DataAdapter } from "obsidian";

import { MAX_INLINE_CHARS, SPILL_HEAD_CHARS, spillFilePath, spillNotice } from "./spill";

export interface SerializeDeps {
  adapter: DataAdapter;
  log: { warn(s: string): void };
}

export interface Serialized {
  /** 真正写进消息的内容 */
  content: string;
  /** 发生外溢时的落点 */
  spilledPath?: string;
  /** 外溢失败退回截断 */
  degraded: boolean;
}

/**
 * 不参与外溢的工具：
 * - read_file：自己就有 from/to 分段能力，再套一层只会让模型去读临时文件；
 * - read_files：批量读的全部价值就是「一次拿全」，外溢等于又变成两步；
 * - use_skill / read_checklist：返回的就是模型要照着做的正文，外溢等于没给它。
 *   （真机上踩过：skill 正文 4089 字符被写进 spill，模型又花一步 read_file 才拿到）
 */
const EXEMPT = new Set(["read_file", "read_files", "use_skill", "read_checklist"]);

/** 工具结果自带 degraded 说明时取出来；没有/非法就当没有 */
function degradedOf(result: unknown): string | undefined {
  if (result && typeof result === "object" && "degraded" in result) {
    const v = (result as { degraded?: unknown }).degraded;
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

export async function serializeToolResult(
  deps: SerializeDeps,
  tool: string,
  runId: string,
  seq: number,
  result: unknown,
): Promise<Serialized> {
  const json = JSON.stringify(result);
  // 「本次数据不完整」必须放在内容最前面：外溢/截断路径下模型可能只看头部，
  // 埋在 JSON 里的字段它可能注意不到。正常结果不加前缀（完成定义里有断言）。
  const marker = degradedOf(result) ? `⚠ 本次数据不完整：${degradedOf(result)}\n` : "";
  if (EXEMPT.has(tool) || json.length <= MAX_INLINE_CHARS) {
    return { content: `${marker}${json}`, degraded: false };
  }

  const path = spillFilePath(runId, tool, seq);
  try {
    // adapter.mkdir 不建父目录，逐级来
    const segments = path.split("/");
    segments.pop();
    let dir = "";
    for (const seg of segments) {
      dir = dir ? `${dir}/${seg}` : seg;
      if (!(await deps.adapter.exists(dir))) await deps.adapter.mkdir(dir);
    }
    await deps.adapter.write(path, json);

    const head = json.slice(0, SPILL_HEAD_CHARS);
    return {
      content: `${marker}${spillNotice(json.length, path, head, json.split("\n").length)}`,
      spilledPath: path,
      degraded: false,
    };
  } catch (e) {
    // 存储故障不能让内容凭空消失：退回截断，至少保留前半段
    const msg = e instanceof Error ? e.message : String(e);
    deps.log.warn(`外溢失败，退回截断：${msg}`);
    return {
      content: `${marker}${json.slice(0, MAX_INLINE_CHARS)}\n…（已截断，原始 ${json.length} 字符）`,
      degraded: true,
    };
  }
}
