import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  resolveOffPeakProviderId,
  projectAccessTokenFingerprint,
  type ApiClient,
  type AiscooAdminOwner,
} from "@zcode/shared";
import { ProviderConfigMap, ProviderConfig, ZhipuAccountAccessConfig } from "@zcode/provider";
import { ProxyChannel } from "@zcode/rpc";
import {
  createOfficialCloudMaterialLoader,
  type OfficialCloudMaterial,
} from "../src/official-mcp/officialCloudCatalog.js";
import {
  createOfficialCloudAccountProviderResolver,
  createOfficialCloudAccountRequestAuthResolver,
} from "../src/official-mcp/officialCloudAccountResolvers.js";
import { resolveOfficialMcpCredentials } from "../src/official-mcp/officialMcpCredentials.js";
import { createOfficialMcpAuthHeadersResolver } from "../src/official-mcp/officialMcpCredentials.js";
import { createOfficialMcpAuthFetch } from "../../../apps/zcode-cli/packages/adapters/src/mcp/official-auth.js";
import { createOfficialMcpAuthHeadersPort } from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/official-mcp-auth-port.js";
import { zcodeOfficialMcpAuthHeadersRequestParamsSchema } from "@zcode/shared";
import {
  buildOffPeakRequestAuth,
  resolveOffPeakCredentials,
} from "../src/session/offPeakRuntimeModel.js";
import { ConversationShareHttpClient } from "../src/conversation-share/conversationShareHttpClient.js";
import { createOffPeakServerClient } from "../src/session/offPeakServerClient.js";
import {
  OFF_PEAK_TASK_OWNER_FENCE,
  OffPeakTaskService,
} from "../src/session/offPeakTaskService.js";
import { OffPeakTaskRepo } from "../src/session/offPeakTaskRepo.js";
import { createServiceLogger } from "../src/logger/serviceLogger.js";
import { createUsageStatsService } from "../src/usage-stats/usageStatsService.js";
import { createCredentialCipherProvider } from "../src/credential/providers/credentialCipherProvider.js";
import {
  createOfficialCloudConnectionHost,
  type OfficialCloudConnectionHost,
} from "../src/official-mcp/officialCloudConnectionService.js";
import type { OAuthProviderAdapter } from "../src/oauth/providers/providerAdapter.js";
import { createNodeApiClient } from "../src/providers/api/nodeApiClient.js";

