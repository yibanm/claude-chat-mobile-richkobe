#!/usr/bin/env bash
# wait-and-fetch.sh —— 等 GitHub Actions 构建完成并把 APK 产物落到本地 dist-release/。
#
# 为什么需要它：CLAUDE.md 0.11 要求「云端构建产物必须回落到本地项目目录，并用蓝字报告路径
# 供用户测试」，禁止只给 Actions 链接或把产物留在云端。
#
# 两处按已有教训做的防护：
#   · artifact zip 下载可能**静默截断**（HTTP 200、退出码 0，但文件不完整）——全局经验记过。
#     故下载后校验 zip 的 EOCD 尾签名（PK\x05\x06），并用 unzip -t 实测完整性，不只看退出码。
#   · fork 仓库的 push 触发在本次实测是**可用**的（run 已 in_progress），故不必退回 dispatch；
#     但若查不到 run，脚本会明确说明而不是静默等待。

set -u

OWNER="yibanm"
REPO="claude-chat-mobile-richkobe"
BRANCH="android"
PROJ="D:/文档/Claude/Code/30.ClaudeChatMobileRichkobe"
OUT="$PROJ/dist-release"
API="https://api.github.com/repos/$OWNER/$REPO"
TOKEN_FILE="D:/1Tools/keys/github-token.txt"

GH_PAT="$(tr -d '\r\n' < "$TOKEN_FILE")"
[ -n "$GH_PAT" ] || { echo "✘ 读不到 token"; exit 1; }

hdr=(-H "Authorization: token $GH_PAT" -H "Accept: application/vnd.github+json")

# ── 1. 找到本分支最新那次 run ────────────────────────────────────
RUN_JSON=$(curl -s "${hdr[@]}" "$API/actions/runs?branch=$BRANCH&per_page=1")
RUN_ID=$(echo "$RUN_JSON" | grep -oE '"id": [0-9]+' | head -1 | grep -oE '[0-9]+')
[ -n "$RUN_ID" ] || { echo "✘ 查不到 $BRANCH 分支的 run（fork 的 push 未触发？）"; exit 1; }
echo "run: $RUN_ID"

# ── 2. 轮询到终态 ────────────────────────────────────────────────
# 最多等 25 分钟（Android 构建含 Gradle 依赖下载，实测本机 5 分钟，CI 冷缓存更久）。
# 每 30 秒一次：再密也不会更快拿到结果，只会多打 API。
for i in $(seq 1 50); do
  J=$(curl -s "${hdr[@]}" "$API/actions/runs/$RUN_ID")
  STATUS=$(echo "$J" | grep -oE '"status": "[^"]*"' | head -1 | sed 's/.*: "//;s/"//')
  CONCL=$(echo "$J" | grep -oE '"conclusion": *("?[^",}]*"?)' | head -1 | sed 's/.*: *//;s/"//g')
  echo "[$i] status=$STATUS conclusion=${CONCL:-null}"
  case "$STATUS" in
    completed) break ;;
  esac
  sleep 30
done

if [ "$STATUS" != "completed" ]; then
  echo "✘ 超时未结束（status=$STATUS）；请人工查看 https://github.com/$OWNER/$REPO/actions/runs/$RUN_ID"
  exit 1
fi

if [ "$CONCL" != "success" ]; then
  echo "✘ 构建未成功：conclusion=$CONCL"
  echo "--- 失败 job 的日志摘要 ---"
  JOBS=$(curl -s "${hdr[@]}" "$API/actions/runs/$RUN_ID/jobs")
  echo "$JOBS" | grep -oE '"name": "[^"]*"|"conclusion": "[^"]*"' | head -20
  # 抓 annotation（workflow 里把 gradle 真错误提成 ::error:: 了，这里能直接看到）
  for jid in $(echo "$JOBS" | grep -oE '"id": [0-9]+' | grep -oE '[0-9]+'); do
    curl -s "${hdr[@]}" "$API/check-runs/$jid/annotations" | grep -oE '"message": "[^"]{0,400}"' | head -10
  done
  exit 1
