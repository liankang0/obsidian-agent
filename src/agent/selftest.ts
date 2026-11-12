/**
 * 设备自检：在没有 UI、没有模型的情况下，直接驱动工具层跑一组剧本。
 *
 * 触发方式：把 `selftest.flag` 放进插件目录，重载插件。
 * 为什么不用 adb 模拟点击：Obsidian 是 WebView 应用，`input text` 打不了中文，
 * 无障碍树里的 bounds 还经常是错的。自检不碰 UI，确定性和覆盖率都更高。
 *
 * 全部操作都在 `<插件目录>/selftest/` 下，不碰用户笔记。
 *
 * 剧本本身定义在 selftest-scenarios.ts，与单测共用（WP7）：
 * 这里只是真机 runner——逐条跑、失败进报告不中断；单测 runner 跑同一份剧本，一条失败整个红。
 */

import type { App } from "obsidian";

import {
  PLUGIN_DIR,
  SCRATCH_DIR,
  SELFTEST_STEPS,
  selftestCall,
  selftestCtx,
  selftestLoop,
  prepareScratch,
  type SelftestEnv,
} from "./selftest-scenarios";
import { SPILL_DIR } from "./spill";
import type { Completion } from "./types";
import type { ToolContext } from "./tools";

export const SELFTEST_FLAG = `${PLUGIN_DIR}/selftest.flag`;
export const SELFTEST_REPORT = `${PLUGIN_DIR}/selftest-report.json`;

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SelfTestReport {
  startedAt: string;
  finishedAt: string;
  pass: number;
  fail: number;
  steps: StepResult[];
}

export async function runSelfTest(app: App, log: ToolContext["log"]): Promise<SelfTestReport> {
  const adapter = app.vault.adapter;
  const steps: StepResult[] = [];
  // 记下自检开始前已有哪些存档，收尾时只删"这次自己造出来的"
  const stateDir = `${PLUGIN_DIR}/state`;
  const statesBefore = new Set<string>();
  try {
    if (await adapter.exists(stateDir)) {
      for (const f of (await adapter.list(stateDir)).files) statesBefore.add(f);
    }
  } catch {
    /* 拿不到就当没有 */
  }

  const check = async (name: string, fn: () => Promise<string>) => {
    try {
      const detail = await fn();
      steps.push({ name, ok: true, detail });
      log.info(`[自检] ✓ ${name}：${detail}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      steps.push({ name, ok: false, detail: msg });
      log.error(`[自检] ✗ ${name}：${msg}`);
    }
  };

  const assert = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(msg);
  };

  const startedAt = new Date().toISOString();

  try {
    // 0. 准备：清空并重建自检目录（夹具与单测 runner 共用同一份）
    await prepareScratch(app, adapter);

    const env: SelftestEnv = {
      app,
      adapter,
      log,
      assert,
      ctx: () => selftestCtx(app, log),
      call: selftestCall,
      makeLoop: (script: Completion[]) => selftestLoop(app, log, script),
    };

    for (const step of SELFTEST_STEPS) {
      await check(step.name, () => step.run(env));
    }
  } finally {
    // 清理：自检产物不留痕
    await adapter.rmdir(SCRATCH_DIR, true).catch(() => undefined);
    await adapter.rmdir(`${SPILL_DIR}/selftest`, true).catch(() => undefined);
    // 自检会真的调用 loop.start()，于是 state/ 里会落一堆「自检：…」存档。
    // 之前只有个别用例自己删，结果真机上攒了 28 个 awaiting_confirm，
    // 面板的「继续执行」列表里全是自检留下的假问题。这里统一收尾。
    try {
      if (await adapter.exists(stateDir)) {
        for (const f of (await adapter.list(stateDir)).files) {
          if (!statesBefore.has(f)) await adapter.remove(f).catch(() => undefined);
        }
      }
    } catch {
      /* 清理失败不影响报告 */
    }
    const report: SelfTestReport = {
      startedAt,
      finishedAt: new Date().toISOString(),
      pass: steps.filter((s) => s.ok).length,
      fail: steps.filter((s) => !s.ok).length,
      steps,
    };
    try {
      await adapter.write(SELFTEST_REPORT, JSON.stringify(report, null, 2));
    } catch (e) {
      log.error(`[自检] 写报告失败：${e instanceof Error ? e.message : String(e)}`);
    }
    return report;
  }
}
