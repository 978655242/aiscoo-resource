import type { IOAuthService, IServiceAccessor } from "@zcode/services";
import type { NewApiOwner } from "@zcode/shared";

export interface BrowserNewApiAccountOptions {
  /** Canonicalized New API origin; used for authorization and storage isolation. */
  origin: string;
  /** Exact http://127.0.0.1:<non-default-port> origin, without a path. */
  browserOrigin: string;
  localStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  sessionStorage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  locks: { request<T>(name: string, run: () => Promise<T>): Promise<T> };
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  crypto?: Pick<Crypto, "getRandomValues" | "subtle">;
}

export interface BrowserNewApiAccount {
  readonly oauth: IOAuthService;
  /** Null until /me confirms login or restore; callers await restore before attachment. */
  getOwner(): NewApiOwner | null;
  /** Opaque persisted identity stamp for cross-tab invalidation; never authenticates an owner. */
  getStorageIdentity(): string | null;
  getControlCredential(expected: NewApiOwner): Promise<{ accessToken: string; owner: NewApiOwner }>;
  getRelayCredential(expected: NewApiOwner): Promise<{ token: string; expiresAt: number }>;
  /** Native-confirmed revocation; synchronously clears only the captured credential owner. */
  invalidateCredential(expected: NewApiOwner): void;
  /** Invalidates this page's in-flight work; persistent login and pending navigation survive. */
  dispose(): void;
}

export interface BrowserAccountConnectionFailure {
  reason: "account-in-use" | "account-mismatch" | "account-changed" | "disconnected";
}

/** 页面拥有连接生命周期；关闭后不能再次交付服务或改变账号存储。 */
export interface BrowserAccountWebConnection {
  readonly closed: boolean;
  connect(wsUrl: string): Promise<IServiceAccessor>;
  dispose(): void;
}

export interface BrowserAccountWebConnectionOptions {
  account: BrowserNewApiAccount;
  onFailure(failure: BrowserAccountConnectionFailure): void;
}