fi

echo "✓ 构建成功"

# ── 3. 取 artifact 并下载 ────────────────────────────────────────
ART_JSON=$(curl -s "${hdr[@]}" "$API/actions/runs/$RUN_ID/artifacts")
ART_ID=$(echo "$ART_JSON" | grep -oE '"id": [0-9]+' | head -1 | grep -oE '[0-9]+')
ART_NAME=$(echo "$ART_JSON" | grep -oE '"name": "[^"]*"' | head -1 | sed 's/.*: "//;s/"//')
ART_SIZE=$(echo "$ART_JSON" | grep -oE '"size_in_bytes": [0-9]+' | head -1 | grep -oE '[0-9]+$')
[ -n "$ART_ID" ] || { echo "✘ 该 run 没有 artifact"; exit 1; }
echo "artifact: $ART_NAME (id=$ART_ID, ${ART_SIZE:-?} bytes)"

mkdir -p "$OUT"
TMPZIP="$OUT/.artifact-$RUN_ID.zip"
curl -sL "${hdr[@]}" "$API/actions/artifacts/$ART_ID/zip" -o "$TMPZIP"

# ── 4. 完整性校验（不只看退出码）────────────────────────────────
# EOCD 尾签名 PK\x05\x06 必须存在，否则 zip 被截断（下载中断也会 HTTP 200）。
if ! tail -c 4096 "$TMPZIP" | grep -q $'PK\x05\x06'; then
  echo "✘ zip 缺 EOCD 尾签名 —— 下载被截断，产物不可用"
  ls -la "$TMPZIP"
  exit 1
fi
if ! unzip -t "$TMPZIP" > /dev/null 2>&1; then
  echo "✘ unzip -t 校验失败 —— zip 损坏"
  exit 1
fi
DL=$(stat -c%s "$TMPZIP")
echo "✓ zip 完整（EOCD + unzip -t 双校验，$DL bytes；API 声明 ${ART_SIZE:-?}）"
if [ -n "${ART_SIZE:-}" ] && [ "$DL" -lt "$ART_SIZE" ]; then
  echo "⚠️ 下载体积小于 API 声明值（$DL < $ART_SIZE）—— 按截断处理"
  exit 1
fi

# ── 5. 解出 APK 并按规范命名 ─────────────────────────────────────
EXDIR="$OUT/.extract-$RUN_ID"
rm -rf "$EXDIR"; mkdir -p "$EXDIR"
unzip -q "$TMPZIP" -d "$EXDIR"
APK=$(find "$EXDIR" -name "*.apk" | head -1)
[ -n "$APK" ] || { echo "✘ artifact 里没有 APK"; find "$EXDIR" -type f | head; exit 1; }

# 版本号取自 APK 自身（aapt 读 badging），不靠猜文件名——文件名由 CI 生成，
# 万一 CI 的改名步骤失效，这里仍能拿到真实版本。
AAPT=$(ls "/c/Users/richkobe/AppData/Local/Android/Sdk"/build-tools/*/aapt.exe 2>/dev/null | sort -V | tail -1)
VER=""
if [ -n "$AAPT" ]; then
  VER=$("$AAPT" dump badging "$APK" 2>/dev/null | grep -oE "versionName='[^']+'" | head -1 | sed "s/versionName='//;s/'//")
fi
[ -n "$VER" ] || VER="1.0.0"
FINAL="$OUT/claude-chat-mobile-richkobe-${VER}-android-arm64.apk"
mv "$APK" "$FINAL"
rm -rf "$EXDIR" "$TMPZIP"

echo ""
echo "✓ 产物已落地：$FINAL"
echo "  大小：$(stat -c%s "$FINAL" | awk '{printf "%.2f MB", $1/1048576}')"
echo "  run：https://github.com/$OWNER/$REPO/actions/runs/$RUN_ID"
