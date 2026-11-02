import type { ReactNode } from "react";
import type { NewApiCatalogIssue, NewApiEntitlements } from "@zcode/shared";
import { ModelRowIdentity } from "./ProviderFormControls.js";
import { InfoIcon, Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ZCodeAboutLogo } from "@/components/ui/ZCodeAboutLogo.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { NativePlanSettingsRead } from "@/hooks/useNativePlanSettings.js";
import type { ProviderSettingsFormProvider } from "@/lib/providerSettingsFormTypes.js";
import {
  formatQuotaRemainingPercentage,
  getQuotaRemainingPercentage,
} from "@/lib/codingPlanQuotaPresentation.js";
import { PlanStatusCardSurface } from "./StatusCards.js";
import { PlanEntryCard } from "./PlanEntryCard.js";
import {
  formatNativePlanPrice,
  formatNativePlanQuotaResetTime,
  type NativePlanQuota,
  getNativePlanReferenceOffers,
} from "./nativePlanSettingsPresentation.js";

// XCODE: 保留原版套餐详情的呈现，仅消费 Native 事实，不套用官方支付或额度语义。
export function NativePlanProviderDetail({
  provider,
  read,
  onOpenPlans,
  catalogIssues,
  children,
}: {
  provider: ProviderSettingsFormProvider;
  read: NativePlanSettingsRead;
  onOpenPlans: () => void;
  catalogIssues?: readonly NewApiCatalogIssue[];
  children?: (modelsVisible: boolean, modelListFooter: ReactNode) => ReactNode;
}) {
  const { intl, locale } = useZCodeIntl();
  const snapshot = read.snapshot;
  const subscription = snapshot?.entitlement.subscription;
  const quota = snapshot?.entitlement.quota;
  const offers = getNativePlanReferenceOffers(snapshot?.plans ?? []);
  const modelsVisible = snapshot?.entitlement.status === "active" && provider.executable;
  // XCODE: 全异常时 provider 不可执行仍须展示原因；诊断只追加只读行，不补 metadata 或 model ref。
  const modelListFooter = catalogIssues?.length
    ? catalogIssues.map((issue) => (
        <div
          key={issue.modelId}
          data-native-catalog-issue={issue.modelId}
          className="border-t border-input-border first:border-t-0"
        >
          <div className="space-y-2 px-3 py-2">
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <ModelRowIdentity model={issue} />
              </div>
            </div>
          </div>
          <div className="px-3 pb-2 text-ui-sm text-destructive break-words">
            {intl.formatMessage(
              { id: "settings.modelProvider.native.catalogIssue" },
              { reason: issue.code },
            )}
          </div>
        </div>
      ))
    : null;
  // 原始 quota 计数不能替代源版剩余百分比卡；两处设置页共用同一呈现。
  return (
    <div className="flex min-w-0 flex-col gap-4" data-native-plan-detail="true">
      <div className="flex h-8 min-w-0 items-center gap-2">
        <ZCodeAboutLogo className="size-5" />
        <h3 className="truncate text-ui-lg font-medium text-foreground">{provider.providerName}</h3>
      </div>
      <div className="space-y-3">
        <NativePlanStatusCard
          planTitle={subscription?.plan_title}
          authorizationStatus={snapshot?.entitlement.status}
          expiresAt={subscription?.end_time}
          connected={read.connected}
          loading={read.loading}
          error={read.error}
          onRetry={() => void read.refresh()}
          onOpenPlans={onOpenPlans}
          usageContent={
            quota ? (
              <div className="space-y-2">
                <h4 className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: "settings.usage.quotaTitle" })}
                </h4>
                <NativePlanQuotaCard
                  compact
                  quota={{
                    unlimited: quota.unlimited,
                    usedPercentage: quota.used_percentage,
                    period: quota.reset_period,
                    nextResetTime: quota.next_reset_time,
                    resetTimeZone: quota.reset_time_zone,
                    resetUtcOffsetSeconds: quota.reset_utc_offset_seconds,
                  }}
                />
              </div>
            ) : undefined
          }
        />
        <PlanEntryCard
          tone="personal"
          title={intl.formatMessage({
            id: "settings.modelProvider.codingPlan.purchaseBanner.personalTitle",
          })}
          disabled={!read.connected || read.loading}
          onClick={onOpenPlans}
          metric={offers.map((offer) => (
            <span
              key={offer.id}
              className="mt-1 flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5"
            >
              <span className="text-ui-xl font-bold leading-none text-foreground">
                {formatNativePlanPrice(offer.priceAmount, offer.currency, locale)}
              </span>
              <span className="text-ui-base font-medium text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.modelProvider.native.referencePeriod" },
                  {
                    period: intl.formatMessage(
                      { id: `settings.modelProvider.native.duration.${offer.durationUnit}` },
                      {
                        count:
                          offer.durationUnit === "custom"
                            ? offer.durationCustomSeconds
                            : offer.durationValue,
                      },
                    ),
                  },
                )}
              </span>
            </span>
          ))}
          description={
            read.loading ? (
              intl.formatMessage({ id: "purchase.entry.loading" })
            ) : read.error ? (
              intl.formatMessage({ id: "settings.modelProvider.codingPlan.productsError" })
            ) : (
              <>
                {offers
                  .map((offer) => offer.subtitle)
                  .filter(Boolean)
                  .join(" · ") ||
                  intl.formatMessage({ id: "settings.modelProvider.native.personalDescription" })}
                <span className="block text-ui-caption">
                  {intl.formatMessage({
                    id: offers.length
                      ? "settings.modelProvider.native.referenceNotice"
                      : "settings.modelProvider.native.noOffers",
                  })}
                </span>
              </>
            )
          }
        />
        <PlanEntryCard
          tone="team"
          title={intl.formatMessage({
            id: "settings.modelProvider.codingPlan.purchaseBanner.teamTitle",
          })}
          description={intl.formatMessage({ id: "settings.modelProvider.native.teamUnsupported" })}
          disabled
        />
        {modelsVisible || modelListFooter ? children?.(modelsVisible, modelListFooter) : null}
      </div>
    </div>
  );
}