const ownerA: AiscooAdminOwner = {
  origin: "https://native.example",
  userId: "1",
  sid: "a",
  authGeneration: 1,
};
const ownerB: AiscooAdminOwner = { ...ownerA, userId: "2", sid: "b", authGeneration: 2 };
function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(now?: () => number, apiClient?: ApiClient) {
  const dir = await mkdtemp(join(tmpdir(), "xcode-official-owner-"));
  const credentialsFile = join(dir, "credentials.json");
  const cipherProvider = createCredentialCipherProvider({
    env: { ZCODE_CREDENTIAL_SECRET: randomBytes(32).toString("hex") },
  });
  const legacy = cipherProvider.encrypt("legacy-unowned-secret");
  await writeFile(
    credentialsFile,
    JSON.stringify({
      zcodejwttoken: legacy,
      "oauth:active_provider": cipherProvider.encrypt("bigmodel"),
    }),
  );
  let owner: AiscooAdminOwner | null = ownerA;
  let exchange = async () => ({
    accessToken: "official-business-secret",
    zcodeJwtToken: "official-jwt-secret",
  });
  let loadCloud: () => Promise<OfficialCloudMaterial> = async () => ({
    access: null,
    catalog: { revision: 1, providers: [] },
  });
  const adapter: OAuthProviderAdapter = {
    providerId: "bigmodel",
    meta: { id: "bigmodel", displayName: "BigModel", enabled: true, order: 1 },
    redirectUri: "zcode://oauth/callback",
    apiClient: {
      request: async () => {
        throw new Error("No network in owner test");
      },
    },
    parseCallbackParams: (url) => {
      const u = new URL(url);
      return { state: u.searchParams.get("state")!, code: u.searchParams.get("code")! };
    },
    buildAuthorizeUrl: (context) => `https://open.bigmodel.cn/login?state=${context.state}`,
    exchangeToken: () => exchange(),
    fetchUserInfo: async () => ({
      id: "official-1",
      username: "cloud-user",
      displayName: "Cloud User",
      rawProfile: { access_token: "never-public" },
    }),
    normalizeError: (error) => (error instanceof Error ? error : new Error(String(error))),
  };
  const dependencies = {
    account: {
      getOwner: () => owner,
      isCurrent: (expected: AiscooAdminOwner) => JSON.stringify(expected) === JSON.stringify(owner),
    },
    adapters: [adapter],
    store: { credentialsFile, cipherProvider },
    loadCloud: () => loadCloud(),
    resolveCodingPlanMaterial: async (credentials: { access: OfficialCloudMaterial["access"] }) =>
      credentials.access
        ? {
            token:
              credentials.access.planKind === "team-coding-plan"
                ? "official-team-key"
                : "official-plan-key",
            apiKeyId: "official-key-id",
            organizationId: "official-org",
            projectId: "official-project",
          }
        : null,
    ...(now ? { now } : {}),
    ...(apiClient ? { apiClient, resolveCodingPlanMaterial: undefined } : {}),
  };
  const host = createOfficialCloudConnectionHost(dependencies);
  const callback = (state: string) => `zcode://oauth/callback?state=${state}&code=one-use-code`;
  return {
    host,
    credentialsFile,
    legacy,
    dependencies,
    callback,
    setOwner: (value: AiscooAdminOwner | null) => {
      owner = value;
    },
    setExchange: (value: typeof exchange) => {
      exchange = value;
    },
    setLoadCloud: (value: typeof loadCloud) => {
      loadCloud = value;
    },
    login: async () => {
      const start = await host.service.startOAuth("bigmodel");
      return host.service.handleCallback(callback(start.state));
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

test("official project token refreshes after expiry and rejects late issuance across owner replacement", async (context) => {
  let clock = 1_800_000_000_000;
  context.mock.method(Date, "now", () => clock);
  const arrived = barrier<void>();
  const release = barrier<void>();
  let issues = 0;
  let pause = false;
  const f = await fixture(() => clock, {
    request: async (input, init) => {
      const path = new URL(String(input)).pathname;
      let data: unknown;
      if (path.endsWith("/getCustomerInfo")) {
        data = {
          organizations: [
            {
              organizationId: "official-org",
              projects: [{ projectId: "official-project", projectType: 1 }],
            },
          ],
        };
      } else if (path.endsWith("/api_keys")) {
        data = [{ apiKey: "official-key-id", name: "zcode-api-key" }];
      } else if (path.endsWith("/official-key-id/access_tokens")) {
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer official-business-secret",
        );
        const issue = ++issues;
        if (pause) {
          arrived.resolve();
          await release.promise;
        }
        data = {
          accessToken: `official-pat-${issue}`,
          tokenType: "Bearer",
          expiresIn: 600,
          expiresAt: clock / 1000 + 600,
        };
      } else throw new Error(`Unexpected project token request: ${path}`);
      return new Response(JSON.stringify({ code: 200, data }), {
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const access = {
      type: "zhipu-account",
      family: "bigmodel",
      planKind: "individual-coding-plan",
    } as const;
    f.setLoadCloud(async () => ({ access, catalog: { revision: 1, providers: [] } }));
    await f.login();
    const offPeakProviderId = resolveOffPeakProviderId("bigmodel");
    const projected = await createOfficialCloudAccountProviderResolver(f.host)({
      configRevision: "official",
      configuredProviders: new ProviderConfigMap([
        [
          offPeakProviderId,
          new ProviderConfig({
            visibility: "hidden",
            access: new ZhipuAccountAccessConfig({ accountType: "bigmodel", mode: "off-peak" }),
          }),
        ],
      ]),
      previousProviders: ProviderConfigMap.empty(),
    });
    assert.equal(projected.states[offPeakProviderId]?.availability, "available");
    assert.equal(issues, 0);
    const resolver = createOfficialCloudAccountRequestAuthResolver(f.host);
    const input = {
      providerId: "account:bigmodel-individual-coding-plan",
      accountAccess: access,
      reason: "usage",
    } as const;
    const first = await resolver.resolveCurrent(input);
    assert.equal(first.apiKey, "official-pat-1");
    assert.match(first.accountScope!, /^[a-f0-9]{64}$/);
    clock += 601_000;
    const second = await resolver.resolveCurrent({
      ...input,
      expectedAccountScope: first.accountScope,
    });
    assert.equal(second.apiKey, "official-pat-2");
    assert.equal(second.accountScope, first.accountScope);
    await assert.rejects(
      resolver.resolveCurrent({
        ...input,
        expectedAccountScope: "0".repeat(64),
      }),
      /scope_invalidated/,
    );
    assert.equal(issues, 2);
    const stored = JSON.parse(await readFile(f.credentialsFile, "utf8")) as Record<string, string>;
    for (const value of Object.values(stored))
      assert.equal(
        f.dependencies.store.cipherProvider.decrypt(value).includes("official-pat-"),
        false,
      );
    pause = true;
    const pending = resolver.resolveCurrent({
      ...input,
      expectedAccountScope: first.accountScope,
      rejectedProjectTokenFingerprint: await projectAccessTokenFingerprint(second.apiKey!),
    });
    await arrived.promise;
    f.host.onPrimaryOwnerChanged(ownerB);
    f.setOwner(ownerB);
    release.resolve();
    await assert.rejects(pending, /scope|owner|changed/i);
    pause = false;
    await f.login();
    const replacement = await resolver.resolveCurrent(input);
    assert.equal(replacement.apiKey, "official-pat-4");
    assert.notEqual(replacement.accountScope, first.accountScope);
  } finally {
    release.resolve();
    await f.dispose();
  }
});

for (const failure of ["network", "timeout", 429, 503, 401, 403, "invalid"] as const) {
  test(`official project token early refresh handles ${failure} without losing valid credentials`, async (context) => {
    const start = 1_800_000_000_000;
    let clock = start;
    context.mock.method(Date, "now", () => clock);
    let issues = 0;
    const f = await fixture(
      () => clock,
      createNodeApiClient({
        fetchImpl: async (input) => {
          const path = new URL(String(input)).pathname;
          let data: unknown;
          if (path.endsWith("/getCustomerInfo"))
            data = {
              organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }],
            };
          else if (path.endsWith("/api_keys")) data = [{ apiKey: "key", name: "zcode-api-key" }];
          else if (path.endsWith("/key/access_tokens")) {
            issues++;
            if (issues > 1) {
              if (failure === "network") throw new TypeError("fetch failed");
              if (failure === "timeout") throw new DOMException("timeout", "AbortError");
              if (failure === "invalid") return new Response("invalid JSON");
              return new Response("upstream failure", { status: failure });
            }
            data = {
              accessToken: "valid-pat",
              tokenType: "Bearer",
              expiresIn: 600,
              expiresAt: start / 1000 + 600,
            };
          } else throw new Error(`Unexpected project token request: ${path}`);
          return Response.json({ code: 200, data });
        },
      }),
    );
    try {
      const access = {
        type: "zhipu-account",
        family: "bigmodel",
        planKind: "individual-coding-plan",
      } as const;
      f.setLoadCloud(async () => ({ access, catalog: { revision: 1, providers: [] } }));
      await f.login();
      const resolver = createOfficialCloudAccountRequestAuthResolver(f.host);
      const input = {
        providerId: "account:bigmodel-individual-coding-plan",
        accountAccess: access,
        reason: "usage",
      } as const;
      const first = await resolver.resolveCurrent(input);
      assert.equal(first.apiKey, "valid-pat");
      clock = start + 481_000;
      if (["network", "timeout", 429, 503].includes(failure)) {
        const refreshed = await resolver.resolveCurrent({
          ...input,
          expectedAccountScope: first.accountScope,
        });
        assert.equal(refreshed.apiKey, "valid-pat");
        assert.equal(refreshed.accountScope, first.accountScope);
        assert.equal(issues, 2);
        clock = start + 600_000;
      }
      await assert.rejects(resolver.resolveCurrent(input), /project_token_/);
    } finally {
      await f.dispose();
    }
  });
}

test("official project token HTTP 404 invalidates its location before the next resolution", async (context) => {
  const start = 1_800_000_000_000;
  let clock = start;
  context.mock.method(Date, "now", () => clock);
  let locations = 0;
  const issued: string[] = [];
  const f = await fixture(
    () => clock,
    createNodeApiClient({
      fetchImpl: async (input) => {
        const path = new URL(String(input)).pathname;
        let data: unknown;
        if (path.endsWith("/getCustomerInfo"))
          data = {
            organizations: [{ organizationId: "org", projects: [{ projectId: "project" }] }],
          };
        else if (path.endsWith("/api_keys"))
          data = [
            {
              apiKey: ++locations === 1 ? "deleted-key" : "replacement-key",
              name: "zcode-api-key",
            },
          ];
        else if (path.endsWith("/access_tokens")) {
          const key = path.split("/").at(-2)!;
          issued.push(key);
          if (issued.length > 1 && key === "deleted-key")
            return new Response("not found", { status: 404 });
          data = {
            accessToken: `pat-${key}`,
            tokenType: "Bearer",
            expiresIn: 600,
            expiresAt: clock / 1000 + 600,
          };
        } else throw new Error(`Unexpected project token request: ${path}`);
        return Response.json({ code: 200, data });
      },
    }),
  );
  try {
    const access = {
      type: "zhipu-account",
      family: "bigmodel",
      planKind: "individual-coding-plan",
    } as const;
    f.setLoadCloud(async () => ({ access, catalog: { revision: 1, providers: [] } }));
    await f.login();
    const resolver = createOfficialCloudAccountRequestAuthResolver(f.host);
    const input = {
      providerId: "account:bigmodel-individual-coding-plan",
      accountAccess: access,
      reason: "usage",
    } as const;
    assert.equal((await resolver.resolveCurrent(input)).apiKey, "pat-deleted-key");
    clock = start + 481_000;
    await assert.rejects(resolver.resolveCurrent(input), /project_token_/);
    assert.equal((await resolver.resolveCurrent(input)).apiKey, "pat-replacement-key");
    assert.equal(locations, 2);
    assert.deepEqual(issued, ["deleted-key", "deleted-key", "replacement-key"]);
  } finally {
    await f.dispose();
  }
});

test("legacy official record discards only the stored execution key and preserves login through refresh", async () => {
  const f = await fixture();
  try {
    await f.login();
    const original = await f.host.service.getSnapshot();
    const stored = JSON.parse(await readFile(f.credentialsFile, "utf8")) as Record<string, string>;
    const cipher = f.dependencies.store.cipherProvider;
    for (const [key, encrypted] of Object.entries(stored)) {
      const raw = cipher.decrypt(encrypted);
      if (raw.startsWith("{") && JSON.parse(raw).schemaVersion === 1) {
        stored[key] = cipher.encrypt(
          JSON.stringify({
            ...JSON.parse(raw),
            codingPlanApiKey: "legacy-execution-secret",
          }),
        );
      }
    }
    await writeFile(f.credentialsFile, JSON.stringify(stored));
    assert.deepEqual(await f.host.service.getSnapshot(), original);
    assert.equal((await f.host.resolveCredentials())?.accessToken, "official-business-secret");
    await f.host.service.refresh();
    const refreshed = JSON.parse(await readFile(f.credentialsFile, "utf8")) as Record<
      string,
      string
    >;
    for (const encrypted of Object.values(refreshed))
      assert.equal(cipher.decrypt(encrypted).includes("legacy-execution-secret"), false);
    assert.equal((await f.host.service.getSnapshot()).status, "connected");
    assert.equal((await f.host.resolveCredentials())?.accessToken, "official-business-secret");
  } finally {
    await f.dispose();
  }
});

test("legacy official logout removes the encrypted record and cannot restore it after restart", async () => {
  const f = await fixture();
  try {
    await f.login();
    const stored = JSON.parse(await readFile(f.credentialsFile, "utf8")) as Record<string, string>;
    const cipher = f.dependencies.store.cipherProvider;
    const connectionKeys: string[] = [];
    for (const [key, encrypted] of Object.entries(stored)) {
      if (!key.startsWith("official-cloud:")) continue;
      connectionKeys.push(key);
      const raw = cipher.decrypt(encrypted);
      if (raw.startsWith("{"))
        stored[key] = cipher.encrypt(
          JSON.stringify({
            ...JSON.parse(raw),
            codingPlanApiKey: "legacy-execution-secret",
          }),
        );
    }
    assert.equal(connectionKeys.length, 2);
    await writeFile(f.credentialsFile, JSON.stringify(stored));
    assert.equal((await f.host.service.getSnapshot()).status, "connected");
    await f.host.service.logout();
    assert.equal(await f.host.resolveCredentials(), null);
    const after = JSON.parse(await readFile(f.credentialsFile, "utf8")) as Record<string, string>;
    for (const key of connectionKeys) assert.equal(after[key], undefined);
    assert.equal(after.zcodejwttoken, f.legacy);
    const restarted = createOfficialCloudConnectionHost(f.dependencies);
    assert.equal(await restarted.resolveCredentials(), null);
    assert.notEqual((await restarted.service.getSnapshot()).status, "connected");
  } finally {
    await f.dispose();
  }
});
function officialPort(host: OfficialCloudConnectionHost) {
  const resolver = createOfficialMcpAuthHeadersResolver({ officialCloudHost: host });
  return createOfficialMcpAuthHeadersPort({
    resolveWorkspace: () => ({ workspaceKey: "/tmp/workspace", workspacePath: "/tmp/workspace" }),
    resolveContext: () => ({
      requestClient: async (_method, params, schema) => {
        const request = zcodeOfficialMcpAuthHeadersRequestParamsSchema.parse(params);
        return schema.parse(await resolver.resolveHeaders(request));
      },
    }),
  });
}

// XCODE: 官方连接必须使用项目短期 Token；仅团队账号不能先被个人项目解析拒绝。
for (const family of ["bigmodel", "zai"] as const) {
  for (const team of [false, true]) {
    test(`official ${family} ${team ? "team" : "personal"} material uses project tokens without secret copying`, async () => {
      const requests: string[] = [];
      let rejectToken = false;
      let loginToken = "official-login";
      const loader = createOfficialCloudMaterialLoader({
        apiClient: {
          request: async (input, init) => {
            const url = new URL(String(input));
            requests.push(url.pathname);
            const headers = new Headers(init?.headers);
            let data: unknown;
            if (url.pathname.endsWith("/getCustomerInfo")) {
              assert.equal(headers.get("Authorization"), loginToken);
              data = {
                organizations: [
                  {
                    organizationId: "official-org",
                    projects: [{ projectId: "official-project", projectType: team ? 2 : 1 }],
                  },
                ],
              };
            } else if (url.pathname.endsWith("/querySubscribeDetail")) {
              assert.equal(
                headers.get("Authorization"),
                family === "zai" ? `Bearer ${loginToken}` : loginToken,
              );
              assert.equal(headers.get("bigmodel-organization"), "official-org");
              assert.equal(headers.get("bigmodel-project"), "official-project");
              data = {
                hasSubscription: true,
                status: "EFFECTIVE",
                memberGrantStatus: "VALID",
                productId: "team-coding",
              };
            } else if (url.pathname.endsWith("/api_keys")) {
              assert.equal(
                headers.get("Authorization"),
                !team && family === "zai" ? `Bearer ${loginToken}` : loginToken,
              );
              if (team) {
                assert.equal(headers.get("bigmodel-organization"), "official-org");
                assert.equal(headers.get("bigmodel-project"), "official-project");
              }
              data = [
                {
                  apiKey: "official-key-id",
                  name: team ? "zcode-team-api-key" : "zcode-api-key",
                  ...(team ? { keyType: 2 } : {}),
                },
              ];
            } else if (url.pathname.endsWith("/official-key-id/access_tokens")) {
              assert.equal(init?.method, "POST");
              assert.equal(headers.get("Authorization"), `Bearer ${loginToken}`);
              if (rejectToken) return new Response("disabled", { status: 403 });
              data = {
                accessToken: "official-project-token",
                tokenType: "Bearer",
                expiresIn: 600,
                expiresAt: Date.now() / 1000 + 600,
              };
            } else if (url.pathname.endsWith("/subscription/list")) {
              assert.equal(headers.get("Authorization"), "official-project-token");
              data = [
                {
                  productId: "personal-coding",
                  status: "VALID",
                  inCurrentPeriod: true,
                },
              ];
            } else {
              throw new Error(`Unexpected official request: ${url.pathname}`);
            }
            return new Response(JSON.stringify({ code: 200, data }), {
              headers: { "content-type": "application/json" },
            });
          },
        },
        readModelView: async () => ({ revision: 1, providers: [] }),
      });
      const credentials = { family, accessToken: "official-login", jwt: "official-jwt" };
      const material = await loader(credentials);
      assert.equal(JSON.stringify(material).includes("official-project-token"), false);
      assert.equal(material.access?.planKind, team ? "team-coding-plan" : "individual-coding-plan");
      assert.ok(requests.some((path) => path.endsWith("/official-key-id/access_tokens")));
      if (team) {
        assert.equal(
          requests.some((path) => path.endsWith("/subscription/list")),
          false,
        );
        assert.equal(
          material.access?.planKind === "team-coding-plan" && material.access.projectId,
          "official-project",
        );
      }
      rejectToken = true;
      loginToken = "new-official-login";
      await assert.rejects(loader({ ...credentials, accessToken: "new-official-login" }));
    });
  }
}

// XCODE: 真正的 worker 端口与鉴权 fetch 必须把一次调用锁在原生 owner/官方代际。
for (const status of [401, 200]) {
  test(`official MCP A invocation rejects late ${status} after B connects without B-authenticated retry`, async () => {
    const f = await fixture();
    const arrived = barrier<void>();
    const release = barrier<void>();
    const sent: string[] = [];
    try {
      await f.login();
      const port = officialPort(f.host);
      const authFetch = createOfficialMcpAuthFetch({
        authHeadersPort: port,
        official: { pluginId: "official-plugin", mcpKey: "official-tool" },
        serverName: "official-tool",
        url: "https://official.example/mcp",
        workspacePath: "/tmp/workspace",
        trustedOrigins: { isTrusted: async () => ({ trusted: true }) },
        baseFetch: async (_url, init) => {
          sent.push(new Headers(init?.headers).get("authorization") ?? "");
          arrived.resolve();
          await release.promise;
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { content: [{ type: "text", text: "A result" }] },
            }),
            { status },
          );
        },
      });
      const pending = authFetch("https://official.example/mcp", {
        method: "POST",
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "old-A" },
        }),
      });
      await arrived.promise;
      f.host.onPrimaryOwnerChanged(ownerB);
      f.setOwner(ownerB);
      f.setExchange(async () => ({
        accessToken: "B-business-secret",
        zcodeJwtToken: "B-jwt-secret",
      }));
      await f.login();
      release.resolve();
      await assert.rejects(
        pending,
        (error: unknown) =>
          error instanceof Error && "kind" in error && error.kind === "official_auth_scope_changed",
      );
      assert.deepEqual(sent, ["Bearer official-jwt-secret"]);
    } finally {
      release.resolve();
      await f.dispose();
    }
  });
}

