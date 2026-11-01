import {
  NEW_API_PROVIDER_ID,
  isCredentialDecryptError,
  type NewApiOwner,
  type NewApiSessionBundle,
  type OAuthCachedSessionRestoreResult,
  type OAuthCallbackResult,
  type OAuthProviderId,
  type OAuthStartResponse,
  type OAuthSessionState,
} from "@zcode/shared";
import { Emitter } from "@zcode/rpc";
import type { IOAuthService } from "../oauth/oauth.js";
import type { NewApiProviderAdapter } from "../oauth/providers/newApiProviderAdapter.js";
import type { NewApiSessionRepo, NewApiStoredSession } from "./newApiSessionRepo.js";
import {
  refreshStoredSession,
  restoreSessionProfile,
  revokeSession,
  type NewApiSessionRefreshFlight,
} from "./newApiSessionOperations.js";
import {
  cachedSessionProfile,
  confirmedProfile,
  errorCode,
  isCurrentOwner,
  isPendingAuthorizationCurrent,
  isRevocation,
  sessionError,
  sessionOwner,
  unavailableSession,
  validateProvider,
  pendingAuthorization,
  validateRotatedSession,
  validateSession,
  type NewApiAuthorizationFlight,
  type PendingNewApiAuthorization,
} from "./newApiSessionValidation.js";

