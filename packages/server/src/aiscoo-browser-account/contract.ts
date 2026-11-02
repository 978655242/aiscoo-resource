import type { Event, IChannelClient, IDisposable } from "@zcode/rpc";
import type { IOAuthService } from "@zcode/services";
import type { NewApiOwner, OAuthCachedSessionRestoreResult } from "@zcode/shared";

export const BROWSER_ACCOUNT_CHANNEL = "aiscoo/browser-account" as const;

/** Positional arguments and results follow IOAuthService; cached restoration uses `restore`. */
export const BROWSER_ACCOUNT_OAUTH_METHODS = [
  "getProviders",
  "getActiveProvider",
  "restoreSession",
  "startOAuth",
  "startOAuthWithPolling",
  "pollPendingOAuth",
  "handleCallback",
  "refreshToken",
  "logout",
  "logoutAll",
  "cancelPending",
] as const satisfies readonly (keyof IOAuthService)[];

export type BrowserAccountOAuthMethod = (typeof BROWSER_ACCOUNT_OAUTH_METHODS)[number];
export type BrowserAccountOAuthRequest = {
  [M in BrowserAccountOAuthMethod]: { method: M; args: Parameters<IOAuthService[M]> };
}[BrowserAccountOAuthMethod];
export type BrowserAccountOAuthResult<M extends BrowserAccountOAuthMethod> = Awaited<
  ReturnType<IOAuthService[M]>
>;

export interface BrowserAccountSessionEvent {
  owner: NewApiOwner | null;
}

export interface BrowserAccountRestoreResult extends BrowserAccountSessionEvent {
  session: OAuthCachedSessionRestoreResult;
}

export interface BrowserAccountControlRequest {
  owner: NewApiOwner;
}

export interface BrowserAccountControlResult {
  owner: NewApiOwner;
  accessToken: string;
}

export interface BrowserAccountRelayRequest {
  owner: NewApiOwner;
}

export interface BrowserAccountRelayResult {
  token: string;
  expiresAt: number;
}

/** Browser-served reverse channel on the existing socket; never contains a refresh token. */
export interface BrowserAccountWireCommands {
  restore: { arg: undefined; result: BrowserAccountRestoreResult };
  control: { arg: BrowserAccountControlRequest; result: BrowserAccountControlResult };
  relay: { arg: BrowserAccountRelayRequest; result: BrowserAccountRelayResult };
  invalidateCredential: { arg: { owner: NewApiOwner }; result: void };
  oauth: {
    arg: BrowserAccountOAuthRequest;
    result: BrowserAccountOAuthResult<BrowserAccountOAuthMethod>;
  };
}

export interface BrowserAccountAuthority {
  readonly oauth: IOAuthService;
  getOwner(): NewApiOwner | null;
  isCurrent(owner: NewApiOwner): boolean;
  withControlSession<T>(
    action: (accessToken: string, owner: NewApiOwner) => Promise<T>,
  ): Promise<T>;
  getRelayCredential(owner: NewApiOwner): Promise<BrowserAccountRelayResult>;
}

export interface BrowserAccountBridgeOptions {
  onOwnerChanged?: (owner: NewApiOwner | null) => void | Promise<void>;
}

export type BrowserAccountInvalidationReason = "owner-changed" | "account-mismatch" | "unavailable";

export interface BrowserAccountAttachment extends IDisposable {
  /** Own restore and the shared owner acceptance; forward services wait for this promise. */
  readonly ready: Promise<void>;
  /** Explicit facade bound to this connection, including tab-local PKCE and cancellation. */
  readonly oauth: IOAuthService;
  /** Parent closes only this socket; owner-changed permits one fresh page admission. */
  readonly onDidInvalidate: Event<BrowserAccountInvalidationReason>;
}

export interface BrowserAccountBridge extends IDisposable {
  /** One Host owner and credential authority; never register this object as an RPC service. */
  readonly authority: BrowserAccountAuthority;
  /** Same full owner may attach concurrently; mismatched restore rejects ready. */
  attach(client: IChannelClient): BrowserAccountAttachment;
}
