import { normalizeAiscooAdminOrigin } from "@zcode/shared/aiscoo-admin";
import type { AiscooUpdateEndpointRuntime } from "./contract.js";

/**
 * Aiscoo 应用内更新的 manifest 来源：与账号服务同一个 origin。
 * 规则见 docs/aiscoo/specs/aiscoo-auto-update.md。
 *
 * - 非 Aiscoo 渠道（上游通用构建）返回 undefined，调用方保持上游行为。
 * - Aiscoo 渠道取不到合法 origin 时返回 null：调用方关闭自动更新，绝不回退官方地址，
 *   因为官方 manifest 只分发 ZCode 安装包。
 * - 打包态下账号源已由早期 bootstrap 用编译值覆盖进 env，这里只读取并复核，不再写入。
 */
export function resolveAiscooUpdateEndpointOrigin(
  runtime: AiscooUpdateEndpointRuntime,
): string | null | undefined {
  if (!runtime.hasAiscooChannel) return undefined;
  const raw = runtime.accountOrigin?.trim();
  if (!raw) return null;
  try {
    return normalizeAiscooAdminOrigin(raw);
  } catch {
    return null;
  }
}
