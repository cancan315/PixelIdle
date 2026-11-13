#!/bin/bash
# ============================================================
# 发布新版本：自动递增版本号 → 打包 fpk → 打 git tag
#
#   用法：./scripts/release.sh [patch|minor|major] ["更新说明"]
#   默认：patch   例：1.0.1 -> 1.0.2
#
# 关键点：版本号必须递增，应用中心才会走「升级」而不是要求先卸载。
# ============================================================
set -u

cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
BUMP="${1:-patch}"
NOTE="${2:-}"

MANIFEST="${ROOT}/manifest"
[ -f "$MANIFEST" ] || { echo "找不到 manifest"; exit 1; }

CUR="$(grep -E '^\s*version\s*=' "$MANIFEST" | head -1 | sed 's/.*=\s*//' | tr -d '[:space:]')"
[ -n "$CUR" ] || { echo "无法读取当前版本"; exit 1; }

IFS='.' read -r MAJ MIN PAT <<< "$CUR"
MAJ="${MAJ:-0}"; MIN="${MIN:-0}"; PAT="${PAT:-0}"

case "$BUMP" in
  major) MAJ=$((MAJ + 1)); MIN=0; PAT=0 ;;
  minor) MIN=$((MIN + 1)); PAT=0 ;;
  patch|*) PAT=$((PAT + 1)) ;;
esac

NEW="${MAJ}.${MIN}.${PAT}"
echo "版本: ${CUR} -> ${NEW}"

# 更新 manifest
python3 - "$MANIFEST" "$NEW" "$NOTE" <<'PY'
import re, sys
path, new, note = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path, encoding='utf-8').read()
s = re.sub(r'^(\s*version\s*=\s*).*$', lambda m: m.group(1) + new, s, count=1, flags=re.M)
if note:
    if re.search(r'^\s*changelog\s*=', s, flags=re.M):
        s = re.sub(r'^(\s*changelog\s*=\s*).*$', lambda m: m.group(1) + note, s, count=1, flags=re.M)
    else:
        s = s.rstrip('\n') + '\n\nchangelog = ' + note + '\n'
open(path, 'w', encoding='utf-8').write(s)
print('manifest 已更新')
PY

# 内联前端：src/ -> app/www/index.html
echo "内联前端…"
node "${ROOT}/scripts/build-web.js" || { echo "前端构建失败"; exit 1; }

# 统一权限（避免再次出现 600/711 这类问题）
chmod 755 app/server/server.js cmd/* scripts/*.sh 2>/dev/null
chmod 644 app/www/* manifest app/ui/config app/ui/images/*.png ICON*.PNG \
         app/server/server.js config/privilege config/resource README.md 2>/dev/null
chmod 755 app app/ui app/www app/ui/images app/server config cmd wizard scripts 2>/dev/null

# 打包
echo "打包中…"
if [ -x "${ROOT}/../tools/fnpack" ]; then
  FNPACK="${ROOT}/../tools/fnpack"
elif command -v fnpack >/dev/null 2>&1; then
  FNPACK="fnpack"
else
  echo "找不到 fnpack"; exit 1
fi

rm -f "${ROOT}/PixelIdle.fpk"
( cd "$ROOT" && "$FNPACK" build ) || { echo "打包失败"; exit 1; }

echo "产物: ${ROOT}/PixelIdle.fpk"

# git 提交与打标签
if [ -d "${ROOT}/.git" ]; then
  git -C "$ROOT" add -A
  git -C "$ROOT" commit -m "release: v${NEW}${NOTE:+ - ${NOTE}}" >/dev/null 2>&1 || true
  git -C "$ROOT" tag -f "v${NEW}" >/dev/null 2>&1 || true
  echo "已提交并打标签 v${NEW}"
fi

echo
echo "下一步：在飞牛应用中心直接安装 PixelIdle.fpk（版本 ${NEW}），"
echo "       版本号大于已安装的 ${CUR} 时应走升级流程，无需先卸载。"