export class NewApiAccountService {
  readonly oauth: IOAuthService;
  #sessionChanges = new Emitter<OAuthSessionState>();
  #adapter: NewApiProviderAdapter;
  #repo: NewApiSessionRepo;
  #now: () => number;
  #readNow = () => this.#now();
  #onOwnerChanged: (owner: NewApiOwner | null) => Promise<void> | void;
  #generation = 0;
  #pending: PendingNewApiAuthorization | null = null;
  #callbackFlight: NewApiAuthorizationFlight | null = null;
  #session: NewApiStoredSession | null = null;
  #owner: NewApiOwner | null = null;
  #mutations: Promise<unknown> = Promise.resolve();
  #refreshFlight: NewApiSessionRefreshFlight | null = null;
  #restoreFlight: {
    generation: number;
    promise: Promise<OAuthCachedSessionRestoreResult>;
  } | null = null;

  constructor(dependencies: {
    adapter: NewApiProviderAdapter;
    repo: NewApiSessionRepo;
    now?: () => number;
    onOwnerChanged?: (owner: NewApiOwner | null) => Promise<void> | void;
  }) {
    this.#adapter = dependencies.adapter;
    this.#repo = dependencies.repo;
    this.#now = dependencies.now ?? Date.now;
    this.#onOwnerChanged = (owner) => {
      // XCODE: 主身份失效立即通知现有 OAuth 消费者，不等待官方连接/Provider 清理或撤销网络。
      if (!owner) this.#sessionChanges.fire("signed-out");
      return dependencies.onOwnerChanged?.(owner);
    };
    // XCODE: RPC 只注册显式公开投影，Host 的 SID、refresh 与 relay 凭据永不进入反射对象。
    this.oauth = Object.freeze({
      onDidChangeSession: this.#sessionChanges.event,
      getProviders: async () => [{ ...this.#adapter.meta }],
      getActiveProvider: async () => (this.#owner ? NEW_API_PROVIDER_ID : null),
      restoreCachedSession: async () => cachedSessionProfile(await this.#restore()),
      restoreCachedSessionState: async () => this.#restore(),
      restoreSession: async () => cachedSessionProfile(await this.#restore()),
      startOAuth: async (provider: OAuthProviderId) => this.#start(provider),
      startOAuthWithPolling: async () => {
        throw sessionError("XCODE_PRIVATE_POLLING_UNSUPPORTED");
      },
      pollPendingOAuth: async () => {
        throw sessionError("XCODE_PRIVATE_POLLING_UNSUPPORTED");
      },
      // XCODE: 回环 code 只能由 Host 送入 owner，公共 RPC 不接受转发的授权回调。
      handleCallback: async (url: string) => this.#handleCallback(url),
      refreshToken: async (provider?: OAuthProviderId) => {
        validateProvider(provider);
        await this.#refresh();
      },
      logout: async (provider?: OAuthProviderId) => {
        validateProvider(provider);
        await this.#logout();
      },
      logoutAll: async () => this.#logout(),
      cancelPending: async (provider?: OAuthProviderId) => {
        validateProvider(provider);
        if (!this.#pending) return;
        this.#generation++;
        this.#pending = null;
        this.#owner = null;
        await this.#onOwnerChanged(null);
      },
    });
  }

  getOwner(): NewApiOwner | null {
    return this.#owner;
  }

  isCurrent(owner: NewApiOwner): boolean {
    return isCurrentOwner(this.#owner, owner);
  }

  async withControlSession<T>(
    action: (accessToken: string, owner: NewApiOwner) => Promise<T>,
  ): Promise<T> {
    const owner = this.#owner;
    if (!owner || !this.#session) throw sessionError("XCODE_SESSION_INVALID");
    let refreshed = false;
    try {
      if (this.#session.bundle.access_expires_at <= this.#now()) {
        await this.#refresh();
        refreshed = true;
      }
      if (!this.isCurrent(owner) || !this.#session) throw sessionError("XCODE_STALE_OWNER");
      let result: T;
      const accessToken = this.#session.bundle.access_token;
      try {
        result = await action(accessToken, owner);
      } catch (error) {
        if (!this.isCurrent(owner)) throw sessionError("XCODE_STALE_OWNER");
        if (refreshed || errorCode(error) !== "XCODE_ACCESS_EXPIRED") throw error;
        if (this.#session?.bundle.access_token === accessToken) await this.#refresh();
        if (!this.isCurrent(owner) || !this.#session) throw sessionError("XCODE_STALE_OWNER");
        result = await action(this.#session.bundle.access_token, owner);
      }
      if (!this.isCurrent(owner)) throw sessionError("XCODE_STALE_OWNER");
      return result;
    } catch (error) {
      if (isRevocation(error) && this.isCurrent(owner))
        await this.#invalidate(this.#session!, this.#generation);
      throw error;
    }
  }

  async getRelayCredential(owner: NewApiOwner): Promise<{ token: string; expiresAt: number }> {
    if (!this.isCurrent(owner) || !this.#session) throw sessionError("XCODE_STALE_OWNER");
    const credential = this.#session.bundle.relay_credential;
    if (credential.expires_at <= this.#now()) {
      await this.#invalidate(this.#session, this.#generation);
      throw sessionError("XCODE_SESSION_INVALID");
    }
    return { token: credential.token, expiresAt: credential.expires_at };
  }

  #mutate<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#mutations.catch(() => undefined).then(run);
    this.#mutations = next;
    return next;
  }

  async #start(provider: OAuthProviderId): Promise<OAuthStartResponse> {
    validateProvider(provider);
    this.#repo.assertStorageAvailable();
    const authorization = this.#adapter.createAuthorization();
    const generation = ++this.#generation;
    this.#owner = null;
    this.#pending = pendingAuthorization(authorization, generation, this.#now());
    await this.#onOwnerChanged(null);
    if (generation !== this.#generation) throw sessionError("XCODE_STALE_OWNER");
    return {
      provider: NEW_API_PROVIDER_ID,
      purpose: "primary-account",
      state: authorization.state,
      authorizeUrl: authorization.authorizeUrl,
    };
  }

  async #handleCallback(url: string): Promise<OAuthCallbackResult | null> {
    const parsed = this.#adapter.parseCallback(url);
    const pending = this.#pending;
    if (
      !pending ||
      parsed.state !== pending.state ||
      pending.generation !== this.#generation ||
      pending.expiresAt <= this.#now()
    )
      return null;
    if (this.#callbackFlight?.pending === pending) return this.#callbackFlight.promise;
    const promise = this.#complete(pending, parsed.code);
    const flight = { pending, promise };
    this.#callbackFlight = flight;
    try {
      return await promise;
    } finally {
      if (this.#callbackFlight === flight) this.#callbackFlight = null;
    }
  }

  async #complete(
    pending: PendingNewApiAuthorization,
    code: string,
  ): Promise<OAuthCallbackResult | null> {
    let bundle: NewApiSessionBundle | null = null;
    let published = false;
    let displaced = this.#session;
    try {
      bundle = await this.#adapter.exchangeCode(code, pending.codeVerifier);
      if (!isPendingAuthorizationCurrent(this.#pending, pending, this.#generation, this.#readNow))
        return null;
      validateSession(bundle, this.#now(), true);
      const userInfo = confirmedProfile(
        await this.#adapter.client.getMe(bundle.access_token),
        bundle,
      );
      const record: NewApiStoredSession = {
        schemaVersion: 1,
        origin: this.#adapter.client.origin,
        bundle,
      };
      const result = await this.#mutate<OAuthCallbackResult | null>(async () => {
        if (!isPendingAuthorizationCurrent(this.#pending, pending, this.#generation, this.#readNow))
          return null;
        // 旧密文不可读时，普通 load/commit 都会解密失败；只对已验证的新登录持锁恢复，
        // 并在等锁与备份后复核代次，防止取消或迟到回调覆盖另一窗口的新登录。
        const previous = await this.#repo.commitVerifiedLogin(record, () => {
          if (
            !isPendingAuthorizationCurrent(this.#pending, pending, this.#generation, this.#readNow)
          )
            throw sessionError("XCODE_STALE_OWNER");
        });
        // XCODE: 取消可发生在文件锁持有期间；提交后必须补偿，不能复活旧登录。
        if (
          !isPendingAuthorizationCurrent(this.#pending, pending, this.#generation, this.#readNow)
        ) {
          await this.#repo.revert(record, previous);
          return null;
        }
        displaced = this.#session;
        this.#session = record;
        this.#owner = sessionOwner(record, pending.generation);
        try {
          await this.#onOwnerChanged(this.#owner);
        } catch (error) {
          this.#owner = null;
          if (this.#session === record) this.#session = displaced;
          await this.#repo.revert(record, previous);
          throw error;
        }
        if (
          !isPendingAuthorizationCurrent(this.#pending, pending, this.#generation, this.#readNow)
        ) {
          if (this.#session === record) this.#session = displaced;
          if (this.#owner?.authGeneration === pending.generation) {
            this.#owner = null;
            await this.#onOwnerChanged(null);
          }
          await this.#repo.revert(record, previous);
          return null;
        }
        this.#pending = null;
        published = true;
        this.#sessionChanges.fire("signed-in");
        return { kind: "session", provider: NEW_API_PROVIDER_ID, userInfo };
      });
      if (published && displaced && displaced.bundle.session_id !== bundle.session_id) {
        const removed = await this.#mutate(async () => {
          try {
            return await this.#repo.remove(displaced!);
          } catch (error) {
            // 同进程恢复已发布新登录；旧坏记录保留备份，不能让清理再次解密失败反转成功结果。
            // 仅记录损坏使用已确认内存 SID 撤销；存储 IO 和安全库错误仍原样传播。
            if (
              !isCredentialDecryptError(error) &&
              errorCode(error) !== "XCODE_CREDENTIAL_RECORD_INVALID"
            )
              throw error;
            return null;
          }
        });
        await revokeSession(this.#adapter, (removed ?? displaced).bundle);
      }
      return pending.generation === this.#generation ? result : null;
    } catch (error) {
      if (pending.generation !== this.#generation || (!published && this.#pending !== pending))
        return null;
      if (!published) this.#pending = null;
      throw error;
    } finally {
      if (bundle && !published) await revokeSession(this.#adapter, bundle);
    }
  }

  async #restore(): Promise<OAuthCachedSessionRestoreResult> {
    const generation = this.#generation;
    // 授权进行中不恢复旧会话，避免与新登录交错。
    if (this.#pending) return { status: "signed-out" };
    if (this.#restoreFlight?.generation === generation) return this.#restoreFlight.promise;
    const promise = this.#restoreCurrent(generation);
    const flight = { generation, promise };
    this.#restoreFlight = flight;
    try {
      return await promise;
    } finally {
      if (this.#restoreFlight === flight) this.#restoreFlight = null;
    }
  }

  async #restoreCurrent(generation: number): Promise<OAuthCachedSessionRestoreResult> {
    let record: NewApiStoredSession | null = null;
    try {
      this.#repo.assertStorageAvailable();
      record = this.#session ?? (await this.#repo.loadActive());
      if (generation !== this.#generation || this.#pending) return { status: "signed-out" };
      if (!record) return { status: "signed-out" };
      if (record.origin !== this.#adapter.client.origin)
        throw sessionError("XCODE_PROTOCOL_INVALID");
      validateSession(record.bundle, this.#now(), false);
      await this.#mutate(async () => {
        if (generation !== this.#generation) throw sessionError("XCODE_STALE_OWNER");
        this.#session = record;
      });
      const userInfo = await restoreSessionProfile(
        this.#adapter,
        record,
        () => this.#session,
        this.#readNow,
        () => this.#refresh(),
      );
      const restoredOwner = await this.#mutate(async () => {
        if (generation !== this.#generation || !this.#session)
          throw sessionError("XCODE_STALE_OWNER");
        if (!this.#owner) {
          this.#owner = sessionOwner(record!, generation);
          try {
            await this.#onOwnerChanged(this.#owner);
          } catch (error) {
            this.#owner = null;
            throw error;
          }
          return true;
        }
        return false;
      });
      if (generation !== this.#generation) return { status: "signed-out" };
      if (restoredOwner) this.#sessionChanges.fire("signed-in");
      if (generation !== this.#generation) return { status: "signed-out" };
      return { status: "authenticated", userInfo };
    } catch (error) {
      if (generation !== this.#generation) return { status: "signed-out" };
      if (record && isRevocation(error)) {
        await this.#invalidate(this.#session ?? record, generation);
        return { status: "signed-out" };
      }
      return unavailableSession(error);
    }
  }

  async #refresh(): Promise<void> {
    const expected = this.#session;
    const generation = this.#generation;
    if (!expected) throw sessionError("XCODE_SESSION_INVALID");
    if (
      this.#refreshFlight?.generation === generation &&
      this.#refreshFlight.session.bundle.session_id === expected.bundle.session_id
    )
      return this.#refreshFlight.promise;
    const promise = this.#rotate(expected, generation);
    const flight = { session: expected, generation, promise };
    this.#refreshFlight = flight;
    try {
      await promise;
    } finally {
      if (this.#refreshFlight === flight) this.#refreshFlight = null;
    }
  }

  async #rotate(expected: NewApiStoredSession, generation: number): Promise<void> {
    let acquired: NewApiSessionBundle | null = null;
    try {
      if (expected.bundle.refresh_expires_at <= this.#now())
        throw sessionError("XCODE_SESSION_INVALID");
      const next = await this.#mutate(async () => {
        if (generation !== this.#generation || this.#session !== expected)
          throw sessionError("XCODE_STALE_OWNER");
        const rotated = await refreshStoredSession(
          this.#repo,
          this.#adapter,
          expected,
          this.#readNow,
          () => {
            if (generation !== this.#generation) throw sessionError("XCODE_STALE_OWNER");
          },
          (bundle) => {
            acquired = bundle;
          },
        );
        if (!rotated) {
          if (acquired) await revokeSession(this.#adapter, acquired);
          throw sessionError("XCODE_SESSION_INVALID");
        }
        validateRotatedSession(rotated, expected, this.#now());
        if (generation !== this.#generation) {
          if (this.#session === null) {
            const removed = await this.#repo.remove(rotated);
            await revokeSession(this.#adapter, (removed ?? rotated).bundle);
          } else if (this.#session === expected) this.#session = rotated;
          throw sessionError("XCODE_STALE_OWNER");
        }
        this.#session = rotated;
        return rotated;
      });
      // XCODE: 先保存轮换后的 refresh，避免 Me 暂时 503 丢失仍可恢复的后继凭据。
      confirmedProfile(await this.#adapter.client.getMe(next.bundle.access_token), next.bundle);
      if (generation !== this.#generation) throw sessionError("XCODE_STALE_OWNER");
    } catch (error) {
      if (generation === this.#generation && isRevocation(error)) {
        await this.#invalidate(this.#session ?? expected, generation);
      }
      throw error;
    }
  }

  async #invalidate(expected: NewApiStoredSession, generation: number): Promise<void> {
    if (generation !== this.#generation) return;
    this.#generation++;
    this.#owner = null;
    this.#pending = null;
    this.#session = null;
    await this.#onOwnerChanged(null);
    const removed = await this.#mutate(async () => this.#repo.remove(expected));
    await revokeSession(this.#adapter, (removed ?? expected).bundle);
  }

  #logout(): Promise<void> {
    return this.#logoutDesktop();
  }

  async #logoutDesktop(): Promise<void> {
    const expected = this.#session;
    this.#generation++;
    this.#owner = null;
    this.#pending = null;
    this.#session = null;
    await this.#onOwnerChanged(null);
    const removed = await this.#mutate(async () => (expected ? this.#repo.remove(expected) : null));
    if (expected) await revokeSession(this.#adapter, (removed ?? expected).bundle);
  }
}
