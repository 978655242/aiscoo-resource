// 真实 Host/HTTP/账号 bridge 与回环 Native 假后端；只使用本次测试创建的合成会话。
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";

function gate() {
  let blocked;
  let release;
  let matches = () => true;
  const entered = [];
  return {
    entered,
    hold(predicate = () => true) {
      assert.equal(blocked, undefined, "release the previous fixture gate first");
      matches = predicate;
      blocked = new Promise((done) => {
        release = done;
      });
    },
    async wait(entry) {
      entered.push(entry);
      if (blocked && matches(entry)) await blocked;
    },
    release() {
      release?.();
      blocked = undefined;
      release = undefined;
    },
  };
}

export async function createNativeFixture(browserOrigin) {
  const { catalog, entitlements } =
    await import("../../../../../services/test/aiscooAdminRegistryFixtures.ts");
  const users = {
    42: { id: "42", username: "browser-e2e-a", display_name: "Browser E2E A", avatar_url: null },
    84: { id: "84", username: "browser-e2e-c", display_name: "Browser E2E C", avatar_url: null },
  };
  const counts = {
    authorize: 0,
    exchange: 0,
    me: 0,
    models: 0,
    refresh: 0,
    logout: 0,
    inference: 0,
  };
  const errors = [];
  const requests = [];
  const authorizations = [];
  const sessions = new Map();
  const byAccess = new Map();
  const proofs = new Map();
  const gates = { authorize: gate(), me: gate(), refresh: gate(), logout: gate() };
  const snapshot = () => ({ schema_version: 1, server_time: Date.now() });
  const display = {
    quota_per_unit: "500000",
    display_type: "USD",
    currency: "USD",
    currency_symbol: "$",
    usd_to_currency_rate: null,
  };
  let nextSession = 0;
  function issue(userId = "42") {
    assert.ok(users[userId]);
    const serial = ++nextSession;
    const bundle = {
      ...snapshot(),
      access_token: `synthetic-control-${serial}-0`,
      access_expires_at: Date.now() + 3_600_000,
      refresh_token: `synthetic-refresh-${serial}-0`,
      refresh_expires_at: Date.now() + 86_400_000,
      token_type: "Bearer",
      session_id: `synthetic-session-${serial}`,
      user: users[userId],
      relay_credential: {
        token: `sk-synthetic-relay-${serial}`,
        expires_at: Date.now() + 86_400_000,
      },
    };
    const record = { bundle, serial, rotations: 0, revoked: false };
    sessions.set(bundle.session_id, record);
    byAccess.set(bundle.access_token, record);
    return bundle;
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const send = (data) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ success: true, data }));
    };
    const reject = (code = "XCODE_SESSION_INVALID") => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ success: false, code, message: code, request_id: "synthetic-request" }),
      );
    };
    try {
      let body;
      if (request.method === "POST") {
        let raw = "";
        for await (const chunk of request) raw += chunk;
        body = raw ? JSON.parse(raw) : {};
      }
      if (url.pathname === "/api/xcode/v1/auth/authorize") {
        counts.authorize++;
        assert.equal(url.searchParams.get("client_id"), "xwork-cli");
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        const callback = new URL(url.searchParams.get("redirect_uri"));
        assert.equal(callback.origin, browserOrigin);
        assert.equal(callback.pathname, "/oauth/callback");
        const userId =
          /(?:^|;\s*)aiscoo-e2e-user=(42|84)(?:;|$)/.exec(request.headers.cookie ?? "")?.[1] ??
          "42";
        const code = createHash("sha256")
          .update(`synthetic-code-${counts.authorize}`)
          .digest("base64url");
        const proof = {
          code,
          userId,
          state: url.searchParams.get("state"),
          challenge: url.searchParams.get("code_challenge"),
        };
        proofs.set(code, proof);
        authorizations.push(proof);
        await gates.authorize.wait({ userId, state: proof.state });
        callback.search = new URLSearchParams({ code, state: proof.state, provider: "new-api" });
        response.writeHead(302, { location: callback.href });
        response.end();
        return;
      }
      if (url.pathname === "/api/xcode/v1/auth/token") {
        const proof = proofs.get(body.code);
        assert.ok(proof, "authorization proof is single-use");
        assert.equal(body.client_id, "xwork-cli");
        assert.equal(body.grant_type, "authorization_code");
        assert.equal(body.redirect_uri, `${browserOrigin}/oauth/callback`);
        assert.equal(
          createHash("sha256").update(body.code_verifier).digest("base64url"),
          proof.challenge,
        );
        proofs.delete(body.code);
        counts.exchange++;
        send(issue(proof.userId));
        return;
      }
      if (url.pathname === "/api/xcode/v1/auth/refresh") {
        const record = sessions.get(body.session_id);
        if (!record || record.revoked || record.bundle.refresh_token !== body.refresh_token)
          return reject();
        assert.equal(body.client_id, "xwork-cli");
        counts.refresh++;
        const old = record.bundle;
        const version = ++record.rotations;
        const rotated = {
          ...old,
          ...snapshot(),
          access_token: `synthetic-control-${record.serial}-${version}`,
          refresh_token: `synthetic-refresh-${record.serial}-${version}`,
          access_expires_at: Date.now() + 3_600_000,
        };
        await gates.refresh.wait({ userId: old.user.id, sessionId: old.session_id });
        // 可控晚到成功模拟已经在网络中的轮换响应，注销后不得重新激活其服务端会话。
        if (!record.revoked && record.bundle.refresh_token === old.refresh_token) {
          record.bundle = rotated;
          byAccess.set(rotated.access_token, record);
        }
        send(rotated);
        return;
      }
      if (url.pathname === "/api/xcode/v1/auth/logout") {
        const record = sessions.get(body.session_id);
        if (!record || record.bundle.refresh_token !== body.refresh_token) return reject();
        assert.equal(body.client_id, "xwork-cli");
        counts.logout++;
        record.revoked = true;
        await gates.logout.wait({ userId: record.bundle.user.id, sessionId: body.session_id });
        send({ ...snapshot(), revoked: true });
        return;
      }
      if (url.pathname.startsWith("/v1/")) {
        counts.inference++;
        throw new Error("This regression must never submit model inference");
      }
      if (url.pathname.startsWith("/api/xcode/v1/")) {
        const token = request.headers.authorization?.replace(/^Bearer /, "");
        const record = byAccess.get(token);
        if (!record || record.revoked) return reject();
        if (record.bundle.access_token !== token) return reject("XCODE_ACCESS_EXPIRED");
        const current = record.bundle;
        const entry = {
          path: url.pathname,
          userId: current.user.id,
          sessionId: current.session_id,
        };
        requests.push(entry);
        switch (url.pathname) {
          case "/api/xcode/v1/me": {
            counts.me++;
            const data = {
              ...snapshot(),
              user: current.user,
              session_id: current.session_id,
              authorization_revision: "7",
            };
            await gates.me.wait(entry);
            send(data);
            return;
          }
          case "/api/xcode/v1/entitlements":
            send({
              ...entitlements,
              ...snapshot(),
              subscription: {
                ...entitlements.subscription,
                plan_title: `Assigned ${current.user.id}`,
              },
            });
            return;
          case "/api/xcode/v1/models":
            counts.models++;
            send({
              ...catalog,
              ...snapshot(),
              models: [
                {
                  ...catalog.models[0],
                  api_type: "openai-chat-completions",
                  model_id: current.user.id === "42" ? "real-model" : "c-model",
                },
              ],
            });
            return;
          case "/api/xcode/v1/plans":
            send({
              ...snapshot(),
              purchase_mode: "manual_admin",
              self_service_purchase: false,
              items: [],
            });
            return;
          case "/api/xcode/v1/client-config":
            send({
              ...snapshot(),
              purchase_mode: "manual_admin",
              self_service_purchase: false,
              self_service_reset: false,
              manual_plan_entry_path: "/xcode/plans",
              display,
            });
            return;
          case "/api/xcode/v1/usage":
            send({
              ...snapshot(),
              as_of: Date.now(),
              scope: "xcode",
              source: "synthetic",
              retention_basis: "synthetic",
              time_zone: "UTC",
              range_start_date: "2026-11-02",
              range_end_date: "2026-11-02",
              granularity: "day",
              display,
              summary: {
                consume_record_count: "0",
                prompt_tokens: "0",
                completion_tokens: "0",
                total_tokens: "0",
                charged_quota: "0",
                refunded_quota: "0",
                net_quota: "0",
              },
              buckets: [],
              models: [],
              unsupported_metrics: [],
            });
            return;
          default:
            throw new Error(`Unimplemented Native fixture endpoint: ${url.pathname}`);
        }
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ code: 0, msg: "", data: [] }));
    } catch (error) {
      errors.push(error.message);
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: false, code: "XCODE_BACKEND_UNAVAILABLE" }));
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    counts,
    errors,
    requests,
    authorizations,
    sessions,
    gates,
    issue,
    async close() {
      for (const item of Object.values(gates)) item.release();
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    },
  };
}

