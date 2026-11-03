import type { RequestVerificationReason } from "@zcode/shared";
import { createHash } from "node:crypto";
import {
  BIGMODEL_PROVIDER_ID,
  type OAuthProviderId,
  type ProviderFamilyDomain,
  type ProjectAccessTokenMaterial,
  type ZCodeAccountAccess,
  type ZCodeProviderAccountAccess,
  ZAI_PROVIDER_ID,
} from "@zcode/shared";
import type { NewApiAccountService } from "../new-api/newApiAccountService.js";
import type { AccountProviderConfigSnapshot, ProviderSource } from "@zcode/provider";
import {
  isNewApiModelProviderId,
  isBuiltinModelProviderId,
  normalizeAiscooModelProviderId,
} from "@zcode/shared";

export interface AccountRequestAuthMaterial {
  /** 私有传输字段兼容旧命名；套餐 OAuth 实际传入短期 Project Token。 */
  apiKey?: string;
  apiKeyId?: string;
  headers?: Record<string, string>;
  accountScope?: string;
}

export interface AccountRequestAuthInput {
  providerId: string;
  modelId?: string;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
  expectedAccountScope?: string;
  rejectedProjectTokenFingerprint?: string;
  reason: RequestVerificationReason | "off-peak" | "usage";
}

export interface AccountAccessIdentityInput {
  providerId: string;
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
}

export class AccountRequestCredentialUnavailableError extends Error {
  constructor(readonly providerId: string) {
    super(`Account request credential is unavailable: ${providerId}`);
    this.name = "AccountRequestCredentialUnavailableError";
  }
}

export interface AccountRequestAuthResolver {
  resolveAccessCurrent(access: ZCodeProviderAccountAccess): Promise<ZCodeAccountAccess | null>;
  resolveCurrent(input: AccountRequestAuthInput): Promise<AccountRequestAuthMaterial>;
  assertCurrent(input: AccountAccessIdentityInput): Promise<void>;
}

interface AccountProviderRequestAuthServiceOptions {
  resolveCurrentAccountAccess(
    access: ZCodeProviderAccountAccess,
  ): Promise<ZCodeAccountAccess | null>;
  loadOAuthTokenSet(providerId: OAuthProviderId): Promise<{
    accessToken?: string | null;
    zcodeJwtToken?: string | null;
  } | null>;
  loadIndividualPlanMaterial(
    providerId: string,
    family: ProviderFamilyDomain,
    rejectedProjectTokenFingerprint?: string,
  ): Promise<ProjectAccessTokenMaterial | null>;
  resolveTeamPlanMaterial(
    access: Extract<ZCodeAccountAccess, { planKind: "team-coding-plan" }>,
    rejectedProjectTokenFingerprint?: string,
  ): Promise<ProjectAccessTokenMaterial | null>;
}

class AccountProviderRequestAuthService implements AccountRequestAuthResolver {
  readonly #options: AccountProviderRequestAuthServiceOptions;

  constructor(options: AccountProviderRequestAuthServiceOptions) {
    this.#options = options;
  }

  resolveAccessCurrent(access: ZCodeProviderAccountAccess): Promise<ZCodeAccountAccess | null> {
    return this.#options.resolveCurrentAccountAccess(access);
  }

