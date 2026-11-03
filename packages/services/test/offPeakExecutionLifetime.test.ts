import assert from "node:assert/strict";
import test from "node:test";
import {
  AccountProviderService,
  ProviderRegistryService,
  ProviderTemplateMap,
  ProviderConfigResolver,
  ProviderRegistry,
  ProviderConfigMap,
  ModelConfigRules,
  ModelConfig,
  ProviderConfig,
  ProviderApiConfig,
  ZhipuAccountAccessConfig,
  type ProviderConfigSnapshot,
} from "@zcode/provider";
import { type ModelRequest } from "@zcode/contracts";
import { AiSdkModelAdapter } from "../../../apps/zcode-cli/packages/adapters/src/model/runner.js";
import { ApiProviderModelRuntime } from "../../../apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.js";
import { createModelExecutionContext } from "../../../apps/zcode-cli/packages/bootstrap/src/session-execution/index.js";
import {
  buildOffPeakRequestAuth,
  resolveOffPeakCredentials,
} from "../src/session/offPeakRuntimeModel.js";
import { createOfficialCloudAccountProviderResolver } from "../src/official-mcp/officialCloudAccountResolvers.js";
import type { OfficialCloudCredentialSnapshot } from "../src/official-mcp/officialCloudConnectionService.js";
import { modelConfig, owner } from "./newApiRegistryFixtures.js";
import { createNewApiProviderAnchors } from "@zcode/provider-node";
import { createNewApiAccountProviderResolver } from "../src/new-api/newApiAccountProviderResolution.js";
import { catalog, entitlements } from "./newApiRegistryFixtures.js";
import { resolveOffPeakProviderId } from "@zcode/shared";

const providerId = resolveOffPeakProviderId("zai");
const credentials: OfficialCloudCredentialSnapshot = {
  owner,
  ownerEpoch: 1,
  connectionKey: "official-connection-a",
  credentialGeneration: "credential-a",
  family: "zai",
  jwt: "official-jwt-a",
  accessToken: "official-access-a",
  access: { type: "zhipu-account", family: "zai", planKind: "individual-coding-plan" },
  catalog: { revision: 1, providers: [{ providerId, modelIds: ["cloud-model"] }] },
};
const resolveCodingPlanMaterial = async () => ({
  token: "official-plan-a",
  apiKeyId: "official-key-a",
  organizationId: "official-org",
  projectId: "official-project",
});
const configuredProviders = new ProviderConfigMap([
  [
    providerId,
    new ProviderConfig({
      group: "zai-family",
      visibility: "hidden",
      access: new ZhipuAccountAccessConfig({
        accountType: "zai",
        mode: "off-peak",
        entitled: true,
      }),
      api: new ProviderApiConfig({
        type: "openai-chat-completions",
        baseUrl: "https://official.invalid/v1",
      }),
      builtinModelIds: ["cloud-model"],
    }),
  ],
]);
const request: ModelRequest = {
  messages: [{ role: "user", content: "hello" }],
  options: { maxOutputTokens: 32 },
};
const drain = async (events: AsyncIterable<unknown>) => {
  try {
    for await (const _event of events) {
      /* SDK cancellation may throw or emit a terminal event. */
    }
  } catch {
    /* Assert transport effects below. */
  }
};

test("offpeak Host auth retains its current-owner fence and matches the worker connection identity", async () => {
  let current = true;
  const host = {
    resolveCredentials: async () => credentials,
    isCurrent: async () => current,
    resolveCodingPlanMaterial,
  };
  const snapshot = await resolveOffPeakCredentials({ officialCloudHost: host });
  const auth = buildOffPeakRequestAuth({ credentials: snapshot, ticketId: "ticket-a" });
  const official = await createOfficialCloudAccountProviderResolver(host)({
    configRevision: "builtin-1",
    configuredProviders,
    previousProviders: ProviderConfigMap.empty(),
  });
  assert.equal(auth.executionIdentity, official.states[providerId]?.connectionKey);
  assert.ok(auth.executionIdentity);
  assert.equal(auth.apiKey, "official-jwt-a");
  assert.equal(auth.headers["X-Coding-Plan-Api-Key"], "official-plan-a");
  for (const secret of [owner.sid, owner.origin])
    assert.equal(auth.executionIdentity.includes(secret), false);
  await auth.assertCurrent?.();
  current = false;
  await assert.rejects(auth.assertCurrent!());
});

