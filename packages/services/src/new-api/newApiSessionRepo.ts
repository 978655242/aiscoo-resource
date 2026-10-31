import { createHash } from "node:crypto";
import { z } from "zod";
import {
  NewApiSessionBundleSchema,
  isCredentialDecryptError,
  normalizeNewApiOrigin,
  type NewApiSessionBundle,
} from "@zcode/shared";
import {
  commitHostCredentialRecords,
  readHostCredentialRecords,
  updateHostCredentialRecords,
  withHostCredentialRefreshLease,
  type HostCredentialStoreDependencies,
} from "../credential/credentialService.js";
import { createPrivateCredentialCipherProvider } from "../credential/providers/privateCredentialCipherProvider.js";

export interface NewApiStoredSession {
  schemaVersion: 1;
  origin: string;
  bundle: NewApiSessionBundle;
}

const storedSessionSchema = z
  .object({
    schemaVersion: z.literal(1),
    origin: z.string(),
    bundle: NewApiSessionBundleSchema,
  })
  .strict();
const activeOwnerSchema = z
  .object({
    userId: z.string().regex(/^[1-9]\d*$/),
    sid: z.string().min(1),
  })
  .strict();

function credentialRecoveryRequired(): Error {
  return Object.assign(new Error("Private account credentials require manual recovery"), {
    code: "XCODE_CREDENTIAL_RECORD_INVALID",
  });
}

// XCODE: 整份typed bundle同一次加密替换，refresh CAS不能覆盖另一窗口的owner。
export class NewApiSessionRepo {
  readonly #origin: string;
  readonly #prefix: string;
  readonly #activeKey: string;
  readonly #store: HostCredentialStoreDependencies;

  constructor(origin: string, dependencies: HostCredentialStoreDependencies = {}) {
    this.#origin = normalizeNewApiOrigin(origin);
    this.#prefix = `new-api:${createHash("sha256").update(this.#origin).digest("hex")}:`;
    this.#activeKey = `${this.#prefix}active`;
    this.#store = dependencies;
  }

