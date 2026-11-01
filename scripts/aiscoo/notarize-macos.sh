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
#   AISCOO_DMG_TEMPLATE    作为安装盘布局模板的 DMG（含背景图、图标位置、卷图标）。默认取 electron-builder
#                          在 mac-arm64 同级输出的 DMG；找不到时退化为无背景图的简易 DMG
#   AISCOO_NOTARY_TIMEOUT_MIN  最长等待分钟数，默认 180；超时不等于失败，提交仍在 Apple 处理
#   AISCOO_NOTARY_SUBMISSION_ID  已有提交的 id；设置后跳过提交，只继续等待并 staple
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
MNT=""; RW=""
cleanup() {
  rm -f "$MACHO_LIST"
  # 中途失败时不能留下挂载着的可写卷。按镜像文件找挂载点，避免 /var 与 /private/var 的路径写法差异。
  if [ -n "$RW" ] && hdiutil info 2>/dev/null | grep -qF "$RW"; then
    hdiutil detach -force "$MNT" -quiet >/dev/null 2>&1 || true
    # 仍未卸载时按设备再试一次
    dev="$(hdiutil info 2>/dev/null | awk -v img="$RW" '$1=="image-path" && index($0,img){f=1} f && /^\/dev\/disk[0-9]+[ \t]/{print $1; exit}')"
    [ -z "$dev" ] || hdiutil detach -force "$dev" -quiet >/dev/null 2>&1 || true
  fi
  rm -rf "$STAGE"
}
trap cleanup EXIT
# 模板：electron-builder 产出的 DMG 带有产品设计的背景图、图标位置（.DS_Store，按文件名记录）和安装专用卷图标。
# 只把里面的 ad-hoc 签名 app 换成已签名的 app，布局原样保留；同名替换不改变 .DS_Store。
TEMPLATE="${AISCOO_DMG_TEMPLATE:-$(dirname "$APP")/../$DMG_NAME}"
if [ -f "$TEMPLATE" ]; then
  TEMPLATE="$(cd "$(dirname "$TEMPLATE")" && pwd)/$(basename "$TEMPLATE")"
  log "  以模板 DMG 保留安装盘布局：${TEMPLATE}"
  RW="$STAGE/rw.dmg"; MNT="$STAGE/mnt"; mkdir -p "$MNT"
  hdiutil convert "$TEMPLATE" -format UDRW -quiet -o "$RW"
  # 模板卷是按当时内容定容的，换入签名后的 app 前先扩容，否则复制到一半会 "No space left"。
  # 预留量取 app 体积的 1.25 倍加 512MB，既放得下，又不会让最终压缩镜像变大（空闲块会被压缩掉）。
  APP_KB="$(du -sk "$APP" | awk '{print $1}')"
  NEED_MB=$(( APP_KB / 1024 * 125 / 100 + 512 ))
  hdiutil resize -size "${NEED_MB}m" "$RW" >/dev/null || die "无法给可写镜像扩容到 ${NEED_MB}MB"
  hdiutil attach "$RW" -nobrowse -noautoopen -noverify -quiet -mountpoint "$MNT" >/dev/null
  [ -d "$MNT/$APP_NAME.app" ] || die "模板 DMG 里没有 ${APP_NAME}.app，无法按名替换（模板：${TEMPLATE}）"
  for f in .DS_Store .background.tiff .VolumeIcon.icns; do
    [ -e "$MNT/$f" ] || log "  警告：模板缺少 ${f}，安装盘布局可能不完整"
  done
  rm -rf "$MNT/$APP_NAME.app"
  ditto "$APP" "$MNT/$APP_NAME.app"
  # 挂载时系统自动生成的索引/事件目录不属于安装盘内容
  rm -rf "$MNT/.fseventsd" "$MNT/.Spotlight-V100" "$MNT/.Trashes" "$MNT/.TemporaryItems" 2>/dev/null || true
  hdiutil detach "$MNT" -quiet
  hdiutil convert "$RW" -format UDZO -imagekey zlib-level=9 -quiet -o "$OUT_DIR/$DMG_NAME"
