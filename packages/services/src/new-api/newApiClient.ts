import { Buffer } from "node:buffer";
import { z } from "zod";
import {
  NEW_API_CALLBACK_URI,
  NEW_API_CLIENT_ID,
  NewApiSessionBundleSchema,
  NewApiMeSchema,
  NewApiPlansSchema,
  NewApiEntitlementsSchema,
  NewApiCatalogSchema,
  NewApiUsageSchema,
  NewApiClientConfigSchema,
  NewApiWebHandoffSchema,
  normalizeNewApiOrigin,
  isNewApiAuthorizationRedirectUri,
  type NewApiSessionBundle,
  type NewApiMe,
  type NewApiPlans,
  type NewApiEntitlements,
  type NewApiCatalog,
  type NewApiUsage,
  type NewApiClientConfig,
  type NewApiWebHandoff,
} from "@zcode/shared";

const serverErrorStatuses: Record<string, number> = {
  XCODE_AUTH_REQUEST_INVALID: 400,
  XCODE_AUTH_CODE_INVALID: 400,
  XCODE_USAGE_REQUEST_INVALID: 400,
  XCODE_ACCESS_EXPIRED: 401,
  XCODE_SESSION_INVALID: 401,
  XCODE_CREDENTIAL_SCOPE_DENIED: 403,
  XCODE_ORIGIN_FORBIDDEN: 403,
  XCODE_AUTHORIZATION_DISABLED: 404,
  XCODE_TOKEN_LIMIT: 409,
  XCODE_RATE_LIMITED: 429,
  AUTH_SESSION_LIMIT: 409,
  AUTH_SESSION_ISSUANCE_LIMIT: 429,
  AUTH_SESSION_MISMATCH: 409,
  AUTH_REFRESH_RACE: 409,
  XCODE_BACKEND_UNAVAILABLE: 503,
  XCODE_USAGE_UNAVAILABLE: 503,
};

export class NewApiClientError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(
      Object.hasOwn(serverErrorStatuses, code) || code === "XCODE_PROTOCOL_INVALID"
        ? code
        : "XCODE_REQUEST_FAILED",
    );
    this.name = "NewApiClientError";
  }
}

const logoutSchema = z
  .object({
    schema_version: z.literal(1),
    server_time: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    revoked: z.literal(true),
  })
  .strict();

export class NewApiClient {
  readonly origin: string;
  readonly redirectUri: string;
  private readonly fetch: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly bodyAbortAsUnavailable: boolean;

  constructor(
    baseUrl: string,
    dependencies: {
      fetch?: typeof globalThis.fetch;
      now?: () => number;
      bodyAbortAsUnavailable?: boolean;
      redirectUri?: string;
    } = {},
  ) {
    this.origin = normalizeNewApiOrigin(baseUrl);
    // XCODE: 构造时验证并绑定渠道，避免授权后换码读取不同redirect；未注入保留上游默认。
    this.redirectUri =
      dependencies.redirectUri === undefined ? NEW_API_CALLBACK_URI : dependencies.redirectUri;
    if (!isNewApiAuthorizationRedirectUri(this.redirectUri))
      throw new NewApiClientError("XCODE_AUTH_REQUEST_INVALID", 400);
    this.fetch = dependencies.fetch ?? globalThis.fetch;
    this.now = dependencies.now ?? Date.now;
    // XCODE: 仅可选本机 Web 期限启用响应体中止分类，桌面保持原行为。
    this.bodyAbortAsUnavailable = dependencies.bodyAbortAsUnavailable ?? false;
  }

  async exchangeAuthorizationCode(input: {
    code: string;
    codeVerifier: string;
    clientId?: string;
    redirectUri?: string;
  }): Promise<NewApiSessionBundle> {
    const bundle = await this.request("auth/token", NewApiSessionBundleSchema, undefined, {
      grant_type: "authorization_code",
      // XCODE: 本地 Web 保留该轮回环参数；桌面未覆盖时使用构造绑定的精确渠道回调。
      client_id: input.clientId ?? NEW_API_CLIENT_ID,
      redirect_uri: input.redirectUri ?? this.redirectUri,
      code: input.code,
      code_verifier: input.codeVerifier,
    });
    this.validateFreshSession(bundle);
    return bundle;
  }

