/**
 * cli-zen-account 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 * 每个方法注释写清：前置/后置条件、幂等性、发出哪些事件、是否等待持久化。
 */
import type { AiscooAdminSessionBundle, AiscooAdminOwner } from "@zcode/shared";
import type { ZenClient, ZenCredentialStore, ZenAuthorizationListener } from "@zcode/adapters/auth";

export interface ZenAccountDependencies {
  client: ZenClient;
  store: ZenCredentialStore<AiscooAdminSessionBundle>;
  createAuthorization(): Promise<{
    listener: ZenAuthorizationListener;
    verifier: string;
    authorizeUrl: string;
  }>;
  openBrowser(url: string): Promise<unknown>;
  now?: () => number;
}
export interface ZenLoginOptions {
  signal?: AbortSignal;
  noBrowser?: boolean;
  onAuthorizeUrl?: (url: string) => void | Promise<void>;
}
export interface ZenLoginResult {
  providerId: "zen";
  user: AiscooAdminSessionBundle["user"];
}
export interface ZenAccountContract {
  getOwner(): AiscooAdminOwner | null;
  restore(signal?: AbortSignal): Promise<ZenLoginResult | null>;
  login(options?: ZenLoginOptions): Promise<ZenLoginResult>;
  logout(): Promise<{ localCleared: boolean; serverRevoked: boolean }>;
  withControlSession<T>(action: (token: string, owner: AiscooAdminOwner) => Promise<T>): Promise<T>;
  getRelayCredential(owner: AiscooAdminOwner): Promise<{ token: string; expiresAt: number }>;
  onDidChange(listener: () => void): () => void;
  dispose(): void;
}
