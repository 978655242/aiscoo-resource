import {
  AISCOO_MODEL_PROVIDER_IDS,
  AiscooAdminCatalogSchema,
  AiscooAdminEntitlementsSchema,
} from "@zcode/shared";
import { ModelConfig, ModelConfigRules } from "@zcode/provider";
export const owner = {
  origin: "http://127.0.0.1:3001",
  userId: "42",
  sid: "native-sid",
  authGeneration: 1,
};
export const modelConfig = {
  enabled: true,
  properties: {
    contextWindow: 8192,
    requiresMfjsToolSchema: false,
    inputFormat: {
      supportsText: true,
      supportsImage: false,
      supportsVideo: false,
      supportsAudio: false,
      supportsPdf: false,
    },
    outputFormat: { supportsText: true },
    supportsToolCall: false,
    supportsJsonSchemaOutput: false,
    supportsNativeWebSearch: false,
    supportsMidConversationSystem: true,
  },
  optionSpecs: {
    reasoningLevel: { values: ["none"], map: "{}" },
    maxOutputTokens: { max: 1024, map: '{"max_tokens": maxOutputTokens}' },
  },
};
// 集中配置通过真实 Built-in 规则构造，不从账号目录复制能力。
export function builtinModelRules(config = modelConfig) {
  return new ModelConfigRules(
    Object.values(AISCOO_MODEL_PROVIDER_IDS).map((providerId) => ({
      type: "provider-model" as const,
      providerId,
      modelId: "real-model",
      config: ModelConfig.fromData(config),
    })),
  );
}
export const entitlements = AiscooAdminEntitlementsSchema.parse({
  schema_version: 1,
  server_time: 1,
  status: "active",
  authorization_revision: "7",
  subscription: {
    id: "1",
    plan_id: "2",
    plan_title: "Assigned",
    source: "admin",
    usage_scope: "zen",
    start_time: 1,
    end_time: null,
  },
  quota: null,
  funding_policy: {
    subscription_only: true,
    wallet_fallback: false,
    other_subscription_fallback: false,
  },
  self_service_reset: false,
  purchase_mode: "manual_admin",
});
export const catalog = AiscooAdminCatalogSchema.parse({
  schema_version: 1,
  server_time: 1,
  catalog_revision: "catalog-1",
  authorization_revision: "7",
  models: [
    {
      model_id: "real-model",
      display_name: "Real",
      api_type: "openai-responses",
      enabled: true,
      disabled_reason: null,
    },
    {
      model_id: "unconfigured",
      display_name: "Missing metadata",
      api_type: null,
      enabled: false,
      disabled_reason: "XCODE_MODEL_CONFIG_MISSING",
    },
    {
      model_id: "bad-cel",
      display_name: "Bad CEL",
      api_type: "anthropic-messages",
      enabled: false,
      disabled_reason: "XCODE_MODEL_DISABLED",
    },
  ],
});
