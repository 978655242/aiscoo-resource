import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { setImmediate } from "node:timers/promises";
import { ZCodeProtocolNdjsonConnection } from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.js";
import { parseProcessAccountProviderConfigSnapshot } from "../../../apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.js";
import {
  zcodeProtocolMessageSchema,
  zcodeProtocolMethods,
  zcodeProviderUpdateAccountConfigParamsSchema,
  type ZCodeProtocolMessage,
} from "@zcode/shared";
import { modelConfig, owner } from "./newApiRegistryFixtures.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCredentialCipherProvider } from "../src/credential/providers/credentialCipherProvider.js";
import { NewApiAccountService } from "../src/new-api/newApiAccountService.js";
import { NewApiClient } from "../src/new-api/newApiClient.js";
import { NewApiSessionRepo } from "../src/new-api/newApiSessionRepo.js";
import { NewApiProviderAdapter } from "../src/oauth/providers/newApiProviderAdapter.js";
import {
  MutableAccountProviderConfigSource,
  createAccountProviderConfigSnapshot,
  ProviderRegistry,
  createRegistryModelConfig,
  type Provider,
  ProviderConfigResolver,
  ProviderConfigMap,
  ModelConfigRules,
  ModelConfig,
  ProviderConfig,
  ProviderApiConfig,
  ApiKeyAccessConfig,
  ZhipuAccountAccessConfig,
  projectModelSelectionProviderView,
} from "@zcode/provider";
import { resolveNewApiAccountProviders } from "../src/new-api/newApiAccountProviderResolution.js";
import { entitlements, catalog } from "./newApiRegistryFixtures.js";
import { createNewApiAccountRequestAuthResolver } from "../src/model-provider/accountProviderRequestAuthService.js";
import { createNewApiProviderAnchors } from "@zcode/provider-node";
import { listRegistryBackedModels } from "../../../apps/zcode-cli/packages/bootstrap/src/app/provider-registry-selection.js";
import { ApiProviderModelRuntime } from "../../../apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.js";
import { AiSdkModelAdapter } from "../../../apps/zcode-cli/packages/adapters/src/model/runner.js";
// XCODE: test/tsconfig.json 将测试与 SDK 绑定同一份源码契约/调用上下文，避免 CLI dist 身份分裂。
import { runWithModelInvocationContext, type ModelRequest } from "@zcode/contracts";

const providerId = "account:aiscoo-openai-responses";
function envelope() {
  return {
    revision: "revision-1",
    basedOnZCodeBuiltinRevision: "builtin-1",
    owner,
    authorizationRevision: "7",
    providers: {
      [providerId]: {
        access: {
          type: "new-api-account",
          accountType: "new-api",
          mode: "private-subscription",
          entitled: true,
        },
        builtinModelIds: ["real-model"],
      },
    },
    states: {
      [providerId]: {
        availability: "available",
        entitled: true,
        current: true,
        connectionKey: "opaque",
      },
    },
    modelConfigs: { [providerId]: { "real-model": modelConfig } },
    catalogIssues: [
      {
        source: "new-api",
        modelId: "missing",
        displayName: "Missing",
        code: "XCODE_MODEL_CONFIG_MISSING",
      },
    ],
  };
}

test("worker preserves complete Native model configuration and issues under one owner", () => {
  const wire = zcodeProviderUpdateAccountConfigParamsSchema.parse(envelope());
  const result = parseProcessAccountProviderConfigSnapshot(wire);
  assert.deepEqual(result.modelConfigs?.[providerId]?.["real-model"], modelConfig);
  assert.deepEqual(result.owner, owner);
  assert.equal(result.catalogIssues?.[0]?.modelId, "missing");
  assert.equal(JSON.stringify(wire).includes("apiKey"), false);
});

