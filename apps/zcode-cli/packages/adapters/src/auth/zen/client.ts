import { z } from "zod";
import {
  normalizeAiscooAdminOrigin,
  ZEN_CLI_CLIENT_ID,
  AiscooAdminSessionBundleSchema,
  AiscooAdminMeSchema,
  AiscooAdminCatalogSchema,
  AiscooAdminEntitlementsSchema,
} from "@zcode/shared";

const requestTimeoutMs = 15_000;
export class ZenClientError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

// XCODE: CLI 以独立 client_id 调用 canonical API，浏览器 cookie 与模型 relay 凭据不参与 control 请求。
export class ZenClient {
  readonly origin: string;
  constructor(
    origin: string,
    private readonly request: typeof fetch = globalThis.fetch,
  ) {
    this.origin = normalizeAiscooAdminOrigin(origin);
  }
  exchange(code: string, codeVerifier: string, redirectUri: string, signal?: AbortSignal) {
    return this.call(
      "auth/token",
      AiscooAdminSessionBundleSchema,
      undefined,
      {
        grant_type: "authorization_code",
        client_id: ZEN_CLI_CLIENT_ID,
        redirect_uri: redirectUri,
        code,
        code_verifier: codeVerifier,
      },
      signal,
    );
  }
  refresh(sessionId: string, refreshToken: string, signal?: AbortSignal) {
    return this.call(
      "auth/refresh",
      AiscooAdminSessionBundleSchema,
      undefined,
      {
        client_id: ZEN_CLI_CLIENT_ID,
        session_id: sessionId,
        refresh_token: refreshToken,
      },
      signal,
    );
  }
  async logout(sessionId: string, refreshToken: string) {
    await this.call("auth/logout", z.object({ revoked: z.literal(true) }), undefined, {
      client_id: ZEN_CLI_CLIENT_ID,
      session_id: sessionId,
      refresh_token: refreshToken,
    });
  }
  me(access: string, signal?: AbortSignal) {
    return this.call("me", AiscooAdminMeSchema, access, undefined, signal);
  }
  catalog(access: string, signal?: AbortSignal) {
    return this.call("models", AiscooAdminCatalogSchema, access, undefined, signal);
  }
  entitlements(access: string, signal?: AbortSignal) {
    return this.call("entitlements", AiscooAdminEntitlementsSchema, access, undefined, signal);
  }
  private async call<T>(
    path: string,
    schema: z.ZodType<T>,
    access?: string,
    body?: object,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers = new Headers({ Accept: "application/json" });
    if (access !== undefined) {
      if (!access || /\s/.test(access)) throw new ZenClientError("XCODE_PROTOCOL_INVALID", 0);
      headers.set("Authorization", `Bearer ${access}`);
    }
    if (body) headers.set("Content-Type", "application/json");
    const deadline = AbortSignal.timeout(requestTimeoutMs);
    try {
      const response = await this.request(new URL(`/api/xcode/v1/${path}`, this.origin), {
        method: body ? "POST" : "GET",
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        redirect: "error",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      if (response.redirected || (response.url && new URL(response.url).origin !== this.origin))
        throw new ZenClientError("XCODE_PROTOCOL_INVALID", response.status);
      const raw: unknown = await response.json();
      if (!response.ok) {
        const failure = z
          .object({ success: z.literal(false), code: z.string().regex(/^[A-Z][A-Z0-9_]{1,80}$/) })
          .safeParse(raw);
        throw new ZenClientError(
          failure.success ? failure.data.code : "XCODE_BACKEND_UNAVAILABLE",
          response.status,
        );
      }
      const parsed = z.object({ success: z.literal(true), data: schema }).safeParse(raw);
      if (!parsed.success) throw new ZenClientError("XCODE_PROTOCOL_INVALID", response.status);
      return parsed.data.data;
    } catch (error) {
      if (error instanceof ZenClientError) throw error;
      if (signal?.aborted) throw signal.reason;
      throw new ZenClientError("XCODE_BACKEND_UNAVAILABLE", 0);
    }
  }
}
