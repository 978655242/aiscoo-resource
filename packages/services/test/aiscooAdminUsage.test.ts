import assert from "node:assert/strict";
import test from "node:test";
import type { AiscooAdminEntitlements, AiscooAdminUsage, AiscooAdminOwner } from "@zcode/shared";
import {
  mapAiscooAdminEntitlement,
  mapAiscooAdminResetStatus,
  mapAiscooAdminUsage,
  validateAiscooAdminUsageRequest,
} from "../src/aiscoo-admin/aiscooAdminUsageMapper.js";
import { applyCodingPlanQuotaResetStatus } from "../../ui/src/lib/codingPlanQuotaResetUi.js";
import { createUsageStatsService } from "../src/usage-stats/usageStatsService.js";
import { AiscooAdminClient } from "../src/aiscoo-admin/aiscooAdminClient.js";

const entitlement: AiscooAdminEntitlements = {
  schema_version: 1,
  server_time: 1800000000000,
  status: "active",
  authorization_revision: "42",
  subscription: {
    id: "7",
    plan_id: "3",
    plan_title: "Private",
    source: "admin",
    usage_scope: "zen",
    start_time: null,
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
const usage: AiscooAdminUsage = {
  schema_version: 1,
  server_time: 1800000000000,
  as_of: 1800000000000,
  scope: "new-api-account",
  source: "native-consume-logs",
  retention_basis: "all-retained-consume-logs",
  time_zone: "America/New_York",
  range_start_date: "2026-03-08",
  range_end_date: "2026-03-08",
  granularity: "hour",
  display: {
    quota_per_unit: "500000",
    display_type: "USD",
    currency: "USD",
    currency_symbol: "$",
    usd_to_currency_rate: null,
  },
  summary: {
    consume_record_count: "12",
    prompt_tokens: "9007199254740993",
    completion_tokens: "2",
    total_tokens: "9007199254740995",
    charged_quota: "100",
    refunded_quota: "150",
    net_quota: "-50",
  },
  buckets: [],
  models: [],
  unsupported_metrics: [
    "agent_duration",
    "tool_usage",
    "cache_tokens",
    "reasoning_tokens",
    "decode_speed",
  ],
};

test("Native quota is the designated single period and remaining percentage is truly remaining", () => {
  const mapped = mapAiscooAdminEntitlement(entitlement, "account:new-api:anthropic-messages");
  assert.equal(mapped.context?.scope, "private-user");
  assert.equal(mapped.mcpQuota, null);
  assert.equal(mapped.quota?.limits.length, 1);
  assert.equal(mapped.remaining?.percentage, 75);
  assert.equal(mapped.quota?.limits[0]?.native?.remaining, "75");
  const unlimited = mapAiscooAdminEntitlement(
    {
      ...entitlement,
      quota: {
        ...entitlement.quota!,
        unlimited: true,
        total: null,
        remaining: null,
        used_percentage: null,
      },
    },
    "account:new-api:anthropic-messages",
  );
  assert.equal(unlimited.quota?.limits[0]?.native?.remaining, null);
  assert.equal(unlimited.remaining, null);
});

test("account usage preserves signed exact decimals and never fabricates model calls or unsupported metrics", () => {
  const mapped = mapAiscooAdminUsage(usage, "today", "account:new-api:anthropic-messages");
  assert.equal(mapped.source, "new-api");
  assert.equal(mapped.scope, "new-api-account");
  assert.equal(mapped.native?.summary.total_tokens, "9007199254740995");
  assert.equal(mapped.native?.summary.net_quota, "-50");
  assert.equal(mapped.modelUsage.totalModelCallCount, null);
  assert.equal(mapped.consumptionRecordCount, "12");
  assert.equal(mapped.activity.summary.totalUsageDurationMs, null);
  assert.equal(mapped.toolUsage.availability, "not-supported");
  assert.equal(mapped.health.availability, "not-supported");
});

test("Native reset uses canonical times, has no opportunities, and cannot enter success animation", () => {
  const status = mapAiscooAdminResetStatus(entitlement);
  assert.equal(status.mode, "native-single-period");
  assert.equal(status.nextResetTime, 1802592000000);
  assert.equal("availableWeekResets" in status, false);
  assert.equal(applyCodingPlanQuotaResetStatus(null, status, 1800000000000), null);
  assert.equal(
    mapAiscooAdminResetStatus({
      ...entitlement,
      subscription: null,
      quota: null,
      status: "unassigned",
    }).period,
    null,
  );
});

test("custom ranges count calendar dates rather than DST elapsed hours and reject over 30 days", () => {
  assert.doesNotThrow(() =>
    validateAiscooAdminUsageRequest({
      range: "custom",
      customStartDate: "2026-03-01",
      customEndDate: "2026-03-30",
      timeZone: "America/New_York",
    }),
  );
  assert.throws(
    () =>
      validateAiscooAdminUsageRequest({
        range: "custom",
        customStartDate: "2026-03-01",
        customEndDate: "2026-03-31",
        timeZone: "America/New_York",
      }),
    /XCODE_USAGE_REQUEST_INVALID/,
  );
  assert.throws(
    () =>
      validateAiscooAdminUsageRequest({
        range: "custom",
        customStartDate: "2026-02-30",
        customEndDate: "2026-03-01",
      }),
    /XCODE_USAGE_REQUEST_INVALID/,
  );
});

test("Native service routes real account HTTP and never falls back when its backend fails", async () => {
  const paths: string[] = [];
  let failing = false;
  let officialHttp = 0;
  const client = new AiscooAdminClient("https://native.example", {
    fetch: async (input, init) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer control");
      if (failing)
        return new Response(
          JSON.stringify({
            success: false,
            code: "XCODE_USAGE_UNAVAILABLE",
            message: "unavailable",
            request_id: "r",
          }),
          { status: 503 },
        );
      return new Response(
        JSON.stringify({
          success: true,
          data: url.pathname.endsWith("/usage") ? usage : entitlement,
        }),
      );
    },
  });
  const service = createUsageStatsService({
    apiClient: {
      request: async () => {
        officialHttp++;
        throw new Error("official fallback");
      },
    } as never,
    accountRequestAuthService: {} as never,
    zcodeAgentService: {
      getAppUsageStats: async () => {
        throw new Error("local fallback");
      },
    },
    native: {
      client,
      account: {
        withControlSession: async <T>(
          run: (token: string, owner: AiscooAdminOwner) => Promise<T>,
        ) => run("control", { origin: client.origin, userId: "1", sid: "sid", authGeneration: 3 }),
      },
    },
  });
  const access = {
    type: "new-api-account",
    accountType: "new-api",
    mode: "private-subscription",
  } as never;
  const request = {
    range: "today" as const,
    preferredProviderId: "account:aiscoo-anthropic-messages",
    accountAccess: access,
    timeZone: "America/New_York",
  };
  assert.equal((await service.getCodingPlanUsageSnapshot(request)).consumptionRecordCount, "12");
  assert.deepEqual(paths.sort(), ["/api/xcode/v1/entitlements", "/api/xcode/v1/usage"]);
  assert.deepEqual(await service.markCodingPlanResetHistoryRead(request), {
    availability: "not-supported",
    reason: "native-history-not-provided",
  });
  const generic = await service.getSnapshot({ range: "7d", dataSource: "new-api" });
  assert.equal(generic.source, "new-api");
  for (const preferredProviderId of [
    undefined,
    "account:new-api-anthropic-messages",
    "account:aiscoo-anthropic-messages",
  ]) {
    const snapshot = await service.getEntitlementSnapshot({ preferredProviderId });
    assert.equal(snapshot.provider?.id, "account:aiscoo-anthropic-messages");
    assert.equal(snapshot.source, "new-api");
  }
  await assert.rejects(
    () => service.getSnapshot({ range: "7d", dataSource: "local" }),
    /XCODE_USAGE_SOURCE_UNSUPPORTED/,
  );
  await assert.rejects(() => service.getSnapshot({ range: "7d" }), /XCODE_USAGE_SOURCE_REQUIRED/);
  const beforeStale = paths.length;
  await assert.rejects(
    () =>
      service.getCodingPlanUsageSnapshot({
        ...request,
        accountAccess: {
          type: "new-api-account",
          accountType: "new-api",
          mode: "private-subscription",
          entitled: true,
          owner: { origin: client.origin, userId: "2", sid: "old-sid", authGeneration: 2 },
        },
      }),
    /XCODE_STALE_OWNER/,
  );
  assert.equal(paths.length, beforeStale);
  await assert.rejects(
    () => service.useCodingPlanReset({ ...request, idempotencyKey: "i", resetType: "WEEK" }),
    /XCODE_SELF_SERVICE_DISABLED/,
  );
  failing = true;
  await assert.rejects(
    () => service.getCodingPlanUsageSnapshot(request),
    /XCODE_USAGE_UNAVAILABLE/,
  );
  assert.equal(officialHttp, 0);
});

test("DST repeated hours stay distinct while daily tokens and record counts aggregate without cache inference", () => {
  const bucket = (start_time: number, label: string, total_tokens: string) => ({
    start_time,
    end_time: start_time + 3600000,
    label,
    consume_record_count: "1",
    prompt_tokens: total_tokens,
    completion_tokens: "0",
    total_tokens,
    charged_quota: "1",
    refunded_quota: "0",
    net_quota: "1",
  });
  const buckets = [
    bucket(Date.parse("2026-11-01T05:00:00Z"), "01:00 -04:00", "10"),
    bucket(Date.parse("2026-11-01T06:00:00Z"), "01:00 -05:00", "20"),
  ];
  const mapped = mapAiscooAdminUsage(
    {
      ...usage,
      range_start_date: "2026-11-01",
      range_end_date: "2026-11-01",
      buckets,
      models: [{ model_id: "historical-disabled-model", ...usage.summary, buckets }],
    },
    "today",
    "account:aiscoo-anthropic-messages",
  );
  assert.deepEqual(mapped.modelUsage.xTime, ["01:00 -04:00", "01:00 -05:00"]);
  const day = mapped.activity.heatmap.weeks[0]?.days[0];
  assert.equal(day?.totalTokens, 30);
  assert.equal(day?.consumptionRecordCount, "2");
  assert.equal(day?.turnCount, null);
  assert.equal(day?.toolCallCount, null);
  assert.equal(mapped.modelUsage.modelDataList[0]?.modelName, "historical-disabled-model");
  assert.equal(mapped.modelUsage.modelDataList[0]?.cachedInputTokensUsage, undefined);
  assert.equal(mapped.modelUsage.modelDataList[0]?.uncachedInputTokensUsage, undefined);
});

test("default server-local usage consumer keeps server calendar dates across a non-UTC midnight", async () => {
  const bucket = (start: string, end: string, label: string, tokens: string) => ({
    ...usage.summary,
    start_time: Date.parse(start),
    end_time: Date.parse(end),
    label,
    consume_record_count: "1",
    total_tokens: tokens,
  });
  const todayBuckets = [
    bucket("2026-10-08T16:00:00Z", "2026-10-08T17:00:00Z", "00:00 +08:00", "9007199254740993"),
    bucket("2026-10-09T15:00:00Z", "2026-10-09T16:00:00Z", "23:00 +08:00", "2"),
  ];
  const dailyBuckets = [
    bucket("2026-10-07T16:00:00Z", "2026-10-08T16:00:00Z", "2026-10-08", "10"),
    bucket("2026-10-08T16:00:00Z", "2026-10-09T16:00:00Z", "2026-10-09", "20"),
  ];
  const client = new AiscooAdminClient("https://native.example", {
    fetch: async (input) => {
      const url = new URL(String(input));
      assert.equal(url.searchParams.has("time_zone"), false);
      const hourly = url.searchParams.get("range") === "today";
      const data = url.pathname.endsWith("/usage")
        ? {
            ...usage,
            time_zone: "server-local",
            granularity: hourly ? "hour" : "day",
            range_start_date: hourly ? "2026-10-09" : "2026-10-08",
            range_end_date: "2026-10-09",
            buckets: hourly ? todayBuckets : dailyBuckets,
          }
        : entitlement;
      return new Response(JSON.stringify({ success: true, data }));
    },
  });
  const service = createUsageStatsService({
    apiClient: {
      request: async () => {
        throw new Error("official fallback");
      },
    } as never,
    accountRequestAuthService: {} as never,
    zcodeAgentService: {
      getAppUsageStats: async () => {
        throw new Error("local fallback");
      },
    },
    native: {
      client,
      account: {
        withControlSession: async <T>(
          run: (token: string, owner: AiscooAdminOwner) => Promise<T>,
        ) => run("control", { origin: client.origin, userId: "1", sid: "sid", authGeneration: 3 }),
      },
    },
  });
  const accountAccess = {
    type: "new-api-account",
    accountType: "new-api",
    mode: "private-subscription",
  } as const;
  const today = await service.getCodingPlanUsageSnapshot({
    range: "today",
    accountAccess,
    preferredProviderId: "account:aiscoo-anthropic-messages",
  });
  const days = today.activity.heatmap.weeks
    .flatMap((week) => week.days)
    .filter((day) => day !== null);
  assert.deepEqual(
    days.map((day) => day.date),
    ["2026-10-09"],
  );
  assert.equal(days[0]?.consumptionRecordCount, "2");
  assert.equal(today.native?.buckets[0]?.total_tokens, "9007199254740993");
  assert.equal(today.native?.buckets[0]?.net_quota, "-50");
  assert.deepEqual(today.modelUsage.xTime, ["00:00 +08:00", "23:00 +08:00"]);
  const daily = await service.getCodingPlanUsageSnapshot({
    range: "7d",
    accountAccess,
    preferredProviderId: "account:aiscoo-anthropic-messages",
  });
  assert.deepEqual(
    daily.activity.heatmap.weeks
      .flatMap((week) => week.days)
      .filter((day) => day !== null)
      .map((day) => [day.date, day.totalTokens]),
    [
      ["2026-10-08", 10],
      ["2026-10-09", 20],
    ],
  );
});
