#!/usr/bin/env bash
# 从“已 Developer ID 签名、已随 DMG 公证”的 Aiscoo.app 生成应用内更新所需的 zip 与 latest-mac.yml。
# 规则见 docs/aiscoo/specs/aiscoo-auto-update.md 第 5 节。
#
# 为什么需要它：notarize-macos.sh 原地重签 .app 后只产出 DMG；electron-builder 先前生成的
# zip、blockmap 与 latest-mac.yml 对应重签前的 ad-hoc app，sha512/size 全部作废。Squirrel.Mac
# 只能安装与已装 app 同一 Developer ID 团队签名的 zip，所以必须从最终签名的 .app 重新打包。
#
# 用法：
#   scripts/aiscoo/build-macos-update-feed.sh <Aiscoo.app 路径> <输出目录> <更新说明目录>
# 更新说明目录内放 zh-CN.md 与/或 en-US.md（Markdown），会写进 releaseNotesByLocale。
# 环境变量（与 notarize-macos.sh 共用默认值；只有 app 本体无法 staple 时才会提交公证）：
#   AISCOO_SIGN_DIR、AISCOO_NOTARY_PROFILE、AISCOO_NOTARY_TIMEOUT_MIN
#   AISCOO_UPDATE_RELEASE_DATE  RFC 3339 发布时间，默认当前 UTC 时间
set -euo pipefail
export LC_ALL=en_US.UTF-8

usage() { awk 'NR==1{next} /^set -/{exit} {sub(/^# ?/, ""); print}' "$0"; exit "${1:-2}"; }
[ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ] && usage 0
[ $# -eq 3 ] || usage 2

[ -d "$1" ] || { printf '[aiscoo-update-feed] ERROR: 找不到 app：%s\n' "$1" >&2; exit 1; }
APP="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
OUT_DIR="$2"
NOTES_DIR="$3"
SIGN_DIR="${AISCOO_SIGN_DIR:-$HOME/aiscoo-release-signing}"
KEYCHAIN="$SIGN_DIR/aiscoo-signing.keychain-db"
PROFILE="${AISCOO_NOTARY_PROFILE:-aiscoo-notary}"
NOTARY_TIMEOUT_MIN="${AISCOO_NOTARY_TIMEOUT_MIN:-180}"
# Darwin 22 = macOS 13，与 packages/desktop/scripts/macos-update-manifest.mjs 保持一致。
MINIMUM_DARWIN_VERSION="22.0.0"
# 本机 Xcode 许可证未接受时 xcrun 会失败；命令行工具自带 notarytool/stapler，足够使用。
if ! xcodebuild -license check >/dev/null 2>&1 && [ -d /Library/Developer/CommandLineTools ]; then
  export DEVELOPER_DIR=/Library/Developer/CommandLineTools
fi

log() { printf '[aiscoo-update-feed] %s\n' "$*"; }
die() { printf '[aiscoo-update-feed] ERROR: %s\n' "$*" >&2; exit 1; }

[ -f "$APP/Contents/Info.plist" ] || die "不是有效的 .app：${APP}"
[ -d "$NOTES_DIR" ] || die "找不到更新说明目录：${NOTES_DIR}"
APP_NAME="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleName' "$APP/Contents/Info.plist")"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist")"
EXEC="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
[ "$(lipo -archs "$APP/Contents/MacOS/$EXEC")" = "arm64" ] || die "本脚本只处理 Apple 芯片包"
ZIP_NAME="${APP_NAME}-${VERSION}-mac-arm64.zip"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"
[ ! -e "$OUT_DIR/$ZIP_NAME" ] || die "输出文件已存在，拒绝覆盖：${OUT_DIR}/${ZIP_NAME}（同版本换包必须发新版本）"
[ ! -e "$OUT_DIR/latest-mac.yml" ] || die "输出文件已存在，拒绝覆盖：${OUT_DIR}/latest-mac.yml"

log "步骤 1/4：确认 app 已 Developer ID 签名（ad-hoc 包无法被已安装的正式包升级）"
codesign --verify --deep --strict "$APP" >/dev/null 2>&1 || die "app 签名校验失败：${APP}"
codesign -dvv "$APP" 2>&1 | grep -q '^Authority=Developer ID Application' \
  || die "app 不是 Developer ID 签名（请先运行 notarize-macos.sh）"
TEAM_ID="$(codesign -dvv "$APP" 2>&1 | sed -n 's/^TeamIdentifier=//p')"
log "  app=${APP_NAME} version=${VERSION} team=${TEAM_ID}"

log "步骤 2/4：给 app 本体 staple 公证票据"
# 已随 DMG 公证的 app 在 Apple 侧已有票据，直接 staple；否则单独把 zip 提交公证后再 staple。
if ! xcrun stapler staple "$APP" >/dev/null 2>&1; then
  [ -f "$KEYCHAIN" ] || die "app 没有可用票据，且找不到专用签名钥匙串：${KEYCHAIN}"
  log "  app 尚无票据，提交 zip 公证（等待上限 ${NOTARY_TIMEOUT_MIN} 分钟）"
  SUBMIT_ZIP="$(mktemp -d "${TMPDIR:-/tmp}/aiscoo-notary-zip.XXXXXX")/${ZIP_NAME}"
  ditto -c -k --sequesterRsrc --keepParent "$APP" "$SUBMIT_ZIP"
  xcrun notarytool submit "$SUBMIT_ZIP" --keychain-profile "$PROFILE" --keychain "$KEYCHAIN" \
    --wait --timeout "${NOTARY_TIMEOUT_MIN}m" --output-format json > "$OUT_DIR/notary-zip-result.json" \
    || die "zip 公证未完成；见 ${OUT_DIR}/notary-zip-result.json（等待超时不等于失败，可稍后重跑）"
  python3 -I -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("status")=="Accepted" else 1)' \
    "$OUT_DIR/notary-zip-result.json" || die "zip 公证未通过；见 ${OUT_DIR}/notary-zip-result.json"
  rm -rf "$(dirname "$SUBMIT_ZIP")"
  xcrun stapler staple "$APP" >/dev/null || die "公证通过但 staple 失败：${APP}"