test("valid official login without a Plan publishes identity scope but never grants offpeak execution", async () => {
  let current = true;
  let selected: OfficialCloudCredentialSnapshot = {
    ...credentials,
    access: null,
  };
  const host = {
    resolveCredentials: async () => selected,
    isCurrent: async () => current,
    resolveCodingPlanMaterial,
  };
  const resolve = createOfficialCloudAccountProviderResolver(host);
  const input = {
    configRevision: "builtin-1",
    configuredProviders,
    previousProviders: ProviderConfigMap.empty(),
  };
  const official = await resolve(input);
  assert.ok(official.states[providerId]?.connectionKey);
  assert.equal(official.states[providerId]?.availability, "unavailable");
  assert.equal(official.states[providerId]?.entitled, false);
  assert.equal(official.states[providerId]?.current, false);
  const resolution = new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: configuredProviders,
    personalProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: new ModelConfigRules([
      {
        type: "provider-model",
        providerId,
        modelId: "cloud-model",
        config: ModelConfig.fromData(modelConfig),
      },
    ]),
    personalModels: ModelConfigRules.empty(),
    accountProviders: official.providers,
    accountStates: official.states,
  });
  assert.equal(
    new ProviderRegistry(resolution.registryProviders).getModel(providerId, "cloud-model"),
    undefined,
  );
  await assert.rejects(resolveOffPeakCredentials({ officialCloudHost: host }));
  selected = { ...selected, family: "bigmodel" };
  assert.equal((await resolve(input)).states[providerId]?.connectionKey, undefined);
  selected = { ...selected, family: "zai" };
  current = false;
  assert.equal((await resolve(input)).states[providerId]?.connectionKey, undefined);
});

for (const transition of ["owner-loss", "owner-replacement", "official-rotation"] as const) {
  test(
    `created offpeak Model cancels on ${transition} and cannot send a subsequent A-authenticated attempt`,
    { timeout: 10_000 },
    async () => {
      let selected: OfficialCloudCredentialSnapshot | null = credentials;
      const host = {
        resolveCredentials: async () => selected,
        isCurrent: async (candidate: OfficialCloudCredentialSnapshot) => candidate === selected,
        resolveCodingPlanMaterial,
      };
      const resolve = createOfficialCloudAccountProviderResolver(host);
      const registryProviders = async () => {
        const official = await resolve({
          configRevision: "builtin-1",
          configuredProviders,
          previousProviders: ProviderConfigMap.empty(),
        });
        return new ProviderConfigResolver().resolve({
          zcodeBuiltinProviders: configuredProviders,
          personalProviders: ProviderConfigMap.empty(),
          zcodeBuiltinModelRules: new ModelConfigRules([
            {
              type: "provider-model",
              providerId,
              modelId: "cloud-model",
              config: ModelConfig.fromData(modelConfig),
            },
          ]),
          personalModels: ModelConfigRules.empty(),
          accountProviders: official.providers,
          accountStates: official.states,
        }).registryProviders;
      };
      const registry = new ProviderRegistry(await registryProviders());
      const runtime = new ApiProviderModelRuntime({
        registry,
        modelAdapter: new AiSdkModelAdapter({ env: {}, retry: { maxAttempts: 1 } }),
      });
      const originalFetch = globalThis.fetch;
      const started = Promise.withResolvers<AbortSignal>();
      const headers: Headers[] = [];
      let running: Promise<void> | undefined;
      globalThis.fetch = async (_url, init) => {
        const signal = init?.signal;
        assert.ok(signal);
        signal.throwIfAborted();
        headers.push(new Headers(init?.headers));
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `data: ${JSON.stringify({
                  id: "cloud-completion",
                  object: "chat.completion.chunk",
                  created: 1,
                  model: "cloud-model",
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant", content: "started" },
                      finish_reason: null,
                    },
                  ],
                })}\n\n`,
              ),
            );
            signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
          },
        });
        started.resolve(signal);
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      };
      runtime.start();
      try {
        const auth = buildOffPeakRequestAuth({
          credentials: await resolveOffPeakCredentials({ officialCloudHost: host }),
          ticketId: "ticket-a",
        });
        const context = createModelExecutionContext({
          selectionScope: "execution",
          requestAuth: {
            apiKey: auth.apiKey,
            headers: auth.headers,
            executionIdentity: auth.executionIdentity,
          },
        });
        const target = {
          selection: {
            providerId,
            modelId: "cloud-model",
            options: { reasoningLevel: "none" as const },
          },
          requestDependencies: context.requestDependencies,
        };
        const model = runtime.modelFactory(target);
        running = drain(model.streamText(request));
        const signal = await started.promise;
        assert.equal(headers[0]?.get("authorization"), "Bearer official-jwt-a");
        assert.equal(headers[0]?.get("X-Coding-Plan-Api-Key"), "official-plan-a");
        selected =
          transition === "owner-loss"
            ? null
            : transition === "owner-replacement"
              ? {
                  ...credentials,
                  owner: {
                    ...owner,
                    sid: "replacement-sid",
                    authGeneration: owner.authGeneration + 1,
                  },
                }
              : { ...credentials, credentialGeneration: "credential-b", jwt: "official-jwt-b" };
        registry.replace(await registryProviders(), transition);
        assert.equal(signal.aborted, true);
        await running;
        await drain(model.streamText(request));
        assert.equal(headers.length, 1);
        assert.throws(() => runtime.modelFactory(target));
      } finally {
        runtime.dispose();
        await running;
        globalThis.fetch = originalFetch;
      }
    },
  );
}