test("official MCP rejects a late streamed A result after the response headers were already accepted", async () => {
  const f = await fixture();
  const arrived = barrier<void>();
  const release = barrier<void>();
  try {
    await f.login();
    const authFetch = createOfficialMcpAuthFetch({
      authHeadersPort: officialPort(f.host),
      official: { pluginId: "official-plugin", mcpKey: "official-tool" },
      serverName: "official-tool",
      url: "https://official.example/mcp",
      workspacePath: "/tmp/workspace",
      trustedOrigins: { isTrusted: async () => ({ trusted: true }) },
      baseFetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              arrived.resolve();
              await release.promise;
              controller.enqueue(new TextEncoder().encode('{"result":"late-A"}'));
              controller.close();
            },
          }),
        ),
    });
    const response = await authFetch("https://official.example/mcp", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
    });
    const pendingBody = response.text();
    await arrived.promise;
    f.host.onPrimaryOwnerChanged(ownerB);
    f.setOwner(ownerB);
    release.resolve();
    await assert.rejects(
      pendingBody,
      (error: unknown) =>
        error instanceof Error && "kind" in error && error.kind === "official_auth_scope_changed",
    );
  } finally {
    release.resolve();
    await f.dispose();
  }
});

test("official scope admission rejects credential rotation and admits anonymous Native only for its captured owner", async () => {
  const f = await fixture();
  try {
    const resolver = createOfficialMcpAuthHeadersResolver({ officialCloudHost: f.host });
    const anonymous = await f.host.captureRequestFence();
    assert.equal(anonymous.token, null);
    assert.equal(await resolver.validateInvocationScope(anonymous.scope), true);
    await f.login();
    assert.equal(await resolver.validateInvocationScope(anonymous.scope), false);
    const captured = await f.host.captureRequestFence();
    assert.equal(await resolver.validateInvocationScope(captured.scope), true);
    await f.host.service.refresh();
    assert.equal(await resolver.validateInvocationScope(captured.scope), false);
    assert.throws(() => captured.assertCurrentSync(), /changed/);
    f.host.onPrimaryOwnerChanged(ownerB);
    f.setOwner(ownerB);
    assert.equal(await resolver.validateInvocationScope(anonymous.scope), false);
    assert.throws(() => anonymous.assertCurrentSync(), /changed/);
  } finally {
    await f.dispose();
  }
});

test("nonprivate official auth keeps its one authenticated 401 retry", async () => {
  const resolver = createOfficialMcpAuthHeadersResolver({
    accountRequestAuthService: { resolveAccessCurrent: async () => null },
    credentialService: {
      load: async (key) =>
        key === "oauth:active_provider"
          ? "bigmodel"
          : key === "zcodejwttoken"
            ? "legacy-jwt"
            : null,
    },
    modelSelectionService: { getView: async () => ({ revision: 1, providers: [] }) },
  });
  const port = createOfficialMcpAuthHeadersPort({
    resolveWorkspace: () => ({ workspaceKey: "/tmp/workspace", workspacePath: "/tmp/workspace" }),
    resolveContext: () => ({
      requestClient: async (_method, params, schema) =>
        schema.parse(
          await resolver.resolveHeaders(
            zcodeOfficialMcpAuthHeadersRequestParamsSchema.parse(params),
          ),
        ),
    }),
  });
  const sent: string[] = [];
  const authFetch = createOfficialMcpAuthFetch({
    authHeadersPort: port,
    official: { pluginId: "official-plugin", mcpKey: "official-tool" },
    serverName: "official-tool",
    url: "https://official.example/mcp",
    workspacePath: "/tmp/workspace",
    trustedOrigins: { isTrusted: async () => ({ trusted: true }) },
    baseFetch: async (_url, init) => {
      sent.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(sent.length === 1 ? "" : '{"result":"legacy-success"}', {
        status: sent.length === 1 ? 401 : 200,
      });
    },
  });
  const response = await authFetch("https://official.example/mcp", {
    method: "POST",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call" }),
  });
  assert.equal(await response.text(), '{"result":"legacy-success"}');
  assert.deepEqual(sent, ["Bearer legacy-jwt", "Bearer legacy-jwt"]);
});

