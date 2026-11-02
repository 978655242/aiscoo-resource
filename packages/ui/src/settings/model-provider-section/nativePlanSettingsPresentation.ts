import type { NativeCodingPlanReadSnapshot, UsageQuotaLimit } from "@zcode/shared";

export type NativePlanReferenceOffer = NativeCodingPlanReadSnapshot["plans"][number];

export type NativePlanQuota = Pick<
  NonNullable<UsageQuotaLimit["native"]>,
  | "unlimited"
  | "usedPercentage"
  | "period"
  | "nextResetTime"
  | "resetTimeZone"
  | "resetUtcOffsetSeconds"
>;

// XCODE: 重置时间沿用服务端时区，避免电脑时区使设置页与浮层显示不同重置日。
export function formatNativePlanQuotaResetTime(
  locale: string,
  quota: NativePlanQuota,
  format: "date" | "dateTime" = "dateTime",
): string | undefined {
  if (quota.period === "never" || quota.nextResetTime == null) return undefined;
  return new Intl.DateTimeFormat(locale, {
    timeZone: quota.resetTimeZone === "server-local" ? "UTC" : quota.resetTimeZone,
    month: "short",
    day: "numeric",
    ...(format === "dateTime"
      ? { hour: "2-digit", minute: "2-digit", hourCycle: "h23" as const }
      : {}),
  }).format(
    quota.nextResetTime +
      (quota.resetTimeZone === "server-local" ? quota.resetUtcOffsetSeconds * 1000 : 0),
  );
}

/** XCODE: 官网套餐只展示首个启用模板，避免分组比价产生多条价格并拼接其他套餐说明。 */
export function getNativePlanReferenceOffers(plans: readonly NativePlanReferenceOffer[]) {
  const offer = plans.find((plan) => plan.enabled);
  return offer ? [offer] : [];
}

/** XCODE: 参考金额保留原十进制精度，不能经过 Number 丢失尾数。 */
export function formatNativePlanPrice(amount: string, currency: string, locale: string) {
  const [whole, fraction = ""] = amount.split(".");
  const digits = Math.max(2, fraction.length);
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    })
      .formatToParts(BigInt(whole!))
      .map((part) => (part.type === "fraction" ? fraction.padEnd(digits, "0") : part.value))
      .join("");
  } catch {
    // 原生目录允许非 ISO 币种；仍呈现真实值，不猜汇率或替用其他币种。
    return `${amount} ${currency}`;
  }
}
