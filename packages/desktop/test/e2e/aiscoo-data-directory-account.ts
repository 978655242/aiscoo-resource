import { createHmac } from "node:crypto";
import { createServer } from "node:http";
import { AiscooAdminSessionRepo } from "@zcode/services/node";
import type { AiscooAdminSessionBundle } from "@zcode/shared";

/** 下游目录验收只替换账号 HTTP；真实 Host 仍解密缓存并校验 Me 后才开放工作区。 */
export async function startAiscooDirectoryAccountFixture() {
  const now = Math.floor(Date.now() / 1000) * 1000;
  const expires = now + 24 * 60 * 60 * 1000;
  const user = {
    id: "88421",
    username: "aiscoo-directory-e2e",
    display_name: "Aiscoo Directory E2E",
    avatar_url: null,
  };
  const sessionId = "aiscoo-directory-e2e-session";
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: "new-api",
      aud: ["new-api-xcode"],
      token_use: "xcode_access",
      sub: user.id,
      sid: sessionId,
      exp: expires / 1000,
      uv: 1,
      sv: 1,
      nbf: now / 1000 - 5,
      iat: now / 1000,
      scopes: ["profile:read", "wallet:read", "usage:read"],
    }),
  ).toString("base64url");
  const token = `${header}.${payload}.${createHmac("sha256", "aiscoo-directory-e2e-signing-key").update(`${header}.${payload}`).digest("base64url")}`;
  const bundle: AiscooAdminSessionBundle = {
    schema_version: 1,
    server_time: now,
    access_token: token,
    access_expires_at: expires,
    refresh_token: "aiscoo-directory-e2e-refresh",
    refresh_expires_at: expires,
    token_type: "Bearer",
    session_id: sessionId,
    user,
    relay_credential: { token: "sk-aiscoo-directory-e2e-unused", expires_at: expires },
  };
  const requests: Array<{ method: string; path: string; authorized: boolean }> = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (path === "/__e2e/facts") {
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ requests }));
      return;
    }
    const authorized = request.headers.authorization === `Bearer ${token}`;
    requests.push({ method: request.method ?? "", path, authorized });
    response.setHeader("Content-Type", "application/json");
    if (!authorized) {
      response.writeHead(401);
      response.end(
        JSON.stringify({
          success: false,
          code: "XCODE_SESSION_INVALID",
          message: "Fixture session required",
          request_id: "aiscoo-directory",
        }),
      );
      return;
    }
    const snapshot = { schema_version: 1, server_time: Date.now() };
    const data: Record<string, unknown> = {
      "/api/xcode/v1/me": { ...snapshot, user, session_id: sessionId, authorization_revision: "1" },
      "/api/xcode/v1/plans": {
        ...snapshot,
        purchase_mode: "manual_admin",
        self_service_purchase: false,
        items: [],
      },
      "/api/xcode/v1/entitlements": {
        ...snapshot,
        status: "unassigned",
        authorization_revision: "1",
        subscription: null,
        quota: null,
        funding_policy: {
          subscription_only: true,
          wallet_fallback: false,
          other_subscription_fallback: false,
        },
        self_service_reset: false,
        purchase_mode: "manual_admin",
      },
      "/api/xcode/v1/models": {
        ...snapshot,
        catalog_revision: "directory-1",
        authorization_revision: "1",
        models: [],
      },
      "/api/xcode/v1/client-config": {
        ...snapshot,
        purchase_mode: "manual_admin",
        self_service_purchase: false,
        self_service_reset: false,
        manual_plan_entry_path: "/xcode/plans",
        display: {
          quota_per_unit: "500000",
          display_type: "USD",
          currency: "USD",
          currency_symbol: "$",
          usd_to_currency_rate: "1",
        },
      },
    };
    if (!(path in data)) {
      response.writeHead(404);
      response.end(JSON.stringify({ success: false, message: "Unexpected fixture endpoint" }));
      return;
    }
    response.end(JSON.stringify({ success: true, data: data[path] }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Account fixture did not bind");
  const origin = `http://127.0.0.1:${address.port}`;
  return {
    origin,
    seed: async (credentialsFile: string) => {
      // 复用公开 repository 和现有 enc:v1 cipher；不注入 Renderer/Host 登录投影。
      const repo = new AiscooAdminSessionRepo(origin, { credentialsFile });
      await repo.commit({ schemaVersion: 1, origin, bundle });
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