  async refreshSession(input: {
    sessionId: string;
    refreshToken: string;
    clientId?: string;
  }): Promise<NewApiSessionBundle> {
    const bundle = await this.request("auth/refresh", NewApiSessionBundleSchema, undefined, {
      // XCODE: refresh 必须与签发该独立会话的客户端一致。
      client_id: input.clientId ?? NEW_API_CLIENT_ID,
      session_id: input.sessionId,
      refresh_token: input.refreshToken,
    });
    this.validateFreshSession(bundle);
    if (bundle.session_id !== input.sessionId)
      throw new NewApiClientError("XCODE_SESSION_INVALID", 200);
    return bundle;
  }

  async logoutSession(input: {
    sessionId: string;
    refreshToken: string;
    clientId?: string;
  }): Promise<void> {
    await this.request("auth/logout", logoutSchema, undefined, {
      // XCODE: 注销和过期登录补偿必须使用签发时的客户端。
      client_id: input.clientId ?? NEW_API_CLIENT_ID,
      session_id: input.sessionId,
      refresh_token: input.refreshToken,
    });
  }

  getMe(accessToken: string): Promise<NewApiMe> {
    return this.request("me", NewApiMeSchema, accessToken);
  }
  getPlans(accessToken: string): Promise<NewApiPlans> {
    return this.request("plans", NewApiPlansSchema, accessToken);
  }
  getEntitlements(accessToken: string): Promise<NewApiEntitlements> {
    return this.request("entitlements", NewApiEntitlementsSchema, accessToken);
  }
  getModels(accessToken: string): Promise<NewApiCatalog> {
    return this.request("models", NewApiCatalogSchema, accessToken);
  }
  getUsage(
    accessToken: string,
    query: {
      range: "today" | "7d" | "30d" | "custom";
      time_zone?: string;
      start_date?: string;
      end_date?: string;
    },
  ): Promise<NewApiUsage> {
    const params = new URLSearchParams({ range: query.range });
    for (const key of ["time_zone", "start_date", "end_date"] as const) {
      if (query[key] !== undefined) params.set(key, query[key]);
    }
    return this.request(`usage?${params}`, NewApiUsageSchema, accessToken);
  }
  getClientConfig(accessToken: string): Promise<NewApiClientConfig> {
    return this.request("client-config", NewApiClientConfigSchema, accessToken);
  }

  async createWebHandoff(accessToken: string): Promise<NewApiWebHandoff> {
    const handoff = await this.request("web-handoffs", NewApiWebHandoffSchema, accessToken, {});
    let url: URL;
    try {
      url = new URL(handoff.url);
    } catch {
      throw new NewApiClientError("XCODE_PROTOCOL_INVALID", 200);
    }
    const entries = [...url.searchParams];
    if (
      url.origin !== this.origin ||
      url.username ||
      url.password ||
      url.hash ||
      handoff.url.includes("#") ||
      url.pathname !== "/xcode/plans" ||
      !handoff.url.startsWith(`${this.origin}/xcode/plans?`) ||
      entries.length !== 1 ||
      entries[0]?.[0] !== "handoff" ||
      !/^[A-Za-z0-9_-]{43}$/.test(entries[0][1]) ||
      handoff.url !== `${this.origin}/xcode/plans?handoff=${entries[0][1]}` ||
      handoff.expires_at <= this.now() ||
      handoff.expires_at <= handoff.server_time ||
      handoff.expires_at - handoff.server_time > 60_000 ||
      handoff.expires_at - this.now() > 60_000
    ) {
      throw new NewApiClientError("XCODE_PROTOCOL_INVALID", 200);
    }
    return handoff;
  }

