import type {
  CodingPlanActivityHeatmapWeek,
  CodingPlanUsageRange,
  CodingPlanUsageRequest,
  CodingPlanUsageSnapshot,
  NativeSinglePeriodResetStatus,
  AiscooAdminAccountUsageSnapshot,
  AiscooAdminEntitlements,
  AiscooAdminUsage,
  UsageEntitlementSnapshot,
  UsageQuotaSnapshot,
} from "@zcode/shared";

export function validateAiscooAdminUsageRequest(
  request: Pick<CodingPlanUsageRequest, "range" | "customStartDate" | "customEndDate" | "timeZone">,
): void {
  try {
    if (!["today", "7d", "30d", "custom"].includes(request.range)) throw new Error();
    if (request.timeZone) new Intl.DateTimeFormat("en", { timeZone: request.timeZone });
    if (request.range !== "custom") return;
    const date = (value: string | null | undefined) => {
      if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error();
      const timestamp = Date.parse(`${value}T00:00:00Z`);
      if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== value)
        throw new Error();
      return timestamp;
    };
    const days = (date(request.customEndDate) - date(request.customStartDate)) / 86400000 + 1;
    if (days < 1 || days > 30) throw new Error();
  } catch {
    throw new Error("XCODE_USAGE_REQUEST_INVALID");
  }
}

export function mapAiscooAdminQuota(
  entitlement: AiscooAdminEntitlements,
): UsageQuotaSnapshot | null {
  const quota = entitlement.quota;
  if (!quota) return null;
  return {
    source: "new-api",
    level: entitlement.subscription?.plan_title ?? null,
    limits: [
      {
        type: "NATIVE_QUOTA",
        userPlanId: entitlement.subscription?.id,
        period: quota.reset_period,
        meter: "quota",
        unitType: "quota",
        percentage: quota.used_percentage ?? undefined,
        nextResetTime: quota.next_reset_time ?? undefined,
        usageDetails: [],
        native: {
          unlimited: quota.unlimited,
          total: quota.total,
          used: quota.used,
          remaining: quota.remaining,
          usedPercentage: quota.used_percentage,
          period: quota.reset_period,
          resetCustomSeconds: quota.reset_custom_seconds,
          lastResetTime: quota.last_reset_time,
          nextResetTime: quota.next_reset_time,
          resetTimeZone: quota.reset_time_zone,
          resetUtcOffsetSeconds: quota.reset_utc_offset_seconds,
        },
      },
    ],
  };
}

export function mapAiscooAdminEntitlement(
  entitlement: AiscooAdminEntitlements,
  providerId: string,
): UsageEntitlementSnapshot {
  const subscription = entitlement.subscription;
  const valid = entitlement.status === "active" || entitlement.status === "exhausted";
  const percentage = entitlement.quota?.used_percentage;
  const quota = mapAiscooAdminQuota(entitlement);
  return {
    source: "new-api",
    scope: "private-user",
    authorizationStatus: entitlement.status,
    authorizationRevision: entitlement.authorization_revision,
    generatedAt: Date.now(),
    serverTime: entitlement.server_time,
    authenticated: true,
    ...(!valid ? { unavailableReason: "no_plan" as const } : {}),
    context: {
      scope: "private-user",
      productId: subscription?.plan_id ?? null,
      displayName: subscription?.plan_title ?? null,
    },
    provider: { id: providerId, name: "Aiscoo" },
    remaining:
      valid && percentage != null
        ? {
            count: null,
            isShow: true,
            percentage: Math.max(0, Math.min(100, 100 - percentage)),
            nextResetTime: entitlement.quota?.next_reset_time,
          }
        : null,
    subscription: subscription
      ? {
          identityType: "unknown",
          identityMasked: null,
          details: [
            {
              productId: subscription.plan_id,
              productName: subscription.plan_title,
              purchaseTime: null,
              beginTime:
                subscription.start_time === null
                  ? null
                  : new Date(subscription.start_time).toISOString(),
              expireTime:
                subscription.end_time === null
                  ? null
                  : new Date(subscription.end_time).toISOString(),
              billingCycle: entitlement.quota?.reset_period ?? null,
            },
          ],
        }
      : null,
    quota,
    mcpQuota: null,
  };
}

export function mapAiscooAdminResetStatus(
  entitlement: AiscooAdminEntitlements,
): NativeSinglePeriodResetStatus {
  return {
    mode: "native-single-period",
    source: "new-api",
    selfServiceEnabled: false,
    authorizationStatus: entitlement.status,
    authorizationRevision: entitlement.authorization_revision,
    period: entitlement.quota?.reset_period ?? null,
    lastResetTime: entitlement.quota?.last_reset_time ?? null,
    nextResetTime: entitlement.quota?.next_reset_time ?? null,
    resetTimeZone: entitlement.quota?.reset_time_zone ?? null,
    history: { availability: "not-supported", reason: "native-history-not-provided" },
  };
}