test("worker cannot execute Native membership without complete capabilities and current owner", () => {
  const valid = envelope();
  for (const patch of [
    { modelConfigs: undefined },
    { owner: undefined },
    { catalogIssues: undefined },
    {
      modelConfigs: {
        [providerId]: {
          "real-model": {
            ...modelConfig,
            optionSpecs: {
              ...modelConfig.optionSpecs,
              reasoningLevel: { values: ["none"], map: "bad (" },
            },
          },
        },
      },
    },
    { modelConfigs: { [providerId]: { "real-model": { ...modelConfig, apiKey: "sk-secret" } } } },
  ]) {
    assert.throws(() => parseProcessAccountProviderConfigSnapshot({ ...valid, ...patch }));
  }
  assert.throws(() =>
    zcodeProviderUpdateAccountConfigParamsSchema.parse({ ...valid, relay: "sk-secret" }),
  );
});

test("Host catalog display names and complete capabilities survive the worker Registry", () => {
  const native = resolveNewApiAccountProviders({
    owner,
    entitlements,
    catalog,
    configRevision: "builtin-1",
  });
  const snapshot = createAccountProviderConfigSnapshot(
    "builtin-1",
    native.providers,
    native.states,
    native,
  );
  const worker = parseProcessAccountProviderConfigSnapshot({
    ...snapshot,
    providers: Object.fromEntries(
      snapshot.providers.entries().map(([id, config]) => [id, config.toJSON()]),
    ),
  });
  const resolution = new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: createNewApiProviderAnchors(owner.origin),
    personalProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: ModelConfigRules.empty(),
    personalModels: ModelConfigRules.empty(),
    accountProviders: worker.providers,
    accountStates: worker.states,
    accountModelConfigs: worker.modelConfigs,
    accountOwner: worker.owner,
    accountRevision: worker.revision,
    accountAuthorizationRevision: worker.authorizationRevision,
  });
  const registry = new ProviderRegistry(resolution.registryProviders);
  const provider = registry.getProvider(providerId)!;
  assert.deepEqual(provider.accountOwner, owner);
  assert.equal(provider.accountRevision, snapshot.revision);
  assert.equal(provider.models[0]?.displayName, "Real");
  assert.equal(listRegistryBackedModels(registry)[0]?.label, "Real");
  const view = projectModelSelectionProviderView(provider);
  assert.deepEqual(JSON.parse(JSON.stringify(view.models[0])), {
    modelId: "real-model",
    displayName: "Real",
    config: modelConfig,
  });
  assert.equal(JSON.stringify(view).includes(owner.sid), false);
  assert.equal(snapshot.revision.includes(owner.origin), false);
  assert.equal(snapshot.revision.includes(owner.sid), false);
  for (const modelId of ["unconfigured", "bad-cel"]) {
    assert.equal(registry.getModel(providerId, modelId), undefined);
    assert.equal(
      registry.validateSelection({ providerId, modelId, options: { reasoningLevel: "none" } }).ok,
      false,
    );
  }
});

test("Native relay resolution rejects non-Native access and snapshot or owner changes across credential IO", async () => {
  let currentOwner = owner;
  const source = new MutableAccountProviderConfigSource();
  const native = resolveNewApiAccountProviders({
    owner,
    entitlements,
    catalog,
    configRevision: "builtin-1",
  });
  const snapshot = createAccountProviderConfigSnapshot(
    "builtin-1",
    native.providers,
    native.states,
    native,
  );
  source.replace(snapshot);
  let crossCredentialIO = () => {};
  const resolver = createNewApiAccountRequestAuthResolver({
    account: {
      isCurrent: (candidate) => JSON.stringify(candidate) === JSON.stringify(currentOwner),
      getRelayCredential: async () => {
        crossCredentialIO();
        return { token: "sk-relay-secret", expiresAt: 1000 };
      },
    },
    accountSource: source,
    official: {
      resolveAccessCurrent: async () => {
        throw new Error("unexpected official auth");
      },
      assertCurrent: async () => {
        throw new Error("unexpected official auth");
      },
      resolveCurrent: async () => {
        throw new Error("unexpected official auth");
      },
    },
  });
  const input = {
    providerId,
    modelId: "real-model",
    reason: "model-request",
    accountAccess: {
      type: "new-api-account",
      accountType: "new-api",
      mode: "private-subscription",
      entitled: true,
      owner,
      authorizationRevision: snapshot.authorizationRevision,
    },
  } as const;
  assert.deepEqual(await resolver.resolveCurrent(input), { apiKey: "sk-relay-secret" });
  const officialAccessSnapshot = {
    ...snapshot,
    revision: `${snapshot.revision}:official-access`,
    providers: snapshot.providers.set(
      providerId,
      new ProviderConfig({ access: new ZhipuAccountAccessConfig({ entitled: true }) }),
    ),
  };
  source.replace(officialAccessSnapshot);
  await assert.rejects(
    resolver.resolveCurrent({
      ...input,
      accountAccess: input.accountAccess,
    }),
  );
  source.replace(snapshot);
  crossCredentialIO = () => {
    currentOwner = { ...owner, authGeneration: 2 };
  };
  await assert.rejects(resolver.resolveCurrent(input));
  currentOwner = owner;
  crossCredentialIO = () => {
    source.replace({ ...snapshot, revision: "replacement-revision" });
  };
  assert.deepEqual(await resolver.resolveCurrent(input), { apiKey: "sk-relay-secret" });
  source.replace(snapshot);
  crossCredentialIO = () => {
    source.replace({
      ...snapshot,
      revision: "authorization-replacement",
      authorizationRevision: "8",
    });
  };
  await assert.rejects(resolver.resolveCurrent(input));
  source.replace(snapshot);
  crossCredentialIO = () => {
    source.replace({
      ...snapshot,
      revision: "model-disabled",
      modelConfigs: {
        ...snapshot.modelConfigs,
        [providerId]: { "real-model": ModelConfig.fromData({ ...modelConfig, enabled: false }) },
      },
    });
  };
  await assert.rejects(resolver.resolveCurrent(input));
});

