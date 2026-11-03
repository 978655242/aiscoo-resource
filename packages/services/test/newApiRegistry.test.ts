import assert from "node:assert/strict";
import test from "node:test";
import {
  ModelConfig,
  ModelConfigRules,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderRegistry,
  ProviderConfig,
  ProviderApiConfig,
  ApiKeyAccessConfig,
} from "@zcode/provider";
import { AISCOO_MODEL_PROVIDER_IDS, NewApiCatalogSchema } from "@zcode/shared";
import { resolveNewApiAccountProviders } from "../src/new-api/newApiAccountProviderResolution.js";
import { resolveZenAccountProviders } from "../../../apps/zcode-cli/packages/bootstrap/src/zen/account-provider.js";
import { createNewApiProviderAnchors, decodeZCodeBuiltinRelease } from "@zcode/provider-node";
import { ApiProviderModelRuntime } from "../../../apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.js";
import {
  owner,
  modelConfig,
  builtinModelRules,
  entitlements,
  catalog,
} from "./newApiRegistryFixtures.js";

const providerId = AISCOO_MODEL_PROVIDER_IDS["openai-responses"];

test("Host and standalone CLI use catalog membership and ignore all legacy capability values", () => {
  for (const resolve of [resolveNewApiAccountProviders, resolveZenAccountProviders]) {
    const expected = resolve({ owner, entitlements, catalog });
    assert.deepEqual(expected.providers.get(providerId)?.builtinModelIds, ["real-model"]);
    assert.deepEqual(
      expected.providers.get(AISCOO_MODEL_PROVIDER_IDS["anthropic-messages"])?.builtinModelIds,
      [],
    );
    assert.deepEqual(
      [...expected.providers.keys()].sort(),
      Object.values(AISCOO_MODEL_PROVIDER_IDS).sort(),
    );
    assert.deepEqual(
      expected.catalogIssues.map((issue) => issue.modelId),
      ["unconfigured", "bad-cel"],
    );
    assert.deepEqual(expected.modelPresentation[providerId]?.["real-model"], {
      displayName: "Real",
    });
    assert.equal(expected.states[providerId]?.current, true);
    assert.equal("modelConfigs" in expected, false);
    assert.equal(JSON.stringify(expected).includes("secret"), false);
    for (const model_config of [
      null,
      false,
      "broken",
      { enabled: false },
      { apiKey: "sk-ignored" },
    ]) {
      const compatible = NewApiCatalogSchema.parse({
        ...catalog,
        models: catalog.models.map((model) => ({ ...model, model_config })),
      });
      assert.equal("model_config" in compatible.models[0]!, false);
      const result = resolve({ owner, entitlements, catalog: compatible });
      assert.equal(result.revision, expected.revision);
      assert.deepEqual(result.providers.toJSON(), expected.providers.toJSON());
      assert.equal(JSON.stringify(result).includes("sk-ignored"), false);
    }
  }
});

test("Native disabled and unroutable catalog rows retain administrator reasons without executable refs", () => {
  const result = resolveNewApiAccountProviders({ owner, entitlements, catalog });
  assert.deepEqual(result.catalogIssues, [
    {
      source: "new-api",
      modelId: "unconfigured",
      displayName: "Missing metadata",
      code: "XCODE_MODEL_CONFIG_MISSING",
    },
    { source: "new-api", modelId: "bad-cel", displayName: "Bad CEL", code: "XCODE_MODEL_DISABLED" },
  ]);
  assert.deepEqual(result.providers.get(providerId)?.builtinModelIds, ["real-model"]);
  assert.deepEqual(result.modelPresentation[providerId]?.["real-model"], { displayName: "Real" });
  const resolution = new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: createNewApiProviderAnchors(owner.origin),
    personalProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: builtinModelRules(),
    personalModels: ModelConfigRules.empty(),
    accountProviders: result.providers,
    accountStates: result.states,
    accountModelPresentation: result.modelPresentation,
  });
  assert.deepEqual(
    resolution.registryProviders.flatMap((provider) =>
      provider.models.map((model) => model.modelId),
    ),
    ["real-model"],
  );
  assert.equal(resolution.registryProviders[0]?.models[0]?.displayName, "Real");
});

