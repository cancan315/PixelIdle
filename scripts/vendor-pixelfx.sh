#!/bin/bash
# ============================================================
# 重新拉取 vendor/pixelfx 里被引用的上游文件，并校验一致性
#
#   用法：./scripts/vendor-pixelfx.sh [仓库路径或 git URL]
#
# 默认从本地已有克隆读取；也可以在第一次使用时传入 git URL，
# 脚本会克隆到临时目录后复制。
#
# 关键点：除 core/index.js 之外，所有 vendor 文件都应和上游逐字节一致。
# 这个脚本会逐文件 cmp，任何差异都会报出来——包括你自己不小心改到的。
# ============================================================
set -eu

cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
DEST="${ROOT}/vendor/pixelfx"

SRC="${1:-/vol1/@appshare/fn-deepseek-harness/dsh/pixelfx-ref}"
TMP=""

cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT

# 传入的是 git URL / 非本地目录时，先克隆
if [ ! -d "$SRC/src/core" ]; then
  case "$SRC" in
    http*|git@*|git://*)
      TMP="$(mktemp -d)"
      echo "克隆 $SRC …"
      git clone --depth 1 "$SRC" "${TMP}/pixelfx" >/dev/null 2>&1 || { echo "克隆失败"; exit 1; }
      SRC="${TMP}/pixelfx"
      ;;
    *)
      echo "找不到上游仓库：$SRC"
      echo "用法：$0 [git URL 或本地 pixelfx 仓库路径]"
      exit 1
      ;;
  esac
fi

UPSTREAM_VERSION="$(grep -m1 '"version"' "${SRC}/package.json" 2>/dev/null | sed 's/.*: *"//; s/".*//')" || true
echo "上游：${SRC}"
echo "版本：${UPSTREAM_VERSION:-未知}"
echo

# 本项目实际引用的文件（core/index.js 除外，它是裁剪过的）
FILES=(
  "src/core/math.js"
  "src/core/color.js"
  "src/core/particles.js"
  "src/core/shapes.js"
  "src/core/sim.js"
  "src/core/painter.js"
  "src/core/font.js"
  "src/core/fx.js"
  "src/core/actor.js"
  "src/fx/impacts/hit-spark.js"
  "src/fx/impacts/_lib.js"
)

mkdir -p "${DEST}/core" "${DEST}/fx/impacts"

same=0; diff=0; copied=0
for f in "${FILES[@]}"; do
  case "$f" in
    src/core/*)     out="${DEST}/core/$(basename "$f")" ;;
    src/fx/*/*)     out="${DEST}/fx/impacts/$(basename "$f")" ;;
  esac
  [ -f "${SRC}/${f}" ] || { echo "  缺失于上游：$f"; diff=$((diff+1)); continue; }

  if [ -f "$out" ] && cmp -s "${SRC}/${f}" "$out"; then
    same=$((same+1))
  else
    if [ -f "$out" ]; then
      echo "  差异：$f  ->  $(basename "$out")"
      diff=$((diff+1))
    fi
    cp "${SRC}/${f}" "$out"
    copied=$((copied+1))
  fi
done
chmod 644 "${DEST}/core/"*.js "${DEST}/fx/impacts/"*.js 2>/dev/null || true

echo
echo "一致 $same 个，更新 $copied 个，差异 $diff 个"

# 裁剪版 index.js 的一致性提示：
# 已知被故意去掉的是这些模块，若上游多出别的新模块才需要人工跟进。
TRIMMED="act.js rig.js poses.js chain.js scene.js"

if [ -f "${SRC}/src/core/index.js" ]; then
  echo
  echo "检查裁剪版 core/index.js…"
  upstream_mods="$(grep -oE 'from "\./[^"]+"' "${SRC}/src/core/index.js" | sed 's|from "\./||; s|"||' | sort -u)"
  local_mods="$(grep -oE 'from "\./[^"]+"' "${DEST}/core/index.js" | sed 's|from "\./||; s|"||' | sort -u)"

  unexpected=""
  while IFS= read -r m; do
    [ -n "$m" ] || continue
    case " $TRIMMED " in *" $m "*) continue ;; esac
    printf '%s\n' "$local_mods" | grep -qxF "$m" || unexpected="${unexpected} ${m}"
  done <<< "$upstream_mods"

  if [ -n "$unexpected" ]; then
    echo "  ⚠ 上游新增了本项目未处理的模块：${unexpected}"
    echo "    若需要用，请在 ${DEST}/core/index.js 里补上对应 export"
  else
    echo "  OK：仅缺少有意裁剪的模块（${TRIMMED// /, }），无新增模块"
  fi
fi

echo
echo "接下来：node scripts/build-fx.js && node scripts/build-web.js"
