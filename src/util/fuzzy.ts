/**
 * 三级模糊匹配（纯函数，可单测）。
 *
 * 来历：Codex 的 `apply-patch/src/seek_sequence.rs` 在精确匹配失败后，
 * 依次尝试「忽略行尾空白」和「忽略首尾空白」。原因是真实失败绝大多数
 * 不是模型记错了内容，而是不可见差异：复制粘贴带出的尾随空格、
 * 中文输入法的全角空格、CRLF 残留。
 *
 * 我们只学它的一半：**降级匹配，但仍要求唯一**。不唯一就报错，
 * 宁可多一轮，也不要在错误的位置改文件。
 */

export type MatchTier = "exact" | "trailing" | "trimmed";

export interface MatchRange {
  /** 原文中的起始偏移 */
  start: number;
  /** 原文中的结束偏移（不含） */
  end: number;
  tier: MatchTier;
}

export interface MatchResult {
  tier: MatchTier;
  /** 命中区间；长度 > 1 表示有歧义 */
  ranges: MatchRange[];
}

/** 每行的起始偏移 */
function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

function splitLines(text: string): { text: string; start: number; end: number }[] {
  const starts = lineOffsets(text);
  const out: { text: string; start: number; end: number }[] = [];
  for (let i = 0; i < starts.length; i++) {
    const start = starts[i];
    const next = i + 1 < starts.length ? starts[i + 1] : text.length + 1;
    const end = Math.min(next - 1, text.length); // 不含换行符
    out.push({ text: text.slice(start, end), start, end });
  }
  return out;
}

const same = (a: string, b: string): boolean => a === b;

const TIERS: Array<{ tier: MatchTier; eq: (a: string, b: string) => boolean }> = [
  { tier: "exact", eq: same },
  { tier: "trailing", eq: (a, b) => a.trimEnd() === b.trimEnd() },
  { tier: "trimmed", eq: (a, b) => a.trim() === b.trim() },
];

/**
 * 在 haystack 里找 needle。
 * 返回最先命中的那一档；该档没有命中则返回 null。
 * 每档最多收集 2 个命中——再多也没有意义，调用方只需要知道「是否唯一」。
 */
export function findMatches(haystack: string, needle: string): MatchResult | null {
  if (!needle) return null;

  const hay = splitLines(haystack);
  const pat = needle.split("\n");
  // 允许 needle 末尾带一个换行（模型常这么写）
  if (pat.length > 1 && pat[pat.length - 1] === "") pat.pop();
  if (pat.length === 0 || pat.length > hay.length) return null;

  for (const { tier, eq } of TIERS) {
    const ranges: MatchRange[] = [];
    const last = hay.length - pat.length;
    for (let i = 0; i <= last; i++) {
      let ok = true;
      for (let k = 0; k < pat.length; k++) {
        if (!eq(hay[i + k].text, pat[k])) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      ranges.push({ start: hay[i].start, end: hay[i + pat.length - 1].end, tier });
      if (ranges.length >= 2) return { tier, ranges }; // 已确定有歧义，不必再扫
    }
    if (ranges.length > 0) return { tier, ranges };
  }
  return null;
}

/** 需要降级才能命中时给出提示，让模型知道格式有偏差 */
export function tierHint(tier: MatchTier): string | undefined {
  if (tier === "exact") return undefined;
  if (tier === "trailing") return "（匹配时忽略了行尾空白差异，请检查缩进/尾随空格）";
  return "（匹配时忽略了首尾空白差异，请检查缩进是否用了全角空格或 Tab）";
}

// ---------------------------------------------------------------------------
// 诊断：匹配失败时，告诉调用方「哪里不对」，而不是只说「没找到」
// ---------------------------------------------------------------------------

const clamp = (s: string, n = 120): string => (s.length <= n ? s : s.slice(0, n) + "…");

function head(text: string, n = 6): string {
  return splitLines(text)
    .slice(0, n)
    .map((l, i) => `${i + 1}: ${clamp(l.text, 80)}`)
    .join("\n");
}

/**
 * 解释为什么没匹配上。
 *
 * 真实案例（手机端 glm-5.3-flash）：模型给 old 的第三行只写了
 * 「> 第二大脑的导航中心」，而文件里是「> 第二大脑的导航中心，所有笔记的总索引」。
 * 只说「未找到」它就会原样重试三次。这里把实际那一行念给它听。
 */
export function explainMismatch(haystack: string, needle: string): string {
  const hay = splitLines(haystack);
  const pat = needle.split("\n");
  if (pat.length > 1 && pat[pat.length - 1] === "") pat.pop();

  const parts: string[] = [`文件共 ${hay.length} 行，开头几行是：`, head(haystack)];

  // 1) 第一行能定位 → 逐行往后找第一个对不上的
  const first = pat[0] ?? "";
  const anchorIdx = hay.findIndex(
    (l) => l.text === first || l.text.trimEnd() === first.trimEnd() || l.text.trim() === first.trim(),
  );

  if (anchorIdx >= 0 && pat.length > 1) {
    for (let k = 1; k < pat.length; k++) {
      const want = pat[k];
      const got = hay[anchorIdx + k]?.text;
      const ok =
        got !== undefined &&
        (got === want || got.trimEnd() === want.trimEnd() || got.trim() === want.trim());
      if (!ok) {
        parts.push(
          "",
          `old 的第 1 行在第 ${anchorIdx + 1} 行找到了，但第 ${k + 1} 行对不上：`,
          `  文件第 ${anchorIdx + k + 1} 行：${got === undefined ? "（文件到这里就结束了）" : "「" + clamp(got) + "」"}`,
          `  你给的 old 第 ${k + 1} 行：「${clamp(want)}」`,
          "",
          "old 必须是从行首到行尾的完整一行（或多个连续完整行），不能只写半句。",
        );
        return parts.join("\n");
      }
    }
  }

  // 2) 第一行都找不到 → 给出包含关系的候选
  const scored = hay
    .map((l, i) => ({ i, text: l.text }))
    .filter((l) => l.text.trim().length > 0)
    .map((l) => {
      const a = l.text.trim();
      const b = first.trim();
      let score = 0;
      if (a.includes(b) || b.includes(a)) score = Math.min(a.length, b.length);
      return { ...l, score };
    })
    .filter((l) => l.score >= 4)
    .sort((x, y) => y.score - x.score)
    .slice(0, 3);

  if (scored.length > 0) {
    parts.push("", "文件里和 old 第一行接近的行：");
    for (const s of scored) parts.push(`  第 ${s.i + 1} 行：「${clamp(s.text)}」`);
    parts.push("", "如果只是尾随空格/缩进不一致，请照抄文件里的完整一行。");
  } else {
    parts.push("", "old 的第一行在文件里完全没有出现。请先 read_file 看清楚原文再改。");
  }
  return parts.join("\n");
}

/** 多处命中时，把每一处念出来，方便模型加长上下文 */
export function explainAmbiguous(haystack: string, ranges: MatchRange[]): string {
  const hay = splitLines(haystack);
  const lines = ranges.slice(0, 3).map((r) => {
    const no = hay.findIndex((l) => l.start === r.start);
    const text = no >= 0 ? hay[no].text : "";
    return `  第 ${no + 1} 行：「${clamp(text)}」`;
  });
  return ["目标文本出现多处，无法确定改哪一处：", ...lines, "", "请在 old 里带上前后各一行，让它唯一。"].join("\n");
}
