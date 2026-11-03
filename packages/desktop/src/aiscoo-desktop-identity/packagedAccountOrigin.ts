import { normalizeAiscooAdminOrigin } from "@zcode/shared/aiscoo-admin";
import { resolveAiscooDesktopIdentity } from "@zcode/shared/aiscoo-desktop-identity";
import type { PackagedAiscooAccountOriginRuntime } from "./contract.js";

/** 账号源环境变量名，与 Main / Host / scheduler 现有读取点保持一致。 */
export const AISCOO_ADMIN_BASE_URL_ENV = "AISCOO_ADMIN_BASE_URL";

// 构建期由 tsup 仅向 Main 包注入；上游通用构建、Host/scheduler 包与单测环境没有该常量。
declare const __AISCOO_ADMIN_BASE_URL__: string | undefined;

/**
 * 解析随包编译的账号源。
 * 未编译（空串或 undefined）或非 Aiscoo 渠道返回 undefined；已编译但非法则抛出 XCODE_ORIGIN_INVALID。
 */
export function resolvePackagedAiscooAccountOrigin(
  compiledOrigin: string | undefined,
  hasAiscooChannel: boolean,
): string | undefined {
  if (!hasAiscooChannel) return undefined;
  const raw = compiledOrigin?.trim();
  if (!raw) return undefined;
  // 与运行期账号策略共用同一个严格解析器，避免构建期与运行期对“合法 origin”理解不一致。
  return normalizeAiscooAdminOrigin(raw);
}

/**
 * 打包态下把编译的账号源写入进程环境，覆盖继承值。
 * 依据：正式包由 Finder 启动，用户机器上的同名环境变量不应让正式包改连别的账号服务，
 * 与“环境变量不能改写已打包渠道”是同一原则。
 *
 * - 未打包的开发运行、非 Aiscoo 渠道、没有编译账号源：不改动环境。
 * - 编译值合法：写入规范化后的 origin。
 * - 编译值运行时复核失败（构建门禁理论上已拦截）：清除继承值并失败关闭，由现有账号策略
 *   显示稳定的“配置不可用”。既不在启动期崩溃，也不回退到用户环境里的值。
 * 返回实际写入的 origin，没有写入时返回 undefined。
 */
export function applyPackagedAiscooAccountOrigin(
  runtime: PackagedAiscooAccountOriginRuntime,
): string | undefined {
  if (!runtime.isPackaged) return undefined;
  let origin: string | undefined;
  try {
    origin = resolvePackagedAiscooAccountOrigin(runtime.compiledOrigin, runtime.hasAiscooChannel);
  } catch {
    delete runtime.env[AISCOO_ADMIN_BASE_URL_ENV];
    return undefined;
  }
  if (!origin) return undefined;
  runtime.env[AISCOO_ADMIN_BASE_URL_ENV] = origin;
  return origin;
}

/** 读取本包的编译常量与渠道后调用 applyPackagedAiscooAccountOrigin；供 Main 早期 bootstrap 使用。 */
export function applyCompiledAiscooAccountOrigin(
  runtime: Pick<PackagedAiscooAccountOriginRuntime, "isPackaged" | "env">,
): string | undefined {
  return applyPackagedAiscooAccountOrigin({
    compiledOrigin:
      typeof __AISCOO_ADMIN_BASE_URL__ === "undefined" ? undefined : __AISCOO_ADMIN_BASE_URL__,
    hasAiscooChannel: resolveAiscooDesktopIdentity() !== null,
    ...runtime,
  });
}
