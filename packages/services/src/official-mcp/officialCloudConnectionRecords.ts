import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  officialCloudCatalogSchema,
  officialCloudFamilySchema,
  zcodeAccountAccessSchema,
  normalizeAiscooAdminOrigin,
  type AiscooAdminOwner,
  type OfficialCloudConnectionSnapshot,
  type OfficialCloudFamily,
  type UserInfo,
  type OAuthTokenSet,
  resolveJwtExpiration,
} from "@zcode/shared";
import {
  readHostCredentialRecords,
  updateHostCredentialRecords,
  type HostCredentialStoreDependencies,
} from "../credential/credentialService.js";
import type { OfficialCloudCredentialSnapshot } from "./officialCloudConnectionService.js";
import type { OfficialCloudMaterial } from "./officialCloudCatalog.js";

const identitySchema = z
  .object({
    id: z.string().min(1),
    username: z.string(),
    displayName: z.string(),
    avatarUrl: z.string().optional(),
  })
  .strict();
const recordSchema = z
  .object({
    schemaVersion: z.literal(1),
    origin: z.string().url(),
    userId: z.string().min(1),
    connectionKey: z.string().min(1),
    credentialGeneration: z.string().min(1),
    family: officialCloudFamilySchema,
    identity: identitySchema,
    tokens: z
      .object({
        accessToken: z.string().min(1),
        zcodeJwtToken: z.string().min(1),
        refreshToken: z.string().optional(),
        expiresAt: z.number().optional(),
      })
      .strict(),
    access: zcodeAccountAccessSchema.nullable(),
    catalog: officialCloudCatalogSchema,
  })
  .strict();
export type StoredConnection = z.infer<typeof recordSchema>;

export function ownerChanged(): Error {
  return new Error("Official cloud owner or credential generation changed");
}
export function prefix(owner: AiscooAdminOwner): string {
  return `official-cloud:${createHash("sha256").update(owner.origin).digest("hex")}:${encodeURIComponent(owner.userId)}:`;
}
export function fingerprint(record: StoredConnection): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}
export function validateRecord(value: unknown, owner: AiscooAdminOwner): StoredConnection {
  // XCODE: 丢弃旧版落盘执行 Key，保留严格校验的登录身份与 owner，不再恢复过期凭据。
  const { codingPlanApiKey: _legacyKey, ...connection } = z
    .record(z.string(), z.unknown())
    .parse(value);
  const record = recordSchema.parse(connection);
  if (
    record.origin !== owner.origin ||
    record.userId !== owner.userId ||
    (record.access && record.access.family !== record.family) ||
    record.identity.id === "unknown"
  )
    throw ownerChanged();
  return record;
}
function recordKey(owner: AiscooAdminOwner, record: StoredConnection): string {
  return `${prefix(owner)}${record.family}:${encodeURIComponent(record.identity.id)}:${record.credentialGeneration}`;
}

/** Persistence admits commits synchronously against the Host's single lifetime owner. */
export function createOfficialCloudConnectionRecords(
  store: HostCredentialStoreDependencies,
  current: (owner: AiscooAdminOwner, capturedEpoch: number) => boolean,
  onCommit: () => void,
) {
  const read = (owner: AiscooAdminOwner): Promise<StoredConnection | null> =>
    readHostCredentialRecords((load) => {
      const active = load(`${prefix(owner)}active`);
      if (!active) return null;
      if (!active.startsWith(prefix(owner)) || active.endsWith(":active")) throw ownerChanged();
      const raw = load(active);
      if (!raw) throw new Error("Official cloud encrypted connection requires recovery");
      const record = validateRecord(JSON.parse(raw), owner);
      if (active !== recordKey(owner, record)) throw ownerChanged();
      return record;
    }, store);
  const commit = async (
    owner: AiscooAdminOwner,
    record: StoredConnection,
    expected: StoredConnection | null,
    capturedEpoch: number,
  ): Promise<boolean> => {
    const activeKey = `${prefix(owner)}active`;
    const key = recordKey(owner, record);
    const oldKey = expected ? recordKey(owner, expected) : null;
    return updateHostCredentialRecords(
      [activeKey, key, ...(oldKey && oldKey !== key ? [oldKey] : [])],
      (records) => {
        if (!current(owner, capturedEpoch) || records.get(activeKey) !== oldKey)
          return { changes: new Map<string, string | null>(), result: false };
        const previous = oldKey ? records.get(oldKey) : null;
        if (
          expected &&
          (!previous ||
            fingerprint(validateRecord(JSON.parse(previous), owner)) !== fingerprint(expected))
        )
          return { changes: new Map<string, string | null>(), result: false };
        const changes = new Map<string, string | null>([
          [activeKey, key],
          [key, JSON.stringify(record)],
        ]);
        if (oldKey && oldKey !== key) changes.set(oldKey, null);
        onCommit();
        return { changes, result: true };
      },
      store,
    );
  };
  const revert = async (
    owner: AiscooAdminOwner,
    committed: StoredConnection,
    previous: StoredConnection | null,
  ): Promise<void> => {
    const activeKey = `${prefix(owner)}active`,
      key = recordKey(owner, committed);
    const previousKey = previous ? recordKey(owner, previous) : null;
    await updateHostCredentialRecords(
      [activeKey, key, ...(previousKey ? [previousKey] : [])],
      (records) => {
        if (records.get(activeKey) !== key || records.get(key) !== JSON.stringify(committed))
          return { changes: new Map<string, string | null>(), result: undefined };
        const changes = new Map<string, string | null>([
          [key, null],
          [activeKey, previousKey],
        ]);
        if (previousKey && previous) changes.set(previousKey, JSON.stringify(previous));
        return { changes, result: undefined };
      },
      store,
    );
  };
  const remove = async (owner: AiscooAdminOwner, record: StoredConnection): Promise<void> => {
    const key = recordKey(owner, record),
      activeKey = `${prefix(owner)}active`;
    await updateHostCredentialRecords(
      [key, activeKey],
      (records) => {
        const stored = records.get(key);
        if (
          records.get(activeKey) !== key ||
          !stored ||
          fingerprint(validateRecord(JSON.parse(stored), owner)) !== fingerprint(record)
        )
          return { changes: new Map<string, string | null>(), result: undefined };
        return {
          changes: new Map([
            [key, null],
            [activeKey, null],
          ]),
          result: undefined,
        };
      },
      store,
    );
  };
  return { read, commit, revert, remove };
}

