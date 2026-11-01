import { Emitter } from "@zcode/rpc";
import { normalizeNewApiOrigin, NEW_API_PROVIDER_ID, type OAuthSessionState } from "@zcode/shared";
import type { HostAccountPolicy, PolicyAccountAuthority } from "./contract.js";
import type { IOAuthService } from "../oauth/oauth.js";
import type { ICodingPlanSubscriptionService } from "../coding-plan-subscription/codingPlanSubscription.js";
import type { IUsageStatsService } from "../usage-stats/usageStats.js";
import type { OfficialCloudConnectionHost } from "../official-mcp/officialCloudConnectionService.js";
import { createNewApiAccountProviderResolver } from "../new-api/newApiAccountProviderResolution.js";

export type { HostAccountPolicy } from "./contract.js";
export const AISCOO_ACCOUNT_CONFIG_UNAVAILABLE = "AISCOO_ACCOUNT_CONFIG_UNAVAILABLE";
export const AISCOO_ACCOUNT_LOGIN_UNSUPPORTED = "AISCOO_ACCOUNT_LOGIN_UNSUPPORTED";
export const AISCOO_OFFICIAL_CLOUD_UNAVAILABLE = "AISCOO_OFFICIAL_CLOUD_UNAVAILABLE";

function failure(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
function rejectConfiguration(): never {
  throw failure(AISCOO_ACCOUNT_CONFIG_UNAVAILABLE);
}
function rejectOfficial(): never {
  throw failure(AISCOO_OFFICIAL_CLOUD_UNAVAILABLE);
}
function rejectLogin(): never {
  throw failure(AISCOO_ACCOUNT_LOGIN_UNSUPPORTED);
}
function assertProvider(provider?: string): void {
  if (provider !== undefined && provider !== NEW_API_PROVIDER_ID) rejectLogin();
}
function assertCallback(raw: string): void {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return rejectLogin();
  }
  if (
    url.searchParams.getAll("provider").length !== 1 ||
    url.searchParams.get("provider") !== NEW_API_PROVIDER_ID ||
    url.searchParams.getAll("purpose").length > 1 ||
    (url.searchParams.has("purpose") && url.searchParams.get("purpose") !== "primary-account")
  )
    rejectLogin();
}

function createUnavailableAccount(): PolicyAccountAuthority {
  const changes = new Emitter<OAuthSessionState>();
  const oauth: IOAuthService = {
    onDidChangeSession: changes.event,
    getProviders: async () => [
      { id: NEW_API_PROVIDER_ID, displayName: "Aiscoo", enabled: false, order: 0 },
    ],
    getActiveProvider: async () => null,
    restoreCachedSession: async () => rejectConfiguration(),
    restoreCachedSessionState: async () => rejectConfiguration(),
    restoreSession: async () => rejectConfiguration(),
    startOAuth: async () => rejectConfiguration(),
    startOAuthWithPolling: async () => rejectLogin(),
    pollPendingOAuth: async () => rejectLogin(),
    handleCallback: async () => rejectConfiguration(),
    refreshToken: async () => rejectConfiguration(),
    logout: async () => {},
    logoutAll: async () => {},
    cancelPending: async () => {},
  };
  return Object.freeze({
    oauth,
    getOwner: () => null,
    isCurrent: () => false,
    withControlSession: async () => rejectConfiguration(),
    getRelayCredential: async () => rejectConfiguration(),
  });
}

function wrapOAuth(oauth: IOAuthService): IOAuthService {
  return Object.freeze({
    ...oauth,
    getProviders: async () =>
      (await oauth.getProviders()).filter((provider) => provider.id === NEW_API_PROVIDER_ID),
    getActiveProvider: async () =>
      (await oauth.getActiveProvider()) === NEW_API_PROVIDER_ID ? NEW_API_PROVIDER_ID : null,
    startOAuth: async (provider) => {
      assertProvider(provider);
      return oauth.startOAuth(provider);
    },
    startOAuthWithPolling: async () => rejectLogin(),
    pollPendingOAuth: async () => rejectLogin(),
    handleCallback: async (raw) => {
      assertCallback(raw);
      return oauth.handleCallback(raw);
    },
    refreshToken: async (provider) => {
      assertProvider(provider);
      return oauth.refreshToken(provider);
    },
    logout: async (provider) => {
      assertProvider(provider);
      return oauth.logout(provider);
    },
    cancelPending: async (provider) => {
      assertProvider(provider);
      return oauth.cancelPending(provider);
    },
  } satisfies IOAuthService);
}

function isRetiredCredential(key: string): boolean {
  // XCODE: 底层 credentialKeySchema 会 trim；先按相同语义检查，防止空白绕过后读取旧身份。
  const canonicalKey = key.trim();
  // XCODE: 仅封闭已退役产品登录镜像，第三方 MCP OAuth 和用户 API Key 继续走原凭据仓储。
  return (
    canonicalKey === "zcodejwttoken" ||
    canonicalKey === "oauth:active_provider" ||
    canonicalKey === "oauth:login_attribution" ||
    /^oauth:(?:zai|bigmodel):/.test(canonicalKey) ||
    canonicalKey.startsWith("official-cloud:")
  );
}