test("official MCP queued invocation scope survives SDK metadata and never leaves the Host/worker boundary", async () => {
  const f = await fixture();
  const requests: { authorization: string | null; body: unknown }[] = [];
  try {
    await f.login();
    const captured = await f.host.captureRequestFence();
    const authFetch = createOfficialMcpAuthFetch({
      authHeadersPort: officialPort(f.host),
      official: { pluginId: "official-plugin", mcpKey: "official-tool" },
      serverName: "official-tool",
      url: "https://official.example/mcp",
      workspacePath: "/tmp/workspace",
      trustedOrigins: { isTrusted: async () => ({ trusted: true }) },
      baseFetch: async (_url, init) => {
        requests.push({
          authorization: new Headers(init?.headers).get("authorization"),
          body: JSON.parse(String(init?.body)),
        });
        return new Response('{"result":"A"}');
      },
    });
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "queued-A",
        arguments: { query: "keep original arguments" },
        _meta: { officialInvocationScope: captured.scope, trace_id: "original-trace" },
      },
    });
    const accepted = await authFetch("https://official.example/mcp", { method: "POST", body });
    assert.equal(await accepted.text(), '{"result":"A"}');
    assert.deepEqual(requests, [
      {
        authorization: "Bearer official-jwt-secret",
        body: {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "queued-A",
            arguments: { query: "keep original arguments" },
            _meta: { trace_id: "original-trace" },
          },
        },
      },
    ]);
    f.host.onPrimaryOwnerChanged(ownerB);
    f.setOwner(ownerB);
    f.setExchange(async () => ({ accessToken: "B-business", zcodeJwtToken: "B-jwt" }));
    await f.login();
    await assert.rejects(
      authFetch("https://official.example/mcp", { method: "POST", body }),
      (error: unknown) =>
        error instanceof Error && "kind" in error && error.kind === "official_auth_scope_changed",
    );
    assert.equal(requests.length, 1);
  } finally {
    await f.dispose();
  }
});

test("unowned official secrets are never adopted; A connection hides from B and recovers only for A", async () => {
  const f = await fixture();
  try {
    assert.equal(await f.host.resolveCredentials(), null);
    assert.deepEqual(await f.host.service.getSnapshot(), {
      status: "disconnected",
      pendingFamily: null,
    });
    await f.login();
    assert.equal((await f.host.service.getSnapshot()).status, "connected");
    f.setOwner(ownerB);
    assert.equal(await f.host.resolveCredentials(), null);
    assert.equal((await f.host.service.getSnapshot()).status, "disconnected");
    f.setOwner(null);
    assert.deepEqual(await f.host.service.getSnapshot(), { status: "locked", pendingFamily: null });
    f.setOwner({ ...ownerA, sid: "a-new", authGeneration: 3 });
    assert.equal((await f.host.service.getSnapshot()).status, "connected");
    assert.equal((await f.host.resolveCredentials())?.jwt, "official-jwt-secret");
    const restarted = createOfficialCloudConnectionHost(f.dependencies);
    assert.equal((await restarted.service.getSnapshot()).status, "connected");
    const raw = await readFile(f.credentialsFile, "utf8");
    assert(!raw.includes("official-jwt-secret"));
    assert.equal(JSON.parse(raw).zcodejwttoken, f.legacy);
  } finally {
    await f.dispose();
  }
});

test("late official callback for A cannot create B connection or publish after A returns", async () => {
  const f = await fixture();
  try {
    const arrived = barrier<void>();
    const token = barrier<{ accessToken: string; zcodeJwtToken: string }>();
    f.setExchange(async () => {
      arrived.resolve();
      return token.promise;
    });
    const start = await f.host.service.startOAuth("bigmodel");
    const pending = f.host.service.handleCallback(f.callback(start.state));
    await arrived.promise;
    f.setOwner(ownerB);
    token.resolve({ accessToken: "late-business", zcodeJwtToken: "late-jwt" });
    assert.equal(await pending, null);
    assert.equal(await f.host.resolveCredentials(), null);
    f.setOwner({ ...ownerA, authGeneration: 3 });
    assert.equal(await f.host.resolveCredentials(), null);
  } finally {
    await f.dispose();
  }
});

test("public projection contains identity and real empty entitlement but no credential or raw profile", async () => {
  const f = await fixture();
  try {
    await f.login();
    const snapshot = await f.host.service.getSnapshot();
    assert.equal(snapshot.status, "connected");
    if (snapshot.status !== "connected") throw new Error("Expected connected");
    assert.equal(snapshot.identity.id, "official-1");
    assert.equal(snapshot.planScope, null);
    assert.deepEqual(snapshot.catalog.providers, []);
    assert(!JSON.stringify(snapshot).includes("secret"));
    assert(!JSON.stringify(snapshot).includes("never-public"));
    for (const field of [
      "owner",
      "origin",
      "userId",
      "sid",
      "authGeneration",
      "accessToken",
      "refreshToken",
      "codingPlanApiKey",
    ]) {
      assert(!JSON.stringify(snapshot).includes(`"${field}"`), `${field} must stay Host-only`);
    }
    const key = snapshot.connectionKey;
    f.setOwner({ ...ownerA, sid: "new-native-session", authGeneration: 20 });
    const next = await f.host.service.getSnapshot();
    assert.equal(next.status, "connected");
    if (next.status === "connected") assert.notEqual(next.connectionKey, key);
    assert.deepEqual(Object.keys(f.host.service).sort(), [
      "getSnapshot",
      "handleCallback",
      "logout",
      "onDidChange",
      "refresh",
      "startOAuth",
    ]);
  } finally {
    await f.dispose();
  }
});

test("late official refresh cannot return data under B or overwrite A credential generation", async () => {
  const f = await fixture();
  try {
    await f.login();
    const before = await f.host.service.getSnapshot();
    const arrived = barrier<void>();
    const cloud = barrier<{
      access: null;
      catalog: { revision: number; providers: never[] };
    }>();
    f.setLoadCloud(async () => {
      arrived.resolve();
      return cloud.promise;
    });
    const pending = f.host.service.refresh();
    await arrived.promise;
    f.setOwner(ownerB);
    cloud.resolve({
      access: null,
      catalog: { revision: 2, providers: [] },
    });
    await assert.rejects(pending, /owner|changed/i);
    assert.equal((await f.host.service.getSnapshot()).status, "disconnected");
    f.setOwner({ ...ownerA, authGeneration: 4 });
    assert.deepEqual((await f.host.service.getSnapshot()).status, before.status);
    const after = await f.host.service.getSnapshot();
    if (before.status === "connected" && after.status === "connected") {
      assert.equal(after.credentialGeneration, before.credentialGeneration);
      assert.notEqual(after.catalog.revision, 2);
    }
  } finally {
    await f.dispose();
  }
});

test("primary owner transition hides credentials synchronously before primary publication", async () => {
  const f = await fixture();
  try {
    await f.login();
    const credentials = await f.host.resolveCredentials();
    assert(credentials);
    f.host.onPrimaryOwnerChanged(ownerB);
    assert.equal(await f.host.resolveCredentials(), null);
    assert.equal((await f.host.service.getSnapshot()).status, "locked");
    assert.equal(await f.host.isCurrent(credentials), false);
    f.setOwner(ownerB);
    assert.equal((await f.host.service.getSnapshot()).status, "disconnected");
    const nextA = { ...ownerA, authGeneration: 5 };
    f.host.onPrimaryOwnerChanged(nextA);
    f.setOwner(nextA);
    assert.equal((await f.host.service.getSnapshot()).status, "connected");
  } finally {
    await f.dispose();
  }
});

test("official TPS rejects a late A response and never reuses A TPS for B", async () => {
  const f = await fixture();
  const arrived = barrier<void>();
  const release = barrier<void>();
  let requests = 0;
  try {
    const access = {
      type: "zhipu-account",
      family: "bigmodel",
      planKind: "individual-coding-plan",
    } as const;
    f.setLoadCloud(async () => ({
      access,
      catalog: { revision: 1, providers: [] },
    }));
    await f.login();
    const service = createUsageStatsService({
      officialCloudHost: f.host,
      accountRequestAuthService: createOfficialCloudAccountRequestAuthResolver(f.host),
      apiClient: {
        request: async () => {
          const requestNumber = ++requests;
          if (requestNumber === 2) {
            arrived.resolve();
            await release.promise;
          }
          return new Response(
            JSON.stringify({ code: 200, data: { proMaxDecodeSpeed: [requestNumber * 10] } }),
          );
        },
      },
      zcodeAgentService: {} as never,
    });
    const request = {
      preferredProviderId: "account:bigmodel-individual-coding-plan",
      accountAccess: access,
      timeZone: "UTC",
    };
    assert.equal(await service.getCodingPlanRegularTps!(request), 10);
    const pending = service.getCodingPlanRegularTps!(request);
    await arrived.promise;
    f.host.onPrimaryOwnerChanged(ownerB);
    f.setOwner(ownerB);
    await f.login();
    release.resolve();
    await assert.rejects(pending, /owner|changed/i);
    assert.equal(await service.getCodingPlanRegularTps!(request), 30);
    assert.equal(requests, 3);
  } finally {
    release.resolve();
    await f.dispose();
  }
});

