/**
 * WP6 轻量收口：预算常量单点。
 *
 * 这里的断言不钉具体数值（数值可以按真机数据调），钉的是**彼此关系**——
 * 五个预算散在五个文件里时，这些关系无从表达也无人看守；
 * 集中到 budgets.ts 之后才守得住。谁要改数值，跑一遍就知道是否打破了全局分配。
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  BATCH_MAX_FILES,
  BATCH_PER_FILE_CHARS,
  BATCH_TOTAL_CHARS,
  CONTEXT_CHARS_GATE,
  HISTORY_BUDGET,
  HISTORY_TURN_CAP,
  MAX_INLINE_CHARS,
  MAX_OUTPUT_CHARS,
  SPILL_HEAD_CHARS,
} from "../src/agent/budgets";

test("预算关系：批量读取装得进单次输出", () => {
  assert.ok(
    BATCH_TOTAL_CHARS <= MAX_OUTPUT_CHARS,
    `整批预算 ${BATCH_TOTAL_CHARS} 超过单次输出上限 ${MAX_OUTPUT_CHARS}，批量读取会被截断等于白读`,
  );
  assert.ok(
    BATCH_PER_FILE_CHARS <= BATCH_TOTAL_CHARS,
    "单篇截断不能超过整批预算",
  );
  assert.ok(BATCH_MAX_FILES >= 1);
});

test("预算关系：外溢必须真的省出上下文", () => {
  assert.ok(
    SPILL_HEAD_CHARS < MAX_INLINE_CHARS,
    `外溢保留的开头 ${SPILL_HEAD_CHARS} 必须比内联上限 ${MAX_INLINE_CHARS} 短，否则外溢等于没省`,
  );
  assert.ok(
    MAX_INLINE_CHARS <= MAX_OUTPUT_CHARS,
    `内联上限 ${MAX_INLINE_CHARS} 超过单次输出上限 ${MAX_OUTPUT_CHARS}，外溢永远不会触发`,
  );
});

test("预算关系：历史不该独自把上下文顶过整体门槛", () => {
  assert.ok(
    HISTORY_TURN_CAP <= HISTORY_BUDGET,
    `单条截断上限 ${HISTORY_TURN_CAP} 超过历史总预算 ${HISTORY_BUDGET}，一条历史就吃光全部额度`,
  );
  assert.ok(
    HISTORY_BUDGET < CONTEXT_CHARS_GATE,
    `历史预算 ${HISTORY_BUDGET} 不该单独顶到整体瘦身门槛 ${CONTEXT_CHARS_GATE}`,
  );
});
