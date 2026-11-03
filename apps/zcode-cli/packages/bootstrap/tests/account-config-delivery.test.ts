import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderConfigMap, ModelConfig, ModelConfigRules, createAccountProviderConfigSnapshot } from "@zcode/provider";
import {
  ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV,
  ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV,
} from "@zcode/provider-node";
import { AISCOO_MODEL_PROVIDER_IDS, zcodeProtocolMethods } from "@zcode/shared";
import {
  startProcessProviderRegistryRuntime,
  parseProcessAccountProviderConfigSnapshot,
} from "../src/app/process-provider-registry-runtime.js";
import { ZCodeProtocolAgentServer } from "../src/zcode-protocol/server.js";
import { createTestProviderRegistry } from "./helpers/registry-backed-test-app.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function startRuntime(env: Readonly<Record<string, string | undefined>> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "account-delivery-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const started = await startProcessProviderRegistryRuntime({
    ...env,
    [ZCODE_BUILTIN_PROVIDER_CONFIG_FILE_ENV]: fileURLToPath(
      new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
    ),
    [ZCODE_PERSONAL_PROVIDER_CONFIG_FILE_ENV]: join(directory, "personal.json"),
  });
  cleanups.unshift(async () => started.dispose());
  return started;
}

describe("托管 Worker 账号交付", () => {
  it.each([
    { env: { AISCOO_ADMIN_BASE_URL: "http://127.0.0.1:3001" }, enabled: true },
    { env: { NEW_API_BASE_URL: "http://127.0.0.1:3001" }, enabled: false },
    {
      env: {
        AISCOO_ADMIN_BASE_URL: "",
        NEW_API_BASE_URL: "http://127.0.0.1:3001",
      },
      enabled: false,
    },
    {
      env: {
        AISCOO_ADMIN_BASE_URL: "http://127.0.0.1:3001",
        NEW_API_BASE_URL: "http://127.0.0.1:3002",
      },
      enabled: true,
    },
  ])("仅新配置键启用 Native origin，旧键不回退：$env", async ({ env, enabled }) => {
    const started = await startRuntime(env);
    // 配置地址只装配锚点；账号未授权时 Registry 仍关闭，不能用可执行投影验证配置。
    const provider = started.snapshot.config.zcodeBuiltinProviders.get(
      AISCOO_MODEL_PROVIDER_IDS["openai-chat-completions"],
    );
    if (enabled) {
      expect(provider?.api?.baseUrl).toBe("http://127.0.0.1:3001/v1");
    } else {
      expect(provider).toBeUndefined();
    }
  });

  it("Account B 先到时接收 B、立即撤销失效授权；配套配置到后才确认整体应用 B", async () => {
    const started = await startRuntime();
    const registry = started.runtime.registryService;
    const previous = registry.getSnapshot();
    const next = createAccountProviderConfigSnapshot("builtin-B", ProviderConfigMap.empty(), {});
    const server = new ZCodeProtocolAgentServer({
      createZCodeApp() {
        throw new Error("账号交付不得创建会话");
      },
      syncAccountProviderConfig: started.syncAccountProviderConfig,
    });
    expect(
      await server.handleMessage({
        id: 1,
        method: zcodeProtocolMethods.providerUpdateAccountConfig,
        params: {
          ...next,
          providers: Object.fromEntries(
            [...next.providers.entries()].map(([id, config]) => [id, config.toJSON()]),
          ),
        },
      }),
    ).toMatchObject({
      result: {
        receivedRevision: next.revision,
        appliedRevision: previous?.sourceRevisions.account,
        providerCount: 0,
        status: "received",
      },
    });
    expect((await started.accountSource.read()).revision).toBe(next.revision);
    expect(registry.getSnapshot()?.account.revision).toBe(next.revision);
    expect(registry.getSnapshot()?.sourceRevisions).toEqual(previous?.sourceRevisions);

    const config = await started.runtime.configService.read();
    vi.spyOn(started.runtime.configService, "read").mockResolvedValue({
      ...config,
      revision: "config-B",
      zcodeBuiltinRevision: "builtin-B",
    });
    await registry.refresh("配套配置到达");
    expect(registry.getSnapshot()?.sourceRevisions.account).toBe(next.revision);
    expect(registry.getSnapshot()?.config.zcodeBuiltinRevision).toBe("builtin-B");
  });

  it("刷新失败后同一份快照重交仍刷新，不能因 Source 已收过而跳过", async () => {
    const started = await startRuntime();
    const next = createAccountProviderConfigSnapshot(
      started.snapshot.config.zcodeBuiltinRevision,
      ProviderConfigMap.empty(),
      {},
    );
    const refresh = vi
      .spyOn(started.runtime.registryService, "refresh")
      .mockRejectedValueOnce(new Error("refresh failed"));
    await expect(started.syncAccountProviderConfig(next)).rejects.toThrow("refresh failed");
    await expect(started.syncAccountProviderConfig(next)).resolves.toEqual({
      changed: false,
      appliedRevision: next.revision,
    });
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(started.runtime.registryService.getSnapshot()?.account.revision).toBe(next.revision);
  });

  it("Native 展示与 owner 同快照应用，能力只使用配套 Built-in，缺 current 时失败关闭", async () => {
    const origin = "http://127.0.0.1:3001";
    const started = await startRuntime({ AISCOO_ADMIN_BASE_URL: origin });
    const providerId = AISCOO_MODEL_PROVIDER_IDS["anthropic-messages"];
    const modelId = "native-model";
    const modelConfig = createTestProviderRegistry([{ providerId, modelId }])
      .getModel(providerId, modelId)!
      .config.toJSON();
    const owner = { origin, userId: "1", sid: "native-session", authGeneration: 1 };
    const envelope = {
      revision: `account:sha256:${"a".repeat(64)}`,
      basedOnZCodeBuiltinRevision: started.snapshot.config.zcodeBuiltinRevision,
      providers: {
        [providerId]: {
          access: {
            type: "new-api-account",
            accountType: "new-api",
            mode: "private-subscription",
            entitled: true,
          },
          builtinModelIds: [modelId],
        },
      },
      states: {
        [providerId]: { availability: "available", entitled: true, current: true },
      },
      owner,
      modelPresentation: { [providerId]: { [modelId]: { displayName: "Native" } } },
      catalogIssues: [],
      catalogRevision: "catalog-1",
      authorizationRevision: "authorization-1",
    };
    const config = await started.runtime.configService.read();
    vi.spyOn(started.runtime.configService, "read").mockResolvedValue({
      ...config, revision: "config-with-native-rules",
      zcodeBuiltinModelRules: new ModelConfigRules([{ type: "provider-model", providerId, modelId, config: ModelConfig.fromData(modelConfig) }]),
    });
    const snapshot = parseProcessAccountProviderConfigSnapshot(envelope);
    await expect(started.syncAccountProviderConfig(snapshot)).resolves.toMatchObject({
      appliedRevision: envelope.revision,
    });
    const applied = started.runtime.registryService.getSnapshot();
    expect(applied?.sourceRevisions.account).toBe(envelope.revision);
    expect(applied?.account.owner).toEqual(owner);
    expect(applied?.account.modelPresentation).toEqual(envelope.modelPresentation);
    expect(applied?.account.authorizationRevision).toBe("authorization-1");
    expect(started.runtime.registryService.getModel(providerId, modelId)?.config.toJSON()).toEqual(
      modelConfig,
    );
    expect(() =>
      parseProcessAccountProviderConfigSnapshot({ ...envelope, modelPresentation: { [providerId]: { [modelId]: modelConfig } } }),
    ).toThrow();
    expect(() =>
      parseProcessAccountProviderConfigSnapshot({
        ...envelope,
        states: {
          [providerId]: { availability: "available", entitled: true, current: false },
        },
      }),
    ).toThrow("Native Account owner/current missing");
    const waiting = parseProcessAccountProviderConfigSnapshot({
      ...envelope,
      revision: `account:sha256:${"b".repeat(64)}`,
      basedOnZCodeBuiltinRevision: "builtin-not-delivered",
      owner: { ...owner, sid: "next-session", authGeneration: 2 },
      authorizationRevision: "authorization-2",
    });
    await expect(started.syncAccountProviderConfig(waiting)).resolves.toMatchObject({
      appliedRevision: envelope.revision,
    });
    expect(started.runtime.registryService.getSnapshot()?.account.revision).toBe(waiting.revision);
    expect(started.runtime.registryService.getSnapshot()?.sourceRevisions.account).toBe(
      envelope.revision,
    );
    expect(started.runtime.registryService.getModel(providerId, modelId)).toBeUndefined();
  });

  it("普通账号有权益却缺 current 时拒绝交付，不能宽松放行", () => {
    expect(() =>
      parseProcessAccountProviderConfigSnapshot({
        revision: "incomplete",
        basedOnZCodeBuiltinRevision: "builtin-A",
        providers: {
          "account:bigmodel-individual-coding-plan": {
            access: { type: "zhipu-account", entitled: true },
          },
        },
        states: {},
      }),
    ).toThrow("current");
  });

  it.each([
    { providerId: "account:bigmodel-individual-coding-plan", entitled: false },
    { providerId: "account:bigmodel-offpeak-idle-plan", entitled: true },
  ])("初始 fail-closed 和闲时不被强加 current：$providerId", ({ providerId, entitled }) => {
    expect(() =>
      parseProcessAccountProviderConfigSnapshot({
        revision: "allowed",
        basedOnZCodeBuiltinRevision: "builtin-A",
        states: {},
        providers: { [providerId]: { access: { type: "zhipu-account", entitled } } },
      }),
    ).not.toThrow();
  });
});
