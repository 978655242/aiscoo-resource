import { z } from "zod";
import { getAiscooDesktopIdentity } from "./aiscoo-desktop-identity/index.js";

export const AISCOO_ADMIN_PROVIDER_ID = "new-api";
export const AISCOO_ADMIN_CALLBACK_URI = "zcode://oauth/callback";
export const AISCOO_ADMIN_CLIENT_ID = "xcode-desktop";

// XCODE: 任意 scheme 或前缀会让不同渠道接管授权，只接收集中身份配置的完整回调 URI。
const aiscooAdminAuthorizationRedirectUris = new Set([
  AISCOO_ADMIN_CALLBACK_URI,
  getAiscooDesktopIdentity("production").oauthRedirectUri,
  getAiscooDesktopIdentity("development").oauthRedirectUri,
  getAiscooDesktopIdentity("preview").oauthRedirectUri,
]);
export function isAiscooAdminAuthorizationRedirectUri(redirectUri: string): boolean {
  return aiscooAdminAuthorizationRedirectUris.has(redirectUri);
}

// XCODE: CLI 使用独立客户端及精确回环回调，不扩大桌面深链的接收范围。
export const ZEN_CLI_CLIENT_ID = "xwork-cli";
export function parseZenAuthorizationCallback(
  raw: string,
  redirectUri: string,
  expectedState: string,
): { state: string; code: string } | null {
  if (!/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/oauth\/callback$/.test(redirectUri)) return null;
  try {
    const target = new URL(redirectUri);
    if (Number(target.port || "80") > 65535 || !raw.startsWith(`${redirectUri}?`)) return null;
    const url = new URL(raw);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (
      url.hash ||
      raw.includes("#") ||
      url.origin !== target.origin ||
      url.pathname !== target.pathname ||
      [...url.searchParams].length !== 3 ||
      ["provider", "code", "state"].some((key) => url.searchParams.getAll(key).length !== 1) ||
      url.searchParams.get("provider") !== AISCOO_ADMIN_PROVIDER_ID ||
      state !== expectedState ||
      !state ||
      !/^[A-Za-z0-9._~-]{22,256}$/.test(state) ||
      !code ||
      !/^[A-Za-z0-9_-]{43}$/.test(code)
    )
      return null;
    return { state, code };
  } catch {
    return null;
  }
}

