#!/usr/bin/env bash
# Developer ID 签名 + 公证 + staple 一条龙：把 electron-builder 产出的 Aiscoo.app 做成可分发的 DMG。
#
# 为什么需要它：electron-builder 配置把 Resources/glm、Resources/tools 列入 signIgnore，约定由
# “打包前的预签名阶段”处理，但本仓库没有对应脚本；Apple 公证会拒绝任何未签名或缺少
# 安全时间戳的 Mach-O，所以在这里统一补齐，并且只用专用钥匙串，不污染用户登录钥匙串。
#
# 用法：
#   scripts/aiscoo/notarize-macos.sh <Aiscoo.app 路径> <输出目录> [--no-notarize]
# 环境变量（均有默认值，指向专用签名目录）：
#   AISCOO_SIGN_DIR        默认 $HOME/aiscoo-release-signing（含 aiscoo-signing.keychain-db 与 keychain.pass）
#   AISCOO_SIGN_IDENTITY   默认 "Developer ID Application: xi yu (5G9ZLJPH2B)"
#   AISCOO_NOTARY_PROFILE  默认 aiscoo-notary（notarytool 凭据 profile，存放在专用钥匙串）
#   AISCOO_ENTITLEMENTS    主 app 的 entitlements，默认取仓库内 packages/desktop/build/entitlements.mac.plist
set -euo pipefail
export LC_ALL=en_US.UTF-8