else
  log "  未找到 DMG 模板（可用 AISCOO_DMG_TEMPLATE 指定），生成无背景图的简易 DMG"
  ditto "$APP" "$STAGE/$APP_NAME.app"
  ln -s /Applications "$STAGE/Applications"
  hdiutil create -quiet -volname "$APP_NAME $VERSION" -srcfolder "$STAGE" -fs HFS+ -format UDZO -ov "$OUT_DIR/$DMG_NAME"
fi
codesign --force --keychain "$KEYCHAIN" --sign "$IDENTITY" --timestamp "$OUT_DIR/$DMG_NAME" >/dev/null
codesign --verify --verbose=2 "$OUT_DIR/$DMG_NAME" 2>&1 | tail -1

if [ "$DO_NOTARIZE" -eq 0 ]; then
  log "已按要求跳过公证（--no-notarize）。产物：${OUT_DIR}/${DMG_NAME}"
  exit 0
fi

log "步骤 5/6：提交 Apple 公证并轮询结果"
# 提交与等待分开：notarytool 的 --wait/--timeout 到期只是本地停止等待，Apple 仍在处理，
# 不能把“等待超时”当成“公证失败”。新开发者账号的首次提交可能排队数十分钟甚至更久。
RESULT_JSON="$OUT_DIR/notary-result.json"
SUBMIT_JSON="$OUT_DIR/notary-submit.json"
NOTARY_TIMEOUT_MIN="${AISCOO_NOTARY_TIMEOUT_MIN:-180}"
NOTARY_POLL_SEC="${AISCOO_NOTARY_POLL_SEC:-30}"
json_field() { python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get(sys.argv[2],""))' "$1" "$2"; }
if [ -n "${AISCOO_NOTARY_SUBMISSION_ID:-}" ]; then
  SUB_ID="$AISCOO_NOTARY_SUBMISSION_ID"
  log "  复用已有提交 ${SUB_ID}（不重复提交）"
else
  xcrun notarytool submit "$OUT_DIR/$DMG_NAME" --keychain-profile "$PROFILE" --keychain "$KEYCHAIN" --output-format json > "$SUBMIT_JSON"
  SUB_ID="$(json_field "$SUBMIT_JSON" id)"
  [ -n "$SUB_ID" ] || die "提交公证失败，未拿到 submission id；见 ${SUBMIT_JSON}"
  log "  已提交：${SUB_ID}（可用 AISCOO_NOTARY_SUBMISSION_ID 在中断后继续等待）"
fi
STATUS=""; waited=0
while :; do
  if xcrun notarytool info "$SUB_ID" --keychain-profile "$PROFILE" --keychain "$KEYCHAIN" --output-format json > "$RESULT_JSON" 2>/dev/null; then
    STATUS="$(json_field "$RESULT_JSON" status)"
  else
    STATUS="(查询失败，稍后重试)"
  fi
  case "$STATUS" in
    Accepted|Invalid|Rejected) break ;;
  esac
  if [ $((waited / 60)) -ge "$NOTARY_TIMEOUT_MIN" ]; then
    die "等待超过 ${NOTARY_TIMEOUT_MIN} 分钟，Apple 仍未给出结论（状态：${STATUS}）。提交仍在 Apple 处理，不是失败；稍后用 AISCOO_NOTARY_SUBMISSION_ID=${SUB_ID} 重新运行即可继续。"
  fi
  [ $((waited % 300)) -eq 0 ] && log "  状态：${STATUS}，已等待 $((waited / 60)) 分钟"
  sleep "$NOTARY_POLL_SEC"; waited=$((waited + NOTARY_POLL_SEC))
done
log "  公证状态：${STATUS}（submission ${SUB_ID}）"
if [ "$STATUS" != "Accepted" ]; then
  xcrun notarytool log "$SUB_ID" --keychain-profile "$PROFILE" --keychain "$KEYCHAIN" "$OUT_DIR/notary-log.json" >/dev/null 2>&1 || true
  die "公证未通过；详情见 ${OUT_DIR}/notary-log.json"
fi

log "步骤 6/6：staple 并做最终验收"
xcrun stapler staple "$OUT_DIR/$DMG_NAME" >/dev/null
xcrun stapler validate "$OUT_DIR/$DMG_NAME" 2>&1 | tail -1
spctl -a -t open --context context:primary-signature -vv "$OUT_DIR/$DMG_NAME" 2>&1 | head -3
log "完成：${OUT_DIR}/${DMG_NAME}"
