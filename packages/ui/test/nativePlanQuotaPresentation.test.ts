// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { NewApiEntitlements } from "@zcode/shared";
import { ZCodeIntlProvider } from "../src/i18n/IntlProvider.js";
import {
  NativePlanProviderDetail,
  NativePlanQuotaCard,
} from "../src/settings/model-provider-section/NativePlanProviderDetail.js";

const quota: NonNullable<NewApiEntitlements["quota"]> = {
  scope: "zen-subscription",
  unit: "quota",
  unlimited: false,
  total: "100",
  used: "25",
  remaining: "75",
  used_percentage: 25,
  reset_period: "monthly",
  reset_custom_seconds: "0",
  last_reset_time: null,
  next_reset_time: Date.UTC(2026, 9, 31, 20),
  reset_time_zone: "Asia/Shanghai",
  reset_utc_offset_seconds: 28800,
};

function showQuota(patch: Partial<typeof quota> = {}) {
  const entitlement: NewApiEntitlements = {
    schema_version: 1,
    server_time: 1,
    status: "active",
    authorization_revision: "1",
    subscription: {
      id: "1",
      plan_id: "1",
      plan_title: "Monthly plan",
      source: "admin",
      usage_scope: "zen",
      start_time: null,
      end_time: null,
    },
    quota: { ...quota, ...patch },
    funding_policy: {
      subscription_only: true,
      wallet_fallback: false,
      other_subscription_fallback: false,
    },
    self_service_reset: false,
    purchase_mode: "manual_admin",
  };
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "en-US" },
      createElement(NativePlanProviderDetail, {
        provider: {
          providerId: "native",
          providerName: "XWork Zen",
          enabled: true,
          executable: true,
          hasPersonalConfig: false,
          personalConfig: {},
          config: {},
          models: [],
        },
        read: {
          connected: true,
          loading: false,
          error: null,
          refresh: async () => {},
          snapshot: {
            source: "new-api",
            purchaseMode: "manual_admin",
            scope: "private-user",
            plans: [],
            entitlement,
          },
        },
        onOpenPlans: () => {},
      }),
    ),
  );
}

afterEach(cleanup);

describe("Native plan remaining quota", () => {
  it("shows the actual remaining percentage and server reset day for the single monthly window", () => {
    showQuota();
    const meter = screen.getByRole("progressbar");
    expect(meter.getAttribute("aria-valuenow")).toBe("75");
    const card = meter.closest('[role="group"]')!;
    expect(card.textContent).toContain("75%");
    expect(card.querySelector("time")?.textContent).toBe("Nov 1, 04:00");
    expect(screen.getAllByRole("progressbar")).toHaveLength(1);
  });

  it.each([
    {
      locale: "zh-CN" as const,
      title: "剩余额度",
      removedTitle: "订阅剩余",
      resetDescription: "不自动重置",
    },
    {
      locale: "en-US" as const,
      title: "Quota remaining",
      removedTitle: "Subscription remaining",
      resetDescription: "No automatic reset",
    },
  ])(
    "keeps only the quota title for both non-resetting card layouts in $locale",
    ({ locale, title, removedTitle, resetDescription }) => {
      for (const compact of [true, false]) {
        render(
          createElement(
            ZCodeIntlProvider,
            { initialLocale: locale },
            createElement(NativePlanQuotaCard, {
              compact,
              quota: {
                unlimited: false,
                usedPercentage: 25,
                period: "never",
                nextResetTime: null,
                resetTimeZone: "UTC",
                resetUtcOffsetSeconds: 0,
              },
            }),
          ),
        );
        expect(screen.queryByText(removedTitle)).toBeNull();
        expect(screen.getByRole("group", { name: title }).textContent).toContain("75%");
        expect(screen.getByText(resetDescription)).toBeTruthy();
        expect(screen.getByRole("progressbar", { name: title }).getAttribute("aria-valuenow")).toBe(
          "75",
        );
        cleanup();
      }
    },
  );

  it("keeps exhausted quota at zero and does not turn unlimited or unknown quota into zero", () => {
    showQuota({ used_percentage: 100, used: "100", remaining: "0" });
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("0");
    cleanup();
    showQuota({ unlimited: true, used_percentage: null, total: null, remaining: null });
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText("Unlimited")).toBeTruthy();
    cleanup();
    showQuota({ used_percentage: null });
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.getByText("--")).toBeTruthy();
  });
});
