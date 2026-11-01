import type { UiLocale, SupportedLocale } from "@zcode/contracts";
import { enUS } from "./locales/en-US.js";
import { zhCN } from "./locales/zh-CN.js";
import {
  DEFAULT_LOCALE,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
  SUPPORTED_LOCALES,
} from "./locale.js";
import type { ZCodeCopy } from "./types.js";
// XCODE: 下游装配投影自有模板，原始 locale 词典和动态用户值保持原样。
import { brandCliCopy } from "./aiscoo-brand/index.js";
export { PRODUCT_NAME, PRODUCT_WORDMARK, brandProductText } from "./aiscoo-brand/index.js";

export {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  detectLocale,
  isSupportedLocale,
  isUiLocale,
  resolveLocale,
};
export type { LocaleDetectionInput } from "./locale.js";
export type { CliCopy, TuiCopy, UiLocale, SupportedLocale, ZCodeCopy } from "./types.js";

const CATALOGS: Record<SupportedLocale, ZCodeCopy> = {
  "en-US": brandCliCopy(enUS),
  "zh-CN": brandCliCopy(zhCN),
};

export function getZCodeCopy(locale?: UiLocale | string, detected?: string | null): ZCodeCopy {
  return CATALOGS[resolveLocale(locale, detected)];
}
