#!/usr/bin/env bash
# 构建并部署到指定 Vault 的插件目录。
#
# 用法：
#   ./deploy.sh /path/to/your/vault
#   VAULT=/path/to/vault ./deploy.sh
#
# 手机上开发时，Vault 通常通过 Syncthing 同步到电脑，
# 这里直接推到同步目录，手机上重载插件即可。

set -euo pipefail

VAULT="${1:-${VAULT:-}}"
if [[ -z "${VAULT}" ]]; then
  echo "用法: ./deploy.sh <vault路径>" >&2
  exit 1
fi
if [[ ! -d "${VAULT}" ]]; then
  echo "错误: Vault 目录不存在: ${VAULT}" >&2
  exit 1
fi

PLUGIN_ID="local-vault-agent"
DEST="${VAULT}/.obsidian/plugins/${PLUGIN_ID}"

echo "==> 构建"
npm run build

echo "==> 部署到 ${DEST}"
mkdir -p "${DEST}"
cp main.js manifest.json styles.css "${DEST}/"

echo "==> 完成"
echo "在 Obsidian 中执行：设置 → 第三方插件 → 关闭再开启 ${PLUGIN_ID}"
