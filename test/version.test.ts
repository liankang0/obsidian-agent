/**
 * WP7：版本与变更记录。
 *
 * 版本唯一来源是 manifest.json；发版走 `npm run release -- <x.y.z>`（一条命令同步
 * manifest / package.json / versions.json 三处）。这条测试不钉具体版本号，
 * 钉的是「三处一致 + 记录不落后」：谁手动只改了其中一处，CI 直接红。
 *
 * 注意：文件路径按 process.cwd() 解析——npm test 从仓库根目录跑（本地与 CI 都是），
 * 打包后的测试文件本身在临时目录里，不能用 import.meta.url 定位。
 */

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const SEMVER = /^\d+\.\d+\.\d+$/;

/** 从仓库根读一个 JSON；cwd 不对时给出能看懂的报错 */
function readRootJson(path: string): unknown {
  const p = resolve(process.cwd(), path);
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`读不到 ${path}（cwd=${process.cwd()}）。请在仓库根目录跑 npm test。原因：${e instanceof Error ? e.message : e}`);
  }
}

const manifest = readRootJson("manifest.json") as { version: string; minAppVersion: string };

test("manifest.json 的版本是合法 semver，且带 minAppVersion", () => {
  assert.match(manifest.version, SEMVER, `版本号必须是三段式：${manifest.version}`);
  assert.match(manifest.minAppVersion, SEMVER, `minAppVersion 必须是三段式：${manifest.minAppVersion}`);
});

test("package.json 版本与 manifest 对齐（漂移说明有人手动改了单边）", () => {
  const pkg = readRootJson("package.json") as { version: string };
  assert.equal(pkg.version, manifest.version, "发版请用 npm run release -- <x.y.z>，不要手动改版本号");
});

test("versions.json 与 manifest 一致（社区市场要求的映射）", () => {
  const p = resolve(process.cwd(), "versions.json");
  if (!existsSync(p)) {
    // 首次发版前可以没有；release 脚本会创建
    assert.ok(true);
    return;
  }
  const versions = JSON.parse(readFileSync(p, "utf8")) as Record<string, string>;
  assert.ok(
    versions[manifest.version] !== undefined,
    `versions.json 缺 ${manifest.version} 的条目（应映射到 ${manifest.minAppVersion}）`,
  );
  assert.equal(versions[manifest.version], manifest.minAppVersion, "minAppVersion 映射和 manifest 不一致");
});

test("CHANGELOG.md 的最新条目就是当前版本", () => {
  const p = resolve(process.cwd(), "CHANGELOG.md");
  let md: string;
  try {
    md = readFileSync(p, "utf8");
  } catch (e) {
    throw new Error(`读不到 CHANGELOG.md（cwd=${process.cwd()}）。请在仓库根目录跑 npm test。原因：${e instanceof Error ? e.message : e}`);
  }
  const headings = [...md.matchAll(/^## \[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
  assert.ok(headings.length > 0, "CHANGELOG.md 里没有任何版本条目");
  assert.equal(
    headings[0],
    manifest.version,
    `CHANGELOG 最新条目是 ${headings[0]}，manifest 是 ${manifest.version}——发版时两处要一起更新`,
  );
});
