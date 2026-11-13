#!/bin/bash
# ============================================================
# 把当前源码同步到「已安装」的应用目录，实现免打包热更新
#
#   用法：sudo ./scripts/sync.sh
#
# 需要 root（已安装目录属主是 PixelIdle 用户）。
# 前端改动：同步后刷新浏览器即可
# 后端改动：需要重启应用（脚本会自动重启服务）
# ============================================================
set -eu

cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
DEST="/vol1/@appcenter/PixelIdle"

[ "$(id -u)" -eq 0 ] || { echo "需要 root 权限：sudo ./scripts/sync.sh"; exit 1; }
[ -d "$DEST" ] || { echo "未找到已安装目录 $DEST"; exit 1; }

echo "构建前端…"
node "${ROOT}/scripts/build-web.js"

echo "同步到 ${DEST} …"
rsync -a --delete \
  --chown=PixelIdle:PixelIdle \
  --exclude 'app.sock' \
  --exclude 'data' \
  "${ROOT}/app/www/" "${DEST}/www/" 
rsync -a --chown=PixelIdle:PixelIdle "${ROOT}/app/server/" "${DEST}/server/"

chmod 644 "${DEST}/www/"* 2>/dev/null || true
chmod 755 "${DEST}/server/server.js" 2>/dev/null || true

# 重启服务，让后端改动生效
if [ -x /var/apps/PixelIdle/cmd/main ]; then
  echo "重启服务…"
  /var/apps/PixelIdle/cmd/main stop >/dev/null 2>&1 || true
  sleep 1
  /var/apps/PixelIdle/cmd/main start >/dev/null 2>&1 || true
  sleep 1
fi

echo "完成。刷新浏览器页面即可看到最新版本。"