test("official family/scope drives MCP and offpeak, never ordinary Native model auth", async () => {
  const f = await fixture();
  try {
    f.setLoadCloud(async () => ({
      access: {
        type: "zhipu-account",
        family: "bigmodel",
        planKind: "team-coding-plan",
        organizationId: "real-org",
        projectId: "real-project",
        productId: "real-product",
      },
      catalog: { revision: 1, providers: [] },
    }));
    await f.login();
    const publicSnapshot = await f.host.service.getSnapshot();
    assert.equal(publicSnapshot.status, "connected");
    if (publicSnapshot.status === "connected")
      assert.deepEqual(publicSnapshot.planScope, {
        targetType: "TEAM",
        organizationId: "real-org",
        projectId: "real-project",
        productId: "real-product",
      });
    const mcp = await resolveOfficialMcpCredentials({ officialCloudHost: f.host });
    assert(mcp.ok);
    assert.deepEqual(mcp.snapshot.wireScope, {
      targetType: "TEAM",
      organizationId: "real-org",
      projectId: "real-project",
    });
    assert.equal(mcp.snapshot.codingPlanAuthorization, "official-business-secret");
    const offpeak = await resolveOffPeakCredentials({
      officialCloudHost: f.host,
      env: { ZCODE_OFFPEAK_MOCK: "1" },
    });
    assert.equal(offpeak.codingPlanApiKey, "official-team-key");
    assert.equal(offpeak.organizationId, "real-org");
    const workerAuth = buildOffPeakRequestAuth({ credentials: offpeak, ticketId: "ticket" });
    assert(!JSON.stringify(workerAuth).includes("assertCurrent"));
    assert(!JSON.stringify(workerAuth).includes(ownerA.origin));
    const providerId = resolveOffPeakProviderId("bigmodel");
    const access = {
      type: "zhipu-account",
      accountType: "bigmodel",
      mode: "off-peak",
      entitled: true,
    } as const;
    const resolver = createOfficialCloudAccountRequestAuthResolver(f.host);
    await assert.rejects(
      resolver.resolveCurrent({ providerId, accountAccess: access, reason: "model-request" }),
    );
    assert.equal(
      (await resolver.resolveCurrent({ providerId, accountAccess: access, reason: "off-peak" }))
        .apiKey,
      "official-team-key",
    );
    const source = createOfficialCloudAccountProviderResolver(f.host);
    const configuredProviders = new ProviderConfigMap([
      [
        providerId,
        new ProviderConfig({
          visibility: "hidden",
          access: new ZhipuAccountAccessConfig({ accountType: "bigmodel", mode: "off-peak" }),
        }),
      ],
    ]);
    const before = await source({
      configRevision: "official",
      configuredProviders,
      previousProviders: new ProviderConfigMap(),
    });
    assert.equal(before.states[providerId]?.entitled, true);
    f.setOwner(ownerB);
    const after = await source({
      configRevision: "official",
      configuredProviders,
      previousProviders: before.providers,
    });
    assert.equal(after.states[providerId]?.entitled, false);
    assert.deepEqual(await resolveOfficialMcpCredentials({ officialCloudHost: f.host }), {
      ok: false,
      reason: "official_auth_unavailable",
    });
    await assert.rejects(
      resolveOffPeakCredentials({ officialCloudHost: f.host, env: { ZCODE_OFFPEAK_MOCK: "1" } }),
    );
  } finally {
    await f.dispose();
  }
});

test("public anonymous preview sends no Native token and rejects a late owner result", async () => {
  const f = await fixture();
  const received = barrier<void>();
  const release = barrier<void>();
  let authorization: string | undefined;
  const server = createServer(async (request, response) => {
    authorization = request.headers.authorization;
    received.resolve();
    await release.promise;
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Loopback address missing");
    const client = new ConversationShareHttpClient({
      apiClient: { request: (url, init) => fetch(url, init) },
      baseUrl: `http://127.0.0.1:${address.port}`,
      tokenProvider: async () => "Native-token-must-never-be-attached",
      requestAuthProvider: () => f.host.captureRequestFence(),
    });
    const pending = client.getPreview("public-share");
    await received.promise;
    assert.equal(authorization, undefined);
    f.setOwner(ownerB);
    release.resolve();
    await assert.rejects(
      pending,
      (error: unknown) => error instanceof Error && error.message.includes("owner changed"),
    );
    await assert.rejects(
      client.getCapabilities(),
      (error: unknown) =>
        error instanceof Error && error.message.includes("authentication required"),
    );
  } finally {
    release.resolve();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await f.dispose();
  }
});

test("official logout blocks new requests synchronously and removes only its Native owner namespace", async () => {
  const f = await fixture();
  try {
    await f.login();
    const logout = f.host.service.logout();
    assert.equal(await f.host.resolveCredentials(), null);
    await logout;
    assert.equal(
      (await createOfficialCloudConnectionHost(f.dependencies).service.getSnapshot()).status,
      "disconnected",
    );
    await f.login();
    f.setOwner(ownerB);
    await f.host.service.logout();
    f.setOwner(ownerA);
    assert.equal((await f.host.service.getSnapshot()).status, "connected");
  } finally {
    await f.dispose();
  }
});

test("pending official purpose and redirect cannot be confused with primary OAuth or another family", async () => {
  const f = await fixture();
  try {
    const start = await f.host.service.startOAuth("bigmodel");
    assert.equal(start.purpose, "official-cloud");
    assert.equal(
      await f.host.service.handleCallback(`${f.callback(start.state)}&purpose=primary-account`),
      null,
    );
    assert.equal(
      await f.host.service.handleCallback(`${f.callback(start.state)}&provider=zai`),
      null,
    );
    assert.equal(
      await f.host.service.handleCallback(
        `https://attacker.example/oauth/callback?state=${start.state}&code=code`,
      ),
      null,
    );
    assert.equal(await f.host.resolveCredentials(), null);
    const snapshot = await f.host.service.handleCallback(f.callback(start.state));
    assert.equal(snapshot?.status, "connected");
  } finally {
    await f.dispose();
  }
});

test("official pending flow is Host-owned and all service observers see invalidations", async () => {
  const f = await fixture();
  let first = 0;
  let second = 0;
  const a = f.host.service.onDidChange(() => {
    first++;
  });
  const b = f.host.service.onDidChange(() => {
    second++;
  });
  try {
    const start = await f.host.service.startOAuth("bigmodel");
    assert.equal((await f.host.service.getSnapshot()).pendingFamily, "bigmodel");
    assert.equal(first, 1);
    assert.equal(second, 1);
    await f.host.service.handleCallback(f.callback(start.state));
    assert.equal((await f.host.service.getSnapshot()).pendingFamily, null);
    assert(first > 1);
    assert.equal(first, second);
    f.host.onPrimaryOwnerChanged(ownerB);
    assert.equal((await f.host.service.getSnapshot()).status, "locked");
    assert.equal(first, second);
  } finally {
    a.dispose();
    b.dispose();
    await f.dispose();
  }
});

for (const change of ["switch", "unlink", "rotate"] as const) {
  test(`offpeak rejects delayed response after official ${change} and preserves other tasks`, async () => {
    const f = await fixture();
    const dir = await mkdtemp(join(tmpdir(), "xcode-offpeak-fence-"));
    const repo = new OffPeakTaskRepo(join(dir, "tasks.sqlite"));
    const arrived = barrier<void>();
    const release = barrier<void>();
    try {
      f.setLoadCloud(async () => ({
        access: { type: "zhipu-account", family: "bigmodel", planKind: "individual-coding-plan" },
        catalog: { revision: 1, providers: [] },
      }));
      await f.login();
      const modelSelection = {
        providerId: resolveOffPeakProviderId("bigmodel"),
        modelId: "official-model",
      };
      const params = {
        title: "Cloud task",
        prompt: "Run",
        permissionMode: "auto" as const,
        workspacePath: dir,
        modelSelection,
      };
      const existing = await repo.create(params, { offPeakTaskId: "existing-history" });
      const client = createOffPeakServerClient({
        logger: createServiceLogger("offpeak-owner-test"),
        resolveOrigin: () => "https://official.example",
        resolveCredentials: () => resolveOffPeakCredentials({ officialCloudHost: f.host }),
        fetchImpl: async (_url, init) => {
          assert.equal(
            new Headers(init?.headers).get("authorization"),
            "Bearer official-jwt-secret",
          );
          assert.equal(
            new Headers(init?.headers).get("x-coding-plan-api-key"),
            "official-plan-key",
          );
          arrived.resolve();
          await release.promise;
          return new Response(JSON.stringify({ ticket_id: "late-ticket", state: "ready" }));
        },
      });
      let publications = 0;
      const service = new OffPeakTaskService({
        repo,
        client,
        logger: createServiceLogger("offpeak-task-owner-test"),
        resolveCodingPlanSupport: async () => ({
          supported: false,
          reason: "connection_unavailable",
        }),
        resolveTelemetryProviderName: async () => "official.example",
        resolveModelSelection: async () => ({ ok: true, selection: modelSelection }),
        onTasksChanged: () => {
          publications++;
        },
      });
      const pending = service.createTask(params);
      await arrived.promise;
      if (change === "switch") f.setOwner(ownerB);
      else if (change === "unlink") await f.host.service.logout();
      else await f.host.service.refresh();
      release.resolve();
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(publications, 0);
      assert.deepEqual(await repo.list(), [existing]);
      service.disposeAll();
    } finally {
      release.resolve();
      repo.close();
      await rm(dir, { recursive: true, force: true });
      await f.dispose();
    }
  });
}

test("offpeak checks owner after awaited origin before sending any credential", async () => {
  const f = await fixture();
  const arrived = barrier<void>();
  const origin = barrier<string>();
  let sends = 0;
  try {
    f.setLoadCloud(async () => ({
      access: { type: "zhipu-account", family: "bigmodel", planKind: "individual-coding-plan" },
      catalog: { revision: 1, providers: [] },
    }));
    await f.login();
    const client = createOffPeakServerClient({
      logger: createServiceLogger("offpeak-origin-owner-test"),
      resolveCredentials: () => resolveOffPeakCredentials({ officialCloudHost: f.host }),
      resolveOrigin: async () => {
        arrived.resolve();
        return origin.promise;
      },
      fetchImpl: async () => {
        sends++;
        return new Response("{}");
      },
    });
    const pending = client.takeTicket("task");
    await arrived.promise;
    f.setOwner(ownerB);
    origin.resolve("https://official.example");
    await assert.rejects(pending, /owner|generation|changed/i);
    assert.equal(sends, 0);
  } finally {
    origin.resolve("https://official.example");
    await f.dispose();
  }
});

for (const operation of ["sync", "retake", "settle"] as const) {
  test(`offpeak ${operation} cannot write late A ticket state after B login`, async () => {
    const f = await fixture();
    const dir = await mkdtemp(join(tmpdir(), "xcode-offpeak-state-fence-"));
    const repo = new OffPeakTaskRepo(join(dir, "tasks.sqlite"));
    const arrived = barrier<void>();
    const release = barrier<void>();
    try {
      f.setLoadCloud(async () => ({
        access: { type: "zhipu-account", family: "bigmodel", planKind: "individual-coding-plan" },
        catalog: { revision: 1, providers: [] },
      }));
      await f.login();
      const modelSelection = {
        providerId: resolveOffPeakProviderId("bigmodel"),
        modelId: "official-model",
      };
      const params = {
        title: "Existing A task",
        prompt: "Run",
        permissionMode: "auto" as const,
        workspacePath: dir,
        modelSelection,
      };
      const task = await repo.create(params, {
        offPeakTaskId: "account-a-task",
        ownerKey: (await resolveOffPeakCredentials({ officialCloudHost: f.host })).ownerKey,
        ...(operation !== "retake" ? { serverTicketId: "account-a-ticket" } : {}),
      });
      const client = createOffPeakServerClient({
        logger: createServiceLogger("offpeak-state-owner-test"),
        resolveOrigin: () => "https://official.example",
        resolveCredentials: () => resolveOffPeakCredentials({ officialCloudHost: f.host }),
        fetchImpl: async () => {
          arrived.resolve();
          await release.promise;
          const response =
            operation === "sync"
              ? { tickets: [{ ticket_id: "account-a-ticket", state: "ready" }] }
              : { ticket_id: "late-ticket", state: operation === "settle" ? "settled" : "ready" };
          return new Response(JSON.stringify(response));
        },
      });
      if (operation === "settle")
        await repo.markTerminal(task.offPeakTaskId, {
          status: "completed",
          endedAt: 100,
          assertCurrent: await client.captureOwnerFence(),
        });
      const before = await repo.list();
      let publications = 0;
      let wakes = 0;
      const service = new OffPeakTaskService({
        repo,
        client,
        logger: createServiceLogger("offpeak-state-task-test"),
        resolveCodingPlanSupport: async () => ({
          supported: false,
          reason: "connection_unavailable",
        }),
        resolveTelemetryProviderName: async () => "official.example",
        resolveModelSelection: async () => ({ ok: true, selection: modelSelection }),
        onTasksChanged: () => {
          publications++;
        },
        requestSchedulerWake: () => {
          wakes++;
        },
      });
      // XCODE: 上游已禁止轮询自动补号；保留迟到换号回归，改由真实手动 Continue 触发取号。
      if (operation === "retake") {
        await repo.setPaused(task.offPeakTaskId, true, {
          now: 100,
          assertCurrent: await client.captureOwnerFence(),
        });
      }
      const pending =
        operation === "retake" ? service.continueTask(task.offPeakTaskId) : service.runSyncCycle();
      const outcome = Promise.allSettled([pending]);
      await arrived.promise;
      const beforeOperation = operation === "retake" ? await repo.list() : before;
      f.setOwner(ownerB);
      release.resolve();
      await outcome;
      assert.deepEqual(await repo.list(), beforeOperation);
      assert.equal(publications, 0);
      assert.equal(wakes, 0);
      service.disposeAll();
    } finally {
      release.resolve();
      repo.close();
      await rm(dir, { recursive: true, force: true });
      await f.dispose();
    }
  });
}

test("offpeak publication fence survives the async gap between ticket response and SQL commit", async () => {
  const f = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "xcode-offpeak-commit-fence-"));
  const repo = new OffPeakTaskRepo(join(dir, "tasks.sqlite"));
  const arrived = barrier<void>();
  const release = barrier<void>();
  try {
    f.setLoadCloud(async () => ({
      access: { type: "zhipu-account", family: "bigmodel", planKind: "individual-coding-plan" },
      catalog: { revision: 1, providers: [] },
    }));
    await f.login();
    const modelSelection = {
      providerId: resolveOffPeakProviderId("bigmodel"),
      modelId: "official-model",
    };
    const create = repo.create.bind(repo);
    repo.create = async (...args) => {
      arrived.resolve();
      await release.promise;
      return create(...args);
    };
    const client = createOffPeakServerClient({
      logger: createServiceLogger("offpeak-commit-owner-test"),
      resolveOrigin: () => "https://official.example",
      resolveCredentials: () => resolveOffPeakCredentials({ officialCloudHost: f.host }),
      fetchImpl: async () => new Response(JSON.stringify({ ticket_id: "ticket", state: "ready" })),
    });
    let publications = 0;
    const service = new OffPeakTaskService({
      repo,
      client,
      logger: createServiceLogger("offpeak-commit-task-test"),
      resolveCodingPlanSupport: async () => ({
        supported: false,
        reason: "connection_unavailable",
      }),
      resolveTelemetryProviderName: async () => "official.example",
      resolveModelSelection: async () => ({ ok: true, selection: modelSelection }),
      onTasksChanged: () => {
        publications++;
      },
    });
    const pending = service.createTask({
      title: "A task",
      prompt: "Run",
      permissionMode: "auto",
      workspacePath: dir,
      modelSelection,
    });
    await arrived.promise;
    await f.host.service.refresh();
    release.resolve();
    assert.equal((await pending).ok, false);
    assert.deepEqual(await repo.list(), []);
    assert.equal(publications, 0);
    service.disposeAll();
  } finally {
    release.resolve();
    repo.close();
    await rm(dir, { recursive: true, force: true });
    await f.dispose();
  }
});