test("official source invalidation revokes worker cloud authorization even behind a mismatching Built-in revision", async () => {
  let currentConfig: ProviderConfigSnapshot = {
    revision: "config-1",
    zcodeBuiltinRevision: "builtin-1",
    personalRevision: "personal-1",
    zcodeBuiltinProviders: createNewApiProviderAnchors(owner.origin).overlay(configuredProviders),
    zcodeBuiltinProviderTemplates: ProviderTemplateMap.empty(),
    personalProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: new ModelConfigRules([
      {
        type: "provider-model",
        providerId,
        modelId: "cloud-model",
        config: ModelConfig.fromData(modelConfig),
      },
    ]),
    personalModels: ModelConfigRules.empty(),
  };
  const configSource = { read: async () => currentConfig, onDidChange: () => () => {} };
  let officialCurrent = true;
  const host = {
    resolveCredentials: async () => (officialCurrent ? credentials : null),
    isCurrent: async () => officialCurrent,
  };
  const resolveOfficial = createOfficialCloudAccountProviderResolver(host);
  const resolve = createNewApiAccountProviderResolver({
    account: {
      getOwner: () => owner,
      isCurrent: () => true,
      withControlSession: async (operation) => operation("native-control", owner),
    },
    client: { getEntitlements: async () => entitlements, getModels: async () => catalog },
    resolveOfficial,
  });
  const source = new AccountProviderService({ configSource, resolve });
  const registry = new ProviderRegistryService({ configSource, accountSource: source });
  try {
    await registry.start();
    assert.ok(registry.getModel(providerId, "cloud-model"));
    const before = await source.read();
    currentConfig = { ...currentConfig, revision: "config-2", zcodeBuiltinRevision: "builtin-2" };
    officialCurrent = false;
    source.invalidateOfficial();
    const after = await source.read();
    assert.equal(after.providers.get(providerId)?.access?.entitled, false);
    assert.equal(after.states?.[providerId]?.connectionKey, undefined);
    assert.deepEqual(after.owner, before.owner);
    assert.deepEqual(after.modelConfigs, before.modelConfigs);
    assert.equal(after.providers.get("account:aiscoo-openai-responses")?.access?.entitled, true);
    await registry.refresh("official-disconnect-before-catalog");
    assert.equal(registry.getModel(providerId, "cloud-model"), undefined);
  } finally {
    registry.dispose();
    source.dispose();
  }
});

