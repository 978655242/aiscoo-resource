import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AISCOO_ADMIN_CALLBACK_URI,
  AISCOO_ADMIN_CLIENT_ID,
  parseAiscooAdminAuthorizationCallback,
  type AiscooAdminSessionBundle,
} from "@zcode/shared";
import { AiscooAdminClient } from "../src/aiscoo-admin/aiscooAdminClient.js";
import { AiscooAdminProviderAdapter } from "../src/oauth/providers/aiscooAdminProviderAdapter.js";

const redirects = [
  "zcode://oauth/callback",
  "aiscoo://oauth/callback",
  "aiscoo-dev://oauth/callback",
  "aiscoo-preview://oauth/callback",
] as const;
const origin = "https://native.example";
const now = 1_800_000_000_000;
const state = "s".repeat(43);
const code = "c".repeat(43);
const callback = (redirectUri: string, callbackState = state) =>
  `${redirectUri}?provider=new-api&state=${callbackState}&code=${code}`;
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const session: AiscooAdminSessionBundle = {
  schema_version: 1,
  server_time: now,
  access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({
    iss: "new-api",
    aud: ["new-api-xcode"],
    token_use: "xcode_access",
    sub: "1",
    sid: "native-test-sid",
    exp: (now + 900_000) / 1000,
    nbf: now / 1000,
    iat: now / 1000,
    uv: 1,
    sv: 1,
    scopes: ["profile:read", "wallet:read", "usage:read"],
  })}.${Buffer.alloc(32, 7).toString("base64url")}`,
  access_expires_at: now + 900_000,
  refresh_token: "native-test-refresh",
  refresh_expires_at: now + 86_400_000,
  token_type: "Bearer",
  session_id: "native-test-sid",
  user: { id: "1", username: "native", display_name: "Native", avatar_url: null },
  relay_credential: { token: "sk-native-test-relay", expires_at: now + 86_400_000 },
};
const invalidRedirects = [
  "",
  "other://oauth/callback",
  "aiscoo-beta://oauth/callback",
  "aiscoo-preview-extra://oauth/callback",
  "https://oauth/callback",
  "aiscoo://oauth.evil/callback",
  "aiscoo://other/callback",
  "aiscoo://user@oauth/callback",
  "aiscoo://oauth:1234/callback",
  "aiscoo://oauth/callback/",
  "aiscoo://oauth/callback-extra",
  "aiscoo://oauth/%63allback",
  "aiscoo://oauth/callback?",
  "aiscoo://oauth/callback?provider=new-api",
  "aiscoo://oauth/callback#",
  "aiscoo://oauth/callback#fragment",
  "AISCOO://oauth/callback",
  "aiscoo://OAUTH/callback",
  " aiscoo://oauth/callback",
];

describe("Native authorization binds the exact desktop redirect", () => {
  it("keeps the upstream callback and client defaults without channel injection", () => {
    const client = new AiscooAdminClient(origin, {
      fetch: async () => {
        throw new Error("Default authorization must not request the backend");
      },
    });
    const adapter = new AiscooAdminProviderAdapter(client);
    const authorizeUrl = new URL(adapter.createAuthorization().authorizeUrl);

    expect(AISCOO_ADMIN_CALLBACK_URI).toBe("zcode://oauth/callback");
    expect(AISCOO_ADMIN_CLIENT_ID).toBe("xcode-desktop");
    expect(client.redirectUri).toBe(AISCOO_ADMIN_CALLBACK_URI);
    expect(adapter.redirectUri).toBe(AISCOO_ADMIN_CALLBACK_URI);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(AISCOO_ADMIN_CALLBACK_URI);
    expect(authorizeUrl.searchParams.get("client_id")).toBe(AISCOO_ADMIN_CLIENT_ID);
    expect(parseAiscooAdminAuthorizationCallback(callback(AISCOO_ADMIN_CALLBACK_URI))).toEqual({
      state,
      code,
    });
    expect(adapter.parseCallback(callback(AISCOO_ADMIN_CALLBACK_URI))).toEqual({ state, code });
    for (const redirectUri of redirects.slice(1)) {
      expect(parseAiscooAdminAuthorizationCallback(callback(redirectUri))).toBeNull();
      expect(() => adapter.parseCallback(callback(redirectUri))).toThrow();
    }
  });

  it.each(redirects)(
    "uses %s consistently for authorize, callback and token while preserving refresh/logout",
    async (redirectUri) => {
      const requests: Array<{ url: string; init: RequestInit }> = [];
      const dependencies = {
        redirectUri: String(redirectUri),
        now: () => now,
        fetch: (async (raw, init) => {
          requests.push({ url: String(raw), init: init! });
          const data = String(raw).endsWith("/auth/logout")
            ? { schema_version: 1, server_time: now, revoked: true }
            : session;
          return new Response(JSON.stringify({ success: true, data }));
        }) as typeof globalThis.fetch,
      };
      const client = new AiscooAdminClient(origin, dependencies);
      const adapter = new AiscooAdminProviderAdapter(client);
      // XCODE: 渠道必须在构造时绑定，调用方后续改注入对象不能改变本轮 PKCE 的回调。
      dependencies.redirectUri = redirectUri === redirects[0] ? redirects[1] : redirects[0];
      const authorization = adapter.createAuthorization();
      const authorizeUrl = new URL(authorization.authorizeUrl);

      expect(client.redirectUri).toBe(redirectUri);
      expect(adapter.redirectUri).toBe(redirectUri);
      expect(authorizeUrl.origin).toBe(origin);
      expect(authorizeUrl.pathname).toBe("/api/xcode/v1/auth/authorize");
      expect(authorizeUrl.searchParams.get("client_id")).toBe("xcode-desktop");
      expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
      expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
      expect(authorizeUrl.searchParams.get("state")).toBe(authorization.state);
      expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
      expect(authorizeUrl.searchParams.get("code_challenge")).toBe(
        createHash("sha256").update(authorization.codeVerifier).digest("base64url"),
      );
      expect(
        parseAiscooAdminAuthorizationCallback(
          callback(redirectUri, authorization.state),
          redirectUri,
        ),
      ).toEqual({ state: authorization.state, code });
      expect(adapter.parseCallback(callback(redirectUri, authorization.state))).toEqual({
        state: authorization.state,
        code,
      });

      await expect(adapter.exchangeCode(code, authorization.codeVerifier)).resolves.toEqual(
        session,
      );
      await expect(adapter.refresh(session)).resolves.toEqual(session);
      await expect(adapter.logout(session)).resolves.toBeUndefined();
      expect(requests.map(({ url }) => url)).toEqual([
        `${origin}/api/xcode/v1/auth/token`,
        `${origin}/api/xcode/v1/auth/refresh`,
        `${origin}/api/xcode/v1/auth/logout`,
      ]);
      expect(JSON.parse(String(requests[0]!.init.body))).toEqual({
        grant_type: "authorization_code",
        client_id: "xcode-desktop",
        redirect_uri: authorizeUrl.searchParams.get("redirect_uri"),
        code,
        code_verifier: authorization.codeVerifier,
      });
      const refreshOrLogout = {
        client_id: "xcode-desktop",
        session_id: session.session_id,
        refresh_token: session.refresh_token,
      };
      expect(JSON.parse(String(requests[1]!.init.body))).toEqual(refreshOrLogout);
      expect(JSON.parse(String(requests[2]!.init.body))).toEqual(refreshOrLogout);
    },
  );

  it.each(redirects)("rejects every other channel when bound to %s", (redirectUri) => {
    const adapter = new AiscooAdminProviderAdapter(new AiscooAdminClient(origin, { redirectUri }));
    for (const other of redirects.filter((candidate) => candidate !== redirectUri)) {
      expect(parseAiscooAdminAuthorizationCallback(callback(other), redirectUri)).toBeNull();
      expect(() => adapter.parseCallback(callback(other))).toThrow("XCODE_AUTH_REQUEST_INVALID");
    }
  });

  it.each(redirects)("preserves strict callback syntax when bound to %s", (redirectUri) => {
    const adapter = new AiscooAdminProviderAdapter(new AiscooAdminClient(origin, { redirectUri }));
    const valid = callback(redirectUri);
    const invalid = [
      valid.replace("://oauth/", "://other/"),
      valid.replace("://oauth/", "://oauth.evil/"),
      valid.replace("://oauth/", "://user@oauth/"),
      valid.replace("://oauth/", "://user:pass@oauth/"),
      valid.replace("://oauth/", "://oauth:1234/"),
      valid.replace("/callback?", "/callback/?"),
      valid.replace("/callback?", "/callback-extra?"),
      valid.replace("/callback?", "/%63allback?"),
      valid.replace("/callback?", "/other/../callback?"),
      valid.replace("provider=new-api", "provider=zai"),
      valid.replace("provider=new-api&", ""),
      valid.replace(`state=${state}`, "state="),
      valid.replace(`state=${state}`, "state=short"),
      valid.replace(`state=${state}`, `state=${"s".repeat(257)}`),
      valid.replace(`state=${state}`, `state=${"s".repeat(21)}%20`),
      valid.replace(`code=${code}`, "code="),
      valid.replace(`code=${code}`, `code=${"c".repeat(42)}`),
      valid.replace(`code=${code}`, `code=${"c".repeat(44)}`),
      valid.replace(`code=${code}`, `code=${"c".repeat(42)}.`),
      `${valid}&provider=new-api`,
      `${valid}&state=${state}`,
      `${valid}&code=${code}`,
      `${valid}&purpose=primary-account`,
      `${valid}&authCode=${code}`,
      `${valid}&redirect_uri=${encodeURIComponent(redirectUri)}`,
      `${valid}#`,
      `${valid}#fragment`,
    ];
    for (const raw of invalid) {
      expect(parseAiscooAdminAuthorizationCallback(raw, redirectUri), raw).toBeNull();
      expect(() => adapter.parseCallback(raw), raw).toThrow("XCODE_AUTH_REQUEST_INVALID");
    }
  });

  it("rejects non-string injected redirects instead of silently selecting a channel", () => {
    for (const value of [null, false, 0, {}, []]) {
      const redirectUri = value as unknown as string;
      expect(parseAiscooAdminAuthorizationCallback(callback(redirects[1]), redirectUri)).toBeNull();
      expect(() => new AiscooAdminClient(origin, { redirectUri })).toThrow(
        "XCODE_AUTH_REQUEST_INVALID",
      );
    }
  });

  it("rejects any redirect outside the four exact values before sending a request", () => {
    for (const redirectUri of invalidRedirects) {
      expect(parseAiscooAdminAuthorizationCallback(callback(redirectUri), redirectUri)).toBeNull();
      expect(parseAiscooAdminAuthorizationCallback(callback(redirects[1]), redirectUri)).toBeNull();
      expect(
        () =>
          new AiscooAdminClient(origin, {
            redirectUri,
            fetch: async () => {
              throw new Error("Invalid redirect must fail before network IO");
            },
          }),
        redirectUri,
      ).toThrow("XCODE_AUTH_REQUEST_INVALID");
    }
  });
});
