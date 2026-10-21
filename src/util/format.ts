/**
 * token 数量的显示格式。
 *
 * 手机状态行只有一条的位置，所以按量级切单位：
 * - 不到 1K：原样（847）
 * - 不到 1M：K，一位小数（12.3K）
 * - 1M 以上：M，两位小数（1.23M）
 *
 * 之前一律用 Mb（百万 token），结果日常几万 token 的任务全显示成
 * 「0.015 Mb · 0.015↑ 0.0002↓」——小数点后四位，眼睛根本读不出量级。
 *
 * 注意：token 不是字节，K / M 在这里是「千 / 百万 token」，不是 kilobyte / megabyte。
 */

const THOUSAND = 1_000;
const MILLION = 1_000_000;

/** 超过这个量才换成 M——1M 是「读起来需要换单位」的自然分界 */
export const M_THRESHOLD = MILLION;

export function toK(tokens: number): number {
  return tokens / THOUSAND;
}

export function toM(tokens: number): number {
  return tokens / MILLION;
}

/**
 * 847 → "847"
 * 1234 → "1.2K"
 * 123_456 → "123K"
 * 1_234_567 → "1.23M"
 * 12_000_000 → "12M"
 */
export function formatTokens(tokens: number): string {
  const safe = Number.isFinite(tokens) && tokens > 0 ? Math.round(tokens) : 0;
  if (safe === 0) return "0";
  if (safe < THOUSAND) return String(safe);
  if (safe < M_THRESHOLD) {
    const k = toK(safe);
    const text = trimZeros(k.toFixed(k < 100 ? 1 : 0));
    // 四舍五入成 1000K 就读不出量级了，这种直接进 M
    if (text !== "1000") return `${text}K`;
  }
  const m = toM(safe);
  return `${trimZeros(m.toFixed(m < 10 ? 2 : 1))}M`;
}

/** 输入+输出一起，附上拆分：12.9K · 11.5K↑ 1.3K↓ */
export function formatUsage(promptTokens: number, completionTokens: number): string {
  const total = formatTokens(promptTokens + completionTokens);
  const detail =
    `${formatTokens(promptTokens)}↑ ${formatTokens(completionTokens)}↓`;
  return `${total} · ${detail}`;
}

/** 只裁小数尾零；整数（比如 1000 这种四舍五入结果）一个字符都不能动 */
function trimZeros(s: string): string {
  if (!s.includes(".")) return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}
