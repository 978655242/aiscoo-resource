import { ModelSelectionFacade, type ProviderRegistryFacadeSource } from "@zcode/provider";
import {
  isBuiltinModelProviderId,
  isStartPlanModelProviderId,
  isAiscooAdminModelProviderId,
  OFF_PEAK_PROVIDER_IDS,
} from "@zcode/shared";
import { resolveLegacyReasoningLevel } from "./legacy-reasoning-level.js";

/** Host 与受管理 Worker 共用身份分类；解析仍由纯 Provider Facade 负责。 */
export function createNodeModelSelectionFacade(
  source: ProviderRegistryFacadeSource,
): ModelSelectionFacade {
  return new ModelSelectionFacade(
    source,
    (providerId) => {
      // Native mode never remaps historical official refs; non-private account behavior is unchanged.
      const native = source
        .getSnapshot()
        ?.resolution.effectiveBuiltinProviders.keys()
        .some(isAiscooAdminModelProviderId);
      if (isStartPlanModelProviderId(providerId)) return "ordinary";
      if (isBuiltinModelProviderId(providerId)) return native ? "ordinary" : "account-plan";
      if (Object.values(OFF_PEAK_PROVIDER_IDS).some((id) => id === providerId))
        return "account-offpeak";
      return "ordinary";
    },
    resolveLegacyReasoningLevel,
  );
}
