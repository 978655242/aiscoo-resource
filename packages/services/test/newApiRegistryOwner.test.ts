import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountProviderService,
  MutableAccountProviderConfigSource,
  ProviderRegistryService,
  ProviderConfigMap,
  ProviderTemplateMap,
  ModelConfigRules,
  ModelConfig,
  NewApiAccountAccessConfig,
  createAccountProviderConfigSnapshot,
  createFailClosedAccountProviderConfigSnapshot,
  ProviderConfig,
  ZhipuAccountAccessConfig,
  ModelSelectionFacade,
  ProviderSettingsFacade,
  extractManualModelConfig,
  parsePersonalModelConfigRules,
  parsePersonalProviderConfigMap,
  type ProviderConfigSnapshot,
} from "@zcode/provider";
import {
  createNewApiProviderAnchors,
  NodeProviderConfigRuntime,
  materializeZCodeBuiltinProviderConfig,
  decodeProviderConfigFile,
  encodeProviderConfigFile,
  decodeZCodeBuiltinRelease,
  NodePersonalProviderConfigRepository,
  NodeModelSelectionConfigRepository,
  NodeZCodeBuiltinProviderConfigSource,
} from "@zcode/provider-node";
import { resolveNewApiAccountProviders } from "../src/new-api/newApiAccountProviderResolution.js";
import { owner, catalog, entitlements, modelConfig } from "./newApiRegistryFixtures.js";

function config(): ProviderConfigSnapshot {
  return {
    revision: "config-1",
    zcodeBuiltinRevision: "builtin-1",
    personalRevision: "personal-1",
    zcodeBuiltinProviders: createNewApiProviderAnchors(owner.origin),
    zcodeBuiltinProviderTemplates: ProviderTemplateMap.empty(),
    personalProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: ModelConfigRules.empty(),
    personalModels: ModelConfigRules.empty(),
  };
}

function legacyPersonalConfig() {
  const old = "account:new-api-openai-chat-completions";
  const current = "account:aiscoo-openai-chat-completions";
  const manual = extractManualModelConfig(modelConfig);
  return {
    schemaVersion: 1,
    config: {
      providerOrder: [old, "account:new-api-custom", current],
      providerConfigRules: {
        providerRules: [
          {
            providerId: old,
            enabled: false,
            providerName: "Old",
            config: {
              visibility: "hidden",
              personalModelIds: ["old-only"],
              modelOrder: ["old-only"],
            },
          },
          {
            providerId: current,
            providerName: "Current",
            config: {
              modelOrder: ["hy3", "model/with/slash"],
            },
          },
          { providerId: "account:new-api-custom", config: { modelOrder: [old] } },
        ],
      },
      modelConfigRules: {
        providerModelRules: [
          { providerId: current, modelId: "hy3", config: { enabled: true } },
          { providerId: old, modelId: "model/with/slash", config: { enabled: false } },
          { providerId: old, modelId: "manual-current", config: { enabled: false } },
        ],
        manualProviderModelRules: [
          { providerId: old, modelId: "hy3", config: manual },
          { providerId: current, modelId: "manual-current", config: manual },
        ],
      },
      defaultModelSelection: {
        providerId: old,
        modelId: "hy3",
        options: { reasoningLevel: "none" },
      },
    },
  };
}

