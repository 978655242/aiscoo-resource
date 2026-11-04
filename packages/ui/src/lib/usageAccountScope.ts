import type { ProviderSettingsView } from "@zcode/services";
import {
  isAiscooAdminModelProviderId,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
} from "@zcode/shared";

export function resolveUsageAccountScope(params: {
  providerId?: string;
  accountAccess?: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  view: ProviderSettingsView | null;
  signedIn: boolean;
  authSessionSeq: number;
}): { native: boolean; ownerKey: string } {
  const native =
    params.accountAccess?.type === "new-api-account" ||
    isAiscooAdminModelProviderId(params.providerId ?? "");
  if (!native) return { native: false, ownerKey: "" };
  const connectionKey = params.view?.providers.find(
    (provider) => provider.providerId === params.providerId,
  )?.accountState?.connectionKey;
  // XCODE: 静态 Native access 不含身份；只复用 Host 的 opaque owner 与主登录 epoch，退出立即拒绝旧投影。
  return {
    native,
    ownerKey:
      params.signedIn && connectionKey
        ? JSON.stringify([connectionKey, params.authSessionSeq])
        : "",
  };
}

export function selectUsageAccountState<T>(
  state: { scopeKey: string | null; snapshot: T | null; loading: boolean; error: string | null },
  scopeKey: string,
  enabled: boolean,
): { snapshot: T | null; loading: boolean; error: string | null } {
  // XCODE: effect 清理晚于 render；身份切换的首帧也不能显示前一个账号的额度、图表或错误。
  return enabled && state.scopeKey === scopeKey
    ? state
    : { snapshot: null, loading: enabled, error: null };
}
