/**
 * 发版脚本（WP7：版本唯一来源为 manifest.json，发版只改一处）。
 *
 *   node scripts/release.mjs 0.1.1     （或 npm run release -- 0.1.1）
 *
 * 一次同步三处版本载体，全部由这一个命令完成：
 *   · manifest.json   —— Obsidian 插件的版本唯一来源（真相在这里）
 *   · package.json    —— npm 元数据，跟着 manifest 对齐，防止混淆
 *   · versions.json   —— 社区插件市场要求的版本 → minAppVersion 映射
 *
 * CHANGELOG.md 不在此脚本内：它是给人读的记录，发版时手动补条目。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("用法：node scripts/release.mjs <x.y.z>  （版本必须是 semver 三段式）");
  process.exit(1);
}

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const manifest = readJson("manifest.json");
const minAppVersion = manifest.minAppVersion;
if (!minAppVersion) {
  console.error("manifest.json 缺 minAppVersion，先补上再发版。");
  process.exit(1);
}

// manifest 是唯一来源：package.json 与 versions.json 都从它对齐到目标版本
manifest.version = version;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);

const pkg = readJson("package.json");
pkg.version = version;
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);

let versions = {};
if (existsSync("versions.json")) {
  try {
    versions = readJson("versions.json");
  } catch {
    console.error("versions.json 不是合法 JSON，拒绝覆盖，先手工修好。");
    process.exit(1);
  }
}
if (versions[version]) {
  console.error(`versions.json 里已有 ${version}，确认要重发就先手工处理。`);
  process.exit(1);
}
versions[version] = minAppVersion;
// 市场要求按版本号倒序的对象；key 顺序在这里就是内容
const sorted = {};
for (const k of Object.keys(versions).sort((a, b) => (a < b ? 1 : -1))) sorted[k] = versions[k];
writeFileSync("versions.json", `${JSON.stringify(sorted, null, 2)}\n`);

console.log(`已发版 ${version}：manifest.json / package.json / versions.json 三处已同步（minAppVersion=${minAppVersion}）。`);
console.log("别忘了在 CHANGELOG.md 里补一条记录。");
