import assert from "node:assert/strict";
import test from "node:test";

import { formatTokens, formatUsage } from "../src/util/format";

test("不到 1000 原样显示", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(7), "7");
  assert.equal(formatTokens(847), "847");
  assert.equal(formatTokens(999), "999");
});

test("1000 到 1M 用 K，取一位小数", () => {
  assert.equal(formatTokens(1000), "1K");
  assert.equal(formatTokens(1234), "1.2K");
  assert.equal(formatTokens(12_345), "12.3K");
  assert.equal(formatTokens(61_000), "61K");
});

test("十万以上不再留小数，免得读不出量级", () => {
  assert.equal(formatTokens(123_456), "123K");
  assert.equal(formatTokens(999_000), "999K");
});

test("超过 1M 才换成 M", () => {
  assert.equal(formatTokens(999_400), "999K");
  assert.equal(formatTokens(999_949), "1M");
  assert.equal(formatTokens(1_000_000), "1M");
  assert.equal(formatTokens(1_234_567), "1.23M");
  assert.equal(formatTokens(12_000_000), "12M");
});

test("贴近 1000K 时直接进 M，不显示 1000K", () => {
  const s = formatTokens(999_980);
  assert.ok(s.endsWith("M"), `应进 M，实际 ${s}`);
});

test("0 与非法值都显示 0", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(-5), "0");
  assert.equal(formatTokens(Number.NaN), "0");
});

test("formatUsage 带输入输出拆分", () => {
  assert.equal(formatUsage(11468, 1337), "12.8K · 11.5K↑ 1.3K↓");
  assert.equal(formatUsage(0, 0), "0 · 0↑ 0↓");
});

test("formatUsage 混量级时各自用各自的单位", () => {
  assert.equal(formatUsage(1_200_000, 800), "1.2M · 1.2M↑ 800↓");
});