fi
xcrun stapler validate "$APP" >/dev/null || die "app 票据校验失败"
spctl -a -t exec -vv "$APP" 2>&1 | grep -q 'source=Notarized Developer ID' || die "Gatekeeper 未认可该 app"

log "步骤 3/4：从最终 app 打 zip（保留符号链接与扩展属性，供 Squirrel.Mac 校验签名）"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT_DIR/$ZIP_NAME"
SIZE="$(stat -f %z "$OUT_DIR/$ZIP_NAME")"
SHA512="$(openssl dgst -sha512 -binary "$OUT_DIR/$ZIP_NAME" | openssl base64 -A)"

log "步骤 4/4：生成 latest-mac.yml"
RELEASE_DATE="${AISCOO_UPDATE_RELEASE_DATE:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
# 用 Python 写 YAML 字符串，避免更新说明里的冒号、引号或换行破坏格式；只读入参，不执行其中内容。
python3 -I - "$OUT_DIR/latest-mac.yml" "$VERSION" "$ZIP_NAME" "$SHA512" "$SIZE" "$RELEASE_DATE" \
  "$MINIMUM_DARWIN_VERSION" "$NOTES_DIR" <<'PY'
import json, os, sys
out, version, name, sha512, size, release_date, minimum, notes_dir = sys.argv[1:9]
def quote(value):
    return json.dumps(value, ensure_ascii=False)
lines = [
    f"version: {quote(version)}",
    "files:",
    f"  - url: {quote(name)}",
    f"    sha512: {quote(sha512)}",
    f"    size: {int(size)}",
    f"path: {quote(name)}",
    f"sha512: {quote(sha512)}",
    f"releaseDate: {quote(release_date)}",
    f"minimumSystemVersion: {quote(minimum)}",
]
notes = {}
for locale in ("zh-CN", "en-US"):
    path = os.path.join(notes_dir, f"{locale}.md")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as handle:
            text = handle.read().strip()
        if text:
            notes[locale] = text
if notes:
    lines.append("releaseNotesByLocale:")
    for locale, text in notes.items():
        lines.append(f"  {locale}: {quote(text)}")
with open(out, "w", encoding="utf-8") as handle:
    handle.write("\n".join(lines) + "\n")
PY
log "完成：${OUT_DIR}/${ZIP_NAME}（${SIZE} 字节）与 ${OUT_DIR}/latest-mac.yml"
log "下一步：scripts/aiscoo/publish-macos-update.mjs ${OUT_DIR}（默认只预演，不上传）"
