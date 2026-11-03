// XCODE: 自有静态模板使用共享品牌，用户插值和兼容标识保持不变。
import { PRODUCT_NAME } from "@zcode/shared/aiscoo-brand";
// XCODE: 独立 CLI 的 Zen 账号组合层；上游 Process runtime 仅提供 extendAccountResolution 扩展点。
import { createHash } from "node:crypto";
import { AccountProviderService, ProviderConfigMap } from "@zcode/provider";
import type { ProviderRuntimeHeadersPort } from "@zcode/core";
import { ZenClient } from "@zcode/adapters/auth";
import { normalizeNewApiOrigin } from "@zcode/shared";
import {
  startProcessProviderRegistryRuntime as startUpstreamRuntime,
  type ProcessAccountResolution,
  type ProcessProviderRegistryRuntimeOptions,
} from "../app/process-provider-registry-runtime.js";
import { ZenAccountRuntime } from "./account.js";
import { resolveZenAccountProviders } from "./account-provider.js";
import { createZenAccount } from "./factory.js";
import { createAiscooProductCredentialStore } from "./product-credentials.js";

export interface ZenProcessProviderRegistryRuntimeOptions extends ProcessProviderRegistryRuntimeOptions {
  readonly standalone?: ProcessProviderRegistryRuntimeOptions["standalone"] & {
    /** 嵌入式 CLI 可提供同一账号 owner，测试使用隔离端口。 */
    readonly zenAccount?: ZenAccountRuntime;
  };
}

type ZenHeadersInput = Parameters<ProviderRuntimeHeadersPort["refreshBeforeModelRequest"]>[0];

export interface ZenModelStatus {
  available: boolean;
  reason: string | null;
}

async function mergeZenResolution(
  zenAccount: ZenAccountRuntime,
  resolved: ProcessAccountResolution,
  configRevision: string,
): Promise<ProcessAccountResolution> {
  const zen = await zenAccount
    .withControlSession(async (token, owner) => {
      const client = new ZenClient(owner.origin);
      const [entitlements, catalog] = await Promise.all([
        client.entitlements(token),
        client.catalog(token),
      ]);
      return resolveZenAccountProviders({ owner, entitlements, catalog, configRevision });
    })
    .catch((error) => {
      if (zenAccount.getOwner()) throw error;
      return resolveZenAccountProviders({ owner: null });
    });
  const combined = {
    ...zen,
    providers: new ProviderConfigMap([...resolved.providers.entries(), ...zen.providers.entries()]),
    states: { ...resolved.states, ...zen.states },
  };
  // 官方连接也是同一 Account 快照的一部分，不能只按 Zen revision 去重。
  return {
    ...combined,
    revision: `account:sha256:${createHash("sha256")
      .update(JSON.stringify([configRevision, combined]))
      .digest("hex")}`,
  };
}

/**
 * 启动进程 Provider Registry；独立 CLI 且配置 AISCOO_ADMIN_BASE_URL 时叠加 Zen 账号。
 * 缺少 Zen 配置时保留自配 Provider；产品 store 始终阻止旧官方账号恢复。
 */
