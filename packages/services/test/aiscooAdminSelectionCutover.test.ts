import assert from "node:assert/strict";
import test from "node:test";
import {
  ProviderConfigResolver,
  ProviderConfigMap,
  ModelConfigRules,
  ModelConfig,
  ProviderConfig,
  ProviderTemplateMap,
  createAccountProviderConfigSnapshot,
  type ProviderConfigSnapshot,
  type ProviderRegistryServiceSnapshot,
  resolveEffectiveModelSelection,
  ProviderSettingsFacade,
  ProviderRegistry,
  completeNewModelSelection,
  normalizeModelSelection,
  resolveInitialModelSelection,
} from "@zcode/provider";
import {
  createAiscooAdminProviderAnchors,
  createNodeModelSelectionFacade,
} from "@zcode/provider-node";
import { resolveAiscooAdminAccountProviders } from "../src/aiscoo-admin/aiscooAdminAccountProviderResolution.js";
import { owner, catalog, entitlements, modelConfig } from "./aiscooAdminRegistryFixtures.js";

test("legacy typed selections resolve the canonical provider without changing history or Registry membership", () => {
  const { facade, registry } = nativeSelectionFixture();
  const selection = Object.freeze({
    providerId: "account:new-api-openai-chat-completions",
    modelId: "chat-model",
    options: Object.freeze({ reasoningLevel: "none" }),
  });
  const canonical = { ...selection, providerId: "account:aiscoo-openai-chat-completions" };
  const index = new ProviderRegistry(registry.providers);
  assert.equal(index.getProvider(selection.providerId), index.getProvider(canonical.providerId));
  assert.equal(
    index.getModel(selection.providerId, selection.modelId),
    index.getModel(canonical.providerId, canonical.modelId),
  );
  assert.deepEqual(index.validateSelection(selection), { ok: true });
  assert.deepEqual(normalizeModelSelection(registry, selection), canonical);
  assert.deepEqual(completeNewModelSelection(registry, selection), canonical);
  assert.deepEqual(resolveInitialModelSelection({ registry, configuredDefault: selection }), {
    source: "configured-default",
    selection: canonical,
  });
  const view = facade.getView(selection, undefined, { selection });
  assert.deepEqual(view.effectiveSelection, canonical);
  assert.deepEqual(view.preferredSelection, canonical);
  assert.ok(
    index.listProviders().every((provider) => !provider.providerId.startsWith("account:new-api-")),
  );
  assert.equal(selection.providerId, "account:new-api-openai-chat-completions");
  assert.equal(view.effectiveSelection?.options?.reasoningLevel, "none");
  for (const providerId of [
    "account:new-api-openai-responses",
    "account:new-api-anthropic-messages",
    "account:new-api-custom",
    "account:zai-individual-coding-plan",
  ]) {
    assert.equal(
      facade.getView(undefined, undefined, {
        selection: { ...selection, providerId },
      }).effectiveSelection,
      null,
    );
  }
});

test("Aiscoo selects only Chat Completions and requires reselect for hidden or old official refs", () => {
  const { facade, registry, snapshot } = nativeSelectionFixture();
  const selection = {
    providerId: "account:aiscoo-openai-chat-completions",
    modelId: "chat-model",
    options: { reasoningLevel: "none" },
  };
  assert.deepEqual(
    facade.getView(undefined, undefined, { selection }).effectiveSelection,
    selection,
  );
  assert.deepEqual(
    facade.getView().providers.map((provider) => provider.providerId),
    ["account:aiscoo-openai-chat-completions"],
  );
  const settings = new ProviderSettingsFacade({
    getView: () => registry,
    getSnapshot: () => snapshot as never,
    refresh: async () => snapshot as never,
    onDidChange: () => () => {},
  }).getView();
  assert.deepEqual(
    settings.providers.map((provider) => provider.providerId),
    ["account:aiscoo-openai-chat-completions"],
  );
  const hidden = facade.getView(undefined, undefined, {
    selection: {
      ...selection,
      providerId: "account:aiscoo-openai-responses",
      modelId: "real-model",
    },
  });
  assert.equal(hidden.effectiveSelection, null);
  assert.equal(hidden.selectionIssue, "provider-not-found");
  const old = { ...selection, providerId: "account:zai-individual-coding-plan" };
  const result = facade.getView(undefined, undefined, { selection: old });
  assert.equal(result.effectiveSelection, null);
  assert.equal(result.selectionIssue, "provider-not-found");
  assert.equal(old.providerId, "account:zai-individual-coding-plan");
  assert.equal(
    resolveEffectiveModelSelection({
      selection: { ...selection, providerId: "account:aiscoo-anthropic-messages" },
      registry,
      classifyProvider: () => "ordinary",
    }).effectiveSelection,
    null,
  );
});

