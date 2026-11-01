import type { IOAuthService, IServiceAccessor } from "@zcode/services";
import { NEW_API_PROVIDER_ID, type IPlatformService, type OAuthProviderId } from "@zcode/shared";
import type { OAuthAccountPolicy, OAuthLifecyclePlatform } from "@/oauth-lifecycle/contract.js";

export type * from "./contract.js";

const CONFIG_UNAVAILABLE = "AISCOO_ACCOUNT_CONFIG_UNAVAILABLE";
const LOGIN_UNSUPPORTED = "AISCOO_ACCOUNT_LOGIN_UNSUPPORTED";

function accountError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

export const aiscooAccountPolicy: OAuthAccountPolicy = Object.freeze({
  acceptsProvider: (provider: OAuthProviderId) => provider === NEW_API_PROVIDER_ID,
});

function acceptsCallbackUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.searchParams.getAll("provider").length === 1 &&
      url.searchParams.get("provider") === NEW_API_PROVIDER_ID
    );
  } catch {
    return false;
  }
}

function createAccountOAuthService(owner: IOAuthService): IOAuthService {
  const getProviders = async () =>
    (await owner.getProviders()).filter(
      (provider) => provider.enabled && aiscooAccountPolicy.acceptsProvider(provider.id),
    );
  const available = async () => (await getProviders()).length > 0;
  const active = async () =>
    (await available()) && (await owner.getActiveProvider()) === NEW_API_PROVIDER_ID
      ? NEW_API_PROVIDER_ID
      : null;
  const requireProvider = (provider: OAuthProviderId) => {
    if (!aiscooAccountPolicy.acceptsProvider(provider)) throw accountError(LOGIN_UNSUPPORTED);
  };
  const requireConfigured = async () => {
    if (!(await available())) throw accountError(CONFIG_UNAVAILABLE);
  };
  const canRestore = async () => {
    if (!(await available())) return false;
    const provider = await owner.getActiveProvider();
    return provider === null || provider === NEW_API_PROVIDER_ID;
  };
  const restoreCachedSessionState: IOAuthService["restoreCachedSessionState"] = async () => {
    // 修复依据：Native 冷启动先恢复才建立 owner；仅拒明确的官方身份，成功后再确认来源。
    if (!(await canRestore())) return { status: "signed-out" };
    const result = await owner.restoreCachedSessionState();
    if (result.status !== "authenticated") return result;
    return (await active()) === NEW_API_PROVIDER_ID ? result : { status: "signed-out" };
  };
  const rejected = async () => {
    throw accountError(LOGIN_UNSUPPORTED);
  };
  return {
    onDidChangeSession: owner.onDidChangeSession ?? (() => ({ dispose() {} })),
    getProviders,
    getActiveProvider: active,
    restoreCachedSessionState,
    async restoreCachedSession() {
      const result = await restoreCachedSessionState();
      return result.status === "authenticated" ? result.userInfo : null;
    },
    async restoreSession() {
      if (!(await canRestore())) return null;
      const user = await owner.restoreSession();
      return (await active()) === NEW_API_PROVIDER_ID ? user : null;
    },
    async startOAuth(provider) {
      requireProvider(provider);
      await requireConfigured();
      const response = await owner.startOAuth(provider);
      if (response.provider !== NEW_API_PROVIDER_ID || response.purpose !== "primary-account")
        throw accountError(LOGIN_UNSUPPORTED);
      return response;
    },
    startOAuthWithPolling: rejected,
    pollPendingOAuth: rejected,
    async handleCallback(url) {
      if (!acceptsCallbackUrl(url)) throw accountError(LOGIN_UNSUPPORTED);
      await requireConfigured();
      const result = await owner.handleCallback(url);
      if (result && result.provider !== NEW_API_PROVIDER_ID) throw accountError(LOGIN_UNSUPPORTED);
      return result;
    },
    async refreshToken(provider = NEW_API_PROVIDER_ID) {
      requireProvider(provider);
      await requireConfigured();
      if ((await active()) !== NEW_API_PROVIDER_ID) throw accountError(LOGIN_UNSUPPORTED);
      await owner.refreshToken(NEW_API_PROVIDER_ID);
    },
    async logout(provider = NEW_API_PROVIDER_ID) {
      requireProvider(provider);
      // 修复依据：恢复和 pending 时 active 尚为空；退出须先同步失效原 owner，不能等待元数据。
      await owner.logout(NEW_API_PROVIDER_ID);
    },
    async logoutAll() {
      // 仅退出 Aiscoo 作用域；通用 owner 不会清除 active 为官方的历史凭据。
      await owner.logout(NEW_API_PROVIDER_ID);
    },
    async cancelPending(provider = NEW_API_PROVIDER_ID) {
      requireProvider(provider);
      // 原 owner 先同步失效 pending，不能让元数据查询为迟到 callback 留出窗口。
      await owner.cancelPending(NEW_API_PROVIDER_ID);
    },
  };
}

/** Root 装配只替换产品账号服务，其他服务继续委托既有 accessor。 */
export function createAiscooAccountLoginServices(services: IServiceAccessor): IServiceAccessor {
  const oauthService = createAccountOAuthService(services.oauthService);
  return new Proxy(services, {
    get(target, property) {
      if (property === "oauthService") return oauthService;
      if (property === "officialCloudConnectionService") return undefined;
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

const userIntentSubscriptions = new Set<keyof IPlatformService>([
  "onFocusTab",
  "onNewTab",
  "onNewTask",
  "onOpenWorkspace",
  "onOpenWorkspacePath",
  "onCloseActiveContextRequest",
  "onOpenBrowserUrl",
  "onOpenFeedbackDialog",
  "onOpenTicketsPanel",
  "onShareImport",
  "onTaskNotificationClick",
]);

export function createAiscooAccountLoginPlatform(
  platform: IPlatformService,
  isInteractionBlocked: () => boolean = () => false,
): OAuthLifecyclePlatform {
  return new Proxy(platform as OAuthLifecyclePlatform, {
    get(target, property) {
      if (property === "oauthAccountPolicy") return aiscooAccountPolicy;
      // inert 无法拦截 Main 原生菜单投递；仅暂停新用户意图，不截断身份/任务事件或窗控。
      if (userIntentSubscriptions.has(property as keyof IPlatformService)) {
        const subscribe = Reflect.get(target, property);
        if (typeof subscribe === "function")
          return (listener: (...args: unknown[]) => void) =>
            subscribe.call(target, (...args: unknown[]) => {
              if (!isInteractionBlocked()) listener(...args);
            });
      }
      if (property === "registerOAuthState")
        return (registration: Parameters<IPlatformService["registerOAuthState"]>[0]) => {
          if (
            registration.provider !== NEW_API_PROVIDER_ID ||
            registration.purpose !== "primary-account"
          )
            throw accountError(LOGIN_UNSUPPORTED);
          return target.registerOAuthState(registration);
        };
      if (property === "onOAuthCallback")
        return (listener: Parameters<IPlatformService["onOAuthCallback"]>[0]) =>
          target.onOAuthCallback((event) => {
            if (
              event.provider === NEW_API_PROVIDER_ID &&
              event.purpose === "primary-account" &&
              acceptsCallbackUrl(event.url)
            )
              return listener(event);
          });
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