// XCODE: Main路由与Host兑换绑定同一精确回调，未注入时保留上游默认且不放宽query。
export function parseAiscooAdminAuthorizationCallback(
  raw: string,
  redirectUri = AISCOO_ADMIN_CALLBACK_URI,
): { state: string; code: string } | null {
  if (!isAiscooAdminAuthorizationRedirectUri(redirectUri)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const entries = [...url.searchParams];
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  if (
    !raw.startsWith(`${redirectUri}?`) ||
    raw.includes("#") ||
    url.hash ||
    url.username ||
    url.password ||
    url.protocol !== new URL(redirectUri).protocol ||
    url.hostname !== "oauth" ||
    url.port ||
    url.pathname !== "/callback" ||
    entries.length !== 3 ||
    entries.some(([key]) => !["code", "state", "provider"].includes(key)) ||
    ["code", "state", "provider"].some((key) => url.searchParams.getAll(key).length !== 1) ||
    url.searchParams.get("provider") !== AISCOO_ADMIN_PROVIDER_ID ||
    !state ||
    !/^[A-Za-z0-9._~-]{22,256}$/.test(state) ||
    !code ||
    !/^[A-Za-z0-9_-]{43}$/.test(code)
  )
    return null;
  return { state, code };
}

export function normalizeAiscooAdminOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("XCODE_ORIGIN_INVALID");
  }
  // XCODE: URL 会把缩写、整数和十六进制 IPv4 转为 loopback，不能把别名当可信本机地址。
  const authority = raw.match(/^https?:\/\/([^/?#]+)\/?$/i)?.[1];
  const hostname = authority?.replace(/:\d+$/, "").toLowerCase();
  if (
    !authority ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(hostname ?? ""))
  ) {
    throw new Error("XCODE_ORIGIN_INVALID");
  }
  return url.origin;
}

export type AiscooAdminOwner = {
  origin: string;
  userId: string;
  sid: string;
  authGeneration: number;
};

const integer = z.string().regex(/^(0|[1-9]\d*)$/);
const positiveId = z.string().regex(/^[1-9]\d*$/);
const decimal = z.string().regex(/^(0|[1-9]\d*)(\.\d+)?$/);
const signedInteger = z.string().regex(/^(0|-?[1-9]\d*)$/);
const milliseconds = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const nonempty = z.string().min(1);
const snapshot = { schema_version: z.literal(1), server_time: milliseconds };
const resetPeriod = z.enum(["never", "daily", "weekly", "monthly", "custom"]);
const user = z
  .object({
    id: positiveId,
    username: z.string(),
    display_name: z.string(),
    avatar_url: z.string().nullable(),
  })
  .strict();
const display = z
  .object({
    quota_per_unit: decimal,
    display_type: z.enum(["USD", "CNY", "CUSTOM", "TOKENS"]),
    currency: z.string().nullable(),
    currency_symbol: z.string(),
    usd_to_currency_rate: decimal.nullable(),
  })
  .strict();

// XCODE: 缓存 control 过期仍可 refresh；新兑换的 JWT 身份和时效由 Host client 单独校验。
export const AiscooAdminSessionBundleSchema = z
  .object({
    ...snapshot,
    access_token: nonempty,
    access_expires_at: milliseconds,
    refresh_token: nonempty,
    refresh_expires_at: milliseconds,
    token_type: z.literal("Bearer"),
    session_id: nonempty,
    user,
    relay_credential: z
      .object({ token: z.string().regex(/^sk-\S+$/), expires_at: milliseconds })
      .strict(),
  })
  .strict();
export type AiscooAdminSessionBundle = z.infer<typeof AiscooAdminSessionBundleSchema>;

export const AiscooAdminMeSchema = z
  .object({
    ...snapshot,
    user,
    session_id: nonempty,
    authorization_revision: integer,
  })
  .strict();
export type AiscooAdminMe = z.infer<typeof AiscooAdminMeSchema>;

export const AiscooAdminPlansSchema = z
  .object({
    ...snapshot,
    purchase_mode: z.literal("manual_admin"),
    self_service_purchase: z.literal(false),
    items: z.array(
      z
        .object({
          id: positiveId,
          title: z.string(),
          subtitle: z.string(),
          price_amount: decimal,
          currency: nonempty,
          duration_unit: z.enum(["year", "month", "day", "hour", "custom"]),
          duration_value: integer,
          duration_custom_seconds: integer,
          total_quota: integer,
          reset_period: resetPeriod,
          reset_custom_seconds: integer,
          enabled: z.boolean(),
        })
        .strict(),
    ),
  })
  .strict();
export type AiscooAdminPlans = z.infer<typeof AiscooAdminPlansSchema>;

export const AiscooAdminEntitlementsSchema = z
  .object({
    ...snapshot,
    status: z.enum(["unassigned", "active", "exhausted", "expired", "revoked"]),
    authorization_revision: integer,
    subscription: z
      .object({
        id: positiveId,
        plan_id: positiveId,
        plan_title: z.string(),
        source: z.literal("admin"),
        usage_scope: z.literal("zen"),
        start_time: milliseconds.nullable(),
        end_time: milliseconds.nullable(),
      })
      .strict()
      .nullable(),
    quota: z
      .object({
        scope: z.literal("zen-subscription"),
        unit: z.literal("quota"),
        unlimited: z.boolean(),
        total: integer.nullable(),
        used: integer,
        remaining: integer.nullable(),
        used_percentage: z.number().finite().nonnegative().nullable(),
        reset_period: resetPeriod,
        reset_custom_seconds: integer,
        last_reset_time: milliseconds.nullable(),
        next_reset_time: milliseconds.nullable(),
        reset_time_zone: nonempty,
        reset_utc_offset_seconds: z.number().int().min(-86400).max(86400),
      })
      .strict()
      .nullable(),
    funding_policy: z
      .object({
        subscription_only: z.literal(true),
        wallet_fallback: z.literal(false),
        other_subscription_fallback: z.literal(false),
      })
      .strict(),
    self_service_reset: z.literal(false),
    purchase_mode: z.literal("manual_admin"),
  })
  .strict();
export type AiscooAdminEntitlements = z.infer<typeof AiscooAdminEntitlementsSchema>;

// XCODE: 账号扩展只传展示字段；能力由上游 Built-in 与 Personal 规则唯一合成。
export const aiscooAdminModelPresentationSchema = z.record(
  z.string(),
  z.record(
    z.string(),
    z.object({ displayName: z.string().optional(), icon: z.string().optional() }).strict(),
  ),
);
export type AiscooAdminModelPresentation = z.infer<typeof aiscooAdminModelPresentationSchema>;

export const AiscooAdminCatalogSchema = z
  .object({
    ...snapshot,
    catalog_revision: nonempty,
    authorization_revision: integer,
    models: z.array(
      z
        .object({
          model_id: nonempty,
          display_name: z.string(),
          // XCODE: 与 Aiscoo 管理端同源的 @lobehub/icons 图标名；旧后端没有该字段。
          icon: z.string().nullable().optional(),
          api_type: z
            .enum(["anthropic-messages", "openai-chat-completions", "openai-responses"])
            .nullable(),
          enabled: z.boolean(),
          disabled_reason: z.string().nullable(),
          // XCODE: 旧服务可返回任意兼容值，新客户端丢弃它，不能阻挡有效目录。
          model_config: z.unknown().optional(),
        })
        .strict()
        .transform(({ model_config: _legacy, ...model }) => model),
    ),
  })
  .strict();
export type AiscooAdminCatalog = z.infer<typeof AiscooAdminCatalogSchema>;

const usageSummary = {
  consume_record_count: integer,
  prompt_tokens: signedInteger,
  completion_tokens: signedInteger,
  total_tokens: signedInteger,
  charged_quota: signedInteger,
  refunded_quota: signedInteger,
  net_quota: signedInteger,
};
const usageBucket = z
  .object({
    start_time: milliseconds,
    end_time: milliseconds,
    label: z.string(),
    ...usageSummary,
  })
  .strict();
export const AiscooAdminUsageSchema = z
  .object({
    ...snapshot,
    as_of: milliseconds,
    scope: z.string(),
    source: z.string(),
    retention_basis: z.string(),
    time_zone: nonempty,
    range_start_date: z.string(),
    range_end_date: z.string(),
    granularity: z.string(),
    display,
    summary: z.object(usageSummary).strict(),
    buckets: z.array(usageBucket),
    models: z.array(
      z.object({ model_id: nonempty, ...usageSummary, buckets: z.array(usageBucket) }).strict(),
    ),
    unsupported_metrics: z.array(z.string()),
  })
  .strict();
export type AiscooAdminUsage = z.infer<typeof AiscooAdminUsageSchema>;

export const AiscooAdminClientConfigSchema = z
  .object({
    ...snapshot,
    purchase_mode: z.literal("manual_admin"),
    self_service_purchase: z.literal(false),
    self_service_reset: z.literal(false),
    manual_plan_entry_path: z.literal("/xcode/plans"),
    display,
  })
  .strict();
export type AiscooAdminClientConfig = z.infer<typeof AiscooAdminClientConfigSchema>;

export const AiscooAdminWebHandoffSchema = z
  .object({
    ...snapshot,
    url: nonempty,
    expires_at: milliseconds,
  })
  .strict();
export type AiscooAdminWebHandoff = z.infer<typeof AiscooAdminWebHandoffSchema>;
