import { Emitter } from "@zcode/rpc";
import {
  NEW_API_PROVIDER_ID,
  ZEN_CLI_CLIENT_ID,
  NewApiSessionBundleSchema,
  NewApiMeSchema,
  normalizeNewApiOrigin,
  parseZenAuthorizationCallback,
  type NewApiOwner,
  type NewApiSessionBundle,
  type OAuthCachedSessionRestoreResult,
  type OAuthCallbackResult,
  type OAuthSessionState,
  type UserInfo,
} from "@zcode/shared";
import type { BrowserNewApiAccount, BrowserNewApiAccountOptions } from "./contract.js";

type Stored = { schemaVersion: 1; authGeneration: number; bundle: NewApiSessionBundle };
type Pending = {
  state: string;
  codeVerifier: string;
  createdAt: number;
  baseGeneration: number | null;
};
const error = (code: string) => Object.assign(new Error(code), { code });
const codeOf = (value: unknown): string =>
  value instanceof Error && "code" in value ? String(value.code) : "XCODE_BACKEND_UNAVAILABLE";
const same = (a: Stored | null, b: Stored | null) =>
  !!a &&
  !!b &&
  a.authGeneration === b.authGeneration &&
  a.bundle.session_id === b.bundle.session_id &&
  a.bundle.user.id === b.bundle.user.id;
const ownerOf = (origin: string, value: Stored): NewApiOwner =>
  Object.freeze({
    origin,
    userId: value.bundle.user.id,
    sid: value.bundle.session_id,
    authGeneration: value.authGeneration,
  });
const profileOf = (user: NewApiSessionBundle["user"]): UserInfo => ({
  id: user.id,
  username: user.username,
  displayName: user.display_name,
  ...(user.avatar_url === null ? {} : { avatarUrl: user.avatar_url }),
});
function parse<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success) throw error("XCODE_PROTOCOL_INVALID");
  return result.data;
}
function validateBundle(bundle: NewApiSessionBundle, now: number, fresh = false): void {
  if (
    /\s/.test(bundle.access_token) ||
    /\s/.test(bundle.refresh_token) ||
    bundle.access_expires_at > bundle.refresh_expires_at ||
    (fresh &&
      [
        bundle.access_expires_at,
        bundle.refresh_expires_at,
        bundle.relay_credential.expires_at,
      ].some((expiry) => expiry <= now || expiry <= bundle.server_time))
  )
    throw error("XCODE_PROTOCOL_INVALID");
  if (bundle.refresh_expires_at <= now || bundle.relay_credential.expires_at <= now)
    throw error("XCODE_SESSION_INVALID");
}

