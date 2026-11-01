import { describe, expect, it } from "vitest";
import { createZenDefaultDependencies } from "@zcode/adapters/auth";
import { resolveZenAccountProviders } from "../src/zen/index.js";
import { createAccountProviderConfigSnapshot } from "@zcode/provider";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ZenAccountRuntime } from "../src/zen/index.js";
import { startProcessProviderRegistryRuntime } from "../src/zen/index.js";
import {
  NewApiCatalogSchema,
  NewApiEntitlementsSchema,
  NEW_API_MODEL_PROVIDER_IDS,
} from "@zcode/shared";

describe("Zen account model authorization", () => {
  it("product credentials canonicalize every key before policy or backing IO", async () => {
    const { createAiscooProductCredentialStore } =
      await import("../src/zen/product-credentials.js");
    const values: Record<string, string> = {
      "oauth:zai:access_token": "old-official",
      zcodejwttoken: "old-jwt",
      "mcp:oauth:third-party:authorization_credentials": "third-party-credentials",
      "account-provider:old:identity": "official-user",
      "account-provider:old:auth-source": "oauth",
      "account-provider:coding-plan:old:account:official-user:api-key": "old-derived-key",
      "account-provider:manual:identity": "key-user",
      "account-provider:manual:auth-source": "manual",
      "account-provider:coding-plan:manual:account:key-user:api-key": "manual-key",
    };
    // 复现底层 validateCredentialKey 的 trim 行为；每次 backing 调用都记录，拒绝不能产生 IO。
    const calls: string[] = [];
    const backing = {
      load: async (key: string) => {
        calls.push(`load:${key}`);
        return values[key.trim()] ?? null;
      },
      save: async (key: string) => {
        calls.push(`save:${key}`);
      },
      saveMany: async (entries: Record<string, string>) => {
        calls.push(`saveMany:${Object.keys(entries).join(",")}`);
      },
      saveReplacing: async (key: string, _value: string, replaced: string[]) => {
        calls.push(`saveReplacing:${key}:${replaced.join(",")}`);
      },
      delete: async (key: string) => {
        calls.push(`delete:${key}`);
      },
      deleteIfValue: async (key: string) => {
        calls.push(`deleteIfValue:${key}`);
        return true;
      },
      deleteIfValues: async (entries: Record<string, string>) => {
        calls.push(`deleteIfValues:${Object.keys(entries).join(",")}`);
        return {};
      },
      deleteManyIfValue: async (key: string, _value: string, deleted: string[]) => {
        calls.push(`deleteManyIfValue:${key}:${deleted.join(",")}`);
        return true;
      },
      clearZaiLoginCredentials: async () => {
        calls.push("clearZaiLoginCredentials");
      },
      saveZaiLoginCredentials: async () => {
        calls.push("saveZaiLoginCredentials");
      },
    };
    const store = createAiscooProductCredentialStore({}, backing as never);
    const allowed = "mcp:oauth:third-party:authorization_credentials";
    for (const key of ["oauth:zai:access_token", "oauth:bigmodel:access_token", "zcodejwttoken"]) {
      for (const variant of [key, ` ${key}`, `${key} `, `\t ${key} \r\n`]) {
        calls.length = 0;
        expect(await store.load(variant)).toBeNull();
        const blocked = [
          () => store.loadMany([allowed, variant]),
          () => store.loadMany([variant, allowed]),
          () => store.save(variant, "replacement"),
          () => store.saveMany({ [allowed]: "safe", [variant]: "replacement" }),
          () => store.saveMany({ [variant]: "replacement", [allowed]: "safe" }),
          () => store.delete(variant),
          () => store.deleteIfValue(variant, "old-official"),
          () => store.deleteIfValues({ [allowed]: "safe", [variant]: "old-official" }),
          () => store.saveReplacing(variant, "replacement", [allowed]),
          () => store.saveReplacing(allowed, "replacement", [allowed, variant]),
          () => store.deleteManyIfValue(variant, "old-official", [allowed]),
          () => store.deleteManyIfValue(allowed, "safe", [allowed, variant]),
        ];
        for (const operation of blocked) {
          await expect(operation()).rejects.toThrow("AISCOO_ACCOUNT_LOGIN_UNSUPPORTED");
          expect(calls).toEqual([]);
        }
      }
    }
    await expect(store.clearZaiLoginCredentials()).rejects.toThrow(
      "AISCOO_ACCOUNT_LOGIN_UNSUPPORTED",
    );
    await expect(store.saveZaiLoginCredentials({} as never)).rejects.toThrow(
      "AISCOO_ACCOUNT_LOGIN_UNSUPPORTED",
    );
    expect(calls).toEqual([]);
    const readable = Object.keys(values).filter(
      (key) => !key.startsWith("oauth:") && key !== "zcodejwttoken",
    );
    expect(await store.loadMany(readable.map((key) => `\t ${key} \n`))).toEqual({
      [allowed]: "third-party-credentials",
      "account-provider:old:identity": null,
      "account-provider:old:auth-source": null,
      "account-provider:coding-plan:old:account:official-user:api-key": null,
      "account-provider:manual:identity": "key-user",
      "account-provider:manual:auth-source": "manual",
      "account-provider:coding-plan:manual:account:key-user:api-key": "manual-key",
    });
    expect(calls).not.toContain("load:account-provider:old:identity");
    expect(calls).not.toContain(
      "load:account-provider:coding-plan:old:account:official-user:api-key",
    );
    calls.length = 0;
    await store.save(` ${allowed} `, "own-token");
    await store.saveMany({ " own-api-key ": "own-secret" });
    await store.delete(" own-api-key ");
    await store.saveReplacing(` ${allowed} `, "own-token", [" own-api-key "]);
    await store.deleteIfValue(" own-api-key ", "own-secret");
    await store.deleteIfValues({ " own-api-key ": "own-secret" });
    await store.deleteManyIfValue(` ${allowed} `, "own-token", [" own-api-key "]);
    expect(calls).toEqual([
      `save:${allowed}`,
      "saveMany:own-api-key",
      "delete:own-api-key",
      `saveReplacing:${allowed}:own-api-key`,
      "deleteIfValue:own-api-key",
      "deleteIfValues:own-api-key",
      `deleteManyIfValue:${allowed}:own-api-key`,
    ]);
    expect(values["oauth:zai:access_token"]).toBe("old-official");
    expect(values.zcodejwttoken).toBe("old-jwt");
  });
  it.each([
    {},
    { NEW_API_BASE_URL: "http://127.0.0.1:3001" },
    { AISCOO_ADMIN_BASE_URL: "", NEW_API_BASE_URL: "http://127.0.0.1:3001" },
  ])("缺少新键时先拒绝配置，不访问系统安全库：%j", async (env) => {
    await expect(createZenDefaultDependencies(env)).rejects.toThrow("Set AISCOO_ADMIN_BASE_URL");
  });

  it("publishes a restored owner through the actual standalone AccountProviderService", async () => {
    const directory = await mkdtemp(join(tmpdir(), "zen-registry-"));
    const configPath = join(directory, "builtin.json");
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        config: {
          providerConfigRules: { providerRules: [], templateRules: [] },
          modelConfigRules: {
            modelRules: [],
            modelApiRules: [],
            providerSiteRules: [],
            templateModelRules: [],
            builtinProviderModelRules: [],
          },
        },
      }),
    );
    const user = { id: "1", username: "test", display_name: "Test", avatar_url: null };
    const now = Date.now();
    const bundle = {
      schema_version: 1,
      server_time: now,
      access_token: "control",
      access_expires_at: now + 100000,
      refresh_token: "refresh",
      refresh_expires_at: now + 200000,
      token_type: "Bearer",
      session_id: "sid",
      user,
      relay_credential: { token: "sk-test", expires_at: now + 200000 },
    };
    const account = new ZenAccountRuntime({
      client: { origin: "https://zen.example.com", me: async () => ({ user, session_id: "sid" }) },
      store: { read: async () => ({ revision: "saved", value: bundle }) },
    } as never);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) =>
      Response.json({
        success: true,
        data: String(url).endsWith("/models")
          ? {
              schema_version: 1,
              server_time: now,
              catalog_revision: "one",
              authorization_revision: "1",
              models: [],
            }
          : {
              schema_version: 1,
              server_time: now,
              status: "unassigned",
              authorization_revision: "1",
              subscription: null,
              quota: null,
              funding_policy: {
                subscription_only: true,
                wallet_fallback: false,
                other_subscription_fallback: false,
              },
              self_service_reset: false,
              purchase_mode: "manual_admin",
            },
      });
    try {
      const runtime = await startProcessProviderRegistryRuntime(
        {
          ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: configPath,
          ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(directory, "personal.json"),
          AISCOO_ADMIN_BASE_URL: "https://zen.example.com",
          ZCODE_DATA_BASE_DIR: directory,
        },
        {
          standalone: {
            zenAccount: account,
            legacyCliUserConfigFilePath: join(directory, "absent"),
          },
        },
      );
      expect(runtime.zenAccount?.getOwner()?.userId).toBe("1");
      expect((await runtime.accountSource.read()).owner?.userId).toBe("1");
      await runtime.refreshStandaloneAccount("test-refresh");
      expect((await runtime.accountSource.read()).revision).toMatch(
        /^account:sha256:[a-f0-9]{64}$/,
      );
      expect(await runtime.readZenModelStatus()).toMatchObject({ available: false });
      const model = {
        model_id: "zen-model",
        display_name: "Zen Test",
        api_type: "openai-chat-completions",
        enabled: true,
        disabled_reason: null,
        model_config: {
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
        },
      };
      globalThis.fetch = async (url) =>
        Response.json({
          success: true,
          data: String(url).endsWith("/models")
            ? {
                schema_version: 1,
                server_time: now,
                catalog_revision: "two",
                authorization_revision: "2",
                models: [model],
              }
            : {
                schema_version: 1,
                server_time: now,
                status: "active",
                authorization_revision: "2",
                subscription: {
                  id: "1",
                  plan_id: "1",
                  plan_title: "Test",
                  source: "admin",
                  usage_scope: "xcode",
                  start_time: now,
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
              },
        });
      await runtime.refreshStandaloneAccount("plan-available");
      expect(await runtime.readZenModelStatus()).toMatchObject({ available: true });
      const requestInput = {
        accountAccess: {
          type: "new-api-account" as const,
          accountType: "new-api" as const,
          mode: "private-subscription" as const,
          entitled: true,
          owner: account.getOwner()!,
          authorizationRevision: "2",
        },
        providerId: NEW_API_MODEL_PROVIDER_IDS["openai-chat-completions"],
        modelId: "zen-model",
        reason: "model-request" as const,
        sessionId: "test" as never,
        traceContext: { traceId: "test" } as never,
      };
      expect(
        await runtime.providerRuntimeHeadersPort!.refreshBeforeModelRequest(requestInput),
      ).toMatchObject({ requestAuth: { apiKey: "sk-test" } });
      globalThis.fetch = async () =>
        Response.json({ success: false, code: "XCODE_SESSION_INVALID" }, { status: 401 });
      await expect(
        runtime.providerRuntimeHeadersPort!.refreshBeforeModelRequest(requestInput),
      ).rejects.toThrow();
      await expect(
        runtime.providerRuntimeHeadersPort!.refreshBeforeModelRequest({
          accountAccess: {
            type: "new-api-account",
            accountType: "new-api",
            mode: "private-subscription",
            entitled: true,
            owner: account.getOwner()!,
            authorizationRevision: "1",
          },
          providerId: NEW_API_MODEL_PROVIDER_IDS["openai-chat-completions"],
          modelId: "missing-model",
          reason: "model-request",
          sessionId: "test" as never,
          traceContext: { traceId: "test" } as never,
        }),
      ).rejects.toThrow();
      runtime.dispose();
    } finally {
      globalThis.fetch = originalFetch;
      await rm(directory, { recursive: true, force: true });
    }
  });
  it("projects only enabled complete catalog models with the current entitlement", () => {
    const owner = { origin: "https://zen.example.com", userId: "1", sid: "sid", authGeneration: 1 };
    const entitlements = NewApiEntitlementsSchema.parse({
      schema_version: 1,
      server_time: 1,
      status: "active",
      authorization_revision: "7",
      subscription: {
        id: "1",
        plan_id: "2",
        plan_title: "Assigned",
        source: "admin",
        usage_scope: "xcode",
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
    const catalog = NewApiCatalogSchema.parse({
      schema_version: 1,
      server_time: 1,
      catalog_revision: "catalog-1",
      authorization_revision: "7",
      models: [
        {
          model_id: "real-model",
          display_name: "Real",
          api_type: "openai-chat-completions",
          enabled: true,
          disabled_reason: null,
          model_config: {
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
          },
        },
      ],
    });
    const result = resolveZenAccountProviders({ owner, entitlements, catalog });
    const id = NEW_API_MODEL_PROVIDER_IDS["openai-chat-completions"];
    expect(result.providers.get(id)?.builtinModelIds).toEqual(["real-model"]);
    expect(result.states[id]?.entitled).toBe(true);
    expect(result.modelConfigs[id]?.["real-model"]?.enabled).toBe(true);
    expect(result.authorizationRevision).toBe("7");
    expect(() =>
      createAccountProviderConfigSnapshot("builtin:1", result.providers, result.states, result),
    ).not.toThrow();
    expect(
      resolveZenAccountProviders({
        owner,
        entitlements: { ...entitlements, status: "unassigned", subscription: null } as never,
        catalog,
      }).states[id]?.entitled,
    ).toBe(false);
  });
  it("keeps all native providers unavailable when no account is restored", () => {
    const result = resolveZenAccountProviders({ owner: null });
    expect(result.providers.entries().length).toBeGreaterThan(0);
    for (const [, config] of result.providers.entries()) {
      expect(config.access?.entitled).toBe(false);
      expect(config.builtinModelIds).toEqual([]);
    }
  });
  it("rejects inconsistent entitlement and catalog revisions", () => {
    expect(() =>
      resolveZenAccountProviders({
        owner: { origin: "https://zen.example.com", userId: "1", sid: "sid", authGeneration: 1 },
        entitlements: { authorization_revision: "1" } as never,
        catalog: { authorization_revision: "2" } as never,
      }),
    ).toThrow("XCODE_AUTHORIZATION_REVISION_MISMATCH");
  });
});
