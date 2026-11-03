import type { AccountProviderConfigSnapshot, ProviderSource } from "@zcode/provider";
import {
  isAiscooAdminModelProviderId,
  isBuiltinModelProviderId,
  normalizeAiscooModelProviderId,
} from "@zcode/shared";
import {
  AccountRequestCredentialUnavailableError,
  type AccountAccessIdentityInput,
  type AccountRequestAuthResolver,
} from "../model-provider/accountProviderRequestAuthService.js";
import type { AiscooAdminAccountService } from "../aiscoo-admin/aiscooAdminAccountService.js";

/** 请求凭据绑定 owner/授权代际；能力版本只影响下一轮冻结配置。 */
export function createAiscooAdminAccountRequestAuthResolver(options: {
  account: Pick<AiscooAdminAccountService, "isCurrent" | "getRelayCredential">;
  accountSource: ProviderSource<AccountProviderConfigSnapshot>;
  official: AccountRequestAuthResolver;
}): AccountRequestAuthResolver {
  const assertNative = async (input: AccountAccessIdentityInput & { modelId?: string }) => {
    const access = input.accountAccess;
    if (access.type !== "new-api-account")
      throw new AccountRequestCredentialUnavailableError(input.providerId);
    // typed 直调不经过协议 schema，只迁移精确旧选择；Host 快照键仍须是规范身份。
    const providerId = normalizeAiscooModelProviderId(input.providerId);
    const snapshot = await options.accountSource.read();
    const providerAccess = snapshot.providers.get(providerId)?.access;
    if (
      !isAiscooAdminModelProviderId(providerId) ||
      !access.owner ||
      !access.authorizationRevision ||
      !options.account.isCurrent(access.owner) ||
      !snapshot.owner ||
      !options.account.isCurrent(snapshot.owner) ||
      access.authorizationRevision !== snapshot.authorizationRevision ||
      providerAccess?.type !== "new-api-account" ||
      providerAccess.entitled !== true ||
      snapshot.states?.[providerId]?.current !== true ||
      // 用规范身份核对授权目录；个人能力变更不撤销已冻结的 turn。
      (input.modelId !== undefined &&
        !snapshot.providers.get(providerId)?.builtinModelIds?.includes(input.modelId))
    ) {
      throw new AccountRequestCredentialUnavailableError(input.providerId);
    }
    return { snapshot, owner: access.owner };
  };
  return {
    resolveAccessCurrent: (access) => {
      if (access.type === "new-api-account") throw new Error("XCODE_PRIVATE_REMOTE_UNSUPPORTED");
      return options.official.resolveAccessCurrent(access);
    },
    assertCurrent: async (input) => {
      if (input.accountAccess.type === "new-api-account") {
        await assertNative(input);
        return;
      }
      // 私有模型身份不能借官方 access 进入另一条凭据路径。
      if (isAiscooAdminModelProviderId(normalizeAiscooModelProviderId(input.providerId)))
        throw new AccountRequestCredentialUnavailableError(input.providerId);
      await options.official.assertCurrent(input);
    },
    resolveCurrent: async (input) => {
      if (input.accountAccess.type !== "new-api-account") {
        if (isAiscooAdminModelProviderId(normalizeAiscooModelProviderId(input.providerId)))
          throw new AccountRequestCredentialUnavailableError(input.providerId);
        if (input.reason === "model-request" && isBuiltinModelProviderId(input.providerId))
          throw new Error("XCODE_LEGACY_OFFICIAL_SELECTION_RESELECT_REQUIRED");
        return options.official.resolveCurrent(input);
      }
      if (input.reason !== "model-request")
        throw new Error(
          `XCODE_PRIVATE_${input.reason === "off-peak" ? "OFF_PEAK" : "USAGE_AUTH"}_UNSUPPORTED`,
        );
      if (!input.modelId) throw new AccountRequestCredentialUnavailableError(input.providerId);
      const { owner } = await assertNative(input);
      const credential = await options.account.getRelayCredential(owner);
      // await 期间可能退出、换授权或下架模型，二次检查后才能释放凭据。
      await assertNative(input);
      return { apiKey: credential.token };
    },
  };
}
