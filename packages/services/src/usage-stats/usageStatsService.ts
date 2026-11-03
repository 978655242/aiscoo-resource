import type {
  ApiClient,
  AppUsageRequest,
  AppUsageSnapshot,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  CodingPlanRegularTpsRequest,
  CodingPlanResetOpportunityRequest,
  CodingPlanResetOpportunityResult,
  CodingPlanResetScopeRequest,
  CodingPlanResetStatusSnapshot,
  CodingPlanResetUseRequest,
  CodingPlanResetUseResult,
  UsageEntitlementRequest,
  UsageEntitlementSnapshot,
  UsageStatsRequest,
  UsageStatsSnapshot,
  NewApiAccountUsageSnapshot,
  CodingPlanResetHistoryReadResult,
  NewApiOwner,
} from "@zcode/shared";
import {
  isCodingPlanModelProviderId,
  isNewApiModelProviderId,
  NEW_API_MODEL_PROVIDER_IDS,
  normalizeAiscooModelProviderId,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { IAccountRequestAuthService } from "../model-provider/accountRequestAuthService.js";
import type { IZCodeAgentService } from "../zcode-agent/zcodeAgent.js";
import type { IUsageStatsService } from "./usageStats.js";
import {
  BigModelUsageQuotaProvider,
  type UsageApiAuthorizationRequest,
  type UsageApiAuthorization,
} from "./providers/bigmodelUsageQuotaProvider.js";
import type { OfficialMcpCredentialSource } from "./providers/zcodeMcpQuotaProvider.js";
import type { NewApiAccountService } from "../new-api/newApiAccountService.js";
import type { NewApiClient } from "../new-api/newApiClient.js";
import {
  mapNewApiAccountUsage,
  mapNewApiEntitlement,
  mapNewApiResetStatus,
  mapNewApiUsage,
  validateNewApiUsageRequest,
} from "../new-api/newApiUsageMapper.js";
import { rejectNewApiSelfService } from "../new-api/newApiSubscriptionReadAdapter.js";
import type { OfficialCloudConnectionHost } from "../official-mcp/officialCloudConnectionService.js";

export interface UsageStatsServiceDependencies {
  officialCloudHost?: Pick<OfficialCloudConnectionHost, "withCredentials">;
  native?: {
    account: Pick<NewApiAccountService, "withControlSession">;
    client: Pick<NewApiClient, "getUsage" | "getEntitlements">;
  };
  apiClient: ApiClient;
  accountRequestAuthService: Pick<
    IAccountRequestAuthService,
    "resolveAccessCurrent" | "resolveCurrent" | "assertCurrent"
  >;
  resolveApiAuthorization?: (
    request: UsageApiAuthorizationRequest,
  ) => Promise<UsageApiAuthorization | null>;
  credentialService?: Pick<ICredentialService, "load">;
  env?: NodeJS.ProcessEnv;
  /** App Usage 经 ZCode Protocol 读取 agent 数据库真实统计。 */
  zcodeAgentService: Pick<IZCodeAgentService, "getAppUsageStats">;
  /**
   * 官方 Server MCP 额度的凭证来源（与 server MCP 调用同一套 5 个身份头）。
   * 缺省时 entitlement 快照不含 MCP 额度。
   */
  officialMcpCredentialSource?: OfficialMcpCredentialSource;
}

const CODING_PLAN_REGULAR_TPS_CACHE_MS = 5 * 60_000;

function isCodingPlanProviderId(providerId: string | undefined): boolean {
  return Boolean(providerId && isCodingPlanModelProviderId(providerId));
}

export function createUsageStatsService(
  dependencies: UsageStatsServiceDependencies,
): IUsageStatsService {
  const createQuotaProvider = () =>
    new BigModelUsageQuotaProvider({
      apiClient: dependencies.apiClient,
      accountRequestAuthService: dependencies.accountRequestAuthService,
      resolveApiAuthorization: dependencies.resolveApiAuthorization,
      credentialService: dependencies.credentialService,
      env: dependencies.env,
      ...(dependencies.officialMcpCredentialSource
        ? { officialMcpCredentialSource: dependencies.officialMcpCredentialSource }
        : {}),
    });
  const quotaProvider = createQuotaProvider();
  const officialRead = async <T>(
    request: UsageEntitlementRequest | UsageStatsRequest,
    operation: (provider: BigModelUsageQuotaProvider) => Promise<T>,
  ): Promise<T> => {
    const host = dependencies.officialCloudHost;
    if (!host) {
      if (dependencies.native) throw new Error("official_cloud_connection_required");
      return operation(quotaProvider);
    }
    return host.withCredentials(async (credentials) => {
      const requested = request.accountAccess;
      const access = credentials.access;
      if (!requested || !access || requested.type !== "zhipu-account")
        throw new Error("official_cloud_scope_required");
      if ("planKind" in requested) {
        if (
          requested.family !== access.family ||
          requested.planKind !== access.planKind ||
          (requested.planKind === "team-coding-plan" &&
            (access.planKind !== "team-coding-plan" ||
              requested.productId !== access.productId ||
              requested.organizationId !== access.organizationId ||
              requested.projectId !== access.projectId))
        ) {
          throw new Error("official_cloud_scope_required");
        }
      } else if (requested.accountType !== access.family || requested.mode !== access.planKind) {
        throw new Error("official_cloud_scope_required");
      }
      return operation(createQuotaProvider());
    });
  };
  const native = dependencies.native;
  const usesNative = (request: UsageEntitlementRequest | UsageStatsRequest) =>
    request.accountAccess?.type === "new-api-account" ||
    Boolean(
      request.preferredProviderId &&
      isNewApiModelProviderId(normalizeAiscooModelProviderId(request.preferredProviderId)),
    ) ||
    Boolean(native && !request.preferredProviderId);
  const assertNativeRequestOwner = (
    request: UsageEntitlementRequest | UsageStatsRequest,
    owner: NewApiOwner,
  ) => {
    const expected =
      request.accountAccess?.type === "new-api-account" ? request.accountAccess.owner : undefined;
    if (
      expected &&
      (expected.origin !== owner.origin ||
        expected.userId !== owner.userId ||
        expected.sid !== owner.sid ||
        expected.authGeneration !== owner.authGeneration)
    ) {
      throw new Error("XCODE_STALE_OWNER");
    }
  };
  const readNativeEntitlement = (request: UsageEntitlementRequest) => {
    if (!native) throw new Error("XCODE_NATIVE_ACCOUNT_REQUIRED");
    return native.account.withControlSession(async (token, owner) => {
      assertNativeRequestOwner(request, owner);
      return mapNewApiEntitlement(
        await native.client.getEntitlements(token),
        // XCODE: 旧调用可读，额度投影与默认写入只产生规范 Aiscoo 模型身份。
        normalizeAiscooModelProviderId(
          request.preferredProviderId ?? NEW_API_MODEL_PROVIDER_IDS["anthropic-messages"],
        ),
      );
    });
  };
  const regularTpsCache = new Map<string, { expiresAt: number; value: number | undefined }>();
  const regularTpsInFlight = new Map<string, Promise<number | undefined>>();

  function regularTpsCacheKey(request: CodingPlanRegularTpsRequest): string {
    return JSON.stringify([
      request.preferredProviderId,
      // Team scope（organizationId/projectId）已内含在 accountAccess 里，整体入 key，
      // 避免同一 provider 下不同账号或不同团队项目共用同一条 TPS 缓存。
      request.accountAccess,
      request.timeZone ?? null,
    ]);
  }

  return {
    async getAppUsageSnapshot(request: AppUsageRequest): Promise<AppUsageSnapshot> {
      // App Usage 现读取 agent 数据库真实统计（model_usage/turn_usage/tool_usage），
      // 经 ZCode Protocol usage/stats 取回。不再读本地 session JSON 估算。
      return dependencies.zcodeAgentService.getAppUsageStats({
        range: request.range,
        timeZone: request.timeZone,
      });
    },
    async getCodingPlanUsageSnapshot(
      request: CodingPlanUsageRequest,
    ): Promise<CodingPlanUsageSnapshot> {
      if (usesNative(request)) {
        if (!native) throw new Error("XCODE_NATIVE_ACCOUNT_REQUIRED");
        validateNewApiUsageRequest(request);
        return native.account.withControlSession(async (token, owner) => {
          assertNativeRequestOwner(request, owner);
          const [usage, entitlement] = await Promise.all([
            native.client.getUsage(token, {
              range: request.range,
              time_zone: request.timeZone,
              ...(request.range === "custom"
                ? { start_date: request.customStartDate!, end_date: request.customEndDate! }
                : {}),
            }),
            native.client.getEntitlements(token),
          ]);
          return mapNewApiUsage(usage, request.range, request.preferredProviderId, entitlement);
        });
      }
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        // Coding Plan 页面只允许预置的 Z.AI/BigModel Coding Plan 账号。
        // 普通 provider id 不能进入 monitor 链路，避免误读 API Key 或环境变量。
        throw new Error("no_bigmodel_api_key");
      }
      return officialRead(request, (provider) => provider.getCodingPlanUsageSnapshot(request));
    },
    async getCodingPlanRegularTps(
      request: CodingPlanRegularTpsRequest,
    ): Promise<number | undefined> {
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      // XCODE: 官方查询沿原生 owner/连接栅栏返回，不复用其它 owner 的 Host 级 TPS 缓存。
      if (native || dependencies.officialCloudHost) {
        return officialRead(request, (provider) => provider.getCodingPlanRegularTps(request));
      }
      const key = regularTpsCacheKey(request);
      const cached = regularTpsCache.get(key);
      if (cached && cached.expiresAt > Date.now()) return cached.value;
      const existing = regularTpsInFlight.get(key);
      if (existing) return existing;

      const requestPromise = quotaProvider
        .getCodingPlanRegularTps(request)
        .then((value) => {
          regularTpsCache.set(key, {
            expiresAt: Date.now() + CODING_PLAN_REGULAR_TPS_CACHE_MS,
            value,
          });
          return value;
        })
        .finally(() => {
          regularTpsInFlight.delete(key);
        });
      regularTpsInFlight.set(key, requestPromise);
      return requestPromise;
    },
    async getCodingPlanResetStatus(
      request: CodingPlanResetScopeRequest,
    ): Promise<CodingPlanResetStatusSnapshot> {
      if (usesNative(request)) {
        if (!native) throw new Error("XCODE_NATIVE_ACCOUNT_REQUIRED");
        return native.account.withControlSession(async (token, owner) => {
          assertNativeRequestOwner(request, owner);
          return mapNewApiResetStatus(await native.client.getEntitlements(token));
        });
      }
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      return officialRead(request, (provider) => provider.getCodingPlanResetStatus(request));
    },
    async requestCodingPlanResetOpportunity(
      request: CodingPlanResetOpportunityRequest,
    ): Promise<CodingPlanResetOpportunityResult> {
      if (usesNative(request)) return rejectNewApiSelfService();
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      return officialRead(request, (provider) =>
        provider.requestCodingPlanResetOpportunity(request),
      );
    },
    async useCodingPlanReset(
      request: CodingPlanResetUseRequest,
    ): Promise<CodingPlanResetUseResult> {
      if (usesNative(request)) return rejectNewApiSelfService();
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      return officialRead(request, (provider) => provider.useCodingPlanReset(request));
    },
    async markCodingPlanResetHistoryRead(
      request: CodingPlanResetScopeRequest,
    ): Promise<CodingPlanResetHistoryReadResult> {
      if (usesNative(request)) {
        if (!native) throw new Error("XCODE_NATIVE_ACCOUNT_REQUIRED");
        return native.account.withControlSession(
          async (_token, owner): Promise<CodingPlanResetHistoryReadResult> => {
            assertNativeRequestOwner(request, owner);
            return { availability: "not-supported", reason: "native-history-not-provided" };
          },
        );
      }
      if (!isCodingPlanProviderId(request.preferredProviderId)) {
        throw new Error("no_bigmodel_api_key");
      }
      await officialRead(request, (provider) => provider.markCodingPlanResetHistoryRead(request));
      return { availability: "available" };
    },
    async getSnapshot(
      request: UsageStatsRequest,
    ): Promise<UsageStatsSnapshot | NewApiAccountUsageSnapshot> {
      if (request.dataSource === "local") throw new Error("XCODE_USAGE_SOURCE_UNSUPPORTED");
      const requestedNative =
        request.accountAccess?.type === "new-api-account" ||
        Boolean(
          request.preferredProviderId &&
          isNewApiModelProviderId(normalizeAiscooModelProviderId(request.preferredProviderId)),
        );
      if (request.dataSource === "new-api" || requestedNative) {
        if (request.dataSource === "monitor") throw new Error("XCODE_USAGE_SOURCE_MISMATCH");
        if (!native) throw new Error("XCODE_NATIVE_ACCOUNT_REQUIRED");
        if (request.range === "all") throw new Error("XCODE_USAGE_REQUEST_INVALID");
        const range = request.range;
        validateNewApiUsageRequest({ range, timeZone: request.timeZone });
        return native.account.withControlSession(async (token, owner) => {
          assertNativeRequestOwner(request, owner);
          return mapNewApiAccountUsage(
            await native.client.getUsage(token, { range, time_zone: request.timeZone }),
            range,
          );
        });
      }
      if (native && !request.preferredProviderId && !request.accountAccess)
        throw new Error("XCODE_USAGE_SOURCE_REQUIRED");
      // App Usage 已迁移到 getAppUsageSnapshot（agent 数据库）。getSnapshot 仅服务 Coding Plan monitor 链路。
      // 任何 monitor 失败都不能回退本地数据，保持数据源隔离。
      return officialRead(request, (provider) => provider.getUsageStatsSnapshot(request));
    },
    async getEntitlementSnapshot(
      request: UsageEntitlementRequest = {},
    ): Promise<UsageEntitlementSnapshot> {
      if (usesNative(request)) return readNativeEntitlement(request);
      return officialRead(request, (provider) => provider.getSnapshotForRequest(request));
    },
  };
}