export async function startProcessProviderRegistryRuntime(
  env: Readonly<Record<string, string | undefined>>,
  options: ZenProcessProviderRegistryRuntimeOptions = {},
) {
  const standalone = options.standalone && {
    ...options.standalone,
    // 只切换 Built-in 源；配置缺失或非法时不回退官方，也不影响其他上游 endpoint。
    resolveBuiltinEndpointOrigin: () => {
      if (!env.AISCOO_ADMIN_BASE_URL?.trim()) throw new Error("AISCOO_ACCOUNT_CONFIG_UNAVAILABLE");
      return normalizeNewApiOrigin(env.AISCOO_ADMIN_BASE_URL.trim());
    },
    credentialStore: createAiscooProductCredentialStore(env, options.standalone.credentialStore),
  };
  const productOptions = { ...options, ...(standalone ? { standalone } : {}) };
  const zenAccount =
    standalone?.zenAccount ??
    (standalone && env.AISCOO_ADMIN_BASE_URL?.trim() ? await createZenAccount(env) : undefined);
  if (!standalone || !zenAccount) {
    const upstream = await startUpstreamRuntime(env, productOptions);
    return Object.freeze({
      ...upstream,
      zenAccount: undefined,
      async refreshStandaloneAccount(reason: string) {
        await upstream.runtime.registryService.refresh(reason);
      },
      async readZenModelStatus(): Promise<ZenModelStatus> {
        return { available: false, reason: `${PRODUCT_NAME} Zen Plan is unavailable.` };
      },
    });
  }
  try {
    await zenAccount.restore();
  } catch (error) {
    standalone.onAccountInitializationError?.(error);
  }
  let upstream: Awaited<ReturnType<typeof startUpstreamRuntime>>;
  try {
    upstream = await startUpstreamRuntime(env, {
      ...options,
      standalone: {
        ...standalone,
        extendAccountResolution: (resolved, configRevision) =>
          mergeZenResolution(zenAccount, resolved, configRevision),
      },
    });
  } catch (error) {
    zenAccount.dispose();
    throw error;
  }
  const accountService = upstream.accountSource;
  if (!(accountService instanceof AccountProviderService))
    throw new Error("Zen 需要独立 CLI 的 AccountProviderService");
  // owner 事件仅同步撤销 Native 投影；登录命令和请求准入负责刷新，避免读取中撤销再排队读取成环。
  // 订阅放在 runtime 启动之后：启动期间的 owner 变化已被 resolver 内 withControlSession 的代次检查覆盖。
  const disposeZenSubscription = zenAccount.onDidChange(() => {
    accountService.invalidateNative(false);
  });
  const headers = upstream.providerRuntimeHeadersPort!;
  const providerRuntimeHeadersPort: ProviderRuntimeHeadersPort = {
    shouldRefreshBeforeModelRequest: headers.shouldRefreshBeforeModelRequest?.bind(headers),
    async refreshBeforeModelRequest(input: ZenHeadersInput) {
      if (input.accountAccess?.type !== "new-api-account")
        return headers.refreshBeforeModelRequest(input);
      // 请求准入刷新权威目录，撤销套餐或模型不能沿用上次列表的执行资格。
      await accountService.refresh("zen-model-request");
      const access = input.accountAccess;
      const owner = zenAccount.getOwner();
      const snapshot = await accountService.read();
      const assertAuthorized = (current: typeof snapshot) => {
        const provider = current.providers.get(input.providerId);
        if (
          !owner ||
          !access.owner ||
          !zenAccount.isCurrent(access.owner) ||
          !current.owner ||
          !zenAccount.isCurrent(current.owner) ||
          current.authorizationRevision !== access.authorizationRevision ||
          current.states?.[input.providerId]?.current !== true ||
          !provider?.builtinModelIds?.includes(input.modelId) ||
          provider.access?.type !== "new-api-account" ||
          provider.access.entitled !== true
        ) throw new Error("XCODE_STALE_OWNER");
      };
      assertAuthorized(snapshot);
      const credential = await zenAccount.getRelayCredential(owner!);
      input.abortSignal?.throwIfAborted();
      // 能力/展示更新不撤销已冻结 turn；凭据 IO 后只复核 owner、授权与真实成员资格。
      assertAuthorized(await accountService.read());
      return { headersApplied: true, requestAuth: { apiKey: credential.token } };
    },
  };
  return Object.freeze({
    ...upstream,
    providerRuntimeHeadersPort,
    // TUI 使用同一账号 owner，避免另起 runtime 后留下过期 Registry。
    zenAccount,
    async refreshStandaloneAccount(reason: string) {
      if (!zenAccount.getOwner()) await zenAccount.restore();
      await accountService.refresh(reason);
      await upstream.runtime.registryService.refresh(reason);
    },
    async readZenModelStatus(): Promise<ZenModelStatus> {
      const account = await accountService.read();
      const available = account.providers
        .entries()
        .some(
          ([, config]) =>
            config.access?.type === "new-api-account" &&
            config.access.entitled &&
            (config.builtinModelIds?.length ?? 0) > 0,
        );
      return {
        available,
        reason: available
          ? null
          : "No usable Zen Plan model is available. Check the assigned plan and model access.",
      };
    },
    dispose() {
      disposeZenSubscription();
      zenAccount.dispose();
      upstream.dispose();
    },
  });
}
