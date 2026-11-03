// @vitest-environment jsdom
// XCODE: 保留退役 App 文件中的 Native 单周期额度与未知缓存读回归。
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BUILTIN_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { ChatCodingPlanUsageRemainingPanel } from "@/chat-input-toolbar/CodingPlanContextUsage.js";
import { ChatContextUsage } from "@/chat-input-toolbar/contextUsage.js";

vi.mock("@/hooks/useCodingPlanQuotaResetUi.js", () => ({
  useCodingPlanQuotaResetUi: () => {
    const controller = {
      entry: null,
      opportunityVisible: false,
      processing: false,
      done: false,
      statusVisible: false,
      reset: vi.fn(async () => undefined),
    };
    return {
      enabled: false,
      ...controller,
      week: controller,
      reserveAutomaticCompletion: vi.fn(async () => ({ status: "blocked" })),
      commitAutomaticCompletion: vi.fn(() => false),
      releaseAutomaticCompletion: vi.fn(async () => undefined),
    };
  },
}));
vi.mock("@/CodingPlanBillingDiscount.js", () => ({
  CodingPlanBillingDiscountBadge: () => null,
  CodingPlanBillingDiscountBadgePill: () => null,
  CodingPlanBillingDiscountInfoDialog: () => null,
  useCodingPlanBillingDiscount: () => ({ active: false, loading: false }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    locale: "en-US",
    intl: { formatMessage: ({ id }: { id: string }) => id },
  }),
}));
vi.mock("@/components/ai-elements/context.js", async () => {
  const React = await import("react");
  const passthrough =
    (tag: "button" | "div") =>
    ({ children, ...props }: { children?: React.ReactNode }) =>
      React.createElement(tag, props, children);
  return {
    Context: passthrough("div"),
    ContextContent: passthrough("div"),
    ContextContentBody: passthrough("div"),
    ContextTrigger: passthrough("button"),
  };
});

function renderNative(native: {
  unlimited: boolean;
  usedPercentage: number | null;
  nextResetTime: number;
  resetTimeZone: string;
  resetUtcOffsetSeconds: number;
}) {
  const providerId = BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan;
  return renderToStaticMarkup(
    createElement(ChatCodingPlanUsageRemainingPanel, {
      config: {
        availableProviders: [
          {
            providerId,
            label: providerId,
            accountAccess: {
              type: "zhipu-account",
              family: "zai",
              planKind: "individual-coding-plan",
            },
          },
        ],
        entitlements: [
          {
            providerId,
            loading: false,
            error: null,
            snapshot: {
              source: "new-api",
              generatedAt: 1,
              authenticated: true,
              provider: { id: providerId, name: "Aiscoo" },
              remaining: null,
              subscription: {
                identityType: "unknown",
                identityMasked: null,
                details: [{ productId: "coding-pro", productName: "Coding Pro" }],
              },
              quota: {
                source: "new-api",
                level: "Fixture",
                limits: [
                  {
                    type: "NATIVE_QUOTA",
                    percentage: native.usedPercentage ?? undefined,
                    nextResetTime: native.nextResetTime,
                    usageDetails: [],
                    native: {
                      unlimited: native.unlimited,
                      total: native.unlimited ? null : "100",
                      used: "25",
                      remaining: native.unlimited ? null : "75",
                      usedPercentage: native.usedPercentage,
                      period: "monthly",
                      resetCustomSeconds: "0",
                      lastResetTime: null,
                      nextResetTime: native.nextResetTime,
                      resetTimeZone: native.resetTimeZone,
                      resetUtcOffsetSeconds: native.resetUtcOffsetSeconds,
                    },
                  },
                ],
              },
            },
          },
        ],
        modelProvidersLoading: false,
      },
      intl: { formatMessage: ({ id }: { id: string }) => id } as never,
      locale: "en-US",
    }),
  );
}

describe("Aiscoo Native context usage", () => {
  it("重置日期按 Native 服务端时区展示，不借用户电脑时区", () => {
    const resetAt = Date.UTC(2025, 7, 20, 20);
    expect(
      renderNative({
        unlimited: false,
        usedPercentage: 25,
        nextResetTime: resetAt,
        resetTimeZone: "Asia/Shanghai",
        resetUtcOffsetSeconds: 0,
      }),
    ).toContain("Aug 21");
    expect(
      renderNative({
        unlimited: false,
        usedPercentage: 25,
        nextResetTime: resetAt,
        resetTimeZone: "server-local",
        resetUtcOffsetSeconds: 9 * 3600,
      }),
    ).toContain("Aug 21");
  });

  it("无限额度不画空进度条，有限额度保留进度条", () => {
    const base = {
      nextResetTime: Date.UTC(2025, 7, 21, 12),
      resetTimeZone: "UTC",
      resetUtcOffsetSeconds: 0,
    };
    expect(renderNative({ ...base, unlimited: true, usedPercentage: null })).not.toContain(
      "width:0%",
    );
    expect(renderNative({ ...base, unlimited: false, usedPercentage: 25 })).toContain("width:75%");
  });

  it("renders unknown instead of 0% when the provider did not report cache reads", () => {
    const html = renderToStaticMarkup(
      createElement(ChatContextUsage, {
        intl: { formatMessage: ({ id }: { id: string }) => id },
        locale: "en-US",
        selectedProvider: "glm",
        taskUsage: { used: 17_000, size: 1_000_000, cache: { hitRate: null } },
      }),
    );
    expect(html).toContain("chat.contextUsage.cacheHitRate");
    expect(html).toContain("chat.contextUsage.cacheHitRateUnknown");
    expect(html).not.toContain("0%");
  });
});
