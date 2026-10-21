/**
 * 敏感文件判定测试。
 * 这里每一条「应拦截」都对应一条真实的泄露路径；每一条「应放行」都对应一种误伤。
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { isSensitivePath, sensitiveReason } from "../src/util/sensitive";

const blocked = [
  ".env",
  ".env.local",
  ".env.production",
  "配置/.env",
  "部署/.env.bak",            // 点变体
  "部署/.env.key",
  ".netrc",
  ".npmrc",
  ".git-credentials",
  "id_rsa",
  "备份/id_ed25519",
  "id_ecdsa.bak",
  "服务器/credentials",
  "服务器/credentials.json",
  "服务器/credentials.json.old",
  "secrets.json",
  "证书/server.pem",
  "证书/server.key",
  "证书/client.p12",
  "安卓/release.keystore",
  "安卓/release.jks",
  "密码库/pass.kdbx",
  ".ssh/config",
  ".aws/credentials",
  ".gnupg/secring",
  ".kube/config",
];

const allowed = [
  "读书/置身事内.md",
  "日记/2024-03-01.md",
  "读书/书单.md",
  ".env.example",
  ".env.sample",
  ".env.template",
  "配置/.env.example",
  "id_rsa.pub",             // 公钥
  "备份/id_ed25519.pub",
  "notes/2024.env.md",      // 文件名里带 env 但不是 .env 文件
  "我的笔记/密钥管理.md",     // 中文标题
  "attachments/图 1.png",
  "index.canvas",
  "📋 任务看板.md",            // emoji 文件名（真实 vault 里的）
  "日记/🔁 循环任务库.md",
  "未命名.base",
];

test("应拦截：密钥 / 凭据 / 私钥 / 点变体", () => {
  for (const p of blocked) {
    assert.equal(isSensitivePath(p), true, `应拦截但放行了：${p}`);
    assert.notEqual(sensitiveReason(p), null, `缺少理由：${p}`);
  }
});

test("应放行：普通笔记、模板、公钥", () => {
  for (const p of allowed) {
    assert.equal(isSensitivePath(p), false, `误伤：${p}（理由：${sensitiveReason(p)}）`);
  }
});

test("理由是人话，能直接给用户看", () => {
  assert.match(String(sensitiveReason(".env")), /密钥|凭据/);
  assert.match(String(sensitiveReason(".ssh/config")), /\.ssh/);
});

test("大小写不敏感", () => {
  assert.equal(isSensitivePath(".ENV"), true);
  assert.equal(isSensitivePath("ID_RSA"), true);
  assert.equal(isSensitivePath("Server.PEM"), true);
});

test("反斜杠路径同样识别", () => {
  assert.equal(isSensitivePath("备份\\id_rsa"), true);
  assert.equal(isSensitivePath("备份\\读书清单.md"), false);
});

test("两层伪装后缀也能剥掉", () => {
  assert.equal(isSensitivePath("id_rsa.old.bak"), true);
  assert.equal(isSensitivePath("credentials.json.orig.tmp"), true);
});
