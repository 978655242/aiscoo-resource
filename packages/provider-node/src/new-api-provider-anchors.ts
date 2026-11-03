import {
  ModelConfigRules,
  NewApiAccountAccessConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderConfigMap,
  type ProviderConfigLayerUpdate,
} from "@zcode/provider";
import {
  AISCOO_MODEL_PROVIDER_IDS,
  normalizeAiscooModelProviderId,
  normalizeAiscooModelProviderRecord,
  normalizeAiscooModelSelection,
} from "@zcode/shared/model-provider-types";
import { normalizeNewApiOrigin } from "@zcode/shared";
import { PRODUCT_NAME } from "@zcode/shared/aiscoo-brand";
import type { ZCodeBuiltinRelease } from "./zcode-builtin-release.js";

/** Local anchors survive CDN changes; only the explicit Host origin owns their routes. */
export function createNewApiProviderAnchors(origin: string): ProviderConfigMap {
  const canonicalOrigin = normalizeNewApiOrigin(origin);
  return new ProviderConfigMap(
    Object.entries(AISCOO_MODEL_PROVIDER_IDS).map(([apiType, providerId]) => ({
      providerId,
      // XCODE: 托管套餐显示名称来自统一品牌配置，不改变 Provider 身份。
      providerName:
        apiType === "openai-chat-completions" ? `${PRODUCT_NAME} Zen` : `New API · ${apiType}`,
      config: new ProviderConfig({
        group: "new-api-family",
        // XCODE: 前端仅开放 Chat Completions，另两种协议保持隐藏，不跨协议改选。
        visibility: apiType === "openai-chat-completions" ? "visible" : "hidden",
        access: new NewApiAccountAccessConfig({ entitled: false }),
        api: new ProviderApiConfig({
          type: apiType as "anthropic-messages" | "openai-chat-completions" | "openai-responses",
          baseUrl: apiType === "anthropic-messages" ? canonicalOrigin : `${canonicalOrigin}/v1`,
        }),
        builtinModelIds: [],
      }),
    })),
  );
}

/** 随包基线在新物化时输出规范身份；缓存 Source 仍保留原 Release 做校验。 */
export function normalizeAiscooBuiltinProviderRelease(
  release: ZCodeBuiltinRelease,
): ZCodeBuiltinRelease {
  const layer = normalizeAiscooProviderConfigLayer({
    providers: release.config.providers,
    models: release.config.modelConfigRules,
  });
  return {
    ...release,
    config: { ...release.config, providers: layer.providers, modelConfigRules: layer.models },
  };
}

/** 已校验配置的单一身份投影；规范键完整条目优先，不修改来源或原 Release。 */
export function normalizeAiscooProviderConfigLayer<T extends ProviderConfigLayerUpdate>(
  layer: T,
): T {
  const providers = normalizeAiscooModelProviderRecord(
    Object.fromEntries(layer.providers.rules().map((rule) => [rule.providerId, rule])),
  );
  const rules = layer.models.rules();
  // 智能/手动规则共享同一精确身份；新键声明的模式必须整体胜出，不能合成矛盾规则。
  const canonicalModelKeys = new Set(
    rules.flatMap((rule) =>
      "providerId" in rule && normalizeAiscooModelProviderId(rule.providerId) === rule.providerId
        ? [JSON.stringify([rule.providerId, rule.modelId])]
        : [],
    ),
  );
  return {
    ...layer,
    providers: new ProviderConfigMap(
      Object.entries(providers).map(([providerId, rule]) => ({ ...rule, providerId })),
    ),
    models: new ModelConfigRules(
      rules
        .filter(
          (rule) =>
            !("providerId" in rule) ||
            normalizeAiscooModelProviderId(rule.providerId) === rule.providerId ||
            !canonicalModelKeys.has(
              JSON.stringify([normalizeAiscooModelProviderId(rule.providerId), rule.modelId]),
            ),
        )
        .map((rule) => ("providerId" in rule ? normalizeAiscooModelSelection(rule) : rule)),
    ),
    ...(layer.providerOrder === undefined
      ? {}
      : {
          providerOrder: layer.providerOrder
            .map(normalizeAiscooModelProviderId)
            .filter(
              (providerId, index, order) =>
                !Object.values(AISCOO_MODEL_PROVIDER_IDS).some((id) => id === providerId) ||
                order.indexOf(providerId) === index,
            ),
        }),
    ...(layer.defaultModelSelection === undefined
      ? {}
      : { defaultModelSelection: normalizeAiscooModelSelection(layer.defaultModelSelection) }),
  };
}