export function createBrowserNewApiAccount(
  options: BrowserNewApiAccountOptions,
): BrowserNewApiAccount {
  const origin = normalizeNewApiOrigin(options.origin);
  if (!/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.test(options.browserOrigin))
    throw error("XCODE_BROWSER_ORIGIN_INVALID");
  let browser: URL;
  try {
    browser = new URL(options.browserOrigin);
  } catch {
    throw error("XCODE_BROWSER_ORIGIN_INVALID");
  }
  if (!browser.port || Number(browser.port) > 65535 || browser.origin !== options.browserOrigin)
    throw error("XCODE_BROWSER_ORIGIN_INVALID");
  const redirectUri = `${browser.origin}/oauth/callback`;
  const key = `aiscoo:browser-new-api:${encodeURIComponent(origin)}:session`;
  const pendingKey = `aiscoo:browser-new-api:${encodeURIComponent(origin)}:pending`;
  const lockName = `${key}:mutation`;
  const now = options.now ?? Date.now;
  const webCrypto = options.crypto ?? globalThis.crypto;
  const fetch = options.fetch ?? globalThis.fetch;
  const changes = new Emitter<OAuthSessionState>();
  let current: Stored | null = null;
  let acceptedOwner: NewApiOwner | null = null;
  let revision = 0;
  let disposed = false;
  let callbackFlight: {
    url: string;
    revision: number;
    promise: Promise<OAuthCallbackResult | null>;
  } | null = null;
  let refreshFlight: { generation: number; promise: Promise<Stored> } | null = null;
  let restoreFlight: {
    revision: number;
    promise: Promise<OAuthCachedSessionRestoreResult>;
  } | null = null;

  function read(): Stored | null {
    try {
      const raw = options.localStorage.getItem(key);
      if (raw === null) return null;
      const value = JSON.parse(raw) as Stored;
      if (
        !value ||
        value.schemaVersion !== 1 ||
        !Number.isSafeInteger(value.authGeneration) ||
        value.authGeneration <= 0 ||
        Object.keys(value).length !== 3
      )
        throw error("XCODE_CREDENTIAL_RECORD_INVALID");
      return {
        schemaVersion: 1,
        authGeneration: value.authGeneration,
        bundle: parse(NewApiSessionBundleSchema, value.bundle),
      };
    } catch {
      throw error("XCODE_CREDENTIAL_RECORD_INVALID");
    }
  }
  const generation = () => read()?.authGeneration ?? null;
  function getStorageIdentity(): string | null {
    const record = read();
    // 仅比较完整持久 owner，不确认身份或携带 token；同 owner 的刷新轮换保持不变。
    return record ? JSON.stringify(ownerOf(origin, record)) : null;
  }
  function project(record: Stored | null): void {
    const changed = !same(current, record);
    const hadOwner = current !== null;
    current = record;
    // 投影失效后仍保留最后确认的 owner，退出不能借用其他标签页后来写入的账号。
    if (record) acceptedOwner = ownerOf(origin, record);
    if (record && changed) changes.fire("signed-in");
    else if (!record && hadOwner) changes.fire("signed-out");
  }
  function check(record: Stored, captured: number): void {
    if (disposed || captured !== revision || !same(read(), record))
      throw error("XCODE_STALE_OWNER");
  }
  function invalidate(record: Stored, captured: number): void {
    if (captured !== revision || disposed) return;
    // 退出与失效不等待刷新锁；同步比较 generation 后删除，迟到网络结果无法重新提交。
    if (same(read(), record)) options.localStorage.removeItem(key);
    if (same(current, record)) {
      revision++;
      project(null);
    }
  }
  function getOwner(): NewApiOwner | null {
    if (disposed || !current) return null;
    try {
      if (same(current, read())) return ownerOf(origin, current);
    } catch {
      /* 损坏或不可读的存储不能继续提供已缓存身份。 */
    }
    revision++;
    project(null);
    return null;
  }
  function expectedRecord(expected: NewApiOwner): Stored {
    const owner = getOwner();
    if (
      !owner ||
      owner.origin !== expected.origin ||
      owner.userId !== expected.userId ||
      owner.sid !== expected.sid ||
      owner.authGeneration !== expected.authGeneration
    )
      throw error("XCODE_STALE_OWNER");
    return read()!;
  }
  const random = () => {
    const bytes = webCrypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  };
  function newGeneration(previous: number | null): number {
    const words = webCrypto.getRandomValues(new Uint32Array(2));
    const value = (words[0]! & 0x1fffff) * 0x100000000 + words[1]! || 1;
    return value === previous ? (value === Number.MAX_SAFE_INTEGER ? 1 : value + 1) : value;
  }
  const validateProvider = (provider?: string) => {
    if (provider !== undefined && provider !== NEW_API_PROVIDER_ID)
      throw error("XCODE_PROVIDER_INVALID");
  };
  async function request(
    path: "auth/token" | "auth/refresh" | "auth/logout" | "me",
    body?: object,
    token?: string,
  ): Promise<unknown> {
    const headers = new Headers({ Accept: "application/json" });
    if (body) headers.set("Content-Type", "application/json");
    if (token) headers.set("Authorization", `Bearer ${token}`);
    let response: Response;
    try {
      response = await fetch(`/api/xcode/v1/${path}`, {
        method: body ? "POST" : "GET",
        headers,
        ...(body ? { body: JSON.stringify(body) } : {}),
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw error("XCODE_BACKEND_UNAVAILABLE");
    }
    if (response.redirected || (response.url && new URL(response.url).origin !== browser.origin))
      throw error("XCODE_PROTOCOL_INVALID");
    let envelope: { success?: unknown; data?: unknown; code?: unknown };
    try {
      envelope = await response.json();
    } catch {
      throw error(response.status >= 500 ? "XCODE_BACKEND_UNAVAILABLE" : "XCODE_PROTOCOL_INVALID");
    }
    if (!response.ok) {
      const codes: Record<string, number> = {
        XCODE_AUTH_REQUEST_INVALID: 400,
        XCODE_AUTH_CODE_INVALID: 400,
        XCODE_ACCESS_EXPIRED: 401,
        XCODE_SESSION_INVALID: 401,
        XCODE_CREDENTIAL_SCOPE_DENIED: 403,
        XCODE_ORIGIN_FORBIDDEN: 403,
        XCODE_AUTHORIZATION_DISABLED: 404,
        XCODE_TOKEN_LIMIT: 409,
        AUTH_SESSION_LIMIT: 409,
        AUTH_SESSION_MISMATCH: 409,
        AUTH_REFRESH_RACE: 409,
        XCODE_RATE_LIMITED: 429,
        AUTH_SESSION_ISSUANCE_LIMIT: 429,
        XCODE_BACKEND_UNAVAILABLE: 503,
      };
      if (
        envelope?.success === false &&
        typeof envelope.code === "string" &&
        Object.hasOwn(codes, envelope.code) &&
        codes[envelope.code] === response.status
      )
        throw error(envelope.code);
      throw error(response.status >= 500 ? "XCODE_BACKEND_UNAVAILABLE" : "XCODE_PROTOCOL_INVALID");
    }
    if (envelope?.success !== true) throw error("XCODE_PROTOCOL_INVALID");
    return envelope.data;
  }
  async function confirm(record: Stored, captured: number): Promise<UserInfo> {
    const me = parse(NewApiMeSchema, await request("me", undefined, record.bundle.access_token));
    check(record, captured);
    if (me.session_id !== record.bundle.session_id || me.user.id !== record.bundle.user.id)
      throw error("XCODE_SESSION_INVALID");
    return profileOf(me.user);
  }
  async function fresh(record: Stored, captured: number, force = false): Promise<Stored> {
    if (refreshFlight?.generation === record.authGeneration) return refreshFlight.promise;
    const promise = options.locks.request(lockName, async () => {
      check(record, captured);
      const stored = read()!;
      validateBundle(stored.bundle, now());
      if (
        stored.bundle.access_expires_at > now() &&
        (!force || stored.bundle.refresh_token !== record.bundle.refresh_token)
      )
        return stored;
      const rotated = parse(
        NewApiSessionBundleSchema,
        await request("auth/refresh", {
          client_id: ZEN_CLI_CLIENT_ID,
          session_id: stored.bundle.session_id,
          refresh_token: stored.bundle.refresh_token,
        }),
      );
      check(stored, captured);
      validateBundle(rotated, now(), true);
      if (
        rotated.user.id !== stored.bundle.user.id ||
        rotated.session_id !== stored.bundle.session_id ||
        rotated.relay_credential.token !== stored.bundle.relay_credential.token ||
        rotated.relay_credential.expires_at !== stored.bundle.relay_credential.expires_at ||
        rotated.refresh_token === stored.bundle.refresh_token
      )
        throw error("XCODE_SESSION_INVALID");
      const next: Stored = { ...stored, bundle: rotated };
      options.localStorage.setItem(key, JSON.stringify(next));
      if (same(current, stored)) current = next;
      return next;
    });
    const flight = { generation: record.authGeneration, promise };
    refreshFlight = flight;
    try {
      return await promise;
    } catch (caught) {
      if (
        [
          "XCODE_SESSION_INVALID",
          "XCODE_CREDENTIAL_SCOPE_DENIED",
          "XCODE_PROTOCOL_INVALID",
        ].includes(codeOf(caught))
      )
        invalidate(record, captured);
      throw caught;
    } finally {
      if (refreshFlight === flight) refreshFlight = null;
    }
  }
  async function restore(): Promise<OAuthCachedSessionRestoreResult> {
    if (disposed) return { status: "signed-out" };
    if (restoreFlight?.revision === revision) return restoreFlight.promise;
    const captured = revision;
    let record: Stored | null = null;
    const promise = (async (): Promise<OAuthCachedSessionRestoreResult> => {
      try {
        record = read();
        if (!record) {
          project(null);
          return { status: "signed-out" };
        }
        let active = await fresh(record, captured);
        let userInfo: UserInfo;
        try {
          userInfo = await confirm(active, captured);
        } catch (caught) {
          check(active, captured);
          if (
            codeOf(caught) !== "XCODE_ACCESS_EXPIRED" ||
            active.bundle.refresh_token !== record.bundle.refresh_token
          )
            throw caught;
          // 仅明确的 access 过期允许刷新重验；授权码兑换永不重试。
          active = await fresh(active, captured, true);
          userInfo = await confirm(active, captured);
        }
        validateBundle(active.bundle, now());
        project(active);
        return captured === revision && same(read(), active)
          ? { status: "authenticated", userInfo }
          : { status: "signed-out" };
      } catch (caught) {
        if (disposed || captured !== revision || codeOf(caught) === "XCODE_STALE_OWNER")
          return { status: "signed-out" };
        if (
          record &&
          ["XCODE_SESSION_INVALID", "XCODE_CREDENTIAL_SCOPE_DENIED"].includes(codeOf(caught))
        ) {
          invalidate(record, captured);
          return { status: "signed-out" };
        }
        project(null);
        return {
          status: "unavailable",
          reason: ["XCODE_PROTOCOL_INVALID", "XCODE_CREDENTIAL_RECORD_INVALID"].includes(
            codeOf(caught),
          )
            ? "credential-recovery-required"
            : "backend-unavailable",
        };
      }
    })();
    const flight = { revision: captured, promise };
    restoreFlight = flight;
    try {
      return await promise;
    } finally {
      if (restoreFlight === flight) restoreFlight = null;
    }
  }
  async function restoreUser(): Promise<UserInfo | null> {
    const result = await restore();
    if (result.status === "unavailable")
      throw error(
        result.reason === "backend-unavailable"
          ? "XCODE_BACKEND_UNAVAILABLE"
          : "XCODE_CREDENTIAL_RECOVERY_REQUIRED",
      );
    return result.status === "authenticated" ? result.userInfo : null;
  }
  async function start(provider: string) {
    validateProvider(provider);
    if (disposed) throw error("XCODE_STALE_OWNER");
    const captured = ++revision;
    const baseGeneration = generation();
    options.sessionStorage.removeItem(pendingKey);
    project(null);
    const state = random();
    const codeVerifier = random();
    const hash = await webCrypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
    if (disposed || captured !== revision || generation() !== baseGeneration)
      throw error("XCODE_STALE_OWNER");
    const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    const pending: Pending = { state, codeVerifier, createdAt: now(), baseGeneration };
    options.sessionStorage.setItem(pendingKey, JSON.stringify(pending));
    const url = new URL("/api/xcode/v1/auth/authorize", origin);
    url.search = new URLSearchParams({
      client_id: ZEN_CLI_CLIENT_ID,
      response_type: "code",
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    }).toString();
    return {
      provider: NEW_API_PROVIDER_ID,
      purpose: "primary-account" as const,
      state,
      authorizeUrl: url.href,
    };
  }
  function handleCallback(url: string): Promise<OAuthCallbackResult | null> {
    if (disposed) return Promise.resolve(null);
    if (callbackFlight?.url === url) return callbackFlight.promise;
    let pending: Pending;
    try {
      pending = JSON.parse(options.sessionStorage.getItem(pendingKey) ?? "null");
    } catch {
      return Promise.resolve(null);
    }
    if (
      !pending ||
      !/^[A-Za-z0-9_-]{43}$/.test(pending.state) ||
      !/^[A-Za-z0-9_-]{43}$/.test(pending.codeVerifier) ||
      !Number.isSafeInteger(pending.createdAt) ||
      pending.createdAt > now() ||
      pending.createdAt + 300_000 <= now() ||
      (pending.baseGeneration !== null &&
        (!Number.isSafeInteger(pending.baseGeneration) || pending.baseGeneration <= 0))
    )
      return Promise.resolve(null);
    const parsed = parseZenAuthorizationCallback(url, redirectUri, pending.state);
    if (!parsed || generation() !== pending.baseGeneration) return Promise.resolve(null);
    const captured = revision;
    const stillPending = () =>
      !disposed &&
      captured === revision &&
      pending.createdAt + 300_000 > now() &&
      generation() === pending.baseGeneration;
    // 合法 proof 必须先消费；重复回调共用单飞结果，兑换失败也不能重放导致服务端撤销 SID。
    options.sessionStorage.removeItem(pendingKey);
    const promise = (async (): Promise<OAuthCallbackResult | null> => {
      let issued: NewApiSessionBundle | null = null;
      let committed = false;
      try {
        const bundle = (issued = parse(
          NewApiSessionBundleSchema,
          await request("auth/token", {
            client_id: ZEN_CLI_CLIENT_ID,
            grant_type: "authorization_code",
            redirect_uri: redirectUri,
            code: parsed.code,
            code_verifier: pending.codeVerifier,
          }),
        ));
        if (!stillPending()) return null;
        validateBundle(bundle, now(), true);
        const me = parse(NewApiMeSchema, await request("me", undefined, bundle.access_token));
        if (!stillPending()) return null;
        if (me.session_id !== bundle.session_id || me.user.id !== bundle.user.id)
          throw error("XCODE_SESSION_INVALID");
        const next: Stored = {
          schemaVersion: 1,
          authGeneration: newGeneration(pending.baseGeneration),
          bundle,
        };
        const displaced = await options.locks.request(lockName, async () => {
          if (!stillPending()) throw error("XCODE_STALE_OWNER");
          validateBundle(bundle, now(), true);
          const previous = read();
          options.localStorage.setItem(key, JSON.stringify(next));
          committed = true;
          project(next);
          return previous;
        });
        if (displaced && displaced.bundle.session_id !== bundle.session_id)
          void revoke(displaced.bundle).catch(() => {});
        if (disposed || captured !== revision || !same(read(), next)) return null;
        return { kind: "session", provider: NEW_API_PROVIDER_ID, userInfo: profileOf(me.user) };
      } catch (caught) {
        if (!stillPending() || codeOf(caught) === "XCODE_STALE_OWNER") return null;
        throw caught;
      } finally {
        // 未提交的兑换与被替换旧 SID 只撤销捕获凭据，不触碰后来登录。
        if (issued && !committed && read()?.bundle.session_id !== issued.session_id)
          void revoke(issued).catch(() => {});
      }
    })();
    const flight = { url, revision: captured, promise };
    callbackFlight = flight;
    void promise
      .finally(() => {
        if (callbackFlight === flight) callbackFlight = null;
      })
      .catch(() => {});
    return promise;
  }
  async function logout(provider?: string): Promise<void> {
    validateProvider(provider);
    let stored: Stored | null = null;
    try {
      stored = read();
    } catch {
      // 无法确认存储 owner 时不删除共享记录，也不撤销未确认的 SID。
    }
    const target =
      acceptedOwner &&
      stored &&
      acceptedOwner.authGeneration === stored.authGeneration &&
      acceptedOwner.sid === stored.bundle.session_id &&
      acceptedOwner.userId === stored.bundle.user.id
        ? stored
        : null;
    acceptedOwner = null;
    revision++;
    options.sessionStorage.removeItem(pendingKey);
    if (target) options.localStorage.removeItem(key);
    project(null);
    if (!target) return;
    await revoke(target.bundle);
  }
  async function revoke(bundle: NewApiSessionBundle): Promise<void> {
    const result = await request("auth/logout", {
      client_id: ZEN_CLI_CLIENT_ID,
      session_id: bundle.session_id,
      refresh_token: bundle.refresh_token,
    });
    const revoked = result as {
      schema_version?: unknown;
      server_time?: unknown;
      revoked?: unknown;
    };
    if (
      !revoked ||
      revoked.schema_version !== 1 ||
      revoked.revoked !== true ||
      !Number.isSafeInteger(revoked.server_time) ||
      Number(revoked.server_time) < 0 ||
      Object.keys(revoked).length !== 3
    )
      throw error("XCODE_PROTOCOL_INVALID");
  }
  return Object.freeze({
    oauth: Object.freeze({
      onDidChangeSession: changes.event,
      getProviders: async () => [
        {
          id: NEW_API_PROVIDER_ID,
          displayName: "New API",
          enabled: true,
          order: 0,
          legalLinks: {
            userAgreementUrl: `${origin}/user-agreement`,
            privacyPolicyUrl: `${origin}/privacy-policy`,
          },
        },
      ],
      getActiveProvider: async () => (getOwner() ? NEW_API_PROVIDER_ID : null),
      restoreCachedSession: restoreUser,
      restoreCachedSessionState: restore,
      restoreSession: restoreUser,
      startOAuth: start,
      startOAuthWithPolling: async () => {
        throw error("XCODE_PRIVATE_POLLING_UNSUPPORTED");
      },
      pollPendingOAuth: async () => {
        throw error("XCODE_PRIVATE_POLLING_UNSUPPORTED");
      },
      handleCallback,
      refreshToken: async (provider?: string) => {
        validateProvider(provider);
        const owner = getOwner();
        if (!owner) throw error("XCODE_SESSION_INVALID");
        await fresh(expectedRecord(owner), revision, true);
        expectedRecord(owner);
      },
      logout,
      logoutAll: () => logout(),
      cancelPending: async (provider?: string) => {
        validateProvider(provider);
        // 没有登录尝试时取消应为空操作，不能使正在轮换的 refresh 结果失效。
        if (!options.sessionStorage.getItem(pendingKey) && callbackFlight?.revision !== revision)
          return;
        revision++;
        options.sessionStorage.removeItem(pendingKey);
      },
    }),
    getOwner,
    getStorageIdentity,
    invalidateCredential: (expected: NewApiOwner) => {
      if (disposed) return;
      const record = read();
      if (
        !record ||
        expected.origin !== origin ||
        expected.userId !== record.bundle.user.id ||
        expected.sid !== record.bundle.session_id ||
        expected.authGeneration !== record.authGeneration
      )
        return;
      // Host 的确认撤销只作用于捕获代次；复用同步失效路径，迟到刷新不能复活，也不删除新账号。
      invalidate(record, revision);
    },
    getControlCredential: async (expected: NewApiOwner) => {
      const record = expectedRecord(expected);
      const captured = revision;
      const active = await fresh(record, captured);
      check(active, captured);
      expectedRecord(expected);
      return { accessToken: active.bundle.access_token, owner: ownerOf(origin, active) };
    },
    getRelayCredential: async (expected: NewApiOwner) => {
      const record = expectedRecord(expected);
      try {
        validateBundle(record.bundle, now());
      } catch (caught) {
        invalidate(record, revision);
        throw caught;
      }
      return {
        token: record.bundle.relay_credential.token,
        expiresAt: record.bundle.relay_credential.expires_at,
      };
    },
    dispose: () => {
      revision++;
      disposed = true;
      project(null);
      changes.dispose();
    },
  });
}