// XCODE: 模型设置和使用统计共用套餐摘要，只接收各自既有 owner 的权益投影。
export function NativePlanStatusCard({
  planTitle,
  authorizationStatus,
  expiresAt,
  connected = true,
  loading = false,
  error,
  onRetry,
  onOpenPlans,
  usageContent,
}: {
  planTitle?: string | null;
  authorizationStatus?: NewApiEntitlements["status"];
  expiresAt?: string | number | null;
  connected?: boolean;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onOpenPlans?: () => void;
  usageContent?: ReactNode;
}) {
  const { intl, locale } = useZCodeIntl();
  const statusId = !connected
    ? "settings.modelProvider.codingPlan.status.loginRequired"
    : loading
      ? "settings.modelProvider.codingPlan.status.checking"
      : error
        ? "settings.modelProvider.codingPlan.status.unavailable"
        : authorizationStatus === "unassigned"
          ? "settings.modelProvider.codingPlan.status.notPurchased"
          : `settings.usage.nativeAuthorization.${authorizationStatus ?? "unassigned"}`;
  return (
    <div data-native-plan-status-card="true">
      <PlanStatusCardSurface
        planTitle={
          planTitle || intl.formatMessage({ id: "settings.modelProvider.planCard.codingPlan" })
        }
        statusMeta={
          <>
            {loading ? (
              <Loader2Icon className="size-3.5 animate-spin text-foreground-subtle" />
            ) : (
              <InfoIcon className="size-3.5 text-foreground-subtle" />
            )}
            <span className="text-ui-base text-foreground-subtle" role={error ? "alert" : "status"}>
              {intl.formatMessage({ id: statusId })}
            </span>
            {expiresAt != null ? (
              <span className="text-ui-caption text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.modelProvider.native.expiresAt" },
                  {
                    time: new Intl.DateTimeFormat(locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    }).format(new Date(expiresAt)),
                  },
                )}
              </span>
            ) : null}
            {error && onRetry ? (
              <Button variant="ghost" size="sm" onClick={onRetry}>
                {intl.formatMessage({ id: "common.retry" })}
              </Button>
            ) : null}
          </>
        }
        trailingAction={
          <Button disabled={!connected || !onOpenPlans} onClick={onOpenPlans}>
            {intl.formatMessage({
              id:
                authorizationStatus === "active"
                  ? "settings.modelProvider.codingPlan.upgrade"
                  : "settings.modelProvider.codingPlan.subscribe",
            })}
          </Button>
        }
        usageContent={usageContent}
      />
    </div>
  );
}

