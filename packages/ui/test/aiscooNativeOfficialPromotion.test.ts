// @vitest-environment jsdom
// XCODE: Native 不复用官方营销与折扣；保留退役 App 文件中的专属断言。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  services: {
    marketingTouchService: {
      query: vi.fn(),
      report: vi.fn().mockResolvedValue(undefined),
    },
    cloudContentService: {},
    codingPlanSubscriptionService: {
      claimManualPlan: vi.fn().mockResolvedValue({ success: true }),
    },
    usageStatsService: {
      getEntitlementSnapshot: vi.fn().mockResolvedValue({}),
    },
    providerSettingsService: { refresh: vi.fn().mockResolvedValue({}) },
  },
  native: true,
  providerStatus: "ready",
  tabs: { openSettingsTab: vi.fn(), activeWorkspacePath: "/fixture" },
  platform: { openExternal: vi.fn() },
  store: {
    user: { id: "fixture" },
    authSessionSeq: 0,
    isRestoringOAuthSession: false,
    requestLoginEntry: vi.fn(),
  },
  intl: { formatMessage: ({ id }: { id: string }) => id },
}));

vi.mock("@/hooks/useProviderSettingsView.js", () => ({
  useProviderSettingsView: () => ({
    state: {
      status: h.providerStatus,
      view: {
        revision: 1,
        providers: [
          {
            providerId: "account:aiscoo-openai-chat-completions",
            effectiveConfig: {
              access: {
                type: h.native ? "new-api-account" : "zhipu-account",
                accountType: "new-api",
                mode: "private-subscription",
                entitled: true,
              },
            },
          },
        ],
      },
    },
  }),
}));
vi.mock("@/hooks/useServices.js", () => ({
  useServices: () => h.services,
  useOptionalServices: () => h.services,
}));
vi.mock("@/hooks/usePlatform.js", () => ({ usePlatform: () => h.platform }));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: typeof h.store) => unknown) => selector(h.store),
  useZCodeStoreWithDefault: (selector: (state: typeof h.store) => unknown) => selector(h.store),
}));
vi.mock("@/store/TabStoreProvider.js", () => ({
  useTabStore: (selector: (state: typeof h.tabs) => unknown) => selector(h.tabs),
  useTabStoreApi: () => ({ getState: () => h.tabs }),
}));
vi.mock("@/WorkspaceSidebarFooterUsageSummary.js", () => ({
  useWorkspaceSidebarFooterUsageSummaryState: () => ({}),
}));
vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  useCodingPlanUpgradeDialog: () => ({ openCodingPlanUpgrade: vi.fn() }),
}));
vi.mock("@/rewards/RewardsProvider.js", () => ({
  useOpenRewards: () => vi.fn(),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: h.intl, locale: "en-US" }),
}));
vi.mock("@/components/cloud-content-dialog/useCloudHeroEnvironment.js", () => ({
  useCloudHeroEnvironment: () => ({ dark: false }),
}));
vi.mock("@/components/marketing-touch/marketingResources.js", () => ({
  prepareMarketingHero: vi.fn().mockResolvedValue({
    hero: { type: "image", src: "fixture.png" },
    release: async () => {},
  }),
}));
vi.mock("@/components/marketing-touch/MarketingDialogs.js", () => ({
  MarketingDialogs: () => null,
}));
vi.mock("@/components/marketing-touch/MarketingBanner.js", () => ({
  MarketingBannerView: () => createElement("button", null, "Claim"),
}));
vi.mock("@/components/ui/toast.js", () => ({ toast: vi.fn() }));
vi.mock("@/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import {
  MarketingBanner,
  MarketingTouchProvider,
} from "@/components/marketing-touch/MarketingTouchProvider.js";
import {
  primeCodingPlanBillingDiscountCacheForTest,
  useCodingPlanBillingDiscountFromService,
} from "@/CodingPlanBillingDiscount.js";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  h.native = true;
  h.providerStatus = "ready";
});

it.each(["native", "loading", "error"])("不在 %s 模式显示或领取官方营销赠送", async (mode) => {
  h.native = mode === "native";
  h.providerStatus = mode === "native" ? "ready" : mode;
  render(
    createElement(MarketingTouchProvider, {
      desktop: true,
      children: createElement(MarketingBanner),
    }),
  );
  await act(async () => {});
  expect(screen.queryByText("Claim")).toBeNull();
  expect(h.services.marketingTouchService.query).not.toHaveBeenCalled();
  expect(h.services.codingPlanSubscriptionService.claimManualPlan).not.toHaveBeenCalled();
});

it("Native 隐藏已缓存的官方折扣且刷新不会读取官方促销", async () => {
  primeCodingPlanBillingDiscountCacheForTest({
    "en-US": { badgeBody: "150% Quota" },
  });
  const service = { getBillingDiscount: vi.fn() };
  let refresh!: () => Promise<void>;
  function DiscountProbe() {
    const discount = useCodingPlanBillingDiscountFromService(service);
    refresh = discount.refresh;
    return discount.active || discount.config ? "official-discount" : null;
  }
  expect(renderToStaticMarkup(createElement(DiscountProbe))).toBe("");
  await refresh();
  expect(service.getBillingDiscount).not.toHaveBeenCalled();
});