const unavailableOfficialCloud: OfficialCloudConnectionHost = Object.freeze({
  service: {
    onDidChange: new Emitter<void>().event,
    getSnapshot: async () => rejectOfficial(),
    startOAuth: async () => rejectLogin(),
    handleCallback: async () => rejectLogin(),
    logout: async () => rejectOfficial(),
    refresh: async () => rejectOfficial(),
  },
  onPrimaryOwnerChanged() {},
  resolveCredentials: async () => null,
  resolveCodingPlanMaterial: async () => null,
  isCurrent: async () => false,
  withCredentials: async () => rejectOfficial(),
  getModelSelectionView: async () => rejectOfficial(),
  captureRequestFence: async () => rejectOfficial(),
  captureOwnerFence: () => ({ isCurrent: () => false }),
});

function wrapSubscription(
  service: ICodingPlanSubscriptionService,
  configured: boolean,
): ICodingPlanSubscriptionService {
  // XCODE: 官方权益没有 Aiscoo 替代，拒绝必须早于上游 provider 的凭据读取与网络请求。
  const guarded: ICodingPlanSubscriptionService = {
    ...service,
    getOffPeakClientConfig: async () => rejectOfficial(),
    getDynamicWorkflowClientConfig: async () => rejectOfficial(),
    getRequestVerificationConfig: async () => null,
  };
  if (configured) return guarded;
  const unavailable = async () => rejectConfiguration();
  return {
    ...guarded,
    batchPreview: unavailable,
    getStaticProducts: unavailable,
    getStaticTeamProducts: unavailable,
    getStartPlanPreview: unavailable,
    createPlanWebHandoff: unavailable,
    getManualClaimPlanPreviews: unavailable,
    claimManualPlan: unavailable,
    getBillingDiscount: unavailable,
    productInfo: unavailable,
    preview: unavailable,
    createSign: unavailable,
    updateSign: unavailable,
    checkPayment: unavailable,
    checkPendingOrders: unavailable,
    queryStripeCards: unavailable,
    bindStripeCard: unavailable,
    unbindStripeCard: unavailable,
    payStripe: unavailable,
    checkPaypalSupport: unavailable,
    createPaypalSetupToken: unavailable,
    subscribePaypal: unavailable,
    getEnterprisePricing: unavailable,
    getEnterpriseBalance: unavailable,
    calculateEnterpriseOrder: unavailable,
    createEnterpriseOrder: unavailable,
    getEnterprisePendingOrders: unavailable,
    cancelEnterpriseOrder: unavailable,
    continueEnterpriseOrderPayment: unavailable,
    checkEnterpriseOrderStatus: unavailable,
  };
}

function wrapUsage(service: IUsageStatsService, configured: boolean): IUsageStatsService {
  if (configured) return service;
  const unavailable = async () => rejectConfiguration();
  return {
    ...service,
    getCodingPlanUsageSnapshot: unavailable,
    getCodingPlanRegularTps: unavailable,
    getCodingPlanResetStatus: unavailable,
    requestCodingPlanResetOpportunity: unavailable,
    useCodingPlanReset: unavailable,
    markCodingPlanResetHistoryRead: unavailable,
    getSnapshot: unavailable,
    getEntitlementSnapshot: unavailable,
  };
}

export function createAiscooAccountPolicy(
  options: { adminBaseUrl?: string } = {},
): HostAccountPolicy {
  let newApiOrigin: string | null = null;
  try {
    newApiOrigin = normalizeNewApiOrigin(options.adminBaseUrl?.trim() ?? "");
  } catch {
    // XCODE: 配置失败仍装配阻断权威，不能因 null client 回到旧官方账号。
  }
  const unavailableAccount = createUnavailableAccount();
  return Object.freeze({
    newApiOrigin,
    allowOfficialCloud: false,
    createUnavailableAccount: () => unavailableAccount,
    wrapOAuth,
    wrapCredentials: (credentials) => ({
      ...credentials,
      load: async (key) => (isRetiredCredential(key) ? null : credentials.load(key)),
      save: async (key, value, assertCurrent) => {
        if (isRetiredCredential(key)) rejectLogin();
        return credentials.save(key, value, assertCurrent);
      },
      delete: async (key, assertCurrent) => {
        if (isRetiredCredential(key)) rejectLogin();
        return credentials.delete(key, assertCurrent);
      },
      recoverUnreadable: async (key, assertCurrent) =>
        isRetiredCredential(key) ? null : credentials.recoverUnreadable(key, assertCurrent),
    }),
    unavailableProviders: createNewApiAccountProviderResolver({
      account: unavailableAccount,
      client: {
        getModels: async () => rejectConfiguration(),
        getEntitlements: async () => rejectConfiguration(),
      },
    }),
    unavailableRequestAuth: {
      resolveAccessCurrent: async () => null,
      resolveCurrent: async () => rejectOfficial(),
      assertCurrent: async () => rejectOfficial(),
    },
    unavailableOfficialCloud,
    wrapSubscription: (service) => wrapSubscription(service, newApiOrigin !== null),
    wrapUsage: (service) => wrapUsage(service, newApiOrigin !== null),
  } satisfies HostAccountPolicy);
}