// XCODE: 私有单周期复用源版卡片布局，只展示后端实际支持的重置窗口。
export function NativePlanQuotaCard({
  quota,
  compact = false,
}: {
  quota: NativePlanQuota;
  compact?: boolean;
}) {
  const { intl, locale } = useZCodeIntl();
  // XCODE: 不重置订阅已有外层“剩余额度”，两处设置页不再重复显示“订阅剩余”。
  const hasPeriodTitle = quota.period !== "never";
  const label = intl.formatMessage({
    id: hasPeriodTitle
      ? `settings.usage.nativeRemaining.${quota.period}`
      : "settings.usage.quotaTitle",
  });
  const limit = {
    type: "NATIVE_QUOTA",
    percentage: quota.usedPercentage ?? undefined,
    usageDetails: [],
  };
  const percentage = quota.unlimited ? null : getQuotaRemainingPercentage(limit);
  const value = quota.unlimited
    ? intl.formatMessage({ id: "settings.usage.nativeUnlimited" })
    : formatQuotaRemainingPercentage(locale, limit);
  const resetTime = formatNativePlanQuotaResetTime(locale, quota);
  return (
    <div
      role="group"
      aria-label={label}
      className={`min-w-0 flex-1 ${compact ? "rounded-lg bg-surface p-3" : "rounded-xl bg-surface/70 p-4"}`}
    >
      {hasPeriodTitle ? (
        <div className={`flex ${compact ? "min-h-6" : "min-h-5"} min-w-0 items-center`}>
          <span
            className={`min-w-0 truncate text-ui-base text-foreground ${compact ? "font-medium" : ""}`}
          >
            {label}
          </span>
        </div>
      ) : null}
      <div
        className={`${hasPeriodTitle ? (compact ? "mt-2" : "mt-1") : ""} flex min-w-0 items-baseline gap-1.5`}
      >
        <span
          className={`${compact ? "text-ui-lg leading-none" : "text-ui-xl"} font-semibold text-foreground`}
        >
          {value}
        </span>
        {resetTime ? (
          <time
            dateTime={new Date(quota.nextResetTime!).toISOString()}
            className={`min-w-0 truncate ${compact ? "text-ui-sm" : "text-ui-base"} text-foreground-subtle`}
          >
            {resetTime}
          </time>
        ) : (
          <span
            className={`min-w-0 truncate ${compact ? "text-ui-sm" : "text-ui-base"} text-foreground-subtle`}
          >
            {intl.formatMessage({ id: `settings.usage.nativePeriod.${quota.period}` })}
          </span>
        )}
      </div>
      {percentage != null ? (
        <div
          role="progressbar"
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentage}
          aria-valuetext={value}
          className={`${compact ? "mt-2 h-1.5 bg-secondary" : "mt-3 h-2 bg-background"} overflow-hidden rounded-full`}
        >
          <div
            className="h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${percentage}%`, backgroundColor: "var(--color-usage-chart-1)" }}
          />
        </div>
      ) : null}
    </div>
  );
}