test("offpeak client rejects a stale result even when the response body was still awaiting", async () => {
  const f = await fixture();
  const arrived = barrier<void>();
  const release = barrier<void>();
  try {
    f.setLoadCloud(async () => ({
      access: { type: "zhipu-account", family: "bigmodel", planKind: "individual-coding-plan" },
      catalog: { revision: 1, providers: [] },
    }));
    await f.login();
    const client = createOffPeakServerClient({
      logger: createServiceLogger("offpeak-body-owner-test"),
      resolveOrigin: () => "https://official.example",
      resolveCredentials: () => resolveOffPeakCredentials({ officialCloudHost: f.host }),
      fetchImpl: async () => {
        const response = new Response("{}");
        response.text = async () => {
          arrived.resolve();
          await release.promise;
          return JSON.stringify({ ticket_id: "late-ticket", state: "ready" });
        };
        return response;
      },
    });
    const pending = client.takeTicket("task");
    await arrived.promise;
    await f.host.service.logout();
    release.resolve();
    await assert.rejects(pending, /changed/i);
  } finally {
    release.resolve();
    await f.dispose();
  }
});

test("official isCurrent rejects an owner change after asynchronous credential resolution accepted A", async () => {
  const f = await fixture();
  try {
    await f.login();
    const credentials = await f.host.resolveCredentials();
    assert(credentials);
    const check = f.dependencies.account.isCurrent;
    let checks = 0;
    f.dependencies.account.isCurrent = (expected) => {
      const accepted = check(expected);
      if (++checks === 4) queueMicrotask(() => f.setOwner(ownerB));
      return accepted;
    };
    assert.equal(await f.host.isCurrent(credentials), false);
  } finally {
    await f.dispose();
  }
});