usage() { awk 'NR==1{next} /^set -/{exit} {sub(/^# ?/, ""); print}' "$0"; exit "${1:-2}"; }
[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && usage 0
[ $# -ge 2 ] || usage 2

APP="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
OUT_DIR="$2"
DO_NOTARIZE=1
[ "${3:-}" = "--no-notarize" ] && DO_NOTARIZE=0

SIGN_DIR="${AISCOO_SIGN_DIR:-$HOME/aiscoo-release-signing}"
KEYCHAIN="$SIGN_DIR/aiscoo-signing.keychain-db"
IDENTITY="${AISCOO_SIGN_IDENTITY:-Developer ID Application: xi yu (5G9ZLJPH2B)}"
PROFILE="${AISCOO_NOTARY_PROFILE:-aiscoo-notary}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ENTITLEMENTS="${AISCOO_ENTITLEMENTS:-$REPO_ROOT/packages/desktop/build/entitlements.mac.plist}"
ENTITLEMENTS_INHERIT="${AISCOO_ENTITLEMENTS_INHERIT:-$REPO_ROOT/packages/desktop/build/entitlements.mac.inherit.plist}"
# 本机 Xcode 许可证未接受时 xcrun 会失败；命令行工具自带 notarytool/stapler，足够使用。
if ! xcodebuild -license check >/dev/null 2>&1 && [ -d /Library/Developer/CommandLineTools ]; then
  export DEVELOPER_DIR=/Library/Developer/CommandLineTools
fi

log() { printf '[aiscoo-notarize] %s\n' "$*"; }
die() { printf '[aiscoo-notarize] ERROR: %s\n' "$*" >&2; exit 1; }

[ -d "$APP" ] || die "找不到 app：${APP}"
[ -f "$APP/Contents/Info.plist" ] || die "不是有效的 .app：${APP}"
[ -f "$KEYCHAIN" ] || die "找不到专用签名钥匙串：${KEYCHAIN}"
[ -f "$SIGN_DIR/keychain.pass" ] || die "找不到钥匙串口令文件：${SIGN_DIR}/keychain.pass"
[ -f "$ENTITLEMENTS" ] || die "找不到 entitlements：${ENTITLEMENTS}"
[ -f "$ENTITLEMENTS_INHERIT" ] || die "找不到 entitlements(inherit)：${ENTITLEMENTS_INHERIT}"

APP_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$APP/Contents/Info.plist" 2>/dev/null)" || die "无法读取 Info.plist：${APP}/Contents/Info.plist"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
EXEC="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
ARCH="$(lipo -archs "$APP/Contents/MacOS/$EXEC")"
[ "$ARCH" = "arm64" ] || die "本脚本只处理 Apple 芯片包，实际架构：${ARCH}"
DMG_NAME="${APP_NAME}-${VERSION}-mac-arm64.dmg"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
[ ! -e "$OUT_DIR/$DMG_NAME" ] || die "输出文件已存在，拒绝覆盖：${OUT_DIR}/${DMG_NAME}（同版本重打包请换新输出目录）"

security unlock-keychain -p "$(cat "$SIGN_DIR/keychain.pass")" "$KEYCHAIN"
security find-identity -v -p codesigning "$KEYCHAIN" | grep -F "$IDENTITY" >/dev/null || die "专用钥匙串里没有签名身份：${IDENTITY}"

SIGN_ARGS=(--force --keychain "$KEYCHAIN" --sign "$IDENTITY" --options runtime --timestamp)

is_macho() { file -b "$1" 2>/dev/null | grep -q 'Mach-O'; }

log "app=$APP_NAME version=$VERSION arch=$ARCH"
log "步骤 1/6：签名所有嵌套的 Mach-O（由内向外；electron-builder 已按配置跳过 glm/ tools/）"
# 先签最深层的可执行文件与库；.app / .framework 这类 bundle 留到后面按层级签。
MACHO_LIST="$(mktemp)"
trap 'rm -f "$MACHO_LIST"' EXIT
find "$APP/Contents" -type f ! -path '*/Contents/MacOS/*' -print0 \
  | while IFS= read -r -d '' f; do
      if is_macho "$f"; then printf '%s\0' "$f"; fi
    done > "$MACHO_LIST"
# 路径深的先签：按目录深度从大到小。不用管道内的 while，改为先排序落盘再读，
# 这样循环里任何一次 codesign 失败都会直接让脚本退出，而不是被子 shell 吞掉。
SORTED_LIST="$(mktemp)"
tr '\0' '\n' < "$MACHO_LIST" | awk -F/ '{print NF"\t"$0}' | sort -rn | cut -f2- > "$SORTED_LIST"
signed=0; skipped=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  # 已被 electron-builder 以同一身份签过且带时间戳的文件无需重签；其余一律重签。
  info="$(codesign -dvv "$f" 2>&1 || true)"
  if codesign --verify "$f" >/dev/null 2>&1 && grep -q "Authority=$IDENTITY" <<<"$info" && grep -q '^Timestamp=' <<<"$info"; then
    skipped=$((skipped + 1))
    continue
  fi
  case "$f" in
    */Contents/Resources/glm/*|*/Contents/Resources/tools/*|*/Contents/Resources/macos-window-bounds/*|*/app.asar.unpacked/*)
      # 辅助可执行文件与原生模块使用继承 entitlements，与主程序的运行时放宽保持一致。
      codesign "${SIGN_ARGS[@]}" --entitlements "$ENTITLEMENTS_INHERIT" "$f" >/dev/null 2>&1 \
        || codesign "${SIGN_ARGS[@]}" "$f" >/dev/null
      ;;
    *)
      codesign "${SIGN_ARGS[@]}" "$f" >/dev/null
      ;;
  esac
  signed=$((signed + 1))
done < "$SORTED_LIST"
rm -f "$SORTED_LIST"
log "  嵌套 Mach-O：新签 $signed 个，已由 electron-builder 正确签名 $skipped 个"

log "步骤 2/6：签名 Frameworks 与 Helper 应用"
while IFS= read -r -d '' b; do
  if [[ "$b" == *.app ]]; then
    codesign "${SIGN_ARGS[@]}" --entitlements "$ENTITLEMENTS_INHERIT" "$b" >/dev/null
  else
    codesign "${SIGN_ARGS[@]}" "$b" >/dev/null
  fi
done < <(find "$APP/Contents/Frameworks" -maxdepth 1 \( -name '*.framework' -o -name '*.app' \) -print0)

log "步骤 3/6：签名主 app（hardened runtime + 安全时间戳 + entitlements）"
codesign "${SIGN_ARGS[@]}" --entitlements "$ENTITLEMENTS" "$APP" >/dev/null
codesign --verify --deep --strict --verbose=2 "$APP" 2>&1 | tail -2
log "  主 app 签名身份：$(codesign -dvv "$APP" 2>&1 | grep -E '^Authority=Developer ID Application' | head -1)"

log "步骤 4/6：制作 DMG 并签名"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/aiscoo-dmg.XXXXXX")"
trap 'rm -f "$MACHO_LIST"; rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/$APP_NAME.app"
ln -s /Applications "$STAGE/Applications"
hdiutil create -quiet -volname "$APP_NAME $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$OUT_DIR/$DMG_NAME"
codesign --force --keychain "$KEYCHAIN" --sign "$IDENTITY" --timestamp "$OUT_DIR/$DMG_NAME" >/dev/null
codesign --verify --verbose=2 "$OUT_DIR/$DMG_NAME" 2>&1 | tail -1

if [ "$DO_NOTARIZE" -eq 0 ]; then
  log "已按要求跳过公证（--no-notarize）。产物：${OUT_DIR}/${DMG_NAME}"
  exit 0
fi

log "步骤 5/6：提交 Apple 公证并等待结果（通常数分钟）"
RESULT_JSON="$OUT_DIR/notary-result.json"
xcrun notarytool submit "$OUT_DIR/$DMG_NAME" --keychain-profile "$PROFILE" --keychain "$KEYCHAIN" --wait --output-format json > "$RESULT_JSON"
STATUS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status",""))' "$RESULT_JSON")"
SUB_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("id",""))' "$RESULT_JSON")"
log "  公证状态：$STATUS（submission $SUB_ID）"
if [ "$STATUS" != "Accepted" ]; then
  xcrun notarytool log "$SUB_ID" --keychain-profile "$PROFILE" --keychain "$KEYCHAIN" "$OUT_DIR/notary-log.json" >/dev/null 2>&1 || true
  die "公证未通过；详情见 ${OUT_DIR}/notary-log.json"
fi

log "步骤 6/6：staple 并做最终验收"
xcrun stapler staple "$OUT_DIR/$DMG_NAME" >/dev/null
xcrun stapler validate "$OUT_DIR/$DMG_NAME" 2>&1 | tail -1
spctl -a -t open --context context:primary-signature -vv "$OUT_DIR/$DMG_NAME" 2>&1 | head -3
log "完成：${OUT_DIR}/${DMG_NAME}"
