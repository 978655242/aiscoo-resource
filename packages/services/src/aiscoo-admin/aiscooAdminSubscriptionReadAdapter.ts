import type {
  NativeCodingPlanReadSnapshot,
  AiscooAdminEntitlements,
  AiscooAdminPlans,
} from "@zcode/shared";
import type { AiscooAdminAccountService } from "./aiscooAdminAccountService.js";
import type { AiscooAdminClient } from "./aiscooAdminClient.js";

export interface AiscooAdminSubscriptionDependencies {
  account: Pick<AiscooAdminAccountService, "withControlSession">;
  client: Pick<AiscooAdminClient, "getPlans" | "getEntitlements" | "createWebHandoff">;
  authorizeWebHandoff?: (handoff: { url: string; ownerGeneration: number }) => Promise<void>;
}

export function mapAiscooAdminSubscriptionRead(
  plans: AiscooAdminPlans,
  entitlement: AiscooAdminEntitlements,
): NativeCodingPlanReadSnapshot {
  return {
    source: "new-api",
    purchaseMode: "manual_admin",
    scope: "private-user",
    entitlement,
    plans: plans.items.map((plan) => ({
      id: plan.id,
      title: plan.title,
      subtitle: plan.subtitle,
      priceAmount: plan.price_amount,
      currency: plan.currency,
      durationUnit: plan.duration_unit,
      durationValue: plan.duration_value,
      durationCustomSeconds: plan.duration_custom_seconds,
      totalQuota: plan.total_quota,
      resetPeriod: plan.reset_period,
      resetCustomSeconds: plan.reset_custom_seconds,
      enabled: plan.enabled,
    })),
  };
}

export function createAiscooAdminSubscriptionReadAdapter({
  account,
  client,
  authorizeWebHandoff,
}: AiscooAdminSubscriptionDependencies) {
  return {
    read: () =>
      account.withControlSession(async (token) => {
        const [plans, entitlements] = await Promise.all([
          client.getPlans(token),
          client.getEntitlements(token),
        ]);
        return mapAiscooAdminSubscriptionRead(plans, entitlements);
      }),
    createPlanWebHandoff: () =>
      account.withControlSession(async (token, owner) => {
        if (!authorizeWebHandoff) throw new Error("XCODE_WEB_HANDOFF_ADMISSION_UNAVAILABLE");
        const result = await client.createWebHandoff(token);
        const handoff = { url: result.url, ownerGeneration: owner.authGeneration };
        // Main 确认精确 URL 后才能返回 RPC，避免 Renderer 改写旧 URL 的 generation。
        await authorizeWebHandoff(handoff);
        return handoff;
      }),
  };
}

export async function rejectAiscooAdminSelfService(): Promise<never> {
  throw new Error("XCODE_SELF_SERVICE_DISABLED");
}
