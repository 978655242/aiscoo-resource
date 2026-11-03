import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelConfig,
  ModelConfigRules,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderConfig,
  ProviderApiConfig,
  ApiKeyAccessConfig,
} from "@zcode/provider";
import { resolveNewApiAccountProviders } from "../src/new-api/newApiAccountProviderResolution.js";
import { createNewApiProviderAnchors } from "@zcode/provider-node";
import { owner, modelConfig, entitlements, catalog } from "./newApiRegistryFixtures.js";

test("Native catalog resolves only admin transport and isolates metadata issues", () => {
  const result = resolveNewApiAccountProviders({ owner, entitlements, catalog });
  assert.deepEqual(result.providers.get("account:aiscoo-openai-responses")?.builtinModelIds, [
    "real-model",
  ]);
  assert.deepEqual(result.providers.get("account:aiscoo-anthropic-messages")?.builtinModelIds, []);
  assert.deepEqual(
    result.catalogIssues.map((issue) => issue.modelId),
    ["unconfigured", "bad-cel"],
  );
  assert.equal(result.states["account:aiscoo-openai-responses"]?.current, true);
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("Native disabled rows retain administrator reasons without selectable or executable refs", () => {
  const disabled = [
    {
      ...catalog.models[0]!,
      model_id: "disabled",
      display_name: "Disabled by administrator",
      enabled: false,
      disabled_reason: "XCODE_MODEL_DISABLED",
    },
    {
      ...catalog.models[0]!,
      model_id: "capability-disabled",
      display_name: "Capability disabled",
      model_config: { ...modelConfig, enabled: false },
    },
  ];
  const result = resolveNewApiAccountProviders({
    owner,
    entitlements,
    catalog: { ...catalog, models: [...catalog.models, ...disabled] },
  });
  assert.deepEqual(result.catalogIssues.slice(-2), [
    {
      source: "new-api",
      modelId: "disabled",
      displayName: "Disabled by administrator",
      code: "XCODE_MODEL_DISABLED",
    },
    {
      source: "new-api",
      modelId: "capability-disabled",
      displayName: "Capability disabled",
      code: "XCODE_MODEL_DISABLED",
    },
  ]);
  assert.deepEqual(result.providers.get("account:aiscoo-openai-responses")?.builtinModelIds, [
    "real-model",
  ]);
  assert.deepEqual(result.modelConfigs["account:aiscoo-openai-responses"]?.["real-model"], {
    ...modelConfig,
    displayName: "Real",
  });
  const resolution = new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: createNewApiProviderAnchors(owner.origin),
    personalProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: ModelConfigRules.empty(),
    personalModels: ModelConfigRules.empty(),
    accountProviders: result.providers,
    accountStates: result.states,
    accountModelConfigs: result.modelConfigs,
  });
  assert.deepEqual(
    resolution.registryProviders.flatMap((provider) =>
      provider.models.map((model) => model.modelId),
    ),
    ["real-model"],
  );
  assert.equal(resolution.registryProviders[0]?.models[0]?.displayName, "Real");
});

test("Native complete capability outranks Personal manual rules", () => {
  const result = resolveNewApiAccountProviders({ owner, entitlements, catalog });
  const resolution = new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: createNewApiProviderAnchors(owner.origin),
    personalProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: ModelConfigRules.empty(),
    personalModels: new ModelConfigRules([
      {
        type: "provider-model",
        providerId: "account:aiscoo-openai-responses",
        modelId: "real-model",
        config: ModelConfig.fromData({
          ...modelConfig,
          properties: { ...modelConfig.properties, contextWindow: 999999, supportsToolCall: true },
          optionSpecs: { ...modelConfig.optionSpecs, maxOutputTokens: { max: 999999, map: "{}" } },
        }),
      },
    ]),
    accountProviders: result.providers,
    accountStates: result.states,
    accountModelConfigs: result.modelConfigs,
  });
  const model = resolution.registryProviders[0]?.models[0];
  assert.equal(model?.config.properties.contextWindow, 8192);
  assert.equal(model?.config.properties.supportsToolCall, false);
  assert.equal(model?.config.optionSpecs.maxOutputTokens.max, 1024);
});

test("all three Native transports retain exact admin membership despite Personal endpoint or key overrides", () => {
  const models = (
    ["anthropic-messages", "openai-chat-completions", "openai-responses"] as const
  ).map((api_type) => ({
    ...catalog.models[0]!,
    model_id: `real-${api_type}`,
    display_name: `Display ${api_type}`,
    api_type,
  }));
  const native = resolveNewApiAccountProviders({
    owner,
    entitlements,
    catalog: { ...catalog, models },
  });
  const anchors = createNewApiProviderAnchors(owner.origin);
  const personal = new ProviderConfigMap(
    anchors.keys().map(
      (id) =>
        [
          id,
          new ProviderConfig({
            access: new ApiKeyAccessConfig({ apiKey: "sk-personal-secret" }),
            api: new ProviderApiConfig({
              type: "openai-responses",
              baseUrl: "https://personal.invalid/v1",
              headers: { Authorization: "Bearer sk-personal-secret" },
            }),
            builtinModelIds: ["invented-model"],
            personalModelIds: ["invented-model"],
          }),
        ] as const,
    ),
  );
  const resolution = new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: anchors,
    personalProviders: personal,
    zcodeBuiltinModelRules: ModelConfigRules.empty(),
    personalModels: ModelConfigRules.empty(),
    accountProviders: native.providers,
    accountStates: native.states,
    accountModelConfigs: native.modelConfigs,
  });
  assert.equal(resolution.registryProviders.length, 3);
  for (const provider of resolution.registryProviders) {
    const apiType = provider.config.api.type;
    assert.equal(provider.config.access.type, "new-api-account");
    assert.equal(
      provider.config.api.baseUrl,
      apiType === "anthropic-messages" ? owner.origin : `${owner.origin}/v1`,
    );
    assert.deepEqual(
      provider.models.map((model) => model.modelId),
      [`real-${apiType}`],
    );
    assert.equal(provider.models[0]?.displayName, `Display ${apiType}`);
    assert.equal(JSON.stringify(provider).includes("sk-personal-secret"), false);
  }
});

test("Native mismatching authorization revision fails closed", () => {
  assert.throws(
    () =>
      resolveNewApiAccountProviders({
        owner,
        entitlements,
        catalog: { ...catalog, authorization_revision: "8" },
      }),
    /revision/i,
  );
  const result = resolveNewApiAccountProviders({
    owner,
    entitlements: { ...entitlements, status: "revoked" },
    catalog,
  });
  assert.equal(result.providers.get("account:aiscoo-openai-responses")?.access?.entitled, false);
});