// XCODE: Native 身份只参与不透明缓存 key，完整 owner 不得跨 Renderer RPC。
export function projectOfficialCloudConnection(
  owner: AiscooAdminOwner,
  record: StoredConnection,
  pendingFamily: OfficialCloudFamily | null,
): OfficialCloudConnectionSnapshot {
  return {
    status: "connected",
    pendingFamily,
    connectionKey: createHash("sha256")
      .update(
        JSON.stringify([
          owner.origin,
          owner.userId,
          owner.sid,
          owner.authGeneration,
          record.connectionKey,
        ]),
      )
      .digest("hex"),
    credentialGeneration: record.credentialGeneration,
    family: record.family,
    identity: record.identity,
    planScope:
      record.access?.planKind === "team-coding-plan"
        ? {
            targetType: "TEAM",
            organizationId: record.access.organizationId,
            projectId: record.access.projectId,
            productId: record.access.productId,
          }
        : record.access?.planKind === "individual-coding-plan"
          ? { targetType: "PERSONAL" }
          : null,
    catalog: record.catalog,
  };
}

export function officialCloudRecordOwnerKey(
  owner: AiscooAdminOwner,
  record: StoredConnection,
): string {
  const access = record.access;
  return createHash("sha256")
    .update(
      JSON.stringify([
        normalizeAiscooAdminOrigin(owner.origin),
        owner.userId,
        record.family,
        record.identity.id,
        access?.planKind ?? null,
        access?.planKind === "team-coding-plan"
          ? [access.organizationId, access.projectId, access.productId]
          : null,
      ]),
    )
    .digest("hex");
}

export function createOfficialCloudCredentialResolver(options: {
  getOwner(): AiscooAdminOwner | null;
  current(owner: AiscooAdminOwner, capturedEpoch?: number): boolean;
  isBlocked(owner: AiscooAdminOwner): boolean;
  getEpoch(): number;
  getLifetime(): number;
  read(owner: AiscooAdminOwner): Promise<StoredConnection | null>;
  now(): number;
}) {
  const { getOwner, current, isBlocked, getEpoch, getLifetime, read, now } = options;
  return async (): Promise<OfficialCloudCredentialSnapshot | null> => {
    const owner = getOwner();
    if (!owner || !current(owner)) return null;
    if (isBlocked(owner)) return null;
    const capturedEpoch = getEpoch();
    const capturedLifetime = getLifetime();
    const before = await read(owner);
    if (!before || !current(owner, capturedEpoch) || isBlocked(owner)) return null;
    const after = await read(owner);
    if (
      !after ||
      !current(owner, capturedEpoch) ||
      capturedLifetime !== getLifetime() ||
      fingerprint(before) !== fingerprint(after)
    )
      return null;
    if (resolveJwtExpiration(before.tokens.zcodeJwtToken, now()).kind === "expired") return null;
    const ownerKey = officialCloudRecordOwnerKey(owner, before);
    const assertCurrentSync = () => {
      if (
        !current(owner, capturedEpoch) ||
        capturedLifetime !== getLifetime() ||
        isBlocked(owner) ||
        resolveJwtExpiration(before.tokens.zcodeJwtToken, now()).kind === "expired"
      )
        throw ownerChanged();
    };
    return {
      owner,
      ownerEpoch: capturedEpoch,
      connectionKey: before.connectionKey,
      credentialGeneration: before.credentialGeneration,
      family: before.family,
      jwt: before.tokens.zcodeJwtToken,
      accessToken: before.tokens.accessToken,
      access: before.access,
      catalog: before.catalog,
      ownerKey,
      assertCurrentSync,
    };
  };
}

export function officialCloudLoginIdentity(profile: UserInfo): UserInfo {
  return {
    id: profile.id,
    username: profile.username,
    displayName: profile.displayName,
    ...(profile.avatarUrl ? { avatarUrl: profile.avatarUrl } : {}),
  };
}

export function createOfficialCloudConnectionRecord(
  owner: AiscooAdminOwner,
  family: OfficialCloudFamily,
  identity: UserInfo,
  tokens: OAuthTokenSet,
  material: OfficialCloudMaterial,
): StoredConnection {
  return validateRecord(
    {
      schemaVersion: 1,
      origin: owner.origin,
      userId: owner.userId,
      family,
      identity,
      tokens,
      ...material,
      connectionKey: randomUUID(),
      credentialGeneration: randomUUID(),
    },
    owner,
  );
}