for (const legacy of [false, true]) {
  test(`offpeak durable owner rejects B continuation and sync of ${legacy ? "legacy orphan" : "A persisted task"}, permits only bound A reconnect`, async () => {
    const f = await fixture();
    const dir = await mkdtemp(join(tmpdir(), "xcode-offpeak-durable-owner-"));
    const repo = new OffPeakTaskRepo(join(dir, "tasks.sqlite"));
    let requests = 0;
    let publications = 0;
    let wakes = 0;
    try {
      f.setLoadCloud(async () => ({
        access: { type: "zhipu-account", family: "bigmodel", planKind: "individual-coding-plan" },
        catalog: { revision: 1, providers: [] },
      }));
      await f.login();
      const modelSelection = {
        providerId: resolveOffPeakProviderId("bigmodel"),
        modelId: "official-model",
      };
      const params = {
        title: "Persisted A task",
        prompt: "Run",
        permissionMode: "auto" as const,
        workspacePath: dir,
        modelSelection,
      };
      const client = createOffPeakServerClient({
        logger: createServiceLogger("offpeak-durable-owner-test"),
        resolveOrigin: () => "https://official.example",
        resolveCredentials: () => resolveOffPeakCredentials({ officialCloudHost: f.host }),
        fetchImpl: async (url) => {
          requests++;
          return new Response(
            JSON.stringify(
              String(url).endsWith("/status")
                ? { tickets: [{ ticket_id: "old-ticket", state: "not_found" }] }
                : { ticket_id: "old-ticket", state: "ready" },
            ),
          );
        },
      });
      const service = new OffPeakTaskService({
        repo,
        client,
        logger: createServiceLogger("offpeak-durable-task-test"),
        resolveCodingPlanSupport: async () => ({
          supported: false,
          reason: "connection_unavailable",
        }),
        resolveTelemetryProviderName: async () => "official.example",
        resolveModelSelection: async () => ({ ok: true, selection: modelSelection }),
        onTasksChanged: () => {
          publications++;
        },
        requestSchedulerWake: () => {
          wakes++;
        },
      });
      const created = legacy
        ? await repo.create(params, { serverTicketId: "old-ticket" })
        : await service.createTask(params);
      const task = "ok" in created ? (assert(created.ok), created.task) : created;
      const channel = ProxyChannel.fromService(service);
      assert.throws(
        () => channel.call(undefined, "captureTaskOwnerFence", [task.offPeakTaskId]),
        /Method not found/,
      );
      assert.throws(
        () => channel.call(undefined, "offPeakTaskOwnerFence", [task.offPeakTaskId]),
        /Method not found/,
      );
      if (!legacy) await (await service[OFF_PEAK_TASK_OWNER_FENCE](task.offPeakTaskId))();
      await repo.setPaused(task.offPeakTaskId, true);
      const before = await repo.list();
      requests = publications = wakes = 0;
      f.host.onPrimaryOwnerChanged(ownerB);
      f.setOwner(ownerB);
      await f.login();
      if (!legacy) {
        await assert.rejects(service.cancelTask(task.offPeakTaskId), /owner|changed/i);
        await assert.rejects(
          service.updateTask(task.offPeakTaskId, { prompt: "B must not replace A" }),
          /owner|changed/i,
        );
        await assert.rejects(service.deleteTask(task.offPeakTaskId), /owner|changed/i);
      }
      await assert.rejects(service.continueTask(task.offPeakTaskId), /owner|changed/i);
      await service.runSyncCycle();
      assert.equal(requests, 0);
      assert.deepEqual(await repo.list(), before);
      assert.equal(publications, 0);
      assert.equal(wakes, 0);
      const reconnectedA = { ...ownerA, sid: "reconnected", authGeneration: 7 };
      f.host.onPrimaryOwnerChanged(reconnectedA);
      f.setOwner(reconnectedA);
      await f.login();
      if (legacy) await assert.rejects(service.continueTask(task.offPeakTaskId), /owner|changed/i);
      else {
        assert.equal((await service.continueTask(task.offPeakTaskId))?.status, "queued");
        assert.equal(requests, 2);
        assert.equal(wakes, 1);
      }
      service.disposeAll();
    } finally {
      repo.close();
      await rm(dir, { recursive: true, force: true });
      await f.dispose();
    }
  });
}

test("offpeak real readiness admission rejects owner invalidation queued after async fence acceptance before INSERT", async () => {
  const f = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "xcode-offpeak-ready-owner-"));
  const repo = new OffPeakTaskRepo(join(dir, "tasks.sqlite"));
  const arrived = barrier<void>();
  const release = barrier<void>();
  try {
    f.setLoadCloud(async () => ({
      access: { type: "zhipu-account", family: "bigmodel", planKind: "individual-coding-plan" },
      catalog: { revision: 1, providers: [] },
    }));
    await f.login();
    const modelSelection = {
      providerId: resolveOffPeakProviderId("bigmodel"),
      modelId: "official-model",
    };
    const client = createOffPeakServerClient({
      logger: createServiceLogger("offpeak-ready-owner-test"),
      resolveOrigin: () => "https://official.example",
      resolveCredentials: () => resolveOffPeakCredentials({ officialCloudHost: f.host }),
      fetchImpl: async () => new Response(JSON.stringify({ ticket_id: "ticket", state: "ready" })),
    });
    let sqlAdmission = false;
    const ready = repo.ensureReady.bind(repo);
    repo.ensureReady = async () => {
      await ready();
      if (!sqlAdmission) return;
      arrived.resolve();
      await release.promise;
    };
    const capture = client.captureOwnerFence.bind(client);
    client.captureOwnerFence = async () => {
      const fence = await capture();
      return Object.assign(async () => {
        await fence();
        if (sqlAdmission) queueMicrotask(() => f.setOwner(ownerB));
      }, fence);
    };
    const create = repo.create.bind(repo);
    repo.create = (...args) => {
      sqlAdmission = true;
      return create(...args);
    };
    let publications = 0;
    const service = new OffPeakTaskService({
      repo,
      client,
      logger: createServiceLogger("offpeak-ready-task-test"),
      resolveCodingPlanSupport: async () => ({
        supported: false,
        reason: "connection_unavailable",
      }),
      resolveTelemetryProviderName: async () => "official.example",
      resolveModelSelection: async () => ({ ok: true, selection: modelSelection }),
      onTasksChanged: () => {
        publications++;
      },
    });
    const pending = service.createTask({
      title: "A task",
      prompt: "Run",
      permissionMode: "auto",
      workspacePath: dir,
      modelSelection,
    });
    await arrived.promise;
    release.resolve();
    assert.equal((await pending).ok, false);
    sqlAdmission = false;
    assert.deepEqual(await repo.list(), []);
    assert.equal(publications, 0);
    service.disposeAll();
  } finally {
    release.resolve();
    repo.close();
    await rm(dir, { recursive: true, force: true });
    await f.dispose();
  }
});

for (const operation of [
  "snapshot",
  "continue",
  "requeue",
  "settle",
  "dispatch-failed",
  "release",
] as const) {
  test(`offpeak ${operation} SQL rejects invalidation queued after async owner fence acceptance`, async () => {
    const f = await fixture();
    const dir = await mkdtemp(join(tmpdir(), "xcode-offpeak-sql-owner-"));
    const repo = new OffPeakTaskRepo(join(dir, "tasks.sqlite"));
    try {
      f.setLoadCloud(async () => ({
        access: { type: "zhipu-account", family: "bigmodel", planKind: "individual-coding-plan" },
        catalog: { revision: 1, providers: [] },
      }));
      await f.login();
      const params = {
        title: "A task",
        prompt: "Run",
        permissionMode: "auto" as const,
        workspacePath: dir,
        modelSelection: {
          providerId: resolveOffPeakProviderId("bigmodel"),
          modelId: "official-model",
        },
      };
      const client = createOffPeakServerClient({
        logger: createServiceLogger("offpeak-sql-owner-test"),
        resolveOrigin: () => "https://official.example",
        resolveCredentials: () => resolveOffPeakCredentials({ officialCloudHost: f.host }),
      });
      const captured = await client.captureOwnerFence();
      const task = await repo.create(params, { ownerKey: captured.ownerKey });
      if (operation === "continue") await repo.setPaused(task.offPeakTaskId, true);
      if (operation === "requeue")
        await repo.markRunning(task.offPeakTaskId, { startedAt: 1, assertCurrent: captured });
      if (operation === "settle")
        await repo.markTerminal(task.offPeakTaskId, {
          status: "completed",
          endedAt: 2,
          assertCurrent: captured,
        });
      if (operation === "release") {
        await repo.updateSchedulingSnapshot(task.offPeakTaskId, {
          schedulable: true,
          assertCurrent: captured,
        });
        await repo.claimDue(Date.now(), captured);
      }
      const before = await repo.list();
      const assertCurrent = Object.assign(async () => {
        await captured();
        queueMicrotask(() => f.setOwner(ownerB));
      }, captured);
      const pending =
        operation === "snapshot"
          ? repo.updateSchedulingSnapshot(task.offPeakTaskId, { schedulable: true, assertCurrent })
          : operation === "continue"
            ? repo.setPaused(task.offPeakTaskId, false, { assertCurrent })
            : operation === "requeue"
              ? repo.requeueForContinuation(task.offPeakTaskId, { assertCurrent })
              : operation === "dispatch-failed"
                ? repo.markTerminal(task.offPeakTaskId, {
                    status: "failed",
                    endedAt: 3,
                    assertCurrent,
                  })
                : operation === "release"
                  ? repo.releaseClaim(task.offPeakTaskId, {
                      error: "late A failure",
                      assertCurrent,
                    })
                  : repo.markSettled(task.offPeakTaskId, 3, assertCurrent);
      await assert.rejects(pending, /owner|changed/i);
      assert.deepEqual(await repo.list(), before);
    } finally {
      repo.close();
      await rm(dir, { recursive: true, force: true });
      await f.dispose();
    }
  });
}