  private async request<T>(
    path: string,
    schema: z.ZodType<T>,
    accessToken?: string,
    body?: object,
  ): Promise<T> {
    const url = new URL(`/api/xcode/v1/${path}`, this.origin);
    const headers = new Headers({ Accept: "application/json" });
    if (accessToken !== undefined) {
      if (!accessToken || /\s/.test(accessToken))
        throw new NewApiClientError("XCODE_PROTOCOL_INVALID", 0);
      headers.set("Authorization", `Bearer ${accessToken}`);
    }
    if (body !== undefined) headers.set("Content-Type", "application/json");
    let response: Response;
    try {
      response = await this.fetch(url.toString(), {
        method: body === undefined ? "GET" : "POST",
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
    } catch {
      throw new NewApiClientError("XCODE_BACKEND_UNAVAILABLE", 0);
    }
    if (response.redirected || (response.url && new URL(response.url).origin !== this.origin)) {
      throw new NewApiClientError("XCODE_PROTOCOL_INVALID", response.status);
    }
    let envelope: unknown;
    try {
      envelope = await response.json();
    } catch (error) {
      // XCODE: 响应体读取可能被本机 Web 的请求期限中止，不能误报协议错误或暴露原始异常。
      const aborted =
        this.bodyAbortAsUnavailable &&
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError");
      throw new NewApiClientError(
        aborted || response.status >= 500 ? "XCODE_BACKEND_UNAVAILABLE" : "XCODE_PROTOCOL_INVALID",
        response.status,
      );
    }
    const failure = z
      .object({
        success: z.literal(false),
        code: z.string(),
        message: z.string(),
        request_id: z.string(),
      })
      .safeParse(envelope);
    if (!response.ok) {
      if (
        failure.success &&
        Object.hasOwn(serverErrorStatuses, failure.data.code) &&
        serverErrorStatuses[failure.data.code] === response.status
      ) {
        const requestId = /^[A-Za-z0-9_-]{1,128}$/.test(failure.data.request_id)
          ? failure.data.request_id
          : undefined;
        throw new NewApiClientError(failure.data.code, response.status, requestId);
      }
      throw new NewApiClientError(
        response.status >= 500 ? "XCODE_BACKEND_UNAVAILABLE" : "XCODE_PROTOCOL_INVALID",
        response.status,
      );
    }
    const success = z.object({ success: z.literal(true), data: schema }).safeParse(envelope);
    if (!success.success) throw new NewApiClientError("XCODE_PROTOCOL_INVALID", response.status);
    return success.data.data;
  }

  private validateFreshSession(bundle: NewApiSessionBundle): void {
    try {
      const parts = bundle.access_token.split(".");
      if (parts.length !== 3 || parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part)))
        throw new Error();
      const decoded = parts.map((part) => Buffer.from(part, "base64url"));
      if (
        decoded.some((part, index) => part.toString("base64url") !== parts[index]) ||
        decoded[2]?.length !== 32
      )
        throw new Error();
      const header = JSON.parse(decoded[0]!.toString("utf8"));
      const claims = JSON.parse(decoded[1]!.toString("utf8"));
      // XCODE: 本地仅校验实际 JWT 声明的一致性，不验证签名；服务端 Me 才是身份权威。
      if (
        header.alg !== "HS256" ||
        header.typ !== "JWT" ||
        claims.iss !== "new-api" ||
        !Array.isArray(claims.aud) ||
        claims.aud.length !== 1 ||
        claims.aud[0] !== "new-api-xcode" ||
        claims.token_use !== "xcode_access" ||
        claims.sub !== bundle.user.id ||
        claims.sid !== bundle.session_id ||
        !Number.isSafeInteger(claims.exp) ||
        claims.exp * 1000 !== bundle.access_expires_at ||
        !Number.isSafeInteger(claims.uv) ||
        claims.uv <= 0 ||
        !Number.isSafeInteger(claims.sv) ||
        claims.sv <= 0 ||
        !Number.isSafeInteger(claims.nbf) ||
        !Number.isSafeInteger(claims.iat) ||
        claims.nbf * 1000 > bundle.server_time ||
        claims.iat * 1000 > bundle.server_time ||
        !Array.isArray(claims.scopes) ||
        claims.scopes.join(" ") !== "profile:read wallet:read usage:read" ||
        [
          bundle.access_expires_at,
          bundle.refresh_expires_at,
          bundle.relay_credential.expires_at,
        ].some((expiry) => expiry <= this.now() || expiry <= bundle.server_time) ||
        bundle.access_expires_at > bundle.refresh_expires_at
      )
        throw new Error();
    } catch {
      throw new NewApiClientError("XCODE_PROTOCOL_INVALID", 200);
    }
  }
}