async function runHost() {
  const { createServerHostServices, createAiscooAccountPolicy } =
    await import("../../../../../services/src/node.ts");
  const { IModelSelectionService, IOAuthService } =
    await import("../../../../../services/src/index.ts");
  const { Event } = await import("../../../../../rpc/src/index.ts");
  const { ModelConfigRules, ProviderConfigMap, ProviderTemplateMap } =
    await import("../../../../../provider/src/index.ts");
  const { serializeZCodeBuiltinRelease } =
    await import("../../../../../provider-node/src/index.ts");
  const { createHttpServer } = await import("../../../../../server/src/index.ts");
  const { createBrowserAccountBridge, resolveBrowserAccountProfile, BROWSER_ACCOUNT_CHANNEL } =
    await import("../../../../../server/src/aiscoo-browser-account/index.ts");
  const profile = resolveBrowserAccountProfile(process.env);
  if (!profile || !process.env.ZCODE_DATA_BASE_DIR)
    throw new Error("Isolated browser fixture configuration is required");
  const builtinPath = join(process.env.ZCODE_DATA_BASE_DIR, "builtin.json");
  await writeFile(
    builtinPath,
    serializeZCodeBuiltinRelease({
      schemaVersion: 1,
      revision: 1,
      config: {
        providers: ProviderConfigMap.empty(),
        providerTemplates: ProviderTemplateMap.empty(),
        modelConfigRules: ModelConfigRules.empty(),
      },
    }),
  );
  let bridge;
  let hookGate;
  let releaseHook;
  let nextConnection = 0;
  const hookEvents = [];
  const attachments = new Map();
  const accountPolicy = createAiscooAccountPolicy({ adminBaseUrl: profile.origin });
  const { services, workspaceIdentityMapper, migrationFailedPathCount } =
    await createServerHostServices({
      sourceServerId: "aiscoo-browser-connection-e2e",
      zcodeBuiltinProviderConfigFilePath: builtinPath,
      accountPolicy,
      aiscooAdminAccountAuthority: {
        origin: profile.origin,
        create(onOwnerChanged) {
          bridge = createBrowserAccountBridge(profile.origin, {
            async onOwnerChanged(owner) {
              hookEvents.push(owner);
              process.send?.({ type: "owner-hook-start", owner });
              if (owner && hookGate) await hookGate;
              await onOwnerChanged(owner);
              process.send?.({ type: "owner", owner: bridge.authority.getOwner() });
            },
          });
          return bridge.authority;
        },
      },
    });
  process.on("message", async ({ id, command }) => {
    try {
      if (command === "hold-owner-hook")
        hookGate = new Promise((done) => {
          releaseHook = done;
        });
      if (command === "release-owner-hook") {
        releaseHook?.();
        hookGate = undefined;
        releaseHook = undefined;
      }
      const view =
        command === "status" ? await services.get(IModelSelectionService).getView() : undefined;
      process.send?.({
        type: "reply",
        id,
        value: {
          owner: bridge.authority.getOwner(),
          hookEvents,
          attachments: [...attachments.values()],
          catalog: view?.providers
            .flatMap((provider) =>
              provider.models.map((model) => `${provider.providerId}/${model.modelId}`),
            )
            .sort(),
          catalogIssues: view?.catalogIssues,
        },
      });
    } catch (error) {
      process.send?.({ type: "reply", id, error: error.message });
    }
  });
  createHttpServer(services, profile.port, {
    serverId: "aiscoo-browser-connection-e2e",
    host: "127.0.0.1",
    workspaces: [],
    workspaceIdentityMapper,
    migrationFailedPathCount,
    virtualProjects: true,
    acceptRequest: profile.acceptRequest,
    attachBrowserPeer(client) {
      const connectionId = ++nextConnection;
      const state = { connectionId, status: "pending" };
      attachments.set(connectionId, state);
      const observed = {
        getChannel(name) {
          const channel = client.getChannel(name);
          if (name !== BROWSER_ACCOUNT_CHANNEL) return channel;
          return {
            listen: channel.listen.bind(channel),
            call(command, arg) {
              process.send?.({
                type: "reverse-rpc",
                connectionId,
                command,
                method: command === "oauth" ? arg?.method : undefined,
              });
              return channel.call(command, arg);
            },
          };
        },
      };
      let attachment;
      try {
        attachment = bridge.attach(observed);
      } catch (error) {
        state.status = "rejected";
        throw error;
      }
      void attachment.ready.then(
        () => {
          state.status = "ready";
        },
        () => {
          state.status = "rejected";
        },
      );
      // 与 production entry-http 一致：按连接包装 OAuth，并把失效事件映射为原 WS 关闭语义。
      return {
        ready: attachment.ready,
        serviceOverrides: new Map([
          [IOAuthService.channelName, accountPolicy.wrapOAuth(attachment.oauth)],
        ]),
        onDidClose: Event.map(attachment.onDidInvalidate, (reason) => ({
          code: 1008,
          reason: {
            "owner-changed": "Browser account changed",
            "account-mismatch": "Browser account does not match",
            unavailable: "Browser account is unavailable",
          }[reason],
        })),
        dispose() {
          state.status = "closed";
          attachment.dispose();
        },
      };
    },
  });
}
if (process.argv.includes("--host")) await runHost();