test("personal codec canonicalizes legacy identities with complete new entries winning in either order", () => {
  for (const reverse of [false, true]) {
    const input = legacyPersonalConfig();
    if (reverse) {
      input.config.providerConfigRules.providerRules.reverse();
      input.config.modelConfigRules.providerModelRules.reverse();
      input.config.modelConfigRules.manualProviderModelRules.reverse();
    }
    const before = structuredClone(input);
    const update = decodeProviderConfigFile(input);
    const id = "account:aiscoo-openai-chat-completions";
    const rule = update.providers.getRule(id)!;
    assert.equal(rule.providerName, "Current");
    assert.equal(rule.enabled, undefined);
    assert.equal(rule.config.visibility, undefined);
    assert.equal(rule.config.personalModelIds, undefined);
    assert.deepEqual(rule.config.modelOrder, ["hy3", "model/with/slash"]);
    assert.deepEqual(update.providerOrder, [id, "account:new-api-custom"]);
    assert.deepEqual(update.providers.get("account:new-api-custom")?.modelOrder, [
      "account:new-api-openai-chat-completions",
    ]);
    assert.equal(update.models.getExactRule(id, "hy3")?.type, "provider-model");
    assert.deepEqual(update.models.getExact(id, "hy3")?.toJSON(), { enabled: true });
    assert.equal(update.models.getExactRule(id, "manual-current")?.type, "manual-provider-model");
    assert.equal(update.models.getExact(id, "model/with/slash")?.enabled, false);
    assert.deepEqual(update.defaultModelSelection, {
      ...input.config.defaultModelSelection,
      providerId: id,
    });
    assert.ok(!update.providers.has("account:new-api-openai-chat-completions"));
    const encoded = encodeProviderConfigFile(update);
    assert.deepEqual(
      encodeProviderConfigFile({
        providers: parsePersonalProviderConfigMap(input.config.providerConfigRules),
        models: parsePersonalModelConfigRules(input.config.modelConfigRules),
        providerOrder: input.config.providerOrder,
        defaultModelSelection: input.config.defaultModelSelection,
      }),
      encoded,
    );
    assert.deepEqual(encodeProviderConfigFile(decodeProviderConfigFile(encoded)), encoded);
    assert.deepEqual(input, before);
  }
  const duplicate = legacyPersonalConfig();
  duplicate.config.providerConfigRules.providerRules.push(
    duplicate.config.providerConfigRules.providerRules[0]!,
  );
  assert.throws(() => decodeProviderConfigFile(duplicate), /重复 providerId/);
  const contradictory = legacyPersonalConfig();
  contradictory.config.modelConfigRules.manualProviderModelRules.push({
    providerId: "account:aiscoo-openai-chat-completions",
    modelId: "hy3",
    config: extractManualModelConfig(modelConfig),
  });
  assert.throws(() => decodeProviderConfigFile(contradictory), /同时声明智能和手动配置/);
});

function shadowedInvalidPersonalConfigs() {
  const legacyId = "account:new-api-openai-chat-completions";
  const canonicalId = "account:aiscoo-openai-chat-completions";
  return [
    {
      name: "incomplete legacy manual model",
      update: {
        providers: ProviderConfigMap.empty(),
        models: new ModelConfigRules([
          {
            type: "manual-provider-model",
            providerId: legacyId,
            modelId: "hy3",
            config: ModelConfig.fromData({ enabled: true }),
          },
          {
            type: "provider-model",
            providerId: canonicalId,
            modelId: "hy3",
            config: ModelConfig.fromData({ enabled: true }),
          },
        ]),
      },
    },
    {
      name: "forbidden legacy Account access",
      update: {
        providers: new ProviderConfigMap([
          {
            providerId: legacyId,
            config: new ProviderConfig({
              access: new NewApiAccountAccessConfig({ entitled: true }),
            }),
          },
          { providerId: canonicalId, config: new ProviderConfig({}) },
        ]),
        models: ModelConfigRules.empty(),
      },
    },
  ];
}

