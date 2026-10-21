import assert from "node:assert/strict";
import test from "node:test";

import { formatMb, formatUsage, toMb } from "../src/util/format";

test("Mb = 百万 token", () => {
  assert.equal(toMb(1_000_000), 1);
  assert.equal(toMb(1500), 0.0015);
});

test("小数值保留 4 位", () => {
  assert.equal(formatMb(1234), "0.0012 Mb");
  assert.equal(formatMb(1500), "0.0015 Mb");
  assert.equal(formatMb(9999), "0.01 Mb".replace("0.01", "0.01")); // 0.009999 → 0.01
});

test("中等值保留 3 位", () => {
  assert.equal(formatMb(12_345), "0.012 Mb");
  assert.equal(formatMb(123_456), "0.123 Mb");
});

test("超过 1M 保留 2 位", () => {
  assert.equal(formatMb(1_234_567), "1.23 Mb");
  assert.equal(formatMb(12_000_000), "12 Mb");
});

test("0 与非法值都显示 0 Mb", () => {
  assert.equal(formatMb(0), "0 Mb");
  assert.equal(formatMb(-5), "0 Mb");
  assert.equal(formatMb(Number.NaN), "0 Mb");
});

test("formatUsage 带输入输出拆分", () => {
  assert.equal(formatUsage(11468, 1337), "0.013 Mb · 0.011↑ 0.0013↓");
  assert.equal(formatUsage(0, 0), "0 Mb · 0↑ 0↓");
});

test("formatUsage 里 Mb 只出现一次，避免行太长", () => {
  const s = formatUsage(5_000_000, 500_000);
  assert.equal((s.match(/Mb/g) ?? []).length, 1);
});
