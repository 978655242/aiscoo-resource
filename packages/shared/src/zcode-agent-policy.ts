// XCODE: 仅统一本产品展示文案，保留内部标识、协议与既有数据。
import { z } from "zod";
// XCODE: 产品展示名由共享品牌契约提供。
import { brandProductText } from "./aiscoo-brand/runtime.js";
import type { CommandAgentSource } from "./command-types.js";
import type { ZCodeProvider } from "./zcode-task-types-core.js";

export const ZCODE_AGENT_PROVIDER = "glm" satisfies ZCodeProvider;
// XCODE: 仅 Agent 展示标签使用产品品牌，provider/source 标识继续兼容。
export const ZCODE_AGENT_PROVIDER_LABEL = brandProductText("XWork Agent");
export const ZCODE_COMMAND_AGENT_SOURCE = "zcodeAgent" satisfies CommandAgentSource;

/**
 * 解析持久化/relay 数据时的 provider 归一 schema：
 * 已移除的第三方 provider 历史值仅作为归一化输入保留，统一收敛为 glm；
 * 其它非法值保持拒绝，与收窄前的校验边界一致。
 */
export const legacyZCodeProviderSchema = z
  .enum(["claude", "opencode", "gemini", "codex", "glm"])
  .transform((): typeof ZCODE_AGENT_PROVIDER => ZCODE_AGENT_PROVIDER);

export const ZCODE_ENABLED_AGENT_PROVIDERS = [
  ZCODE_AGENT_PROVIDER,
] as const satisfies readonly ZCodeProvider[];

export const ZCODE_COMMAND_AGENT_SOURCES = [
  ZCODE_COMMAND_AGENT_SOURCE,
] as const satisfies readonly CommandAgentSource[];

export function normalizeAgentProviderToZCodeAgent(
  _provider?: ZCodeProvider | null,
): ZCodeProvider {
  return ZCODE_AGENT_PROVIDER;
}

export function normalizeAgentProvidersToZCodeAgent(
  _providers?: ReadonlyArray<ZCodeProvider> | null,
): ZCodeProvider[] {
  return [...ZCODE_ENABLED_AGENT_PROVIDERS];
}

export function normalizeCommandAgentSourceToZCodeAgent(
  _agentSource?: CommandAgentSource | null,
): CommandAgentSource {
  return ZCODE_COMMAND_AGENT_SOURCE;
}

export function isZCodeAgentProvider(
  provider: ZCodeProvider | null | undefined,
): provider is typeof ZCODE_AGENT_PROVIDER {
  return provider === ZCODE_AGENT_PROVIDER;
}