for (const { name, update } of shadowedInvalidPersonalConfigs()) {
  test(`personal codec refuses shadowed ${name} before canonical deduplication`, () => {
    assert.throws(() => {
      parsePersonalProviderConfigMap({ providerRules: update.providers.toJSON() });
      update.models.toPersonalJSON();
    });
    assert.throws(() => encodeProviderConfigFile(update));
  });

  test(`personal repository refuses shadowed ${name} without writing or publishing`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "aiscoo-invalid-provider-config-"));
    const filePath = join(dir, "personal.json");
    const stored = JSON.stringify(
      encodeProviderConfigFile({
        providers: ProviderConfigMap.empty(),
        models: ModelConfigRules.empty(),
      }),
    );
    await writeFile(filePath, stored);
    const personal = new NodePersonalProviderConfigRepository({
      filePath,
      pollingIntervalMs: false,
    });
    let changes = 0;
    personal.onDidChange(() => {
      changes += 1;
    });
    try {
      await assert.rejects(personal.update(() => update));
      assert.equal(await readFile(filePath, "utf8"), stored);
      assert.equal(changes, 0);
    } finally {
      personal.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("personal repository reads and saves legacy defaults through one canonical file boundary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aiscoo-provider-config-"));
  const filePath = join(dir, "personal.json");
  await writeFile(filePath, JSON.stringify(legacyPersonalConfig()));
  const personal = new NodePersonalProviderConfigRepository({ filePath, pollingIntervalMs: false });
  const selections = new NodeModelSelectionConfigRepository({ personalRepository: personal });
  try {
    const selection = await selections.read();
    assert.equal(selection?.providerId, "account:aiscoo-openai-chat-completions");
    const first = await personal.read();
    const stored = await readFile(filePath, "utf8");
    assert.equal((await personal.read()).revision, first.revision);
    assert.equal(await readFile(filePath, "utf8"), stored);
    const legacy = Object.freeze({
      providerId: "account:new-api-openai-responses",
      modelId: "model/with/slash",
      options: Object.freeze({ reasoningLevel: "none" }),
    });
    const saved = await selections.saveConfiguredDefault(legacy);
    assert.deepEqual(saved, { ...legacy, providerId: "account:aiscoo-openai-responses" });
    assert.equal(
      JSON.parse(await readFile(filePath, "utf8")).config.defaultModelSelection.providerId,
      saved?.providerId,
    );
    assert.equal(legacy.providerId, "account:new-api-openai-responses");
  } finally {
    selections.dispose();
    personal.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("builtin fence admits no new owner and immediately revokes the old owner execution", async () => {
  let current = config();
  const configSource = { read: async () => current, onDidChange: () => () => {} };
  const source = new MutableAccountProviderConfigSource();
  const native = resolveNewApiAccountProviders({
    owner,
    catalog,
    entitlements,
    configRevision: "builtin-1",
  });
  source.replace(
    createAccountProviderConfigSnapshot("builtin-1", native.providers, native.states, native),
  );
  const registry = new ProviderRegistryService({ configSource, accountSource: source });
  try {
    await registry.start();
    assert.ok(registry.getModel("account:aiscoo-openai-responses", "real-model"));
    current = { ...current, revision: "config-2", zcodeBuiltinRevision: "builtin-2" };
    const replacement = resolveNewApiAccountProviders({
      owner: { ...owner, sid: "other-owner", authGeneration: 2 },
      catalog,
      entitlements,
      configRevision: "builtin-1",
    });
    source.replace(
      createAccountProviderConfigSnapshot(
        "builtin-1",
        replacement.providers,
        replacement.states,
        replacement,
      ),
    );
    await registry.refresh("owner-switch");
    assert.equal(registry.getModel("account:aiscoo-openai-responses", "real-model"), undefined);
    const matching = resolveNewApiAccountProviders({
      owner: { ...owner, sid: "other-owner", authGeneration: 2 },
      catalog,
      entitlements,
      configRevision: "builtin-2",
    });
    source.replace(
      createAccountProviderConfigSnapshot(
        "builtin-2",
        matching.providers,
        matching.states,
        matching,
      ),
    );
    await registry.refresh("matching-builtin");
    assert.equal(
      registry.getProvider("account:aiscoo-openai-responses")?.accountOwner?.sid,
      "other-owner",
    );
  } finally {
    registry.dispose();
  }
});

test("builtin mismatch preserves old Native capabilities but revokes a removed model immediately", async () => {
  let current = config();
  const source = new MutableAccountProviderConfigSource();
  const native = resolveNewApiAccountProviders({
    owner,
    catalog,
    entitlements,
    configRevision: "builtin-1",
  });
  source.replace(
    createAccountProviderConfigSnapshot("builtin-1", native.providers, native.states, native),
  );
  const registry = new ProviderRegistryService({
    configSource: { read: async () => current, onDidChange: () => () => {} },
    accountSource: source,
  });
  const id = "account:aiscoo-openai-responses";
  try {
    await registry.start();
    const oldApplied = registry.getSnapshot()!.sourceRevisions.account;
    current = { ...current, revision: "config-2", zcodeBuiltinRevision: "builtin-2" };
    const changedCatalog = {
      ...catalog,
      models: catalog.models.map((entry) =>
        entry.model_id === "real-model"
          ? {
              ...entry,
              model_config: {
                ...modelConfig,
                optionSpecs: {
                  ...modelConfig.optionSpecs,
                  reasoningLevel: { values: ["none", "high"], map: "{}" },
                },
              },
            }
          : entry,
      ),
    };
    const changed = resolveNewApiAccountProviders({
      owner,
      catalog: changedCatalog,
      entitlements,
      configRevision: "builtin-1",
    });
    source.replace(
      createAccountProviderConfigSnapshot("builtin-1", changed.providers, changed.states, changed),
    );
    await registry.refresh("capabilities-before-builtin");
    assert.deepEqual(
      registry.getModel(id, "real-model")?.config.optionSpecs.reasoningLevel.values,
      ["none"],
    );
    assert.equal(registry.getSnapshot()!.sourceRevisions.account, oldApplied);
    assert.notEqual((await source.read()).revision, oldApplied);

    const revoked = resolveNewApiAccountProviders({
      owner,
      catalog: {
        ...changedCatalog,
        models: changedCatalog.models.map((entry) =>
          entry.model_id === "real-model"
            ? { ...entry, model_config: { ...modelConfig, enabled: false } }
            : entry,
        ),
      },
      entitlements,
      configRevision: "builtin-1",
    });
    source.replace(
      createAccountProviderConfigSnapshot("builtin-1", revoked.providers, revoked.states, revoked),
    );
    await registry.refresh("disabled-before-builtin");
    assert.equal(registry.getModel(id, "real-model"), undefined);
    assert.equal(registry.getSnapshot()!.sourceRevisions.account, oldApplied);

    source.replace(
      createAccountProviderConfigSnapshot("builtin-2", changed.providers, changed.states, changed),
    );
    await registry.refresh("matching-builtin-capabilities");
    assert.deepEqual(
      registry.getModel(id, "real-model")?.config.optionSpecs.reasoningLevel.values,
      ["none", "high"],
    );
    assert.equal(registry.getSnapshot()!.sourceRevisions.account, changed.revision);
  } finally {
    registry.dispose();
  }
});

test("Native revisions and Renderer projections never serialize the private owner", async () => {
  let currentOwner = owner;
  let configRevision = "builtin-1";
  let currentCatalog = catalog;
  const source = new AccountProviderService({
    configSource: {
      read: async () => ({ ...config(), zcodeBuiltinRevision: configRevision }),
      onDidChange: () => () => {},
    },
    resolve: async (input) =>
      resolveNewApiAccountProviders({
        owner: currentOwner,
        catalog: currentCatalog,
        entitlements,
        configRevision: input.configRevision,
      }),
  });
  const registry = new ProviderRegistryService({
    configSource: {
      read: async () => ({ ...config(), zcodeBuiltinRevision: configRevision }),
      onDidChange: () => () => {},
    },
    accountSource: source,
  });
  try {
    await registry.start();
    const first = await source.read();
    assert.match(first.revision, /^account:sha256:[a-f0-9]{64}$/);
    assert.equal(
      registry.getProvider("account:aiscoo-openai-responses")?.accountOwner?.sid,
      owner.sid,
    );
    assert.equal(
      registry.getProvider("account:aiscoo-openai-responses")?.accountRevision,
      first.revision,
    );
    assert.equal(
      registry.getModel("account:aiscoo-openai-responses", "real-model")?.displayName,
      "Real",
    );
    for (const projected of [
      new ModelSelectionFacade(registry).getView(),
      new ProviderSettingsFacade(registry).getView(),
    ]) {
      assert.equal(JSON.stringify(projected).includes('"accountOwner"'), false);
      for (const field of ["userId", "sid", "authGeneration"])
        assert.equal(JSON.stringify(projected).includes(`"${field}"`), false);
    }
    for (const field of ["origin", "userId", "sid", "authGeneration"])
      assert.equal(first.revision.includes(field), false);
    assert.equal(first.revision.includes(owner.origin), false);
    assert.equal(first.revision.includes(owner.sid), false);
    assert.equal((await source.refresh("same-facts")).revision, first.revision);
    configRevision = "builtin-2";
    const changedBuiltin = await source.refresh("builtin-change");
    assert.notEqual(changedBuiltin.revision, first.revision);
    currentCatalog = { ...catalog, authorization_revision: "8" };
    await assert.rejects(source.refresh("mismatch"), /revision/i);
    const denied = await source.read();
    assert.equal(denied.owner, null);
    assert.equal(denied.revision.includes(owner.sid), false);
    currentCatalog = catalog;
    currentOwner = { ...owner, authGeneration: 2 };
    const replacement = await source.refresh("generation-change");
    assert.notEqual(replacement.revision, changedBuiltin.revision);
  } finally {
    registry.dispose();
    source.dispose();
  }
});

test("initial Native denial and resolver errors do not leak origin through revision", async () => {
  const current = { ...config(), zcodeBuiltinRevision: `builtin:native:${owner.origin}` };
  const initial = createFailClosedAccountProviderConfigSnapshot(current);
  assert.equal(initial.revision.includes(owner.origin), false);
  assert.equal(initial.owner, null);
  const native = resolveNewApiAccountProviders({
    owner,
    catalog,
    entitlements,
    configRevision: current.zcodeBuiltinRevision,
  });
  const { revision: _revision, ...plaintextDetails } = native;
  assert.throws(
    () =>
      createAccountProviderConfigSnapshot(
        current.zcodeBuiltinRevision,
        native.providers,
        native.states,
        plaintextDetails,
      ),
    /opaque/,
  );
  const source = new AccountProviderService({
    configSource: { read: async () => current, onDidChange: () => () => {} },
    resolve: async () => {
      throw new Error("catalog unavailable");
    },
  });
  try {
    const denied = await source.read();
    assert.equal(denied.revision.includes(owner.origin), false);
    assert.equal(denied.owner, null);
    assert.equal(denied.providers.get("account:aiscoo-openai-responses")?.access?.entitled, false);
  } finally {
    source.dispose();
  }
});

test("account source synchronous invalidation removes Native models and issues before catalog IO", async () => {
  const source = new AccountProviderService({
    configSource: { read: async () => config(), onDidChange: () => () => {} },
    resolve: async (input) =>
      resolveNewApiAccountProviders({
        owner,
        catalog,
        entitlements,
        configRevision: input.configRevision,
      }),
  });
  try {
    assert.equal((await source.read()).catalogIssues?.length, 2);
    source.invalidateNative();
    const denied = await source.read();
    assert.equal(denied.owner, null);
    assert.deepEqual(denied.catalogIssues, []);
    assert.deepEqual(denied.providers.get("account:aiscoo-openai-responses")?.builtinModelIds, []);
    assert.equal(denied.providers.get("account:aiscoo-openai-responses")?.access?.entitled, false);
  } finally {
    source.dispose();
  }
});

test("primary owner loss revokes hidden cloud models, unlike a Native read failure", async () => {
  const id = "account:off-peak-zai";
  const source = new AccountProviderService({
    configSource: { read: async () => config(), onDidChange: () => () => {} },
    resolve: async (input) => {
      const native = resolveNewApiAccountProviders({
        owner,
        catalog,
        entitlements,
        configRevision: input.configRevision,
      });
      return {
        ...native,
        providers: native.providers.set(
          id,
          new ProviderConfig({
            access: new ZhipuAccountAccessConfig({
              accountType: "zai",
              mode: "off-peak",
              entitled: true,
            }),
            builtinModelIds: ["cloud-only-model"],
          }),
        ),
        states: {
          ...native.states,
          [id]: { availability: "available", entitled: true, current: true },
        },
      };
    },
  });
  try {
    await source.read();
    source.invalidateNative();
    assert.equal((await source.read()).providers.get(id)?.access?.entitled, true);
    source.invalidateNative(true);
    const denied = await source.read();
    assert.equal(denied.providers.get(id)?.access?.entitled, false);
    assert.deepEqual(denied.providers.get(id)?.builtinModelIds, []);
    assert.equal(denied.states?.[id]?.availability, "unavailable");
  } finally {
    source.dispose();
  }
});

test("legacy builtin projection preserves raw same-revision content conflict checks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aiscoo-builtin-identity-"));
  const bundledFilePath = join(dir, "bundled.json");
  const activeFilePath = join(dir, "active.json");
  const content = (providerId: string) => ({
    schemaVersion: 1,
    revision: 7,
    config: {
      providerConfigRules: {
        templateRules: [],
        providerRules: [{ providerId, config: { group: "new-api-family" } }],
      },
      modelConfigRules: ModelConfigRules.empty().toZCodeBuiltinJSON(),
    },
  });
  const old = content("account:new-api-openai-chat-completions");
  const current = content("account:aiscoo-openai-chat-completions");
  await writeFile(bundledFilePath, JSON.stringify(old));
  await writeFile(activeFilePath, JSON.stringify(current));
  const source = new NodeZCodeBuiltinProviderConfigSource({
    bundledFilePath,
    activeFilePath,
    watch: false,
  });
  try {
    const snapshot = await source.read();
    assert.deepEqual(snapshot.providers.keys(), ["account:aiscoo-openai-chat-completions"]);
    assert.equal(
      snapshot.providers.get("account:aiscoo-openai-chat-completions")?.group,
      "new-api-family",
    );
    assert.deepEqual(JSON.parse(await readFile(activeFilePath, "utf8")), old);
    await assert.rejects(
      source.applyRemoteRelease(decodeZCodeBuiltinRelease(current)),
      /相同 revision 7 对应不同内容/,
    );
  } finally {
    source.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("materialized and refreshed CDN config keep the three explicit-origin local anchors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-anchors-"));
  const content = (revision: number) =>
    JSON.stringify({
      schemaVersion: 1,
      revision,
      config: {
        providerConfigRules: {
          templateRules: [],
          providerRules: createNewApiProviderAnchors(owner.origin)
            .toJSON()
            .map((rule) => ({
              ...rule,
              providerId: rule.providerId.replace("account:aiscoo-", "account:new-api-"),
            })),
        },
        modelConfigRules: {
          ...ModelConfigRules.empty().toZCodeBuiltinJSON(),
          builtinProviderModelRules: [
            {
              providerId: "account:new-api-openai-chat-completions",
              modelId: "hy3",
              config: { enabled: true },
            },
          ],
        },
      },
    });
  const builtin = await materializeZCodeBuiltinProviderConfig({
    environmentConfigRoot: dir,
    content: content(1),
    newApiOrigin: owner.origin,
  });
  const runtime = new NodeProviderConfigRuntime({
    zcodeBuiltinFilePath: builtin,
    newApiOrigin: owner.origin,
    personalFilePath: join(dir, "personal.json"),
    personalPollingIntervalMs: false,
    watch: false,
  });
  try {
    const first = await runtime.configService.read();
    assert.equal(first.zcodeBuiltinProviders.keys().length, 3);
    assert.ok(first.zcodeBuiltinProviders.keys().every((id) => id.startsWith("account:aiscoo-")));
    assert.equal(
      first.zcodeBuiltinModelRules.getExact("account:aiscoo-openai-chat-completions", "hy3")
        ?.enabled,
      true,
    );
    assert.equal(
      first.zcodeBuiltinProviders.getRule("account:aiscoo-openai-chat-completions")?.providerName,
      "Aiscoo Zen",
    );
    const materialized = JSON.parse(await readFile(builtin, "utf8"));
    assert.equal(
      materialized.config.providerConfigRules.providerRules.find(
        (rule: { providerId: string }) =>
          rule.providerId === "account:aiscoo-openai-chat-completions",
      ).providerName,
      "Aiscoo Zen",
    );
    assert.equal(
      first.zcodeBuiltinProviders.get("account:aiscoo-anthropic-messages")?.api?.baseUrl,
      owner.origin,
    );
    await writeFile(builtin, content(2));
    const refreshed = await runtime.configService.read();
    assert.equal(refreshed.zcodeBuiltinProviders.keys().length, 3);
    assert.ok(
      refreshed.zcodeBuiltinProviders.keys().every((id) => id.startsWith("account:aiscoo-")),
    );
    assert.equal(
      refreshed.zcodeBuiltinModelRules.getExact("account:aiscoo-openai-chat-completions", "hy3")
        ?.enabled,
      true,
    );
    assert.equal(
      JSON.parse(await readFile(builtin, "utf8")).config.providerConfigRules.providerRules[0]
        .providerId,
      "account:new-api-anthropic-messages",
    );
    assert.equal(
      refreshed.zcodeBuiltinProviders.get("account:aiscoo-openai-responses")?.api?.baseUrl,
      `${owner.origin}/v1`,
    );
    assert.notEqual(refreshed.zcodeBuiltinRevision, first.zcodeBuiltinRevision);
  } finally {
    runtime.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Registry readiness survives a superseded initial account failure", async () => {
  let rejectFirst!: (error: Error) => void;
  let entered!: () => void;
  const firstEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const first = new Promise<never>((_, reject) => {
    rejectFirst = reject;
  });
  let reads = 0;
  const configSource = { read: async () => config(), onDidChange: () => () => {} };
  const source = new AccountProviderService({
    configSource,
    resolve: async (input) => {
      if (++reads === 1) {
        entered();
        await first;
      }
      return resolveNewApiAccountProviders({
        owner,
        catalog,
        entitlements,
        configRevision: input.configRevision,
      });
    },
  });
  const registry = new ProviderRegistryService({ configSource, accountSource: source });
  try {
    const ready = registry.start();
    await firstEntered;
    const replacement = source.refresh("newer-account-state");
    rejectFirst(new Error("superseded network failure"));
    await ready;
    await replacement;
    assert.equal(
      registry.getModel("account:aiscoo-openai-responses", "real-model")?.displayName,
      "Real",
    );
  } finally {
    registry.dispose();
    source.dispose();
  }
});
