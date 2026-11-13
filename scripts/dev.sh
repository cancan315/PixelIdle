#!/bin/bash
# ============================================================
# 开发服务器（热更新，无需打包/安装）
#
#   用法：./scripts/dev.sh [端口]
#
# 特点：
#   - 直接读工作区源码，改完刷新浏览器即生效
#   - 监听 0.0.0.0，可在家里的电脑浏览器访问
#   - 存档写在临时目录，不污染正式应用数据
# ============================================================
set -u

cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"

PORT="${1:-8899}"
DEV_DATA="${ROOT}/.devdata"
NODE_BIN="/var/apps/nodejs_v22/target/bin/node"
[ -x "$NODE_BIN" ] || NODE_BIN="$(command -v node)"

mkdir -p "$DEV_DATA"

# 停止已在运行的开发服务
if [ -f "${DEV_DATA}/dev.pid" ]; then
  OLD="$(head -n1 "${DEV_DATA}/dev.pid" 2>/dev/null | tr -d '[:space:]')"
  if [ -n "$OLD" ] && kill -0 "$OLD" 2>/dev/null; then
    kill -TERM "$OLD" 2>/dev/null
    sleep 0.4
  fi
  rm -f "${DEV_DATA}/dev.pid"
fi

# 取局域网 IP 用于提示
LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "${LAN_IP:-}" ] || LAN_IP="<本机IP>"

echo "启动开发服务器…"
echo "  源码目录: ${ROOT}/src"
echo "            （直接服务 src/，改完刷新浏览器即可，无需打包）"
echo "  本机访问: http://127.0.0.1:${PORT}/app/PixelIdle/"
echo "  局域网  : http://${LAN_IP}:${PORT}/app/PixelIdle/"
echo "  版本信息: http://${LAN_IP}:${PORT}/app/PixelIdle/api/version"
echo

TRIM_APPDEST="${ROOT}/app" \
TRIM_PKGVAR="${DEV_DATA}" \
TRIM_APPVER="dev" \
WWW_DIR="${ROOT}/src" \
PORT="$PORT" \
HOST="0.0.0.0" \
GATEWAY_PREFIX="/app/PixelIdle" \
"$NODE_BIN" "${ROOT}/app/server/server.js" > "${DEV_DATA}/dev.log" 2>&1 &

echo $! > "${DEV_DATA}/dev.pid"
sleep 1.2

if kill -0 "$(cat "${DEV_DATA}/dev.pid")" 2>/dev/null; then
  echo "已启动（PID $(cat "${DEV_DATA}/dev.pid")）"
  echo "日志: ${DEV_DATA}/dev.log"
  echo
  echo "修改 src/index.html 或 src/game.js 后刷新浏览器即可看到效果，无需重新打包。"
else
  echo "启动失败，日志如下："
  cat "${DEV_DATA}/dev.log"
  exit 1
fi
