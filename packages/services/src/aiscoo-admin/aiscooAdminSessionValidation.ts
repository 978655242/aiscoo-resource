import { Buffer } from "node:buffer";
import {
  AISCOO_ADMIN_PROVIDER_ID,
  AiscooAdminMeSchema,
  AiscooAdminSessionBundleSchema,
  type AiscooAdminSessionBundle,
  type AiscooAdminOwner,
  type OAuthCachedSessionRestoreResult,
  type OAuthCallbackResult,
  type OAuthProviderId,
  type UserInfo,
} from "@zcode/shared";
import type { AiscooAdminStoredSession } from "./aiscooAdminSessionRepo.js";

export type PendingAiscooAdminAuthorization = Readonly<{
  state: string;
  codeVerifier: string;
  provider: typeof AISCOO_ADMIN_PROVIDER_ID;
  purpose: "primary-account";
  generation: number;
  expiresAt: number;
}>;

export interface AiscooAdminAuthorizationFlight {
  pending: PendingAiscooAdminAuthorization;
  promise: Promise<OAuthCallbackResult | null>;
}

export function pendingAuthorization(
  authorization: Pick<PendingAiscooAdminAuthorization, "state" | "codeVerifier">,
  generation: number,
  now: number,
): PendingAiscooAdminAuthorization {
  return Object.freeze({
    state: authorization.state,
    codeVerifier: authorization.codeVerifier,
    provider: AISCOO_ADMIN_PROVIDER_ID,
    purpose: "primary-account",
    generation,
    expiresAt: now + 300_000,
  });
}

export function validateProvider(provider?: OAuthProviderId): void {
  if (provider !== undefined && provider !== AISCOO_ADMIN_PROVIDER_ID)
    throw sessionError("XCODE_PROVIDER_INVALID");
}

export function isPendingAuthorizationCurrent(
  current: PendingAiscooAdminAuthorization | null,
  expected: PendingAiscooAdminAuthorization,
  generation: number,
  now: () => number,
): boolean {
  return current === expected && expected.generation === generation && expected.expiresAt > now();
}

export function isCurrentOwner(current: AiscooAdminOwner | null, owner: AiscooAdminOwner): boolean {
  return (
    current !== null &&
    owner.origin === current.origin &&
    owner.userId === current.userId &&
    owner.sid === current.sid &&
    owner.authGeneration === current.authGeneration
  );
}

export function sessionOwner(
  record: AiscooAdminStoredSession,
  generation: number,
): AiscooAdminOwner {
  return Object.freeze({
    origin: record.origin,
    userId: record.bundle.user.id,
    sid: record.bundle.session_id,
    authGeneration: generation,
  });
}

export function cachedSessionProfile(result: OAuthCachedSessionRestoreResult): UserInfo | null {
  if (result.status === "unavailable")
    throw sessionError(
      result.reason === "credential-recovery-required"
        ? "XCODE_CREDENTIAL_RECOVERY_REQUIRED"
        : "XCODE_BACKEND_UNAVAILABLE",
    );
  return result.status === "authenticated" ? result.userInfo : null;
}

export function unavailableSession(error: unknown): OAuthCachedSessionRestoreResult {
  const recoveryCodes = [
    "XCODE_PROTOCOL_INVALID",
    "XCODE_CREDENTIAL_RECORD_INVALID",
    "XCODE_SECURE_STORAGE_UNAVAILABLE",
    "XCODE_CREDENTIAL_RECOVERY_REQUIRED",
    "ZCODE_CREDENTIAL_DECRYPT_FAILED",
  ];
  return {
    status: "unavailable",
    reason: recoveryCodes.includes(errorCode(error))
      ? "credential-recovery-required"
      : "backend-unavailable",
  };
}

export function sessionError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

export function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "XCODE_BACKEND_UNAVAILABLE";
}

export function isRevocation(error: unknown): boolean {
  return ["XCODE_SESSION_INVALID", "XCODE_CREDENTIAL_SCOPE_DENIED"].includes(errorCode(error));
}

export function validateSession(
  bundle: AiscooAdminSessionBundle,
  now: number,
  fresh: boolean,
): void {
  if (!AiscooAdminSessionBundleSchema.safeParse(bundle).success)
    throw sessionError("XCODE_PROTOCOL_INVALID");
  try {
    const segments = bundle.access_token.split(".");
    if (segments.length !== 3 || segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment)))
      throw new Error();
    const decoded = segments.map((segment) => Buffer.from(segment, "base64url"));
    if (
      decoded.some((value, index) => value.toString("base64url") !== segments[index]) ||
      decoded[2]!.length !== 32
    )
      throw new Error();
    const header = JSON.parse(decoded[0]!.toString("utf8"));
    const claims = JSON.parse(decoded[1]!.toString("utf8"));
    // XCODE: 缓存只做结构/用途检查；签名和身份仍必须由远端 Me 确认。
    if (
      header.alg !== "HS256" ||
      header.typ !== "JWT" ||
      claims.iss !== "new-api" ||
      !Array.isArray(claims.aud) ||
      claims.aud.length !== 1 ||
      claims.aud[0] !== "new-api-xcode" ||
      claims.token_use !== "xcode_access" ||
      claims.sub !== bundle.user.id ||
      claims.sid !== bundle.session_id ||
      !Number.isSafeInteger(claims.exp) ||
      claims.exp * 1000 !== bundle.access_expires_at ||
      !Number.isSafeInteger(claims.uv) ||
      claims.uv <= 0 ||
      !Number.isSafeInteger(claims.sv) ||
      claims.sv <= 0 ||
      !Number.isSafeInteger(claims.nbf) ||
      !Number.isSafeInteger(claims.iat) ||
      claims.nbf * 1000 > bundle.server_time ||
      claims.iat * 1000 > bundle.server_time ||
      !Array.isArray(claims.scopes) ||
      claims.scopes.join(" ") !== "profile:read wallet:read usage:read" ||
      bundle.access_expires_at > bundle.refresh_expires_at ||
      (fresh &&
        (bundle.access_expires_at <= now ||
          bundle.refresh_expires_at <= now ||
          bundle.relay_credential.expires_at <= now))
    )
      throw new Error();
  } catch {
    throw sessionError("XCODE_PROTOCOL_INVALID");
  }
}

export function confirmedProfile(value: unknown, bundle: AiscooAdminSessionBundle): UserInfo {
  const result = AiscooAdminMeSchema.safeParse(value);
  if (!result.success) throw sessionError("XCODE_PROTOCOL_INVALID");
  const me = result.data;
  if (me.session_id !== bundle.session_id || me.user.id !== bundle.user.id) {
    throw sessionError("XCODE_SESSION_INVALID");
  }
  return {
    id: me.user.id,
    username: me.user.username,
    displayName: me.user.display_name,
    ...(me.user.avatar_url === null ? {} : { avatarUrl: me.user.avatar_url }),
  };
}

export function validateRotatedSession(
  rotated: AiscooAdminStoredSession,
  expected: AiscooAdminStoredSession,
  now: number,
): void {
  validateSession(rotated.bundle, now, true);
  if (
    rotated.origin !== expected.origin ||
    rotated.bundle.user.id !== expected.bundle.user.id ||
    rotated.bundle.session_id !== expected.bundle.session_id ||
    rotated.bundle.relay_credential.token !== expected.bundle.relay_credential.token
  )
    throw sessionError("XCODE_SESSION_INVALID");
}
