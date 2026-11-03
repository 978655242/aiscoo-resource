import assert from "node:assert/strict";
import test from "node:test";
import type { AiscooAdminEntitlements, AiscooAdminPlans, AiscooAdminOwner } from "@zcode/shared";
import { createCodingPlanSubscriptionService } from "../src/coding-plan-subscription/codingPlanSubscriptionService.js";
import {
  createAiscooAdminSubscriptionReadAdapter,
  mapAiscooAdminSubscriptionRead,
} from "../src/aiscoo-admin/aiscooAdminSubscriptionReadAdapter.js";
import { AiscooAdminClient } from "../src/aiscoo-admin/aiscooAdminClient.js";
import { AiscooAdminPlanWebviewPolicy } from "../../desktop/src/main/aiscooAdminPlanWebviewPolicy.js";

export const entitlement: AiscooAdminEntitlements = {
  schema_version: 1,
  server_time: 1800000000000,
  status: "active",
  authorization_revision: "42",
  subscription: {
    id: "9007199254740993",
    plan_id: "7",
    plan_title: "Private",
    source: "admin",
    usage_scope: "zen",
    start_time: 1800000000000,
    end_time: null,
  },
  quota: {
    scope: "zen-subscription",
    unit: "quota",
    unlimited: false,
    total: "100",
    used: "25",
    remaining: "75",
    used_percentage: 25,
    reset_period: "monthly",
    reset_custom_seconds: "0",
    last_reset_time: 1800000000000,
    next_reset_time: 1802592000000,
    reset_time_zone: "America/New_York",
    reset_utc_offset_seconds: -14400,
  },
  funding_policy: {
    subscription_only: true,
    wallet_fallback: false,
    other_subscription_fallback: false,
  },
  self_service_reset: false,
  purchase_mode: "manual_admin",
};
const plans: AiscooAdminPlans = {
  schema_version: 1,
  server_time: 1800000000000,
  purchase_mode: "manual_admin",
  self_service_purchase: false,
  items: [
    {
      id: "7",
      title: "Private",
      subtitle: "Admin only",
      price_amount: "9007199254740993.12",
      currency: "USD",
      duration_unit: "custom",
      duration_value: "1",
      duration_custom_seconds: "172800",
      total_quota: "100",
      reset_period: "monthly",
      reset_custom_seconds: "0",
      enabled: true,
    },
  ],
};

test("Native plan reads preserve exact price, native period and designated entitlement without fake wallets", () => {
  const result = mapAiscooAdminSubscriptionRead(plans, entitlement);
  assert.equal(result.source, "new-api");
  assert.equal(result.purchaseMode, "manual_admin");
  assert.equal(result.scope, "private-user");
  assert.equal(result.plans[0]?.priceAmount, "9007199254740993.12");
  assert.equal(result.plans[0]?.durationUnit, "custom");
  assert.equal(result.entitlement.subscription?.id, "9007199254740993");
  assert.equal("wallet" in result, false);
  assert.equal("organizationId" in result, false);
});

test("every private payment write rejects before transport and all six reads are explicit unsupported", async () => {
  let http = 0;
  const service = createCodingPlanSubscriptionService({
    apiClient: {
      request: async () => {
        http++;
        throw new Error("unexpected HTTP");
      },
    } as never,
    credentialService: { load: async () => null },
    native: {
      account: {
        withControlSession: async <T>(
          run: (token: string, owner: AiscooAdminOwner) => Promise<T>,
        ) =>
          run("control", {
            origin: "https://native.example",
            userId: "1",
            sid: "sid",
            authGeneration: 3,
          }),
      },
      client: {} as never,
    },
  });
  for (const write of [
    "createSign",
    "updateSign",
    "bindStripeCard",
    "unbindStripeCard",
    "payStripe",
    "createPaypalSetupToken",
    "subscribePaypal",
    "calculateEnterpriseOrder",
    "createEnterpriseOrder",
    "cancelEnterpriseOrder",
    "continueEnterpriseOrderPayment",
    "claimManualPlan",
  ] as const) {
    await assert.rejects(() => service[write]({} as never), /XCODE_SELF_SERVICE_DISABLED/);
  }
  for (const read of ["getManualClaimPlanPreviews", "getBillingDiscount"] as const) {
    await assert.rejects(() => service[read](), /XCODE_SELF_SERVICE_DISABLED/);
  }
  for (const read of [
    "checkPayment",
    "checkPendingOrders",
    "queryStripeCards",
    "checkPaypalSupport",
    "getEnterprisePendingOrders",
    "checkEnterpriseOrderStatus",
  ] as const) {
    assert.deepEqual(await service[read]({} as never), {
      availability: "not-supported",
      reason: "manual_admin",
      data: null,
    });
  }
  assert.equal(http, 0);
});

test("official payment reads wrap actual data and Native identity failure is not unsupported", async () => {
  const official = createCodingPlanSubscriptionService({
    apiClient: {
      request: async () => new Response(JSON.stringify({ code: 200, data: "PENDING" })),
    } as never,
    credentialService: {
      load: async (key) => (key === "oauth:bigmodel:access_token" ? "official-access" : null),
    },
  });
  assert.deepEqual(await official.checkPayment({ bizId: "order" }), {
    availability: "available",
    data: { status: "PENDING" },
  });
  const native = createCodingPlanSubscriptionService({
    apiClient: {} as never,
    credentialService: { load: async () => null },
    native: {
      account: {
        withControlSession: async () => {
          throw new Error("XCODE_SESSION_INVALID");
        },
      },
      client: {} as never,
    },
  });
  await assert.rejects(() => native.checkPayment({ bizId: "order" }), /XCODE_SESSION_INVALID/);
});

test("handoff RPC cannot mint without Main authority or publish before its acknowledgment", async () => {
  let minted = 0;
  const origin = "https://native.example";
  const now = 1800000000000;
  const client = new AiscooAdminClient(origin, {
    now: () => now,
    fetch: async () => {
      minted++;
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            schema_version: 1,
            server_time: now,
            expires_at: now + 30000,
            url: `${origin}/xcode/plans?handoff=${"h".repeat(43)}`,
          },
        }),
      );
    },
  });
  const account = {
    withControlSession: async <T>(run: (token: string, owner: AiscooAdminOwner) => Promise<T>) =>
      run("control", { origin, userId: "1", sid: "sid", authGeneration: 3 }),
  };
  const unsupported = createAiscooAdminSubscriptionReadAdapter({ account, client });
  await assert.rejects(
    unsupported.createPlanWebHandoff(),
    /XCODE_WEB_HANDOFF_ADMISSION_UNAVAILABLE/,
  );
  assert.equal(minted, 0);
  const policy = new AiscooAdminPlanWebviewPolicy();
  policy.setOwner({ origin, ownerGeneration: 3 });
  const gate = Promise.withResolvers<void>();
  const requested = Promise.withResolvers<void>();
  const adapter = createAiscooAdminSubscriptionReadAdapter({
    account,
    client,
    authorizeWebHandoff: async (handoff) => {
      requested.resolve();
      await gate.promise;
      if (!policy.authorize(handoff)) throw new Error("XCODE_STALE_WEB_HANDOFF");
    },
  });
  let published = false;
  const result = adapter.createPlanWebHandoff().then((handoff) => {
    published = true;
    return handoff;
  });
  await requested.promise;
  assert.equal(published, false);
  gate.resolve();
  const handoff = await result;
  assert.equal(policy.canAttach(policy.prepare(handoff).partition, handoff.url), true);
});
