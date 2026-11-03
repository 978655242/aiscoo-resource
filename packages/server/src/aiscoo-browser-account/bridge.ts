import { Emitter, type IChannel, type IChannelClient, type IDisposable } from "@zcode/rpc";
import type { IOAuthService } from "@zcode/services";
import {
  normalizeAiscooAdminOrigin,
  type AiscooAdminOwner,
  type OAuthSessionState,
} from "@zcode/shared";
import {
  BROWSER_ACCOUNT_CHANNEL,
  BROWSER_ACCOUNT_OAUTH_METHODS,
  type BrowserAccountAuthority,
  type BrowserAccountBridge,
  type BrowserAccountBridgeOptions,
  type BrowserAccountControlResult,
  type BrowserAccountInvalidationReason,
  type BrowserAccountOAuthMethod,
  type BrowserAccountOAuthResult,
  type BrowserAccountRelayResult,
  type BrowserAccountRestoreResult,
  type BrowserAccountSessionEvent,
} from "./contract.js";
import {
  bridgeError,
  publicOAuth,
  publicSession,
  readOwner,
  requireWire,
  sameOwner,
  sanitizedError,
} from "./wire.js";

type Attachment = {
  channel: IChannel;
  ready: Promise<void>;
  subscription?: IDisposable;
  owner?: AiscooAdminOwner | null;
  observedOwner?: AiscooAdminOwner | null;
  events: number;
  invalidations: Emitter<BrowserAccountInvalidationReason>;
};

