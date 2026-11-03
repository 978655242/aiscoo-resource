import type { AiscooAdminSessionBundle, UserInfo } from "@zcode/shared";
import type { AiscooAdminProviderAdapter } from "../oauth/providers/aiscooAdminProviderAdapter.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import type { AiscooAdminSessionRepo, AiscooAdminStoredSession } from "./aiscooAdminSessionRepo.js";
import {
  confirmedProfile,
  errorCode,
  sessionError,
  validateSession,
} from "./aiscooAdminSessionValidation.js";

const log = createServiceLogger("aiscooAdminAccount");

export interface AiscooAdminSessionRefreshFlight {
  session: AiscooAdminStoredSession;
  generation: number;
  promise: Promise<void>;
}

export function refreshStoredSession(
  repo: AiscooAdminSessionRepo,
  adapter: AiscooAdminProviderAdapter,
  expected: AiscooAdminStoredSession,
  now: () => number,
  assertCurrent: () => void,
  onAcquired: (bundle: AiscooAdminSessionBundle) => void,
): Promise<AiscooAdminStoredSession | null> {
  return repo.refreshCurrent(expected, async (current) => {
    assertCurrent();
    if (
      current.access_token !== expected.bundle.access_token &&
      current.access_expires_at > now() &&
      current.refresh_expires_at > now() &&
      current.relay_credential.expires_at > now()
    )
      return current;
    const bundle = await adapter.refresh(current);
    onAcquired(bundle);
    validateSession(bundle, now(), true);
    if (
      bundle.user.id !== expected.bundle.user.id ||
      bundle.session_id !== expected.bundle.session_id ||
      bundle.relay_credential.token !== expected.bundle.relay_credential.token ||
      bundle.refresh_token === current.refresh_token
    )
      throw sessionError("XCODE_SESSION_INVALID");
    return bundle;
  });
}

export async function restoreSessionProfile(
  adapter: AiscooAdminProviderAdapter,
  record: AiscooAdminStoredSession,
  currentSession: () => AiscooAdminStoredSession | null,
  now: () => number,
  refresh: () => Promise<void>,
): Promise<UserInfo> {
  if (record.bundle.refresh_expires_at <= now()) throw sessionError("XCODE_SESSION_INVALID");
  if (record.bundle.access_expires_at <= now()) await refresh();
  try {
    return confirmedProfile(
      await adapter.client.getMe(currentSession()!.bundle.access_token),
      currentSession()!.bundle,
    );
  } catch (error) {
    if (errorCode(error) !== "XCODE_ACCESS_EXPIRED" || currentSession() !== record) throw error;
    await refresh();
    return confirmedProfile(
      await adapter.client.getMe(currentSession()!.bundle.access_token),
      currentSession()!.bundle,
    );
  }
}

export async function revokeSession(
  adapter: AiscooAdminProviderAdapter,
  bundle: AiscooAdminSessionBundle,
): Promise<void> {
  try {
    await adapter.logout(bundle);
    log.info(undefined, "Private session remotely revoked");
  } catch (error) {
    log.warn(undefined, "Private session remote revocation failed", errorCode(error));
  }
}
