import { NewApiCatalogSchema, NewApiEntitlementsSchema } from "@zcode/shared";
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
export const entitlements = NewApiEntitlementsSchema.parse({
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
export const catalog = NewApiCatalogSchema.parse({
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
      model_config: modelConfig,
    },
    {
      model_id: "unconfigured",
      display_name: "Missing metadata",
      api_type: null,
      enabled: false,
      disabled_reason: "XCODE_MODEL_CONFIG_MISSING",
      model_config: null,
    },
    {
      model_id: "bad-cel",
      display_name: "Bad CEL",
      api_type: "anthropic-messages",
      enabled: true,
      disabled_reason: null,
      model_config: {
        ...modelConfig,
        optionSpecs: {
          ...modelConfig.optionSpecs,
          reasoningLevel: { values: ["none"], map: "not valid CEL (" },
        },
      },
    },
  ],
});
