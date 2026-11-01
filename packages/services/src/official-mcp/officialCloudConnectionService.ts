import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Emitter } from "@zcode/rpc";
import {
  officialCloudFamilySchema,
  type NewApiOwner,
  type OfficialCloudFamily,
  type OfficialCloudConnectionSnapshot,
  resolveJwtExpiration,
  type ApiClient,
  type ProjectAccessTokenMaterial,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/provider";
import type { HostCredentialStoreDependencies } from "../credential/credentialService.js";
import { createOAuthProviderAdapters } from "../oauth/providers/index.js";
import { createOAuthRuntimeConfig } from "../oauth/runtimeConfig.js";
import type { OAuthProviderAdapter } from "../oauth/providers/providerAdapter.js";
import type { IOfficialCloudConnectionService } from "./officialCloudConnection.js";
import {
  resolveOfficialCloudCatalogDependencies,
  type OfficialCloudMaterial,
  type OfficialCloudLoginCredentials,
} from "./officialCloudCatalog.js";
import { buildOfficialOffPeakModelSelectionView } from "../model-provider/offPeakModelSelectionView.js";
import { createOfficialCloudRequestFences } from "./officialCloudRequestFences.js";
import {
  createOfficialCloudConnectionRecords,
  createOfficialCloudCredentialResolver,
  createOfficialCloudConnectionRecord,
  officialCloudLoginIdentity,
  ownerChanged,
  prefix,
  projectOfficialCloudConnection,
  validateRecord,
} from "./officialCloudConnectionRecords.js";

export interface OfficialCloudCredentialSnapshot
  extends OfficialCloudLoginCredentials, OfficialCloudMaterial {
  owner: NewApiOwner;
  ownerEpoch: number;
  connectionKey: string;
  credentialGeneration: string;
  /** Host-only durable principal binding, independent of session/credential rotation. */
  ownerKey?: string;
  /** Captured lifetime check for synchronous SQL/publication admission after awaits. */
  assertCurrentSync?: () => void;
}
// XCODE: 非秘密摘要统一绑定原生 owner、官方连接及凭据代际，供 worker 准入比较。
export function officialCloudInvocationScope(credentials: OfficialCloudCredentialSnapshot): string {
  const { owner, ownerEpoch, connectionKey, credentialGeneration } = credentials;
  return `official-cloud:sha256:${createHash("sha256")
    .update(
      JSON.stringify([
        owner.origin,
        owner.userId,
        owner.sid,
        owner.authGeneration,
        ownerEpoch,
        connectionKey,
        credentialGeneration,
      ]),
    )
    .digest("hex")}`;
}
export interface OfficialCloudConnectionHost {
  service: IOfficialCloudConnectionService;
  onPrimaryOwnerChanged(nextOwner?: NewApiOwner | null): void;
  resolveCredentials(): Promise<OfficialCloudCredentialSnapshot | null>;
  resolveCodingPlanMaterial(
    credentials: OfficialCloudCredentialSnapshot,
    rejectedProjectTokenFingerprint?: string,
  ): Promise<ProjectAccessTokenMaterial | null>;
  isCurrent(credentials: OfficialCloudCredentialSnapshot): Promise<boolean>;
  withCredentials<T>(run: (credentials: OfficialCloudCredentialSnapshot) => Promise<T>): Promise<T>;
  getModelSelectionView(): Promise<ModelSelectionView>;
  captureRequestFence(): Promise<{
    token: string | null;
    scope: string;
    assertCurrentSync(): void;
    isCurrent(): Promise<boolean>;
  }>;
  captureOwnerFence(): { isCurrent(): boolean };
}
interface Dependencies {
  account: { getOwner(): NewApiOwner | null; isCurrent(owner: NewApiOwner): boolean };
  apiClient?: ApiClient;
  adapters?: readonly OAuthProviderAdapter[];
  store?: HostCredentialStoreDependencies;
  zcodeBuiltinFilePath?: string;
  readModelView?: (access: OfficialCloudMaterial["access"]) => Promise<ModelSelectionView>;
  loadCloud?: (credentials: OfficialCloudLoginCredentials) => Promise<OfficialCloudMaterial>;
  resolveCodingPlanMaterial?: (
    credentials: OfficialCloudLoginCredentials & {
      access: OfficialCloudMaterial["access"];
      accountIdentity: string;
    },
    rejectedProjectTokenFingerprint?: string,
  ) => Promise<ProjectAccessTokenMaterial | null>;
  now?: () => number;
  onDidChange?: () => void | Promise<void>;
}

/** Host-only owner. Only `service` is registered in RPC; secrets never become service methods. */
export function createOfficialCloudConnectionHost(
  dependencies: Dependencies,
): OfficialCloudConnectionHost {
  const store = dependencies.store ?? {};
  const now = dependencies.now ?? Date.now;
  const adapters =
    dependencies.adapters ??
    createOAuthProviderAdapters(createOAuthRuntimeConfig(), { apiClient: dependencies.apiClient });
  const { readModelView, loadCloud, resolveCodingPlanMaterial, clearCodingPlanMaterial } =
    resolveOfficialCloudCatalogDependencies(dependencies);
  let epoch = 0;
  let credentialLifetime = 0;
  const changes = new Emitter<void>();
  let primaryTransitionOwner: NewApiOwner | null | undefined;
  const blockedOwners = new Set<string>();
  let pending: {
    purpose: "official-cloud";
    owner: NewApiOwner;
    epoch: number;
    state: string;
    family: OfficialCloudFamily;
    expiresAt: number;
  } | null = null;
  const current = (owner: NewApiOwner, capturedEpoch = epoch) =>
    capturedEpoch === epoch &&
    dependencies.account.isCurrent(owner) &&
    (primaryTransitionOwner === undefined ||
      JSON.stringify(owner) === JSON.stringify(primaryTransitionOwner));
  const { read, commit, revert, remove } = createOfficialCloudConnectionRecords(
    store,
    current,
    () => {
      credentialLifetime++;
    },
  );
  const pendingFamily = (owner: NewApiOwner) =>
    pending &&
    pending.expiresAt > now() &&
    current(pending.owner, pending.epoch) &&
    JSON.stringify(pending.owner) === JSON.stringify(owner)
      ? pending.family
      : null;
  const getSnapshot = async (): Promise<OfficialCloudConnectionSnapshot> => {
    const owner = dependencies.account.getOwner();
    if (!owner || !current(owner)) return { status: "locked", pendingFamily: null };
    if (blockedOwners.has(prefix(owner))) return { status: "disconnected", pendingFamily: null };
    const capturedEpoch = epoch;
    const record = await read(owner);
    if (!current(owner, capturedEpoch)) return getSnapshot();
    return record
      ? projectOfficialCloudConnection(owner, record, pendingFamily(owner))
      : { status: "disconnected", pendingFamily: pendingFamily(owner) };
  };
  const resolveCredentials = createOfficialCloudCredentialResolver({
    getOwner: () => dependencies.account.getOwner(),
    current,
    isBlocked: (owner) => blockedOwners.has(prefix(owner)),
    getEpoch: () => epoch,
    getLifetime: () => credentialLifetime,
    read,
    now,
  });
  const isCurrent = async (credentials: OfficialCloudCredentialSnapshot): Promise<boolean> => {
    if (credentials.ownerEpoch !== epoch || !current(credentials.owner)) return false;
    const latest = await resolveCredentials();
    try {
      credentials.assertCurrentSync?.();
    } catch {
      return false;
    }
    return (
      latest !== null &&
      JSON.stringify(latest) === JSON.stringify(credentials) &&
      current(credentials.owner, credentials.ownerEpoch) &&
      resolveJwtExpiration(credentials.jwt, now()).kind !== "expired"
    );
  };
  const service: IOfficialCloudConnectionService = {
    onDidChange: changes.event,
    getSnapshot,
    async startOAuth(family) {
      officialCloudFamilySchema.parse(family);
      const owner = dependencies.account.getOwner();
      if (!owner || !current(owner))
        throw new Error("Official cloud requires Native account login");
      const adapter = adapters.find(
        (candidate) => candidate.providerId === family && candidate.meta.enabled,
      );
      if (!adapter) throw new Error("Official cloud family is unavailable");
      const state = randomBytes(32).toString("hex");
      clearCodingPlanMaterial();
      epoch++;
      pending = {
        purpose: "official-cloud",
        owner: { ...owner },
        epoch,
        state,
        family,
        expiresAt: now() + 300_000,
      };
      changes.fire();
      return {
        provider: family,
        purpose: "official-cloud",
        state,
        authorizeUrl: adapter.buildAuthorizeUrl({
          providerId: family,
          state,
          redirectUri: adapter.redirectUri,
          now,
        }),
      };
    },
    async handleCallback(url) {
      const flow = pending;
      if (
        !flow ||
        flow.purpose !== "official-cloud" ||
        flow.expiresAt <= now() ||
        !current(flow.owner, flow.epoch)
      )
        return null;
      const parsed = new URL(url);
      if (
        parsed.searchParams.get("state") !== flow.state ||
        (parsed.searchParams.has("provider") &&
          parsed.searchParams.get("provider") !== flow.family) ||
        (parsed.searchParams.has("purpose") &&
          parsed.searchParams.get("purpose") !== "official-cloud")
      )
        return null;
      const adapter = adapters.find((candidate) => candidate.providerId === flow.family)!;
      const redirect = new URL(adapter.redirectUri);
      if (
        parsed.protocol !== redirect.protocol ||
        parsed.host !== redirect.host ||
        parsed.pathname !== redirect.pathname
      )
        return null;
      const context = {
        providerId: flow.family,
        state: flow.state,
        redirectUri: adapter.redirectUri,
        now,
      };
      const params = adapter.parseCallbackParams(url);
      if (params.state !== flow.state) return null;
      pending = null;
      changes.fire();
      const expected = await read(flow.owner);
      if (!current(flow.owner, flow.epoch)) return null;
      const tokens = await adapter.exchangeToken(params, context);
      if (!current(flow.owner, flow.epoch)) return null;
      if (!adapter.fetchUserInfo) throw new Error("Official cloud identity unavailable");
      const profile = await adapter.fetchUserInfo(tokens, context);
      if (!current(flow.owner, flow.epoch)) return null;
      const identity = officialCloudLoginIdentity(profile);
      const material = await loadCloud({
        family: flow.family,
        accessToken: tokens.accessToken,
        jwt: tokens.zcodeJwtToken ?? "",
      });
      if (!current(flow.owner, flow.epoch)) return null;
      const record = createOfficialCloudConnectionRecord(
        flow.owner,
        flow.family,
        identity,
        tokens,
        material,
      );
      if (!(await commit(flow.owner, record, expected, flow.epoch))) return null;
      if (!current(flow.owner, flow.epoch)) {
        await revert(flow.owner, record, expected);
        return null;
      }
      blockedOwners.delete(prefix(flow.owner));
      changes.fire();
      await dependencies.onDidChange?.();
      if (!current(flow.owner, flow.epoch)) return null;
      return projectOfficialCloudConnection(flow.owner, record, pendingFamily(flow.owner));
    },
    async logout() {
      pending = null;
      clearCodingPlanMaterial();
      epoch++;
      const owner = dependencies.account.getOwner();
      if (!owner) return;
      blockedOwners.add(prefix(owner));
      changes.fire();
      const record = await read(owner);
      if (!record) {
        blockedOwners.delete(prefix(owner));
        changes.fire();
        await dependencies.onDidChange?.();
        return;
      }
      await remove(owner, record);
      blockedOwners.delete(prefix(owner));
      changes.fire();
      await dependencies.onDidChange?.();
    },
    async refresh() {
      // XCODE: 刷新开始即失效冻结的官方执行，不能等 credential store/network 返回才撤销 A。
      clearCodingPlanMaterial();
      const capturedEpoch = ++epoch;
      changes.fire();
      const credentials = await resolveCredentials();
      if (!credentials || !current(credentials.owner, capturedEpoch))
        throw new Error("Official cloud connection required");
      const record = await read(credentials.owner);
      if (!record || !current(credentials.owner, capturedEpoch)) throw ownerChanged();
      const material = await loadCloud(credentials);
      if (!current(credentials.owner, capturedEpoch) || !(await isCurrent(credentials)))
        throw ownerChanged();
      const next = validateRecord(
        { ...record, ...material, credentialGeneration: randomUUID() },
        credentials.owner,
      );
      if (!(await commit(credentials.owner, next, record, capturedEpoch))) throw ownerChanged();
      if (!current(credentials.owner, capturedEpoch)) {
        await revert(credentials.owner, next, record);
        throw ownerChanged();
      }
      changes.fire();
      await dependencies.onDidChange?.();
      if (!current(credentials.owner, capturedEpoch)) throw ownerChanged();
      return projectOfficialCloudConnection(
        credentials.owner,
        next,
        pendingFamily(credentials.owner),
      );
    },
  };
  return {
    service,
    onPrimaryOwnerChanged(nextOwner = dependencies.account.getOwner()) {
      clearCodingPlanMaterial();
      epoch++;
      pending = null;
      primaryTransitionOwner = nextOwner;
      changes.fire();
    },
    resolveCredentials,
    async resolveCodingPlanMaterial(credentials, rejectedProjectTokenFingerprint) {
      if (!(await isCurrent(credentials))) throw ownerChanged();
      const material = await resolveCodingPlanMaterial(
        { ...credentials, accountIdentity: officialCloudInvocationScope(credentials) },
        rejectedProjectTokenFingerprint,
      );
      if (!(await isCurrent(credentials))) throw ownerChanged();
      credentials.assertCurrentSync?.();
      return material;
    },
    isCurrent,
    ...createOfficialCloudRequestFences({
      account: dependencies.account,
      getEpoch: () => epoch,
      current,
      resolveCredentials,
      isCurrent,
      invocationScope: officialCloudInvocationScope,
    }),
    async withCredentials(run) {
      const capturedEpoch = epoch;
      const credentials = await resolveCredentials();
      if (!credentials) throw new Error("Official cloud connection required");
      const result = await run(credentials);
      if (!current(credentials.owner, capturedEpoch) || !(await isCurrent(credentials)))
        throw ownerChanged();
      credentials.assertCurrentSync?.();
      return result;
    },
    async getModelSelectionView() {
      if (!readModelView) throw new Error("Original official model catalog unavailable");
      return this.withCredentials(async (credentials) =>
        buildOfficialOffPeakModelSelectionView(
          await readModelView(credentials.access),
          credentials.family,
        ),
      );
    },
  };
}
