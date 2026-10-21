/**
 * token 数量的显示格式。
 *
 * 主计数单位是 Mb（百万 token），因为手机状态行只有一条的位置：
 * 精确到个位会让数字长得像个错误堆栈，而且没人关心第 1234 个 token。
 *
 * 注意：token 不是字节，Mb 在这里是「百万 token」的意思，不是 megabyte。
 */

const MILLION = 1_000_000;

export function toMb(tokens: number): number {
  return tokens / MILLION;
}

/**
 * 0 → "0 Mb"
 * 1234 → "0.0012 Mb"
 * 1_234_567 → "1.23 Mb"
 */
export function formatMb(tokens: number): string {
  const safe = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
  const mb = toMb(safe);
  if (mb === 0) return "0 Mb";
  if (mb < 0.01) return `${trimZeros(mb.toFixed(4))} Mb`;
  if (mb < 1) return `${trimZeros(mb.toFixed(3))} Mb`;
  return `${trimZeros(mb.toFixed(2))} Mb`;
}

/** 输入+输出一起，附上拆分：0.012 Mb · 0.011↑ 0.001↓ */
export function formatUsage(promptTokens: number, completionTokens: number): string {
  const total = formatMb(promptTokens + completionTokens);
  const detail = `${formatMb(promptTokens).replace(" Mb", "")}↑ ${formatMb(completionTokens).replace(" Mb", "")}↓`;
  return `${total} · ${detail}`;
}

function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