test("offpeak Native scheduler claims only durable current-owner tasks and preserves legacy local scheduling", async () => {
  const f = await fixture();
  const dir = await mkdtemp(join(tmpdir(), "xcode-offpeak-claim-owner-"));
  const client = createOffPeakServerClient({
    logger: createServiceLogger("offpeak-claim-owner-test"),
    resolveOrigin: () => "https://official.example",
    resolveCredentials: () => resolveOffPeakCredentials({ officialCloudHost: f.host }),
    fetchImpl: async () => new Response(JSON.stringify({ ticket_id: "ticket", state: "ready" })),
  });
  const repo = new OffPeakTaskRepo(join(dir, "tasks.sqlite"), 5000, () =>
    client.captureOwnerFence(),
  );
  try {
    f.setLoadCloud(async () => ({
      access: { type: "zhipu-account", family: "bigmodel", planKind: "individual-coding-plan" },
      catalog: { revision: 1, providers: [] },
    }));
    await f.login();
    const modelSelection = {
      providerId: resolveOffPeakProviderId("bigmodel"),
      modelId: "official-model",
    };
    const params = {
      title: "Owned task",
      prompt: "Run",
      permissionMode: "auto" as const,
      workspacePath: dir,
      modelSelection,
    };
    const service = new OffPeakTaskService({
      repo,
      client,
      logger: createServiceLogger("offpeak-claim-task-test"),
      resolveCodingPlanSupport: async () => ({
        supported: false,
        reason: "connection_unavailable",
      }),
      resolveTelemetryProviderName: async () => "official.example",
      resolveModelSelection: async () => ({ ok: true, selection: modelSelection }),
    });
    const created = await service.createTask(params);
    assert(created.ok);
    const orphan = await repo.create(params, { schedulable: true });
    f.host.onPrimaryOwnerChanged(ownerB);
    f.setOwner(ownerB);
    await f.login();
    assert.deepEqual(await repo.claimDue(Date.now()), []);
    await assert.rejects(
      repo.markRunning(created.task.offPeakTaskId, { startedAt: 1 }),
      /owner|changed/i,
    );
    const nextA = { ...ownerA, sid: "reconnected", authGeneration: 9 };
    f.host.onPrimaryOwnerChanged(nextA);
    f.setOwner(nextA);
    await f.login();
    assert.deepEqual(
      (await repo.claimDue(Date.now())).map((task) => task.offPeakTaskId),
      [created.task.offPeakTaskId],
    );
    const legacyRepo = new OffPeakTaskRepo(join(dir, "tasks.sqlite"));
    try {
      assert.deepEqual(
        (await legacyRepo.claimDue(Date.now())).map((task) => task.offPeakTaskId),
        [orphan.offPeakTaskId],
      );
    } finally {
      legacyRepo.close();
    }
    service.disposeAll();
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
    await f.dispose();
  }
});

test("official isCurrent rejects credential expiration queued after async resolution accepted its snapshot", async () => {
  let now = 1_000;
  const f = await fixture(() => now);
  try {
    const payload = Buffer.from(JSON.stringify({ exp: 60 })).toString("base64url");
    f.setExchange(async () => ({
      accessToken: "official-access",
      zcodeJwtToken: `e30.${payload}.signature`,
    }));
    await f.login();
    const credentials = await f.host.resolveCredentials();
    assert(credentials);
    const check = f.dependencies.account.isCurrent;
    let checks = 0;
    f.dependencies.account.isCurrent = (expected) => {
      const accepted = check(expected);
      if (++checks === 4)
        queueMicrotask(() => {
          now = 70_000;
        });
      return accepted;
    };
    assert.equal(await f.host.isCurrent(credentials), false);
  } finally {
    await f.dispose();
  }
});

for (const change of ["official-account", "team-scope", "family"] as const) {
  test(`offpeak durable row rejects ${change} replacement for the same Native principal without charging or publishing`, async () => {
    const f = await fixture();
    const dir = await mkdtemp(join(tmpdir(), "xcode-offpeak-cloud-principal-"));
    const repo = new OffPeakTaskRepo(join(dir, "tasks.sqlite"));
    let requests = 0;
    let publications = 0;
    try {
      f.setLoadCloud(async () => ({
        access: { type: "zhipu-account", family: "bigmodel", planKind: "individual-coding-plan" },
        catalog: { revision: 1, providers: [] },
      }));
      await f.login();
      const modelSelection = {
        providerId: resolveOffPeakProviderId("bigmodel"),
        modelId: "official-model",
      };
      const client = createOffPeakServerClient({
        logger: createServiceLogger("offpeak-cloud-principal-test"),
        resolveOrigin: () => "https://official.example",
        resolveCredentials: () => resolveOffPeakCredentials({ officialCloudHost: f.host }),
        fetchImpl: async () => {
          requests++;
          return new Response(JSON.stringify({ ticket_id: "ticket", state: "ready" }));
        },
      });
      const service = new OffPeakTaskService({
        repo,
        client,
        logger: createServiceLogger("offpeak-cloud-principal-task-test"),
        resolveCodingPlanSupport: async () => ({
          supported: false,
          reason: "connection_unavailable",
        }),
        resolveTelemetryProviderName: async () => "official.example",
        resolveModelSelection: async () => ({ ok: true, selection: modelSelection }),
        onTasksChanged: () => {
          publications++;
        },
      });
      const created = await service.createTask({
        title: "Original cloud owner",
        prompt: "Run",
        permissionMode: "auto",
        workspacePath: dir,
        modelSelection,
      });
      assert(created.ok);
      assert.equal("ownerKey" in created.task, false);
      assert.equal("native_owner_key" in created.task, false);
      await repo.setPaused(created.task.offPeakTaskId, true);
      const before = await repo.list();
      requests = publications = 0;
      if (change === "official-account") {
        f.dependencies.adapters[0]!.fetchUserInfo = async () => ({
          id: "official-other",
          username: "other",
          displayName: "Other",
        });
      } else if (change === "team-scope") {
        f.setLoadCloud(async () => ({
          access: {
            type: "zhipu-account",
            family: "bigmodel",
            planKind: "team-coding-plan",
            organizationId: "team",
            projectId: "project",
            productId: "product",
          },
          catalog: { revision: 1, providers: [] },
        }));
      } else {
        f.dependencies.adapters.push({
          ...f.dependencies.adapters[0]!,
          providerId: "zai",
          meta: { id: "zai", displayName: "ZAI", enabled: true, order: 2 },
        });
        f.setLoadCloud(async () => ({
          access: { type: "zhipu-account", family: "zai", planKind: "individual-coding-plan" },
          catalog: { revision: 1, providers: [] },
        }));
      }
      if (change === "family") {
        const start = await f.host.service.startOAuth("zai");
        await f.host.service.handleCallback(f.callback(start.state));
      } else await f.login();
      await assert.rejects(service.continueTask(created.task.offPeakTaskId), /owner|changed/i);
      await service.runSyncCycle();
      assert.equal(requests, 0);
      assert.equal(publications, 0);
      assert.deepEqual(await repo.list(), before);
      service.disposeAll();
    } finally {
      repo.close();
      await rm(dir, { recursive: true, force: true });
      await f.dispose();
    }
  });
}

test("offpeak scheduler multi Host key admission excludes Native orphans and rejects queued lifetime loss before claim SQL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "xcode-offpeak-multi-host-owner-"));
  const path = join(dir, "tasks.sqlite");
  const repo = new OffPeakTaskRepo(path);
  let db: DatabaseSync | undefined;
  try {
    const params = {
      title: "Owned task",
      prompt: "Run",
      permissionMode: "auto" as const,
      workspacePath: dir,
      modelSelection: {
        providerId: resolveOffPeakProviderId("bigmodel"),
        modelId: "official-model",
      },
    };
    const ownerKeys = ["a".repeat(64), "b".repeat(64)];
    const a = await repo.create(params, { ownerKey: ownerKeys[0], schedulable: true });
    const b = await repo.create(params, { ownerKey: ownerKeys[1], schedulable: true });
    await repo.create(params, { schedulable: true });
    db = new DatabaseSync(path);
    const before = db.prepare("SELECT * FROM off_peak_tasks ORDER BY off_peak_task_id").all();
    let current = true;
    const assertCurrentSync = () => {
      if (!current) throw new Error("owner admission changed");
    };
    const stale = Object.assign(
      async () => {
        queueMicrotask(() => {
          current = false;
        });
      },
      { ownerKeys, assertCurrentSync },
    );
    await assert.rejects(repo.claimDue(Date.now(), stale), /owner admission changed/);
    assert.deepEqual(
      db.prepare("SELECT * FROM off_peak_tasks ORDER BY off_peak_task_id").all(),
      before,
    );
    current = true;
    const admitted = Object.assign(
      async () => {
        assertCurrentSync();
      },
      { ownerKeys, assertCurrentSync },
    );
    const claimed = await repo.claimDue(Date.now(), admitted);
    assert.deepEqual(
      new Set(claimed.map((task) => task.offPeakTaskId)),
      new Set([a.offPeakTaskId, b.offPeakTaskId]),
    );
    await repo.releaseClaim(a.offPeakTaskId);
    await repo.releaseClaim(b.offPeakTaskId);
    const locked = Object.assign(async () => {}, { ownerKeys: [] as string[], assertCurrentSync });
    assert.deepEqual(await repo.claimDue(Date.now(), locked), []);
  } finally {
    db?.close();
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("official credentials captured while refresh is awaiting lose synchronous admission at credential commit", async () => {
  const f = await fixture();
  const arrived = barrier<void>();
  const release = barrier<void>();
  try {
    await f.login();
    f.setLoadCloud(async () => {
      arrived.resolve();
      await release.promise;
      return { access: null, catalog: { revision: 2, providers: [] } };
    });
    const refreshing = f.host.service.refresh();
    await arrived.promise;
    const captured = await f.host.resolveCredentials();
    assert(captured?.assertCurrentSync);
    captured.assertCurrentSync();
    release.resolve();
    await refreshing;
    assert.throws(() => captured.assertCurrentSync!(), /owner|generation|changed/i);
    assert.equal(await f.host.isCurrent(captured), false);
  } finally {
    release.resolve();
    await f.dispose();
  }
});
