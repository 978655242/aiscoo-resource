import type { AiscooAdminOwner, OAuthCachedSessionRestoreResult, UserInfo } from "@zcode/shared";
import type { BrowserAccountOAuthMethod } from "./contract.js";

export function bridgeError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export function sanitizedError(error: unknown): Error & { code: string } {
  const code = (error as { code?: unknown } | null)?.code;
  const known = [
    "XCODE_STALE_OWNER",
    "XCODE_PROTOCOL_INVALID",
    "XCODE_SESSION_INVALID",
    "XCODE_CREDENTIAL_SCOPE_DENIED",
    "XCODE_BACKEND_UNAVAILABLE",
    "XCODE_CREDENTIAL_RECOVERY_REQUIRED",
    "XCODE_ACCESS_EXPIRED",
    "XCODE_AUTH_REQUEST_INVALID",
    "XCODE_AUTH_CODE_INVALID",
    "XCODE_RATE_LIMITED",
    "XCODE_PRIVATE_POLLING_UNSUPPORTED",
    "XCODE_LOGOUT_FAILED",
    "XCODE_BROWSER_ACCOUNT_MISMATCH",
  ];
  return bridgeError(
    typeof code === "string" && known.includes(code) ? code : "XCODE_BROWSER_ACCOUNT_UNAVAILABLE",
  );
}

export function requireWire(condition: unknown): asserts condition {
  if (!condition) throw bridgeError("XCODE_PROTOCOL_INVALID");
}

export function readOwner(value: AiscooAdminOwner | null, origin: string): AiscooAdminOwner | null {
  if (value === null) return null;
  requireWire(
    value &&
      Object.keys(value).sort().join() === "authGeneration,origin,sid,userId" &&
      value.origin === origin &&
      typeof value.userId === "string" &&
      /^[1-9]\d*$/.test(value.userId) &&
      typeof value.sid === "string" &&
      value.sid.length > 0 &&
      value.sid.trim() === value.sid &&
      Number.isSafeInteger(value.authGeneration) &&
      value.authGeneration > 0,
  );
  return Object.freeze({
    origin,
    userId: value.userId,
    sid: value.sid,
    authGeneration: value.authGeneration,
  });
}

export function sameOwner(a: AiscooAdminOwner | null, b: AiscooAdminOwner | null): boolean {
  return (
    a === b ||
    (!!a &&
      !!b &&
      a.origin === b.origin &&
      a.userId === b.userId &&
      a.sid === b.sid &&
      a.authGeneration === b.authGeneration)
  );
}

export function publicUser(value: UserInfo | null): UserInfo | null {
  if (value === null) return null;
  requireWire(
    value &&
      typeof value.id === "string" &&
      typeof value.username === "string" &&
      typeof value.displayName === "string" &&
      (value.avatarUrl === undefined || typeof value.avatarUrl === "string"),
  );
  return {
    id: value.id,
    username: value.username,
    displayName: value.displayName,
    ...(value.avatarUrl === undefined ? {} : { avatarUrl: value.avatarUrl }),
  };
}

export function publicSession(
  value: OAuthCachedSessionRestoreResult,
): OAuthCachedSessionRestoreResult {
  switch (value?.status) {
    case "authenticated":
      return { status: value.status, userInfo: publicUser(value.userInfo)! };
    case "signed-out":
      return { status: value.status };
    case "reauthentication-required":
      requireWire(value.reason === "jwt-expired");
      return { status: value.status, reason: value.reason };
    case "unavailable":
      requireWire(["credential-recovery-required", "backend-unavailable"].includes(value.reason));
      return { status: value.status, reason: value.reason };
    default:
      throw bridgeError("XCODE_PROTOCOL_INVALID");
  }
}

/** Only declared public OAuth fields survive reverse RPC; arbitrary wire objects never escape. */
export function publicOAuth(method: BrowserAccountOAuthMethod, value: any): any {
  switch (method) {
    case "getProviders":
      requireWire(Array.isArray(value));
      return value.map((meta) => {
        requireWire(
          meta?.id === "new-api" &&
            typeof meta.displayName === "string" &&
            typeof meta.enabled === "boolean" &&
            Number.isFinite(meta.order),
        );
        return {
          id: meta.id,
          displayName: meta.displayName,
          enabled: meta.enabled,
          order: meta.order,
          ...(meta.legalLinks
            ? {
                legalLinks: {
                  userAgreementUrl: String(meta.legalLinks.userAgreementUrl),
                  privacyPolicyUrl: String(meta.legalLinks.privacyPolicyUrl),
                },
              }
            : {}),
        };
      });
    case "getActiveProvider":
      requireWire(value === null || value === "new-api");
      return value;
    case "restoreSession":
      return publicUser(value);
    case "startOAuth":
    case "startOAuthWithPolling":
      requireWire(
        value?.provider === "new-api" &&
          value.purpose === "primary-account" &&
          typeof value.authorizeUrl === "string" &&
          typeof value.state === "string",
      );
      return {
        provider: value.provider,
        purpose: value.purpose,
        authorizeUrl: value.authorizeUrl,
        state: value.state,
      };
    case "handleCallback":
    case "pollPendingOAuth":
      if (value === null) return null;
      requireWire(value?.provider === "new-api");
      if (value.kind === "duplicate") return { kind: value.kind, provider: value.provider };
      requireWire(value.kind === "session");
      return { kind: value.kind, provider: value.provider, userInfo: publicUser(value.userInfo) };
    default:
      return undefined;
  }
}
