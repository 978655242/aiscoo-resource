import {
  ProviderConfig,
  ProviderConfigMap,
  ProviderTemplateMap,
  ZhipuAccountAccessConfig,
  AiscooAdminAccountAccessConfig,
  type ModelConfigRules,
} from "./config/index.js";
import type { AccountProviderStates } from "./account-provider-state.js";
import type { AiscooAdminOwner, AiscooAdminModelPresentation } from "@zcode/shared/aiscoo-admin";
import type { AiscooAdminCatalogIssue } from "@zcode/shared/model-provider-types";

// XCODE: 账号只补充名称/图标，不能成为第二份模型能力配置。
export type AccountModelPresentation = Readonly<
  Record<string, Readonly<Record<string, Readonly<AiscooAdminModelPresentation[string][string]>>>>
>;

export interface ProviderSource<TSnapshot> {
  read(): Promise<TSnapshot>;
  onDidChange(listener: (reason: string) => void): () => void;
}

export interface ProviderConfigSnapshot {
  readonly revision: string;
  readonly zcodeBuiltinRevision: string;
  readonly personalRevision: string;
  readonly zcodeBuiltinProviders: ProviderConfigMap;
  readonly zcodeBuiltinProviderTemplates: ProviderTemplateMap;
  readonly personalProviders: ProviderConfigMap;
  readonly zcodeBuiltinModelRules: ModelConfigRules;
  readonly personalModels: ModelConfigRules;
  readonly personalProviderOrder?: readonly string[];
}

export interface AccountProviderConfigSnapshot {
  readonly revision: string;
  readonly basedOnZCodeBuiltinRevision: string;
  readonly providers: ProviderConfigMap;
  readonly states?: AccountProviderStates;
  readonly modelPresentation?: AccountModelPresentation;
  readonly catalogIssues?: readonly AiscooAdminCatalogIssue[];
  readonly catalogRevision?: string;
  readonly authorizationRevision?: string;
  readonly owner?: AiscooAdminOwner | null;
}

/** 首次 Account 事实尚未到达时，基于当前 Built-in 生成可发布的 fail-closed Overlay。 */
export function createFailClosedAccountProviderConfigSnapshot(
  config: ProviderConfigSnapshot,
): AccountProviderConfigSnapshot {
  const unentitledProviders = new ProviderConfigMap(
    config.zcodeBuiltinProviders.entries().flatMap(([providerId, provider]) =>
      provider.access?.type === "zhipu-account" || provider.access?.type === "new-api-account"
        ? ([
            [
              providerId,
              new ProviderConfig({
                access:
                  provider.access.type === "new-api-account"
                    ? new AiscooAdminAccountAccessConfig({ entitled: false })
                    : new ZhipuAccountAccessConfig({ entitled: false }),
              }),
            ],
          ] as const)
        : [],
    ),
  );
  return createAccountProviderConfigSnapshot(
    config.zcodeBuiltinRevision,
    unentitledProviders,
    undefined,
    { owner: null, modelPresentation: {}, catalogIssues: [] },
  );
}

export function createAccountProviderConfigSnapshot(
  basedOnZCodeBuiltinRevision: string,
  providers: ProviderConfigMap,
  states?: AccountProviderStates,
  details: Pick<
    AccountProviderConfigSnapshot,
    "modelPresentation" | "catalogIssues" | "owner" | "catalogRevision" | "authorizationRevision"
  > & { readonly revision?: string } = {},
): AccountProviderConfigSnapshot {
  const { revision, ...snapshotDetails } = details;
  const native = providers
    .entries()
    .some(([, config]) => config.access?.type === "new-api-account");
  // XCODE: Native owner 只进 Host/worker 信封，不能经 revision 的 JSON 被投影或写入日志。
  if (snapshotDetails.owner && !/^account:sha256:[a-f0-9]{64}$/.test(revision ?? ""))
    throw new Error("Native Account snapshot requires an opaque Host revision");
  return Object.freeze({
    revision:
      revision ??
      (native
        ? "account:native-unavailable"
        : `account:${JSON.stringify([basedOnZCodeBuiltinRevision, providers.toJSON(), states, snapshotDetails])}`),
    basedOnZCodeBuiltinRevision,
    providers,
    ...(states ? { states } : {}),
    ...snapshotDetails,
  });
}

const EMPTY_ACCOUNT_PROVIDER_CONFIG_SNAPSHOT: AccountProviderConfigSnapshot = Object.freeze({
  revision: "empty-account-config-v1",
  basedOnZCodeBuiltinRevision: "uninitialized",
  providers: ProviderConfigMap.empty(),
});

/**
 * 由进程外围适配器更新的账号 Provider 可用范围。
 *
 * Source 只保存账号状态投影出的第三层 Provider Config Overlay。
 * models 是账号权益约束；Token、API Key、Header 与账号身份不得写入 Config。
 */
export class MutableAccountProviderConfigSource implements ProviderSource<AccountProviderConfigSnapshot> {
  readonly #listeners = new Set<(reason: string) => void>();
  #snapshot: AccountProviderConfigSnapshot = EMPTY_ACCOUNT_PROVIDER_CONFIG_SNAPSHOT;

  async read(): Promise<AccountProviderConfigSnapshot> {
    return this.#snapshot;
  }

  /** XCODE: 原子写入/网络发送需同步读取同一快照，不能等待 Registry 的异步刷新。 */
  getSnapshot(): AccountProviderConfigSnapshot {
    return this.#snapshot;
  }

  onDidChange(listener: (reason: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  replace(snapshot: AccountProviderConfigSnapshot, reason = "replace"): boolean {
    if (snapshot.revision === this.#snapshot.revision) return false;
    this.#snapshot = freezeAccountProviderConfigSnapshot(snapshot);
    for (const listener of this.#listeners) listener(reason);
    return true;
  }
}

function freezeAccountProviderConfigSnapshot(
  snapshot: AccountProviderConfigSnapshot,
): AccountProviderConfigSnapshot {
  return Object.freeze({
    revision: snapshot.revision,
    basedOnZCodeBuiltinRevision: snapshot.basedOnZCodeBuiltinRevision,
    providers: snapshot.providers,
    ...(snapshot.states ? { states: snapshot.states } : {}),
    ...(snapshot.modelPresentation ? { modelPresentation: snapshot.modelPresentation } : {}),
    ...(snapshot.catalogIssues ? { catalogIssues: snapshot.catalogIssues } : {}),
    ...(snapshot.owner !== undefined ? { owner: snapshot.owner } : {}),
    ...(snapshot.catalogRevision ? { catalogRevision: snapshot.catalogRevision } : {}),
    ...(snapshot.authorizationRevision
      ? { authorizationRevision: snapshot.authorizationRevision }
      : {}),
  });
}