function nativeSelectionFixture(
  personalProviders = ProviderConfigMap.empty(),
  extraBuiltinRules = ModelConfigRules.empty(),
) {
  const config: ProviderConfigSnapshot = {
    revision: "config-1",
    zcodeBuiltinRevision: "builtin-1",
    personalRevision: "personal-1",
    zcodeBuiltinProviders: createAiscooAdminProviderAnchors(owner.origin),
    zcodeBuiltinProviderTemplates: ProviderTemplateMap.empty(),
    personalProviders,
    personalModels: ModelConfigRules.empty(),
    zcodeBuiltinModelRules: new ModelConfigRules([
      { type: "model", modelMatch: ".*", config: ModelConfig.fromData(modelConfig) },
      ...extraBuiltinRules.rules(),
    ]),
  };
  const native = resolveAiscooAdminAccountProviders({
    owner,
    catalog: {
      ...catalog,
      models: [
        ...catalog.models,
        { ...catalog.models[0]!, model_id: "chat-model", api_type: "openai-chat-completions" },
        {
          ...catalog.models[0]!,
          model_id: "deepseek-v4-flash",
          api_type: "openai-chat-completions",
        },
      ],
    },
    entitlements,
    configRevision: config.zcodeBuiltinRevision,
  });
  const account = createAccountProviderConfigSnapshot(
    config.zcodeBuiltinRevision,
    native.providers,
    native.states,
    native,
  );
  const resolution = new ProviderConfigResolver().resolve({
    ...config,
    accountProviders: account.providers,
    accountModelPresentation: account.modelPresentation,
    accountStates: account.states,
  });
  const registry = { revision: 1, providers: resolution.registryProviders };
  const snapshot: ProviderRegistryServiceSnapshot = {
    config,
    account,
    resolution,
    registry,
    sourceRevisions: { config: config.revision, account: account.revision },
  };
  const facade = createNodeModelSelectionFacade({
    getView: () => registry,
    getSnapshot: () => snapshot,
    refresh: async () => snapshot,
    onDidChange: () => () => {},
  });
  return { facade, registry, snapshot };
}

test("Native personal overlays cannot hide or rename Aiscoo or expose hidden transports", () => {
  const personal = new ProviderConfigMap([
    {
      providerId: "account:aiscoo-openai-chat-completions",
      providerName: "Local renamed provider",
      config: new ProviderConfig({ visibility: "hidden", modelOrder: ["deepseek-v4-flash"] }),
    },
    {
      providerId: "account:aiscoo-openai-responses",
      config: new ProviderConfig({ visibility: "visible" }),
    },
  ]);
  const { facade, registry, snapshot } = nativeSelectionFixture(personal);
  const settings = new ProviderSettingsFacade({
    getView: () => registry,
    getSnapshot: () => snapshot,
    refresh: async () => snapshot,
    onDidChange: () => () => {},
  }).getView();
  for (const view of [facade.getView(), settings]) {
    assert.deepEqual(
      view.providers.map((provider) => provider.providerId),
      ["account:aiscoo-openai-chat-completions"],
    );
    assert.equal(view.providers[0]!.providerName, "Aiscoo Zen");
  }
});

test("Native historical reasoning never inherits official Built-in aliases", () => {
  const builtin = new ModelConfigRules([
    {
      type: "model",
      modelMatch: ".*deepseek-v4-flash(?:[.\\-:/\\[].*)?",
      config: ModelConfig.fromData({
        optionSpecs: { reasoningLevel: { values: ["disabled", "low"], map: "{}" } },
      }),
    },
  ]);
  const { facade } = nativeSelectionFixture(ProviderConfigMap.empty(), builtin);
  for (const level of ["off", "nothink", "deleted-level"]) {
    const selection = {
      providerId: "account:aiscoo-openai-chat-completions",
      modelId: "deepseek-v4-flash",
      options: { reasoningLevel: level },
    };
    const view = facade.getView(undefined, undefined, { selection });
    assert.equal(view.selectionIssue, "reasoning-level-not-supported", level);
    assert.equal(selection.options.reasoningLevel, level);
  }
  const valid = {
    providerId: "account:aiscoo-openai-chat-completions",
    modelId: "deepseek-v4-flash",
    options: { reasoningLevel: "disabled" },
  };
  assert.deepEqual(
    facade.getView(undefined, undefined, { selection: valid }).effectiveSelection,
    valid,
  );
});