for (const transition of ["primary-owner-loss", "official-disconnect"] as const) {
  test(`late Native refresh failure cannot resurrect cloud authorization after ${transition}`, async () => {
    let nativeOwner: typeof owner | null = owner;
    let officialCurrent = true;
    let pause = false;
    const entered = Promise.withResolvers<void>();
    const failure = Promise.withResolvers<never>();
    const config: ProviderConfigSnapshot = {
      revision: "config-1",
      zcodeBuiltinRevision: "builtin-1",
      personalRevision: "personal-1",
      zcodeBuiltinProviders: createNewApiProviderAnchors(owner.origin).overlay(configuredProviders),
      zcodeBuiltinProviderTemplates: ProviderTemplateMap.empty(),
      personalProviders: ProviderConfigMap.empty(),
      zcodeBuiltinModelRules: new ModelConfigRules([
        {
          type: "provider-model",
          providerId,
          modelId: "cloud-model",
          config: ModelConfig.fromData(modelConfig),
        },
      ]),
      personalModels: ModelConfigRules.empty(),
    };
    const configSource = { read: async () => config, onDidChange: () => () => {} };
    const resolve = createNewApiAccountProviderResolver({
      account: {
        getOwner: () => nativeOwner,
        isCurrent: (candidate) => candidate === nativeOwner,
        withControlSession: async (operation) => {
          const captured = nativeOwner;
          if (!captured) throw new Error("XCODE_SESSION_INVALID");
          return operation("native-control", captured);
        },
      },
      client: {
        getEntitlements: async () => entitlements,
        getModels: async () => {
          if (!pause) return catalog;
          entered.resolve();
          return failure.promise;
        },
      },
      resolveOfficial: createOfficialCloudAccountProviderResolver({
        resolveCredentials: async () => (officialCurrent ? credentials : null),
        isCurrent: async () => officialCurrent && nativeOwner === owner,
      }),
    });
    const source = new AccountProviderService({ configSource, resolve });
    const registry = new ProviderRegistryService({ configSource, accountSource: source });
    try {
      await registry.start();
      assert.ok(registry.getModel(providerId, "cloud-model"));
      pause = true;
      const refresh = source.refresh("paused-native-catalog");
      await entered.promise;
      if (transition === "primary-owner-loss") {
        nativeOwner = null;
        source.invalidateNative(true);
      } else {
        officialCurrent = false;
        source.invalidateOfficial();
      }
      failure.reject(new Error("XCODE_STALE_OWNER"));
      await refresh.catch(() => {});
      const current = await source.read();
      assert.equal(current.providers.get(providerId)?.access?.entitled, false);
      assert.equal(current.states?.[providerId]?.connectionKey, undefined);
      assert.deepEqual(current.owner, nativeOwner);
      await registry.refresh("verify-terminal-owner-state");
      assert.equal(registry.getModel(providerId, "cloud-model"), undefined);
    } finally {
      registry.dispose();
      source.dispose();
    }
  });
}

test("nonprivate offpeak remains usable with ticket auth but cannot run without its required auth", async () => {
  const resolution = new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: configuredProviders,
    personalProviders: ProviderConfigMap.empty(),
    accountProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: new ModelConfigRules([
      {
        type: "provider-model",
        providerId,
        modelId: "cloud-model",
        config: ModelConfig.fromData(modelConfig),
      },
    ]),
    personalModels: ModelConfigRules.empty(),
  });
  const registry = new ProviderRegistry(resolution.registryProviders);
  const runtime = new ApiProviderModelRuntime({
    registry,
    modelAdapter: new AiSdkModelAdapter({ env: {}, retry: { maxAttempts: 1 } }),
  });
  const originalFetch = globalThis.fetch;
  const received: Headers[] = [];
  globalThis.fetch = async (_url, init) => {
    received.push(new Headers(init?.headers));
    return new Response(
      `data: ${JSON.stringify({
        id: "legacy",
        object: "chat.completion.chunk",
        created: 1,
        model: "cloud-model",
        choices: [{ index: 0, delta: { content: "legacy works" }, finish_reason: "stop" }],
      })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  runtime.start();
  try {
    const selection = {
      providerId,
      modelId: "cloud-model",
      options: { reasoningLevel: "none" as const },
    };
    const missing = runtime.modelFactory({ selection });
    await drain(missing.streamText(request));
    assert.equal(received.length, 0);
    const execution = createModelExecutionContext({
      selectionScope: "execution",
      requestAuth: {
        apiKey: "legacy-jwt",
        headers: {
          Authorization: "Bearer legacy-jwt",
          "X-Coding-Plan-Api-Key": "legacy-plan",
          "X-Off-Peak-Ticket-ID": "legacy-ticket",
        },
      },
    });
    const legacy = runtime.modelFactory({
      selection,
      requestDependencies: execution.requestDependencies,
    });
    await drain(legacy.streamText(request));
    assert.equal(received.length, 1);
    assert.equal(received[0]?.get("X-Off-Peak-Ticket-ID"), "legacy-ticket");
    assert.equal(received[0]?.get("authorization"), "Bearer legacy-jwt");
  } finally {
    runtime.dispose();
    globalThis.fetch = originalFetch;
  }
});