test("Native typed auth accepts exact legacy selections without accepting incomplete snapshots or official access", async () => {
  const source = new MutableAccountProviderConfigSource();
  const native = resolveNewApiAccountProviders({
    owner,
    entitlements,
    catalog,
    configRevision: "builtin-1",
  });
  const snapshot = createAccountProviderConfigSnapshot(
    "builtin-1",
    native.providers,
    native.states,
    native,
  );
  source.replace(snapshot);
  let relayReads = 0;
  let officialReads = 0;
  const unexpectedOfficial = async (): Promise<never> => {
    officialReads++;
    throw new Error("unexpected official auth");
  };
  const auth = createNewApiAccountRequestAuthResolver({
    account: {
      isCurrent: (candidate) => JSON.stringify(candidate) === JSON.stringify(owner),
      getRelayCredential: async () => {
        relayReads++;
        return { token: "sk-current-native", expiresAt: 1000 };
      },
    },
    accountSource: source,
    official: {
      resolveAccessCurrent: unexpectedOfficial,
      assertCurrent: unexpectedOfficial,
      resolveCurrent: unexpectedOfficial,
    },
  });
  const accountAccess = {
    type: "new-api-account",
    accountType: "new-api",
    mode: "private-subscription",
    entitled: true,
    owner,
    authorizationRevision: snapshot.authorizationRevision,
  } as const;
  const legacyId = "account:new-api-openai-responses";
  const input = {
    providerId: legacyId,
    modelId: "real-model",
    accountAccess,
    reason: "model-request",
  } as const;
  assert.deepEqual(await auth.resolveCurrent(input), { apiKey: "sk-current-native" });
  await auth.assertCurrent(input);
  assert.equal(input.providerId, legacyId, "compatibility must not mutate the captured selection");
  assert.equal(relayReads, 1);
  for (const id of [providerId, legacyId]) {
    const officialAccess = {
      type: "zhipu-account",
      accountType: "zai",
      mode: "individual-coding-plan",
      entitled: true,
    } as const;
    await assert.rejects(
      auth.resolveCurrent({ ...input, providerId: id, accountAccess: officialAccess }),
    );
    await assert.rejects(auth.assertCurrent({ providerId: id, accountAccess: officialAccess }));
  }
  for (const id of [
    "account:new-api-openai-responses-custom",
    "account:zai-individual-coding-plan",
  ]) {
    await assert.rejects(auth.resolveCurrent({ ...input, providerId: id }));
  }
  await assert.rejects(
    auth.resolveCurrent({
      ...input,
      accountAccess: {
        ...accountAccess,
        owner: { ...owner, authGeneration: owner.authGeneration + 1 },
      },
    }),
  );
  source.replace({
    ...snapshot,
    revision: `${snapshot.revision}:missing-capabilities`,
    modelConfigs: {},
  });
  await assert.rejects(
    auth.resolveCurrent(input),
    "legacy ID compatibility cannot bypass missing worker capabilities",
  );
  source.replace({
    ...snapshot,
    revision: `${snapshot.revision}:legacy-snapshot`,
    providers: new ProviderConfigMap([[legacyId, snapshot.providers.get(providerId)!]]),
    states: { [legacyId]: snapshot.states[providerId]! },
    modelConfigs: { [legacyId]: snapshot.modelConfigs![providerId]! },
  });
  await assert.rejects(
    auth.resolveCurrent(input),
    "legacy snapshot keys cannot satisfy canonical membership",
  );
  assert.equal(relayReads, 1);
  assert.equal(officialReads, 0);
});