  assertStorageAvailable(): void {
    if (!this.#store.cipherProvider) createPrivateCredentialCipherProvider();
  }

  async loadActive(): Promise<NewApiStoredSession | null> {
    return readHostCredentialRecords((load) => {
      const active = load(this.#activeKey);
      if (active === null) return null;
      const owner = this.#parseActive(active);
      const raw = load(this.#recordKey(owner.userId, owner.sid));
      if (raw === null) throw credentialRecoveryRequired();
      const session = this.#parseSession(raw);
      if (session.bundle.user.id !== owner.userId || session.bundle.session_id !== owner.sid) {
        throw credentialRecoveryRequired();
      }
      return session;
    }, this.#store);
  }

  async commit(session: NewApiStoredSession): Promise<void> {
    const next = this.#validateSession(session);
    const key = this.#recordKey(next.bundle.user.id, next.bundle.session_id);
    await updateHostCredentialRecords(
      [key, this.#activeKey],
      () => ({
        changes: new Map([
          [key, JSON.stringify(next)],
          [
            this.#activeKey,
            JSON.stringify({
              userId: next.bundle.user.id,
              sid: next.bundle.session_id,
            }),
          ],
        ]),
        result: undefined,
      }),
      this.#store,
    );
  }

  // 新登录已通过换码与 Me 核验，才能恢复旧记录；冷恢复和 refresh 仍失败关闭。
  async commitVerifiedLogin(
    session: NewApiStoredSession,
    assertCurrent: () => void,
  ): Promise<NewApiStoredSession | null> {
    const next = this.#validateSession(session);
    const key = this.#recordKey(next.bundle.user.id, next.bundle.session_id);
    return commitHostCredentialRecords(
      [key, this.#activeKey],
      (load) => {
        let recoveryRequired = false;
        const recover = <T>(read: () => T): T | null => {
          try {
            return read();
          } catch (error) {
            if (
              !isCredentialDecryptError(error) &&
              !(
                error instanceof Error &&
                "code" in error &&
                error.code === "XCODE_CREDENTIAL_RECORD_INVALID"
              )
            )
              throw error;
            recoveryRequired = true;
            return null;
          }
        };
        const previous = recover(() => {
          const active = load(this.#activeKey);
          if (active === null) return null;
          const owner = this.#parseActive(active);
          const raw = load(this.#recordKey(owner.userId, owner.sid));
          if (raw === null) throw credentialRecoveryRequired();
          const stored = this.#parseSession(raw);
          if (!this.#matchesActive(owner, stored)) throw credentialRecoveryRequired();
          return stored;
        });
        // 新 SID 也可能与不可读历史记录重名，覆盖前同样保留其密文证据。
        recover(() => {
          const raw = load(key);
          if (raw !== null) {
            const stored = this.#parseSession(raw);
            if (!this.#matchesOwner(stored, next)) throw credentialRecoveryRequired();
          }
        });
        return {
          changes: new Map([
            [key, JSON.stringify(next)],
            [
              this.#activeKey,
              JSON.stringify({
                userId: next.bundle.user.id,
                sid: next.bundle.session_id,
              }),
            ],
          ]),
          result: previous,
          recoveryRequired,
        };
      },
      assertCurrent,
      this.#store,
    );
  }

  async rotate(expected: NewApiStoredSession, session: NewApiStoredSession): Promise<boolean> {
    const next = this.#validateSession(session);
    this.#validateSession(expected);
    if (
      next.bundle.user.id !== expected.bundle.user.id ||
      next.bundle.session_id !== expected.bundle.session_id ||
      next.bundle.relay_credential.token !== expected.bundle.relay_credential.token
    ) {
      throw credentialRecoveryRequired();
    }
    const key = this.#recordKey(expected.bundle.user.id, expected.bundle.session_id);
    return updateHostCredentialRecords(
      [key],
      (records) => {
        const current = records.get(key);
        if (!current || !this.#matchesCredential(this.#parseSession(current), expected)) {
          return { changes: new Map<string, string | null>(), result: false };
        }
        return {
          changes: new Map([[key, JSON.stringify(next)]]),
          result: true,
        };
      },
      this.#store,
    );
  }

  async refreshCurrent(
    expected: NewApiStoredSession,
    refresh: (bundle: NewApiSessionBundle) => Promise<NewApiSessionBundle>,
  ): Promise<NewApiStoredSession | null> {
    this.#validateSession(expected);
    const key = this.#recordKey(expected.bundle.user.id, expected.bundle.session_id);
    return withHostCredentialRefreshLease(
      key,
      async () => {
        const current = await readHostCredentialRecords((load) => {
          const raw = load(key);
          return raw === null ? null : this.#parseSession(raw);
        }, this.#store);
        if (current === null) return null;
        if (
          !this.#matchesOwner(current, expected) ||
          current.bundle.relay_credential.token !== expected.bundle.relay_credential.token
        ) {
          throw credentialRecoveryRequired();
        }
        const next: NewApiStoredSession = {
          schemaVersion: 1,
          origin: this.#origin,
          bundle: await refresh(current.bundle),
        };
        this.#validateSession(next);
        if (
          !this.#matchesOwner(next, current) ||
          next.bundle.relay_credential.token !== current.bundle.relay_credential.token
        ) {
          throw credentialRecoveryRequired();
        }
        if (
          next.bundle.access_token === current.bundle.access_token &&
          next.bundle.refresh_token === current.bundle.refresh_token
        )
          return current;
        return (await this.rotate(current, next)) ? next : null;
      },
      this.#store,
    );
  }

  async remove(expected: NewApiStoredSession): Promise<NewApiStoredSession | null> {
    this.#validateSession(expected);
    const key = this.#recordKey(expected.bundle.user.id, expected.bundle.session_id);
    return updateHostCredentialRecords<NewApiStoredSession | null>(
      [key, this.#activeKey],
      (records) => {
        const raw = records.get(key);
        const current = raw ? this.#parseSession(raw) : null;
        if (!current || !this.#matchesOwner(current, expected)) {
          return { changes: new Map<string, string | null>(), result: null };
        }
        const changes = new Map<string, string | null>([[key, null]]);
        const active = records.get(this.#activeKey);
        if (active && this.#matchesActive(this.#parseActive(active), expected)) {
          changes.set(this.#activeKey, null);
        }
        return { changes, result: current };
      },
      this.#store,
    );
  }

  async revert(
    committed: NewApiStoredSession,
    previous: NewApiStoredSession | null,
  ): Promise<void> {
    this.#validateSession(committed);
    if (previous) this.#validateSession(previous);
    const key = this.#recordKey(committed.bundle.user.id, committed.bundle.session_id);
    const previousKey = previous
      ? this.#recordKey(previous.bundle.user.id, previous.bundle.session_id)
      : null;
    const keys = [key, this.#activeKey];
    if (previousKey !== null && previousKey !== key) keys.push(previousKey);
    await updateHostCredentialRecords(
      keys,
      (records) => {
        const current = records.get(key);
        if (!current || !this.#matchesCredential(this.#parseSession(current), committed)) {
          return {
            changes: new Map<string, string | null>(),
            result: undefined,
          };
        }
        const changes = new Map<string, string | null>([[key, null]]);
        const active = records.get(this.#activeKey);
        if (active && this.#matchesActive(this.#parseActive(active), committed)) {
          const prior = previousKey === null ? null : records.get(previousKey);
          changes.set(
            this.#activeKey,
            prior && previous
              ? JSON.stringify({
                  userId: previous.bundle.user.id,
                  sid: previous.bundle.session_id,
                })
              : null,
          );
        }
        return { changes, result: undefined };
      },
      this.#store,
    );
  }

  #recordKey(userId: string, sid: string): string {
    return `${this.#prefix}${encodeURIComponent(userId)}:${encodeURIComponent(sid)}`;
  }

  #validateSession(value: unknown): NewApiStoredSession {
    const parsed = storedSessionSchema.safeParse(value);
    if (!parsed.success || parsed.data.origin !== this.#origin) throw credentialRecoveryRequired();
    return parsed.data;
  }

  #parseSession(raw: string): NewApiStoredSession {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw credentialRecoveryRequired();
    }
    return this.#validateSession(value);
  }

  #parseActive(raw: string): z.infer<typeof activeOwnerSchema> {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw credentialRecoveryRequired();
    }
    const parsed = activeOwnerSchema.safeParse(value);
    if (!parsed.success) throw credentialRecoveryRequired();
    return parsed.data;
  }

  #matchesCredential(current: NewApiStoredSession, expected: NewApiStoredSession): boolean {
    return (
      this.#matchesOwner(current, expected) &&
      current.bundle.refresh_token === expected.bundle.refresh_token
    );
  }

  #matchesOwner(current: NewApiStoredSession, expected: NewApiStoredSession): boolean {
    return (
      current.origin === expected.origin &&
      current.bundle.user.id === expected.bundle.user.id &&
      current.bundle.session_id === expected.bundle.session_id
    );
  }

  #matchesActive(
    active: z.infer<typeof activeOwnerSchema>,
    expected: NewApiStoredSession,
  ): boolean {
    return active.userId === expected.bundle.user.id && active.sid === expected.bundle.session_id;
  }
}