export function createBrowserAccountBridge(
  configuredOrigin: string,
  options: BrowserAccountBridgeOptions = {},
): BrowserAccountBridge {
  const origin = normalizeAiscooAdminOrigin(configuredOrigin);
  const changes = new Emitter<OAuthSessionState>();
  const attachments = new Set<Attachment>();
  let owner: AiscooAdminOwner | null = null;
  let revision = 0;
  let disposed = false;
  let ownerAcceptance: Promise<void> = Promise.resolve();

  function live(source: Attachment): void {
    if (!attachments.has(source)) throw bridgeError("XCODE_STALE_OWNER");
  }
  function current(source: Attachment, capturedRevision = revision): void {
    live(source);
    if (
      source.owner === undefined ||
      !sameOwner(source.owner, owner) ||
      revision !== capturedRevision
    )
      throw bridgeError("XCODE_STALE_OWNER");
  }
  function connection(): Attachment {
    // 后台按需读取优先使用最近确认的连接；页面 OAuth 始终捕获自己的连接，不参与选择。
    const source = [...attachments]
      .reverse()
      .find((candidate) => candidate.owner !== undefined && sameOwner(candidate.owner, owner));
    if (!source) throw bridgeError("XCODE_BROWSER_ACCOUNT_UNAVAILABLE");
    return source;
  }
  async function request<T>(source: Attachment, command: string, arg?: unknown): Promise<T> {
    try {
      return await source.channel.call<T>(command, arg);
    } catch (error) {
      throw sanitizedError(error);
    }
  }
  function detach(source: Attachment, reason?: BrowserAccountInvalidationReason): void {
    if (!attachments.delete(source)) return;
    source.subscription?.dispose();
    // 只有最后一个匹配来源离开才撤销账号；关闭 A 不得让仍在使用的 B 丢失目录和密钥来源。
    if (
      owner &&
      ![...attachments].some(
        (candidate) => candidate.owner !== undefined && sameOwner(candidate.owner, owner),
      )
    )
      void transition(null).catch(() => undefined);
    if (reason) source.invalidations.fire(reason);
    source.invalidations.dispose();
  }
  function transition(next: AiscooAdminOwner | null, source?: Attachment): Promise<void> {
    if (source) {
      live(source);
      source.owner = next;
    }
    if (sameOwner(owner, next)) return ownerAcceptance;
    // 先替换唯一投影和修订，再清理不匹配的连接；异步 hook 不能复活旧 owner。
    owner = next;
    const capturedRevision = ++revision;
    let accept!: () => void;
    let reject!: (error: unknown) => void;
    const accepted = new Promise<void>((resolve, rejectPromise) => {
      accept = resolve;
      reject = rejectPromise;
    });
    // hook 可同步触发下一次会话事件，先登记本次 acceptance，不能覆盖后来代次的 Promise。
    ownerAcceptance = accepted;
    void accepted.catch(() => undefined);
    for (const candidate of attachments) {
      if (candidate.owner !== undefined && !sameOwner(candidate.owner, next))
        detach(candidate, "owner-changed");
    }
    void (async () => {
      await options.onOwnerChanged?.(next);
      if (revision !== capturedRevision) throw bridgeError("XCODE_STALE_OWNER");
      changes.fire(next ? "signed-in" : "signed-out");
    })().then(accept, (error: unknown) => {
      if (revision === capturedRevision) {
        owner = null;
        revision++;
        ownerAcceptance = Promise.resolve();
        // 失败清理只归本次 revision 所有；包含退出中的 null 来源，旧 hook 不能关闭后来已接受的账号。
        for (const candidate of attachments) {
          if (candidate.owner !== undefined) detach(candidate, "unavailable");
        }
      }
      reject(sanitizedError(error));
    });
    return accepted;
  }
  async function restore(source: Attachment): Promise<BrowserAccountRestoreResult["session"]> {
    live(source);
    const capturedRevision = revision;
    const capturedOwner = owner;
    const capturedEvents = source.events;
    const result = await request<BrowserAccountRestoreResult>(source, "restore");
    live(source);
    const next = readOwner(result?.owner, origin);
    const session = publicSession(result?.session);
    requireWire(
      session.status === "authenticated"
        ? next !== null && session.userInfo?.id === next.userId
        : next === null,
    );
    // 初次反向恢复的 session 回声不能单独改 Host；必须与最终验证结果一致。
    if (source.events !== capturedEvents)
      requireWire(source.observedOwner !== undefined && sameOwner(source.observedOwner, next));
    if (source.owner === undefined && owner && !sameOwner(owner, next))
      throw bridgeError("XCODE_BROWSER_ACCOUNT_MISMATCH");
    // 并发首次恢复可共享同一 owner 的一次 acceptance；注销/换号后的旧恢复仍拒绝。
    if (
      revision !== capturedRevision &&
      !(
        revision === capturedRevision + 1 &&
        capturedOwner === null &&
        next !== null &&
        sameOwner(owner, next)
      )
    )
      throw bridgeError("XCODE_STALE_OWNER");
    const accepted = transition(next, source);
    const acceptedRevision = revision;
    await accepted;
    current(source, acceptedRevision);
    return session;
  }
  async function cachedSession(source: Attachment) {
    await source.ready;
    current(source);
    return restore(source);
  }
  async function cachedUser(source: Attachment) {
    const session = await cachedSession(source);
    if (session.status === "unavailable")
      throw bridgeError(
        session.reason === "backend-unavailable"
          ? "XCODE_BACKEND_UNAVAILABLE"
          : "XCODE_CREDENTIAL_RECOVERY_REQUIRED",
      );
    return session.status === "authenticated" ? session.userInfo : null;
  }
  async function oauth<M extends BrowserAccountOAuthMethod>(
    source: Attachment,
    method: M,
    ...args: Parameters<IOAuthService[M]>
  ): Promise<BrowserAccountOAuthResult<M>> {
    requireWire(BROWSER_ACCOUNT_OAUTH_METHODS.includes(method));
    await source.ready;
    current(source);
    const capturedRevision = revision;
    const result = await request(source, "oauth", { method, args });
    current(source);
    // 登录/退出等命令可发布新 owner；只读返回必须仍属于捕获的修订。
    if (["getProviders", "getActiveProvider", "restoreSession"].includes(method))
      current(source, capturedRevision);
    return publicOAuth(method, result);
  }
  function createOAuth(resolveSource: () => Attachment): IOAuthService {
    return Object.freeze({
      onDidChangeSession: changes.event,
      getProviders: async () => oauth(resolveSource(), "getProviders"),
      getActiveProvider: async () => oauth(resolveSource(), "getActiveProvider"),
      restoreCachedSession: async () => cachedUser(resolveSource()),
      restoreCachedSessionState: async () => cachedSession(resolveSource()),
      restoreSession: async () => oauth(resolveSource(), "restoreSession"),
      startOAuth: async (provider) => oauth(resolveSource(), "startOAuth", provider),
      startOAuthWithPolling: async (provider) =>
        oauth(resolveSource(), "startOAuthWithPolling", provider),
      pollPendingOAuth: async () => oauth(resolveSource(), "pollPendingOAuth"),
      handleCallback: async (url) => oauth(resolveSource(), "handleCallback", url),
      refreshToken: async (...args) => oauth(resolveSource(), "refreshToken", ...args),
      logout: async (...args) => oauth(resolveSource(), "logout", ...args),
      logoutAll: async () => oauth(resolveSource(), "logoutAll"),
      cancelPending: async (...args) => oauth(resolveSource(), "cancelPending", ...args),
    } satisfies IOAuthService);
  }
  const authority: BrowserAccountAuthority = {
    oauth: createOAuth(connection),
    getOwner: () => owner,
    isCurrent: (expected) =>
      !disposed &&
      !!owner &&
      sameOwner(owner, expected) &&
      [...attachments].some(
        (candidate) => candidate.owner !== undefined && sameOwner(candidate.owner, expected),
      ),
    async withControlSession(action) {
      const source = connection();
      const expected = owner;
      const capturedRevision = revision;
      if (!expected) throw bridgeError("XCODE_SESSION_INVALID");
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await request<BrowserAccountControlResult>(source, "control", {
            owner: expected,
          });
          current(source, capturedRevision);
          if (!sameOwner(readOwner(result?.owner, origin), expected))
            throw bridgeError("XCODE_STALE_OWNER");
          requireWire(typeof result.accessToken === "string" && result.accessToken.length > 0);
          try {
            const output = await action(result.accessToken, expected);
            current(source, capturedRevision);
            return output;
          } catch (error) {
            current(source, capturedRevision);
            // 远端已确认 control 过期时，仅委托原浏览器刷新一次；每次 await 后仍校验原 owner。
            if (attempt !== 0 || sanitizedError(error).code !== "XCODE_ACCESS_EXPIRED") throw error;
            await request(source, "oauth", { method: "refreshToken", args: ["new-api"] });
            current(source, capturedRevision);
          }
        }
        throw bridgeError("XCODE_ACCESS_EXPIRED");
      } catch (error) {
        current(source, capturedRevision);
        const failure = sanitizedError(error);
        if (["XCODE_SESSION_INVALID", "XCODE_CREDENTIAL_SCOPE_DENIED"].includes(failure.code)) {
          // Native 已确认撤销；先同步失效所有 Host 账号读取，再按捕获代次通知原浏览器。
          const accepted = transition(null, source);
          const invalidatedRevision = revision;
          const notified = request<void>(source, "invalidateCredential", { owner: expected });
          await Promise.all([accepted, notified]);
          current(source, invalidatedRevision);
        }
        throw failure;
      }
    },
    async getRelayCredential(expected) {
      const source = connection();
      const capturedRevision = revision;
      if (!owner || !sameOwner(owner, expected)) throw bridgeError("XCODE_STALE_OWNER");
      try {
        const result = await request<BrowserAccountRelayResult>(source, "relay", { owner });
        current(source, capturedRevision);
        requireWire(
          typeof result?.token === "string" &&
            result.token.length > 0 &&
            Number.isSafeInteger(result.expiresAt),
        );
        if (result.expiresAt <= Date.now()) throw bridgeError("XCODE_SESSION_INVALID");
        return { token: result.token, expiresAt: result.expiresAt };
      } catch (error) {
        current(source, capturedRevision);
        throw sanitizedError(error);
      }
    },
  };
  return {
    authority,
    attach(client: IChannelClient) {
      if (disposed) throw bridgeError("XCODE_BROWSER_ACCOUNT_DISPOSED");
      const source: Attachment = {
        channel: client.getChannel(BROWSER_ACCOUNT_CHANNEL),
        ready: Promise.resolve(),
        events: 0,
        invalidations: new Emitter<BrowserAccountInvalidationReason>(),
      };
      attachments.add(source);
      try {
        source.subscription = source.channel.listen<BrowserAccountSessionEvent>("session")(
          (event) => {
            if (!attachments.has(source)) return;
            try {
              const next = readOwner(event?.owner, origin);
              source.observedOwner = next;
              source.events++;
              if (source.owner === undefined || sameOwner(source.owner, next)) return;
              current(source);
              void transition(next, source).catch(() => undefined);
            } catch {
              detach(source, "unavailable");
            }
          },
        );
        source.ready = restore(source).then(() => undefined);
        void source.ready.catch((error: unknown) => {
          const code = sanitizedError(error).code;
          detach(
            source,
            code === "XCODE_BROWSER_ACCOUNT_MISMATCH"
              ? "account-mismatch"
              : code === "XCODE_STALE_OWNER"
                ? "owner-changed"
                : "unavailable",
          );
        });
      } catch (error) {
        detach(source, "unavailable");
        throw sanitizedError(error);
      }
      return {
        ready: source.ready,
        oauth: createOAuth(() => source),
        onDidInvalidate: source.invalidations.event,
        dispose: () => detach(source),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const source of attachments) detach(source);
      changes.dispose();
    },
  };
}