test("real Host account owner grants relay only for current revision and stops on logout", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-worker-auth-"));
  const now = 1_800_000_000_000;
  const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString("base64url");
  const accessToken = `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: "new-api",
    aud: ["new-api-xcode"],
    token_use: "xcode_access",
    sub: "42",
    sid: owner.sid,
    exp: (now + 60_000) / 1000,
    nbf: now / 1000 - 1,
    iat: now / 1000,
    uv: 1,
    sv: 1,
    scopes: ["profile:read", "wallet:read", "usage:read"],
  })}.${Buffer.alloc(32, 1).toString("base64url")}`;
  const user = { id: "42", username: "user", display_name: "User", avatar_url: null };
  const bundle = {
    schema_version: 1,
    server_time: now,
    access_token: accessToken,
    access_expires_at: now + 60_000,
    refresh_token: "refresh-secret",
    refresh_expires_at: now + 600_000,
    token_type: "Bearer",
    session_id: owner.sid,
    user,
    relay_credential: { token: "sk-relay-secret", expires_at: now + 600_000 },
  };
  const client = new NewApiClient(owner.origin, {
    now: () => now,
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      const data = path.endsWith("/auth/token")
        ? bundle
        : path.endsWith("/me")
          ? {
              schema_version: 1,
              server_time: now,
              user,
              session_id: owner.sid,
              authorization_revision: "7",
            }
          : { schema_version: 1, server_time: now, revoked: true };
      return new Response(JSON.stringify({ success: true, data }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  const account = new NewApiAccountService({
    adapter: new NewApiProviderAdapter(client),
    repo: new NewApiSessionRepo(owner.origin, {
      credentialsFile: join(dir, "credentials.json"),
      cipherProvider: createCredentialCipherProvider({
        env: { ZCODE_CREDENTIAL_SECRET: "1".repeat(64) },
      }),
    }),
    now: () => now,
  });
  try {
    const start = await account.oauth.startOAuth("new-api");
    await account.oauth.handleCallback(
      `zcode://oauth/callback?provider=new-api&state=${start.state}&code=${"c".repeat(43)}`,
    );
    const currentOwner = account.getOwner()!;
    const native = resolveNewApiAccountProviders({
      owner: currentOwner,
      entitlements,
      catalog,
      configRevision: "builtin-1",
    });
    const snapshot = createAccountProviderConfigSnapshot(
      "builtin-1",
      native.providers,
      native.states,
      native,
    );
    const accountSource = new MutableAccountProviderConfigSource();
    accountSource.replace(snapshot);
    const auth = createNewApiAccountRequestAuthResolver({
      account,
      accountSource,
      official: {
        resolveAccessCurrent: async () => {
          throw new Error("unexpected official auth");
        },
        assertCurrent: async () => {
          throw new Error("unexpected official auth");
        },
        resolveCurrent: async () => {
          throw new Error("unexpected official auth");
        },
      },
    });
    const accountAccess = {
      type: "new-api-account",
      accountType: "new-api",
      mode: "private-subscription",
      entitled: true,
      owner: currentOwner,
      authorizationRevision: snapshot.authorizationRevision,
    } as const;
    const input = {
      providerId,
      modelId: "real-model",
      accountAccess,
      reason: "model-request",
    } as const;
    assert.deepEqual(await auth.resolveCurrent(input), { apiKey: "sk-relay-secret" });
    await assert.rejects(auth.resolveCurrent({ ...input, reason: "off-peak" }), /UNSUPPORTED/);
    await assert.rejects(
      auth.resolveCurrent({
        ...input,
        providerId: "account:zai-individual-coding-plan",
        accountAccess: {
          type: "zhipu-account",
          accountType: "zai",
          mode: "individual-coding-plan",
          entitled: true,
        },
      }),
      /RESELECT_REQUIRED/,
    );
    await assert.rejects(
      auth.resolveCurrent({
        ...input,
        accountAccess: { ...accountAccess, authorizationRevision: "old" },
      }),
    );
    await assert.rejects(
      auth.resolveCurrent({
        ...input,
        accountAccess: { ...accountAccess, owner: { ...currentOwner, authGeneration: 0 } },
      }),
    );
    await assert.rejects(auth.resolveCurrent({ ...input, modelId: "missing" }));
    const serialized = JSON.stringify(snapshot);
    for (const secret of [accessToken, bundle.refresh_token, bundle.relay_credential.token])
      assert.equal(serialized.includes(secret), false);
    await account.oauth.logout();
    await assert.rejects(auth.resolveCurrent(input));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "Native invalidation aborts active SDK streams without cancelling custom execution or reviving late auth",
  { timeout: 10_000 },
  async () => {
    const nativeId = "account:aiscoo-openai-chat-completions";
    const native = resolveNewApiAccountProviders({
      owner,
      entitlements,
      catalog: {
        ...catalog,
        models: [{ ...catalog.models[0]!, api_type: "openai-chat-completions" }],
      },
      configRevision: "builtin-1",
    });
    const resolution = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: createNewApiProviderAnchors(owner.origin),
      personalProviders: new ProviderConfigMap([
        [
          "custom",
          new ProviderConfig({
            group: "standard-personal",
            access: new ApiKeyAccessConfig({ apiKey: "sk-custom-test" }),
            api: new ProviderApiConfig({
              type: "openai-chat-completions",
              baseUrl: "https://custom.invalid/v1",
            }),
            personalModelIds: ["custom-model"],
          }),
        ],
      ]),
      zcodeBuiltinModelRules: ModelConfigRules.empty(),
      personalModels: new ModelConfigRules([
        {
          type: "provider-model",
          providerId: "custom",
          modelId: "custom-model",
          config: ModelConfig.fromData(modelConfig),
        },
      ]),
      accountProviders: native.providers,
      accountStates: native.states,
      accountModelConfigs: native.modelConfigs,
      accountOwner: owner,
      accountRevision: native.revision,
      accountAuthorizationRevision: native.authorizationRevision,
    });
    const registry = new ProviderRegistry(resolution.registryProviders);
    const runtime = new ApiProviderModelRuntime({
      registry,
      modelAdapter: new AiSdkModelAdapter({ env: {}, retry: { maxAttempts: 1 } }),
    });
    const originalFetch = globalThis.fetch;
    let nativeStarted = Promise.withResolvers<AbortSignal>();
    const customStarted = Promise.withResolvers<AbortSignal>();
    const nativeRequest = new AbortController();
    const customRequest = new AbortController();
    const consumption: Promise<void>[] = [];
    let nativeFetches = 0;
    globalThis.fetch = async (input, init) => {
      const custom = (input instanceof Request ? input.url : String(input)).startsWith(
        "https://custom.invalid/",
      );
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      assert.ok(signal);
      signal.throwIfAborted();
      if (!custom) nativeFetches++;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({
                id: "test-completion",
                object: "chat.completion.chunk",
                created: 1,
                model: custom ? "custom-model" : "real-model",
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
      (custom ? customStarted : nativeStarted).resolve(signal);
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    const consume = async (events: AsyncIterable<unknown>) => {
      try {
        for await (const _event of events) {
          /* Drain until cancellation. */
        }
      } catch {
        /* Cancellation may throw or emit a terminal event. */
      }
    };
    const request: ModelRequest = {
      messages: [{ role: "user", content: "hello" }],
      options: { maxOutputTokens: 32 },
    };
    runtime.start();
    try {
      const nativeModel = runtime.modelFactory({
        selection: {
          providerId: nativeId,
          modelId: "real-model",
          options: { reasoningLevel: "none" },
        },
      });
      assert.equal(nativeModel.displayName, "Real");
      const customModel = runtime.modelFactory({
        selection: {
          providerId: "custom",
          modelId: "custom-model",
          options: { reasoningLevel: "none" },
        },
      });
      consumption.push(
        runWithModelInvocationContext(
          {
            refreshRuntimeHeadersBeforeAttempt: async () => ({
              headersApplied: true,
              requestAuth: { apiKey: "sk-native-test" },
            }),
          },
          () => consume(nativeModel.streamText({ ...request, abortSignal: nativeRequest.signal })),
        ),
      );
      consumption.push(
        consume(customModel.streamText({ ...request, abortSignal: customRequest.signal })),
      );
      const [nativeSignal, customSignal] = await Promise.all([
        nativeStarted.promise,
        customStarted.promise,
      ]);
      registry.replace(
        resolution.registryProviders.map((provider) =>
          provider.providerId === nativeId
            ? { ...provider, accountRevision: `${native.revision}:capability-refresh` }
            : provider,
        ),
        "native-capability-change",
      );
      assert.equal(
        nativeSignal.aborted,
        false,
        "capability-only publication must preserve the turn",
      );
      assert.equal(customSignal.aborted, false);
      registry.replace(
        resolution.registryProviders.map((provider) =>
          provider.providerId === nativeId
            ? {
                ...provider,
                accountOwner: { ...owner, authGeneration: 2 },
                accountRevision: `${native.revision}:replacement`,
              }
            : provider,
        ),
        "native-owner-change",
      );
      assert.equal(nativeSignal.aborted, true);
      assert.equal(customSignal.aborted, false);
      await consumption[0];

      const disabled = createRegistryModelConfig(
        ModelConfig.fromData({ ...modelConfig, enabled: false }),
      );
      assert.ok(disabled.ok);
      const changes: Array<(provider: Provider) => Provider> = [
        (provider) => ({ ...provider, accountAuthorizationRevision: "replacement-auth" }),
        (provider) => ({ ...provider, models: [] }),
        (provider) => ({
          ...provider,
          models: provider.models.map((model) => ({ ...model, config: disabled.config })),
        }),
      ];
      for (const change of changes) {
        registry.replace(resolution.registryProviders, "native-restored");
        nativeStarted = Promise.withResolvers<AbortSignal>();
        const model = runtime.modelFactory({
          selection: {
            providerId: nativeId,
            modelId: "real-model",
            options: { reasoningLevel: "none" },
          },
        });
        const consuming = runWithModelInvocationContext(
          {
            refreshRuntimeHeadersBeforeAttempt: async () => ({
              headersApplied: true,
              requestAuth: { apiKey: "sk-native-test" },
            }),
          },
          () => consume(model.streamText(request)),
        );
        consumption.push(consuming);
        const signal = await nativeStarted.promise;
        registry.replace(
          resolution.registryProviders.map((provider) =>
            provider.providerId === nativeId ? change(provider) : provider,
          ),
          "native-eligibility-lost",
        );
        assert.equal(signal.aborted, true);
        assert.equal(customSignal.aborted, false);
        await consuming;
      }
      registry.replace(resolution.registryProviders, "native-restored-before-late-auth");
      const fetchesBeforeLateAuth = nativeFetches;

      const waitingModel = runtime.modelFactory({
        selection: {
          providerId: nativeId,
          modelId: "real-model",
          options: { reasoningLevel: "none" },
        },
      });
      const authStarted = Promise.withResolvers<void>();
      const lateAuth = Promise.withResolvers<{
        headersApplied: boolean;
        requestAuth: { apiKey: string };
      }>();
      const waiting = runWithModelInvocationContext(
        {
          refreshRuntimeHeadersBeforeAttempt: () => {
            authStarted.resolve();
            return lateAuth.promise;
          },
        },
        () => consume(waitingModel.streamText(request)),
      );
      consumption.push(waiting);
      await authStarted.promise;
      registry.replace(
        resolution.registryProviders.filter((provider) => provider.providerId !== nativeId),
        "native-owner-lost",
      );
      lateAuth.resolve({ headersApplied: true, requestAuth: { apiKey: "sk-late-native-test" } });
      await waiting;
      assert.equal(nativeFetches, fetchesBeforeLateAuth);
      assert.equal(customSignal.aborted, false);
    } finally {
      runtime.dispose();
      nativeRequest.abort();
      customRequest.abort();
      await Promise.allSettled(consumption);
      globalThis.fetch = originalFetch;
    }
  },
);

test("Native authorization updates abort a held protocol generation while preserving ordinary request serialization", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const replies: ZCodeProtocolMessage[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").trim().split("\n")) {
      replies.push(zcodeProtocolMessageSchema.parse(JSON.parse(line)));
    }
  });
  const modelAbort = new AbortController();
  const generationStarted = Promise.withResolvers<void>();
  const modelAborted = Promise.withResolvers<void>();
  const finishGeneration = Promise.withResolvers<void>();
  const ordinaryFinished = Promise.withResolvers<void>();
  let generationFinished = false;
  let ordinaryStarted = false;
  let acceptedRevision: string | undefined;
  modelAbort.signal.addEventListener("abort", () => modelAborted.resolve(), { once: true });
  const connection = new ZCodeProtocolNdjsonConnection({
    input,
    output,
    handleMessage: async (message) => {
      assert.ok("id" in message && "method" in message);
      switch (message.method) {
        case zcodeProtocolMethods.workspaceGenerateText:
          generationStarted.resolve();
          await modelAborted.promise;
          // 模拟 SDK abort 后仍在清理的请求，普通请求不能越过该请求。
          await finishGeneration.promise;
          generationFinished = true;
          return { id: message.id, result: { cancelled: modelAbort.signal.aborted } };
        case zcodeProtocolMethods.providerUpdateAccountConfig: {
          const snapshot = zcodeProviderUpdateAccountConfigParamsSchema.parse(message.params);
          acceptedRevision = snapshot.revision;
          modelAbort.abort();
          return { id: message.id, result: { acceptedRevision } };
        }
        case zcodeProtocolMethods.workspaceReadPresentation:
          ordinaryStarted = true;
          ordinaryFinished.resolve();
          return {
            id: message.id,
            result: { acceptedRevision, generationFinished },
          };
        default:
          assert.fail(`Unexpected protocol method: ${message.method}`);
      }
    },
  });
  connection.start();
  const send = (id: string, method: string, params: unknown) => {
    input.write(`${JSON.stringify({ id, method, params })}\n`);
  };
  try {
    send("generate", zcodeProtocolMethods.workspaceGenerateText, {
      prompt: "held Native generation",
      modelSelection: { providerId, modelId: "real-model" },
    });
    await generationStarted.promise;
    send("ordinary", zcodeProtocolMethods.workspaceReadPresentation, {});
    send("authorize", zcodeProtocolMethods.providerUpdateAccountConfig, envelope());
    await setImmediate();
    assert.equal(
      modelAbort.signal.aborted,
      true,
      "the authorization update must abort the model before held generation finishes",
    );
    assert.equal(acceptedRevision, "revision-1");
    assert.equal(generationFinished, false);
    assert.equal(ordinaryStarted, false, "ordinary requests must remain serialized");
    finishGeneration.resolve();
    await ordinaryFinished.promise;
    await setImmediate();
    assert.deepEqual(
      replies.find((reply) => "id" in reply && reply.id === "generate"),
      { id: "generate", result: { cancelled: true } },
    );
    assert.deepEqual(
      replies.find((reply) => "id" in reply && reply.id === "authorize"),
      { id: "authorize", result: { acceptedRevision: "revision-1" } },
    );
    assert.deepEqual(
      replies.find((reply) => "id" in reply && reply.id === "ordinary"),
      { id: "ordinary", result: { acceptedRevision: "revision-1", generationFinished: true } },
    );
  } finally {
    modelAbort.abort();
    finishGeneration.resolve();
    input.end();
    await connection.waitForClose();
    input.destroy();
    output.destroy();
  }
});
