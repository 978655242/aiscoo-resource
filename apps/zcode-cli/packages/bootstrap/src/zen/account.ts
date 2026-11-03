import {
  AiscooAdminSessionBundleSchema,
  type AiscooAdminSessionBundle,
  type AiscooAdminOwner,
} from "@zcode/shared";
import type {
  ZenAccountContract,
  ZenAccountDependencies,
  ZenLoginOptions,
  ZenLoginResult,
} from "./contract.js";

const loginTimeoutMs = 600_000;
const revokedCodes = new Set(["XCODE_SESSION_INVALID", "XCODE_CREDENTIAL_SCOPE_DENIED"]);

// XCODE: 独立 CLI 账号事实集中于此，UI 和 Registry 只读取 owner 投影。
export class ZenAccountRuntime implements ZenAccountContract {
  private generation = 0;
  private owner: AiscooAdminOwner | null = null;
  private session: { revision: string; value: AiscooAdminSessionBundle } | null = null;
  private listeners = new Set<() => void>();
  private pendingLogin: AbortController | null = null;
  constructor(private readonly deps: ZenAccountDependencies) {}
  getOwner() {
    return this.owner;
  }
  isCurrent(owner: AiscooAdminOwner) {
    return (
      this.owner !== null &&
      owner.origin === this.owner.origin &&
      owner.userId === this.owner.userId &&
      owner.sid === this.owner.sid &&
      owner.authGeneration === this.owner.authGeneration
    );
  }
  private now() {
    return (this.deps.now ?? Date.now)();
  }
  private emit() {
    for (const listener of this.listeners) listener();
  }
  onDidChange(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  dispose() {
    this.pendingLogin?.abort(new Error("ZEN_AUTH_CANCELED"));
    this.generation++;
    this.owner = null;
    this.session = null;
    this.listeners.clear();
  }
  private current(generation: number) {
    if (generation !== this.generation) throw new Error("XCODE_STALE_OWNER");
  }
  private async verify(bundle: AiscooAdminSessionBundle, signal?: AbortSignal) {
    AiscooAdminSessionBundleSchema.parse(bundle);
    if (
      [
        bundle.access_expires_at,
        bundle.refresh_expires_at,
        bundle.relay_credential.expires_at,
      ].some((expiry) => expiry <= this.now())
    )
      throw new Error("XCODE_SESSION_INVALID");
    const me = await this.deps.client.me(bundle.access_token, signal);
    if (me.user.id !== bundle.user.id || me.session_id !== bundle.session_id)
      throw new Error("XCODE_SESSION_INVALID");
  }
  private activate(record: { revision: string; value: AiscooAdminSessionBundle }, generation: number) {
    this.current(generation);
    this.session = record;
    this.owner = {
      origin: this.deps.client.origin,
      userId: record.value.user.id,
      sid: record.value.session_id,
      authGeneration: generation,
    };
    this.emit();
    return { providerId: "zen" as const, user: record.value.user };
  }
  async restore(signal?: AbortSignal): Promise<ZenLoginResult | null> {
    const hadOwner = this.owner !== null;
    const generation = ++this.generation;
    this.owner = null;
    this.session = await this.deps.store.read(this.deps.client.origin);
    this.current(generation);
    if (!this.session) {
      if (hadOwner) this.emit();
      return null;
    }
    if (this.session.value.access_expires_at <= this.now()) await this.refresh(generation, signal);
    else await this.verify(this.session.value, signal);
    this.current(generation);
    const latest = await this.deps.store.read(this.deps.client.origin);
    this.current(generation);
    if (!latest || latest.revision !== this.session?.revision) throw new Error("XCODE_STALE_OWNER");
    return this.activate(latest, generation);
  }
  async login(options: ZenLoginOptions = {}): Promise<ZenLoginResult> {
    options.signal?.throwIfAborted();
    this.pendingLogin?.abort(new Error("ZEN_AUTH_SUPERSEDED"));
    const pending = new AbortController();
    this.pendingLogin = pending;
    const generation = ++this.generation;
    this.owner = null;
    this.emit();
    await this.deps.store.assertAvailable();
    const previous = await this.deps.store.read(this.deps.client.origin);
    this.current(generation);
    const authorization = await this.deps.createAuthorization();
    const signal = AbortSignal.any([
      pending.signal,
      ...(options.signal ? [options.signal] : []),
      AbortSignal.timeout(loginTimeoutMs),
    ]);
    let issued: AiscooAdminSessionBundle | undefined;
    let accepted = false;
    try {
      signal.throwIfAborted();
      await options.onAuthorizeUrl?.(authorization.authorizeUrl);
      if (!options.noBrowser) await this.deps.openBrowser(authorization.authorizeUrl);
      const callback = await authorization.listener.wait(signal);
      this.current(generation);
      // 修复：code 兑换一旦发出，服务端可能已签发 SID；若用 abort 打断请求，客户端拿不到 bundle，
      // 就无法精确撤销而留下孤儿会话。兑换只受自身 HTTP 期限约束，取消在拿到结果后由 finally 补偿。
      issued = await this.deps.client.exchange(
        callback.code,
        authorization.verifier,
        authorization.listener.redirectUri,
      );
      await this.verify(issued, signal);
      signal.throwIfAborted();
      this.current(generation);
      if (
        !(await this.deps.store.compareAndSwap(
          this.deps.client.origin,
          previous?.revision ?? null,
          issued,
        ))
      )
        throw new Error("XCODE_STALE_OWNER");
      const stored = await this.deps.store.read(this.deps.client.origin);
      signal.throwIfAborted();
      this.current(generation);
      if (!stored || stored.value.session_id !== issued.session_id)
        throw new Error("XCODE_STALE_OWNER");
      const result = this.activate(stored, generation);
      accepted = true;
      // 修复原因：换号只覆盖本地密文会让被替换 SID 的 refresh 与 relay 凭据在服务端存活到过期，且本机再也无法撤销；
      // 与 Desktop aiscooAdminAccountService 一致，提交成功后尽力撤销旧 SID，失败不影响新登录。
      if (previous && previous.value.session_id !== issued.session_id)
        await this.deps.client
          .logout(previous.value.session_id, previous.value.refresh_token)
          .catch(() => {});
      return result;
    } finally {
      if (this.pendingLogin === pending) this.pendingLogin = null;
      try {
        await authorization.listener.close();
      } finally {
        if (issued && !accepted) {
          // XCODE: 本机清理失败仍须尝试精确撤销本次签发 SID，不能让存储故障跳过补偿。
          try {
            const stored = await this.deps.store.read(this.deps.client.origin);
            if (stored?.value.session_id === issued.session_id)
              await this.deps.store.compareAndSwap(this.deps.client.origin, stored.revision, null);
          } finally {
            await this.deps.client.logout(issued.session_id, issued.refresh_token);
          }
        }
      }
    }
  }
  private async refresh(generation: number, signal?: AbortSignal, rejectedToken?: string) {
    await this.deps.store.withLease(this.deps.client.origin, async () => {
      const stored = await this.deps.store.read(this.deps.client.origin);
      this.current(generation);
      if (!stored || (this.session && stored.value.session_id !== this.session.value.session_id))
        throw new Error("XCODE_STALE_OWNER");
      if (
        stored.value.access_expires_at > this.now() &&
        stored.value.access_token !== rejectedToken
      ) {
        this.session = stored;
        return;
      }
      const next = await this.deps.client.refresh(
        stored.value.session_id,
        stored.value.refresh_token,
        signal,
      );
      if (
        next.session_id !== stored.value.session_id ||
        next.user.id !== stored.value.user.id ||
        next.relay_credential.token !== stored.value.relay_credential.token
      )
        throw new Error("XCODE_SESSION_INVALID");
      // XCODE: refresh 已在服务器轮换；先安全提交后继，Me 短暂不可用不能遗失新 refresh。
      try {
        AiscooAdminSessionBundleSchema.parse(next);
        // 修复原因：代次在 refresh 期间变化（换号/退出）时旧实现直接抛错，轮换出的后继既不保存也不撤销，
        // 本机只剩已失效的旧 refresh，服务端 SID 与 relay 凭据无法再撤销；因此代次检查也必须走撤销补偿。
        this.current(generation);
        if (!(await this.deps.store.compareAndSwap(this.deps.client.origin, stored.revision, next)))
          throw new Error("XCODE_STALE_OWNER");
      } catch (error) {
        // XCODE: 后继无法安全保存时撤销本次轮换 SID，避免稍后重放旧 refresh 导致隐式失效。
        if (generation === this.generation) {
          this.owner = null;
          this.session = null;
          this.emit();
        }
        await this.deps.client.logout(next.session_id, next.refresh_token);
        throw error;
      }
      this.session = await this.deps.store.read(this.deps.client.origin);
      this.current(generation);
      await this.verify(next, signal);
    });
  }
  async withControlSession<T>(
    action: (token: string, owner: AiscooAdminOwner) => Promise<T>,
  ): Promise<T> {
    const owner = this.owner;
    if (!owner || !this.session) throw new Error("XCODE_SESSION_INVALID");
    try {
      const stored = await this.deps.store.read(owner.origin);
      this.current(owner.authGeneration);
      if (!stored || stored.value.session_id !== owner.sid) throw new Error("XCODE_STALE_OWNER");
      this.session = stored;
      if (stored.value.access_expires_at <= this.now()) await this.refresh(owner.authGeneration);
      const token = this.session!.value.access_token;
      let value: T;
      try {
        value = await action(token, owner);
      } catch (error) {
        this.current(owner.authGeneration);
        if ((error as { code?: string }).code !== "XCODE_ACCESS_EXPIRED") throw error;
        await this.refresh(owner.authGeneration, undefined, token);
        value = await action(this.session!.value.access_token, owner);
      }
      this.current(owner.authGeneration);
      return value;
    } catch (error) {
      // XCODE: 旧请求的撤销错误不能清除换号或恢复后建立的新代次。
      if (this.isCurrent(owner) && revokedCodes.has((error as { code?: string }).code ?? "")) {
        this.owner = null;
        this.session = null;
        this.emit();
      }
      throw error;
    }
  }
  async getRelayCredential(owner: AiscooAdminOwner) {
    if (!this.isCurrent(owner) || !this.session) throw new Error("XCODE_STALE_OWNER");
    const stored = await this.deps.store.read(owner.origin);
    if (!this.isCurrent(owner) || stored?.value.session_id !== owner.sid) {
      if (this.isCurrent(owner)) {
        this.owner = null;
        this.session = null;
        this.emit();
      }
      throw new Error("XCODE_STALE_OWNER");
    }
    const credential = stored.value.relay_credential;
    if (credential.expires_at <= this.now()) {
      this.owner = null;
      this.session = null;
      this.emit();
      throw new Error("XCODE_SESSION_INVALID");
    }
    return { token: credential.token, expiresAt: credential.expires_at };
  }
  async logout() {
    this.pendingLogin?.abort(new Error("ZEN_AUTH_CANCELED"));
    this.generation++;
    this.owner = null;
    this.session = null;
    this.emit();
    const stored = await this.deps.store.read(this.deps.client.origin);
    if (!stored) return { localCleared: true, serverRevoked: true };
    const localCleared = await this.deps.store.compareAndSwap(
      this.deps.client.origin,
      stored.revision,
      null,
    );
    if (!localCleared) throw new Error("XCODE_STALE_OWNER");
    try {
      await this.deps.client.logout(stored.value.session_id, stored.value.refresh_token);
      return { localCleared, serverRevoked: true };
    } catch (error) {
      // 修复原因：本地已清空后再抛错会让 CLI 报"退出失败"且 --json 拿不到 localCleared；
      // 服务端回已失效/越权即视为已撤销，其余错误如实报告未撤销。
      return { localCleared, serverRevoked: revokedCodes.has((error as { code?: string }).code ?? "") };
    }
  }
}