test("Native capabilities compose Built-in and Personal rules, including disable and restore", () => {
  const account = resolveNewApiAccountProviders({ owner, entitlements, catalog });
  const personal = ModelConfig.fromData({
    enabled: true,
    properties: { contextWindow: 16384 },
    optionSpecs: { maxOutputTokens: { max: 2048 } },
  });
  const resolve = (personalModels: ModelConfigRules) =>
    new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: createNewApiProviderAnchors(owner.origin),
      personalProviders: ProviderConfigMap.empty(),
      zcodeBuiltinModelRules: builtinModelRules(),
      personalModels,
      accountProviders: account.providers,
      accountStates: account.states,
      accountModelPresentation: account.modelPresentation,
    });
  const rules = new ModelConfigRules([
    { type: "provider-model", providerId, modelId: "real-model", config: personal },
  ]);
  const edited = resolve(rules);
  assert.equal(edited.registryProviders[0]?.models[0]?.config.properties.contextWindow, 16384);
  assert.equal(edited.registryProviders[0]?.models[0]?.config.properties.supportsToolCall, false);
  assert.equal(
    edited.registryProviders[0]?.models[0]?.config.optionSpecs.maxOutputTokens.max,
    2048,
  );
  assert.equal(
    edited.resolvedProviders.find((provider) => provider.providerId === providerId)?.models[0]
      ?.effectiveBuiltinConfig.properties?.contextWindow,
    8192,
  );
  const disabled = resolve(
    rules.setExact(
      providerId,
      "real-model",
      personal.overlay(ModelConfig.fromData({ enabled: false })),
    ),
  );
  assert.equal(disabled.registryProviders.length, 0);
  const restored = resolve(ModelConfigRules.empty());
  assert.equal(restored.registryProviders[0]?.models[0]?.config.properties.contextWindow, 8192);
  const invalid = new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: createNewApiProviderAnchors(owner.origin),
    personalProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: builtinModelRules({
      ...modelConfig,
      optionSpecs: {
        ...modelConfig.optionSpecs,
        reasoningLevel: { values: ["none"], map: "invalid (" },
      },
    }),
    personalModels: ModelConfigRules.empty(),
    accountProviders: account.providers,
    accountStates: account.states,
    accountModelPresentation: account.modelPresentation,
  });
  // 目录资格与能力验证是独立边界：目录仍含成员，损坏的集中能力不能创建执行模型。
  assert.deepEqual(account.providers.get(providerId)?.builtinModelIds, ["real-model"]);
  const candidate = invalid.resolvedProviders.find((provider) => provider.providerId === providerId)
    ?.models[0];
  assert.equal(candidate?.executable, false);
  assert.equal(candidate?.selectable, false);
  assert.ok(candidate?.issues.some((issue) => issue.path.includes("reasoningLevel")));
  assert.equal(invalid.registryProviders.length, 0);
  const registry = new ProviderRegistry(invalid.registryProviders);
  const selection = { providerId, modelId: "real-model", options: { reasoningLevel: "none" } };
  assert.equal(registry.validateSelection(selection).ok, false);
  let created = 0;
  const runtime = new ApiProviderModelRuntime({
    registry,
    modelAdapter: {
      createModel: () => {
        created++;
        throw new Error("unexpected inference");
      },
    } as never,
  });
  runtime.start();
  try {
    assert.throws(() => runtime.modelFactory({ selection }));
    assert.equal(created, 0);
  } finally {
    runtime.dispose();
  }
  // 真实 Release 的 schema 在进入 Source 前也拒绝相同非法 CEL。
  assert.throws(() =>
    decodeZCodeBuiltinRelease({
      schemaVersion: 1,
      revision: 1,
      config: {
        providerConfigRules: { templateRules: [], providerRules: [] },
        modelConfigRules: {
          ...ModelConfigRules.empty().toZCodeBuiltinJSON(),
          builtinProviderModelRules: [
            {
              providerId,
              modelId: "real-model",
              config: {
                ...modelConfig,
                optionSpecs: {
                  ...modelConfig.optionSpecs,
                  reasoningLevel: { values: ["none"], map: "invalid (" },
                },
              },
            },
          ],
        },
      },
    }),
  );
});

test("all three Native transports retain exact admin membership despite Personal endpoint or key overrides", () => {
  const models = (
    ["anthropic-messages", "openai-chat-completions", "openai-responses"] as const
  ).map((api_type) => ({
    ...catalog.models[0]!,
    model_id: "real-model",
    display_name: `Display ${api_type}`,
    api_type,
  }));
  for (const model of models) {
    const native = resolveNewApiAccountProviders({
      owner,
      entitlements,
      catalog: { ...catalog, models: [model] },
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
      zcodeBuiltinModelRules: builtinModelRules(),
      personalModels: new ModelConfigRules([
        {
          type: "provider-model",
          providerId: AISCOO_MODEL_PROVIDER_IDS[model.api_type],
          modelId: "invented-model",
          config: ModelConfig.fromData(modelConfig),
        },
      ]),
      accountProviders: native.providers,
      accountStates: native.states,
      accountModelPresentation: native.modelPresentation,
    });
    assert.equal(resolution.registryProviders.length, 1);
    const provider = resolution.registryProviders[0]!;
    assert.equal(provider.config.access.type, "new-api-account");
    assert.equal(
      provider.config.api.baseUrl,
      model.api_type === "anthropic-messages" ? owner.origin : `${owner.origin}/v1`,
    );
    assert.deepEqual(
      provider.models.map((entry) => entry.modelId),
      ["real-model"],
    );
    assert.equal(provider.models[0]?.displayName, `Display ${model.api_type}`);
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
  assert.equal(result.providers.get(providerId)?.access?.entitled, false);
});
