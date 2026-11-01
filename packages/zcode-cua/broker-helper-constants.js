// XCODE: Helper 展示名读取同源品牌事实，bundle ID 与协议身份保持兼容。
import { PRODUCT_NAME } from "@zcode/shared/aiscoo-brand";
export const HELPER_APP_NAME = `${PRODUCT_NAME} Computer Use.app`;
export const DEV_HELPER_APP_NAME = `${PRODUCT_NAME} Computer Use Dev.app`;
export const HELPER_DISPLAY_NAME = `${PRODUCT_NAME} Computer Use`;
// XCODE: 展示名与真实 Mach-O 文件名分离；不机械重命名 producer 可执行文件。
export const HELPER_EXECUTABLE_NAME = "XWork Computer Use";
export const HELPER_BUNDLE_ID = "dev.zcode.cua-helper";
export const DEV_CUA_HELPER_BUNDLE_ID = "dev.zcode.cua-helper.dev";
export const HELPER_GHOST_CURSOR_OVERLAY_ARG = "--ghost-cursor-overlay";
