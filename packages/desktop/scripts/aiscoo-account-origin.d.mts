/**
 * 手写声明的原因：该 .mjs 同时被 tsup 配置和回归测试使用，仓库未开启 allowJs，
 * 缺少本文件时调用点会退化为隐式 any。改 .mjs 导出时必须同步本文件。
 */
export const AISCOO_ADMIN_BASE_URL_ENV: "AISCOO_ADMIN_BASE_URL";
export function normalizeAiscooAccountOrigin(raw: string): string;
export function resolveBuildAiscooAccountOrigin(options: {
  env: Record<string, string | undefined>;
  channel: "production" | "preview" | "development";
}): string;
