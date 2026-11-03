import assert from "node:assert/strict";
import test from "node:test";
import type { ProviderSettingsView, IUsageStatsService } from "@zcode/services";
import {
  resolveUsageAccountScope,
  selectUsageAccountState,
} from "../../ui/src/lib/usageAccountScope.js";
import {
  readCachedUsageEntitlementSnapshot,
  writeCachedUsageEntitlementSnapshot,
} from "../../ui/src/lib/usageEntitlementCache.js";
import { buildNativeCodingPlanUsageSource } from "../../ui/src/lib/codingPlanUsageSources.js";
import {
  beginSharedEntitlementRequest,
  buildEntitlementFreshnessKey,
  publishSharedEntitlementSnapshot,
  readSharedEntitlementSnapshot,
} from "../../ui/src/lib/usageEntitlementRefreshPolicy.js";
import { mapAiscooAdminEntitlement } from "../src/aiscoo-admin/aiscooAdminUsageMapper.js";
import { entitlements } from "./aiscooAdminRegistryFixtures.js";

const providerId = "account:aiscoo-anthropic-messages";
const access = {
  type: "new-api-account",
  accountType: "new-api",
  mode: "private-subscription",
  entitled: true,
} as const;
const view = (connectionKey: string): ProviderSettingsView =>
  ({
    revision: 1,
    providers: [{ providerId, effectiveConfig: { access }, accountState: { connectionKey } }],
  }) as ProviderSettingsView;
const scope = (connectionKey: string, authSessionSeq = 1, signedIn = true) =>
  resolveUsageAccountScope({
    providerId,
    accountAccess: access,
    view: view(connectionKey),
    signedIn,
    authSessionSeq,
  });
const options = {
  includeSubscription: true,
  preferredProviderId: providerId,
  accountAccess: access,
  allowDisabledPreferredProvider: false,
  requirePreferredProvider: true,
};
const snapshot = mapAiscooAdminEntitlement(entitlements, providerId);

test("Native cache scopes separate A, B and repeated login of the same account", () => {
  const a = scope("opaque-a");
  const b = scope("opaque-b");
  const relogin = scope("opaque-a", 2);
  assert.notEqual(a.ownerKey, b.ownerKey);
  assert.notEqual(a.ownerKey, relogin.ownerKey);
  assert.equal(scope("opaque-a", 1, false).ownerKey, "");
  assert.equal(
    resolveUsageAccountScope({
      providerId,
      accountAccess: access,
      view: null,
      signedIn: true,
      authSessionSeq: 1,
    }).ownerKey,
    "",
  );
});

test("actual shared entitlement cache and in-flight policy never reuse A as B", () => {
  const service = {} as IUsageStatsService;
  const key = (ownerKey: string) =>
    buildEntitlementFreshnessKey({ cacheKey: "fixed-public-source", options, ownerKey });
  const aKey = key(scope("opaque-a").ownerKey);
  const bKey = key(scope("opaque-b").ownerKey);
  const repeatedKey = key(scope("opaque-a", 2).ownerKey);
  const aRequest = beginSharedEntitlementRequest({
    usageStatsService: service,
    freshnessKey: aKey,
    invalidate: false,
  });
  const bRequest = beginSharedEntitlementRequest({
    usageStatsService: service,
    freshnessKey: bKey,
    invalidate: false,
  });
  assert.notEqual(aRequest.requestKey, bRequest.requestKey);
  // A's delayed result is allowed only in A's private cache namespace, never in B's read.
  publishSharedEntitlementSnapshot({ usageStatsService: service, freshnessKey: aKey, snapshot });
  assert.equal(
    readSharedEntitlementSnapshot({ usageStatsService: service, freshnessKey: bKey }),
    null,
  );
  assert.equal(
    readSharedEntitlementSnapshot({ usageStatsService: service, freshnessKey: repeatedKey }),
    null,
  );
});

test("hook render selector hides cached or late A state before B/logout effects run", () => {
  const aKey = scope("opaque-a").ownerKey;
  const bKey = scope("opaque-b").ownerKey;
  const old = { scopeKey: aKey, snapshot, loading: false, error: "A-only" };
  assert.equal(selectUsageAccountState(old, aKey, true).snapshot, snapshot);
  assert.equal(selectUsageAccountState(old, bKey, true).snapshot, null);
  assert.equal(selectUsageAccountState(old, bKey, true).error, null);
  assert.equal(selectUsageAccountState(old, aKey, false).snapshot, null);
  assert.equal(selectUsageAccountState(old, scope("opaque-a", 2).ownerKey, true).snapshot, null);
});

test("official and custom requests keep their existing cache scope", () => {
  assert.deepEqual(
    resolveUsageAccountScope({
      providerId: "personal:custom",
      view: null,
      signedIn: false,
      authSessionSeq: 9,
    }),
    { native: false, ownerKey: "" },
  );
  assert.deepEqual(
    resolveUsageAccountScope({
      providerId: "account:zai-individual-coding-plan",
      accountAccess: { type: "zhipu-account", family: "zai", planKind: "individual-coding-plan" },
      view: null,
      signedIn: false,
      authSessionSeq: 9,
    }),
    { native: false, ownerKey: "" },
  );
});

test("Native persistent cache neither restores old unscoped data nor writes new quota", () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "window");
  const entries = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
  };
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage } });
  try {
    entries.set("fixed-public-source", JSON.stringify({ cachedAt: Date.now(), snapshot }));
    assert.equal(readCachedUsageEntitlementSnapshot({ cacheKey: "fixed-public-source" }), null);
    assert.equal(entries.has("fixed-public-source"), false);
    writeCachedUsageEntitlementSnapshot({ cacheKey: "fixed-public-source", snapshot });
    assert.equal(entries.has("fixed-public-source"), false);
  } finally {
    if (previous) Object.defineProperty(globalThis, "window", previous);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("static Native anchor without a Host owner cannot become a usage source after logout", () => {
  assert.equal(buildNativeCodingPlanUsageSource(view("")), null);
  assert.equal(buildNativeCodingPlanUsageSource(view("opaque-a"))?.providerId, providerId);
});