// Chart values are display approximations only; every exact signed value remains in native.
function chartValue(value: string): number {
  const number = Number(value);
  return Number.isFinite(number)
    ? number
    : value.startsWith("-")
      ? -Number.MAX_VALUE
      : Number.MAX_VALUE;
}
function dateInZone(time: number, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(time);
  const get = (type: string) => parts.find((part) => part.type === type)?.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function mapAiscooAdminAccountUsage(
  native: AiscooAdminUsage,
  range: CodingPlanUsageRange,
): AiscooAdminAccountUsageSnapshot {
  if (native.scope !== "new-api-account") throw new Error("XCODE_PROTOCOL_INVALID");
  return { source: "new-api", scope: "new-api-account", range, generatedAt: Date.now(), native };
}

export function mapAiscooAdminUsage(
  native: AiscooAdminUsage,
  range: CodingPlanUsageRange,
  providerId: string,
  entitlement?: AiscooAdminEntitlements,
): CodingPlanUsageSnapshot {
  mapAiscooAdminAccountUsage(native, range);
  const days = new Map<string, { tokens: bigint; records: bigint }>();
  for (const bucket of native.buckets) {
    // XCODE: server-local 不是 IANA；日桶标签/小时范围是后端自然日，不能借用客户端时区或当前额度 offset。
    const date =
      native.time_zone === "server-local"
        ? native.granularity === "hour"
          ? native.range_start_date
          : bucket.label
        : dateInZone(bucket.start_time, native.time_zone);
    const day = days.get(date) ?? { tokens: 0n, records: 0n };
    day.tokens += BigInt(bucket.total_tokens);
    day.records += BigInt(bucket.consume_record_count);
    days.set(date, day);
  }
  const sorted = [...days].sort(([a], [b]) => a.localeCompare(b));
  const max = sorted.reduce(
    (result, [, value]) => (value.tokens > result ? value.tokens : result),
    0n,
  );
  const peakDate = sorted.find(([, value]) => value.tokens === max && max > 0n)?.[0] ?? null;
  const weeks: CodingPlanActivityHeatmapWeek[] = [];
  let currentStreak = 0;
  let longestStreak = 0;
  for (const [date, value] of sorted) {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    if (!weeks.length || weekday === 0)
      weeks.push({ weekIndex: weeks.length, days: Array(7).fill(null) });
    weeks[weeks.length - 1]!.days[weekday] = {
      date,
      totalTokens: chartValue(value.tokens.toString()),
      turnCount: null,
      toolCallCount: null,
      consumptionRecordCount: value.records.toString(),
      level:
        max === 0n || value.tokens <= 0n
          ? 0
          : (Math.min(4, Math.max(1, Number((value.tokens * 4n) / max))) as 1 | 2 | 3 | 4),
    };
    currentStreak = value.records > 0n ? currentStreak + 1 : 0;
    longestStreak = Math.max(currentStreak, longestStreak);
  }
  const granularity = native.granularity === "hour" ? "hour" : "day";
  const unavailable = {
    cacheHitRate: null,
    cacheHitRateTrend: null,
    totalCredits: null,
    totalCreditsTrend: null,
    averageDailyCredits: null,
    averageDailyCreditsTrend: null,
  };
  return {
    source: "new-api",
    scope: "new-api-account",
    consumptionRecordCount: native.summary.consume_record_count,
    native,
    displayPrecision: "approximate",
    range,
    rangeStartDate: native.range_start_date,
    rangeEndDate: native.range_end_date,
    generatedAt: Date.now(),
    sourceProvider: { id: providerId, name: "Aiscoo" },
    quota: entitlement ? mapAiscooAdminQuota(entitlement) : null,
    activity: {
      summary: {
        totalTokens: chartValue(native.summary.total_tokens),
        peakDailyTokens: chartValue(max.toString()),
        peakDailyTokensDate: peakDate,
        totalUsageDurationMs: null,
        currentStreakDays: currentStreak,
        longestStreakDays: longestStreak,
        favoriteModelName:
          [...native.models].sort((a, b) =>
            BigInt(a.total_tokens) > BigInt(b.total_tokens) ? -1 : 1,
          )[0]?.model_id ?? null,
      },
      heatmap: {
        startDate: native.range_start_date,
        endDate: native.range_end_date,
        maxTokens: chartValue(max.toString()),
        weeks,
      },
    },
    detail: { model: unavailable, tool: unavailable },
    modelUsage: {
      xTime: native.buckets.map((bucket) => bucket.label),
      granularity,
      totalModelCallCount: null,
      totalTokensUsage: chartValue(native.summary.total_tokens),
      modelDataList: native.models.map((model, sortOrder) => {
        const buckets = new Map(model.buckets.map((bucket) => [bucket.start_time, bucket]));
        return {
          modelName: model.model_id,
          sortOrder,
          tokensUsage: native.buckets.map((bucket) =>
            chartValue(buckets.get(bucket.start_time)?.total_tokens ?? "0"),
          ),
          outputTokensUsage: native.buckets.map((bucket) =>
            chartValue(buckets.get(bucket.start_time)?.completion_tokens ?? "0"),
          ),
          totalTokens: chartValue(model.total_tokens),
        };
      }),
      modelSummaryList: native.models.map((model, sortOrder) => ({
        modelName: model.model_id,
        sortOrder,
        totalTokens: chartValue(model.total_tokens),
      })),
    },
    toolUsage: {
      availability: "not-supported",
      xTime: [],
      granularity,
      toolDataList: [],
      toolSummaryList: [],
    },
    health: {
      availability: "not-supported",
      xTime: [],
      proMaxDecodeSpeed: [],
      liteDecodeSpeed: [],
    },
  };
}