  async resolveCurrent(input: AccountRequestAuthInput): Promise<AccountRequestAuthMaterial> {
    const providerId = input.providerId.trim();
    if (input.accountAccess.type === "new-api-account")
      throw new Error("XCODE_PRIVATE_REQUEST_AUTH_UNCONFIGURED");
    const access = await this.#resolveAccess(input.accountAccess);
    if (!access) throw new AccountRequestCredentialUnavailableError(providerId);

    if (access.planKind === "start-plan") {
      const tokenSet = await this.#options.loadOAuthTokenSet(resolveOAuthProviderId(access.family));
      return { apiKey: requireApiKey(tokenSet?.zcodeJwtToken, providerId) };
    }

    const scoped = input.reason !== "usage" || input.expectedAccountScope !== undefined;
    if (input.rejectedProjectTokenFingerprint && !input.expectedAccountScope)
      throw new Error("project_token_scope_invalidated");
    const accountScope = scoped ? await this.#scope(access) : undefined;
    if (input.expectedAccountScope !== undefined && input.expectedAccountScope !== accountScope)
      throw new Error("project_token_scope_invalidated");
    const material =
      access.planKind === "individual-coding-plan"
        ? await this.#options.loadIndividualPlanMaterial(
            providerId,
            access.family,
            input.rejectedProjectTokenFingerprint,
          )
        : await this.#options.resolveTeamPlanMaterial(
            access,
            input.rejectedProjectTokenFingerprint,
          );
    if (scoped) {
      // 换证 IO 前后校验原请求身份，避免 401 重试或闲时票据串用新账号/项目。
      const latest = await this.#resolveAccess(input.accountAccess);
      if (!latest || accountScope !== (await this.#scope(latest)))
        throw new Error("project_token_scope_invalidated");
    }
    return {
      apiKey: requireApiKey(material?.token, providerId),
      apiKeyId: material?.apiKeyId,
      ...(accountScope ? { accountScope } : {}),
    };
  }

  async #scope(access: ZCodeAccountAccess): Promise<string> {
    const login = await this.#options.loadOAuthTokenSet(resolveOAuthProviderId(access.family));
    if (!login?.accessToken?.trim())
      throw new AccountRequestCredentialUnavailableError(access.family);
    return createHash("sha256")
      .update(
        JSON.stringify([
          access.family,
          access.planKind,
          access.planKind === "team-coding-plan"
            ? [access.organizationId, access.projectId, access.productId]
            : null,
          login.accessToken.trim(),
          login.zcodeJwtToken?.trim() ?? null,
        ]),
      )
      .digest("hex");
  }

  async assertCurrent(input: AccountAccessIdentityInput): Promise<void> {
    if (!(await this.#resolveAccess(input.accountAccess))) {
      throw new AccountRequestCredentialUnavailableError(input.providerId);
    }
  }

  #resolveAccess(
    access: ZCodeProviderAccountAccess | ZCodeAccountAccess,
  ): Promise<ZCodeAccountAccess | null> {
    if (access.type === "new-api-account") return Promise.resolve(null);
    return "mode" in access
      ? this.#options.resolveCurrentAccountAccess(access)
      : Promise.resolve(access);
  }
}

function resolveOAuthProviderId(family: ProviderFamilyDomain): OAuthProviderId {
  return family === "zai" ? ZAI_PROVIDER_ID : BIGMODEL_PROVIDER_ID;
}

function requireApiKey(value: string | null | undefined, providerId: string): string {
  const normalized = value?.trim() ?? "";
  if (!normalized) {
    throw new AccountRequestCredentialUnavailableError(providerId);
  }
  return normalized;
}

export function createAccountProviderRequestAuthService(
  options: AccountProviderRequestAuthServiceOptions,
): AccountProviderRequestAuthService {
  return new AccountProviderRequestAuthService(options);
}

/** XCODE: 请求凭据绑定 owner/授权代际；能力版本只影响下一轮冻结配置。 */
export function createNewApiAccountRequestAuthResolver(options: {
  account: Pick<NewApiAccountService, "isCurrent" | "getRelayCredential">;
  accountSource: ProviderSource<AccountProviderConfigSnapshot>;
  official: AccountRequestAuthResolver;
}): AccountRequestAuthResolver {
  const assertNative = async (input: AccountAccessIdentityInput & { modelId?: string }) => {
    const access = input.accountAccess;
    if (access.type !== "new-api-account")
      throw new AccountRequestCredentialUnavailableError(input.providerId);
    // XCODE: typed 直调不经过协议 schema，只迁移精确旧选择；Host 快照键仍须是规范身份。
    const providerId = normalizeAiscooModelProviderId(input.providerId);
    const snapshot = await options.accountSource.read();
    const providerAccess = snapshot.providers.get(providerId)?.access;
    if (
      !isNewApiModelProviderId(providerId) ||
      !access.owner ||
      !access.authorizationRevision ||
      !options.account.isCurrent(access.owner) ||
      !snapshot.owner ||
      !options.account.isCurrent(snapshot.owner) ||
      access.authorizationRevision !== snapshot.authorizationRevision ||
      providerAccess?.type !== "new-api-account" ||
      providerAccess.entitled !== true ||
      snapshot.states?.[providerId]?.current !== true ||
      (input.modelId !== undefined &&
        (!snapshot.providers.get(providerId)?.builtinModelIds?.includes(input.modelId) ||
          snapshot.modelConfigs?.[providerId]?.[input.modelId]?.enabled !== true))
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
      // XCODE: 私有模型身份不能借官方 access 进入另一条凭据路径。
      if (isNewApiModelProviderId(normalizeAiscooModelProviderId(input.providerId)))
        throw new AccountRequestCredentialUnavailableError(input.providerId);
      await options.official.assertCurrent(input);
    },
    resolveCurrent: async (input) => {
      if (input.accountAccess.type !== "new-api-account") {
        if (isNewApiModelProviderId(normalizeAiscooModelProviderId(input.providerId)))
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
      // XCODE: await 期间可能退出、换授权或下架模型，二次检查后才能释放凭据。
      await assertNative(input);
      return { apiKey: credential.token };
    },
  };
}
