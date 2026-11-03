import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import { Socket } from "node:net";
import { randomBytes } from "node:crypto";
import {
  IOAuthService,
  IOfficialCloudConnectionService,
  IUsageStatsService,
  ICodingPlanSubscriptionService,
  IOffPeakTaskService,
  ICredentialService,
  IModelSelectionService,
  IProviderSettingsService,
} from "../src/index.js";
import type { LocalCredentialService } from "../src/credential/credentialService.js";

const configError = /AISCOO_ACCOUNT_CONFIG_UNAVAILABLE/;
const loginError = /AISCOO_ACCOUNT_LOGIN_UNSUPPORTED/;

for (const adminBaseUrl of [undefined, "", "  ", "http://untrusted.example", "not-an-origin"]) {
  test(`Aiscoo Host fails closed for ${JSON.stringify(adminBaseUrl)} with historical credentials`, async () => {
    const home = await mkdtemp(join(tmpdir(), "aiscoo-only-host-"));
    const savedEnv = { ...process.env };
    Object.assign(process.env, {
      HOME: home,
      USERPROFILE: home,
      ZCODE_DATA_BASE_DIR: home,
      ZCODE_DESKTOP_HOME_DIR: home,
      ZCODE_SETTINGS_FILE_PATH: join(home, ".zcode", "v2", "setting.json"),
    });
    delete process.env.AISCOO_ADMIN_BASE_URL;
    mock.method(Socket.prototype, "connect", () => {
      throw new Error("Network is forbidden");
    });
    mock.method(globalThis, "fetch", async () => {
      throw new Error("Network is forbidden");
    });
    const { createAiscooAccountPolicy } = await import("../src/aiscoo-account-policy/index.js");
    const {
      createLocalServices,
      disposeServiceResourcesAndWait,
      setDataBaseDir,
      getProviderProvisioningSource,
    } = await import("../src/node.js");
    setDataBaseDir(home);
    // XCODE: 所有旧凭据都在临时 HOME；格式故意不可解密，任何恢复/解密即暴露回退。
    const credentialsFile = join(home, ".zcode", "v2", "credentials.json");
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    const historical = JSON.stringify({
      "oauth:active_provider": "zai",
      "oauth:zai:access_token": "historical-secret-do-not-read",
      "oauth:bigmodel:user_info": "historical-profile-do-not-read",
      zcodejwttoken: "historical-jwt-do-not-read",
      "official-cloud:historical-owner": "historical-connection-do-not-read",
    });
    await writeFile(credentialsFile, historical);
    await writeFile(process.env.ZCODE_SETTINGS_FILE_PATH!, "{}");
    await writeFile(
      join(home, "builtin.json"),
      JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        config: {
          providerConfigRules: { templateRules: [], providerRules: [] },
          modelConfigRules: {
            modelRules: [],
            modelApiRules: [],
            providerSiteRules: [],
            templateModelRules: [],
            builtinProviderModelRules: [],
          },
        },
      }),
    );
    const networkRequests: string[] = [];
    const services = createLocalServices({
      accountPolicy: createAiscooAccountPolicy({ adminBaseUrl }),
      serviceAuthorityMode: "desktop-local",
      zcodeBuiltinProviderConfigFilePath: join(home, "builtin.json"),
      runtimeProcessEnvPatch: { PATH: process.env.PATH ?? "" },
      hostApiNetworkTransport: {
        fetch: async (input) => {
          networkRequests.push(String(input));
          throw new Error("Network is forbidden in this scenario");
        },
        dispose() {},
        async disposeAndWait() {},
      },
      zcodeAgentCommandResolver: () => null,
    });
    try {
      const oauth = services.get(IOAuthService);
      assert.deepEqual(
        (await oauth.getProviders()).map((provider) => provider.id),
        ["new-api"],
      );
      assert.equal(await oauth.getActiveProvider(), null);
      for (const restore of [
        oauth.restoreCachedSession,
        oauth.restoreCachedSessionState,
        oauth.restoreSession,
      ])
        await assert.rejects(restore(), configError);
      await assert.rejects(oauth.startOAuth("new-api"), configError);
      for (const provider of ["zai", "bigmodel"]) {
        await assert.rejects(oauth.startOAuth(provider), loginError);
        await assert.rejects(oauth.startOAuthWithPolling(provider), loginError);
        await assert.rejects(oauth.refreshToken(provider), loginError);
        await assert.rejects(oauth.logout(provider), loginError);
        await assert.rejects(
          oauth.handleCallback(`zcode://oauth/callback?provider=${provider}&state=old&code=old`),
          loginError,
        );
      }
      await assert.rejects(oauth.pollPendingOAuth(), loginError);
      assert.equal(services.getOptional(IOfficialCloudConnectionService), undefined);
      assert.equal(await services.get(ICredentialService).load("zcodejwttoken"), null);
      const view = await services.get(IModelSelectionService).getView();
      assert.ok(view.providers.every((provider) => provider.models.length === 0));
      const provisioned = await getProviderProvisioningSource(services)!.read("isolated-aiscoo");
      assert.deepEqual(provisioned.credentials, []);
      const usage = services.get(IUsageStatsService);
      await assert.rejects(usage.getEntitlementSnapshot(), configError);
      await assert.rejects(
        usage.getSnapshot({ dataSource: "monitor", range: "day" } as never),
        configError,
      );
      const subscription = services.get(ICodingPlanSubscriptionService);
      await assert.rejects(subscription.getStaticProducts(), configError);
      await assert.rejects(
        subscription.getOffPeakClientConfig(),
        /AISCOO_OFFICIAL_CLOUD_UNAVAILABLE/,
      );
      assert.deepEqual(await services.get(IOffPeakTaskService).getCodingPlanSupport(), {
        supported: false,
        reason: "jwt_missing",
      });
      // XCODE: 缺少合法管理端源时只读本地 Built-in，自配模型不受影响且不探测官方源。
      assert.deepEqual(networkRequests, []);
      assert.equal(await readFile(credentialsFile, "utf8"), historical);
    } finally {
      await disposeServiceResourcesAndWait(services);
      mock.restoreAll();
      for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
      Object.assign(process.env, savedEnv);
      await rm(home, { recursive: true, force: true });
    }
  });
}

test("Aiscoo credential policy normalizes retired keys before every backing operation", async () => {
  const { createAiscooAccountPolicy } = await import("../src/aiscoo-account-policy/index.js");
  const calls: string[] = [];
  const service = createAiscooAccountPolicy().wrapCredentials({
    async load(key) {
      calls.push(`load:${key}`);
      return "historical-secret";
    },
    async save(key) {
      calls.push(`save:${key}`);
    },
    async delete(key) {
      calls.push(`delete:${key}`);
    },
    async recoverUnreadable(key) {
      calls.push(`recover:${key}`);
      return "historical-secret";
    },
  });
  for (const key of [
    "zcodejwttoken",
    "oauth:active_provider",
    "oauth:login_attribution",
    "oauth:zai:access_token",
    "oauth:bigmodel:user_info",
    "official-cloud:historical",
  ]) {
    for (const candidate of [key, ` ${key} `, `\t${key}\n`]) {
      assert.equal(await service.load(candidate), null);
      assert.equal(await service.recoverUnreadable(candidate, () => {}), null);
      await assert.rejects(service.save(candidate, "replacement"), loginError);
      await assert.rejects(service.delete(candidate), loginError);
    }
  }
  assert.deepEqual(calls, []);
  assert.equal(await service.load(" mcp-oauth:thirdparty:token "), "historical-secret");
  assert.equal(await service.load(" api-key:bigmodel "), "historical-secret");
  assert.deepEqual(calls, ["load: mcp-oauth:thirdparty:token ", "load: api-key:bigmodel "]);
});

test("Aiscoo policy keeps the existing configured PKCE owner and unrelated credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "aiscoo-policy-valid-"));
  const [
    { createAiscooAccountPolicy },
    { NewApiAccountService },
    { NewApiSessionRepo },
    { NewApiClient },
    { NewApiProviderAdapter },
    { createCredentialCipherProvider },
    { createTelemetryUserIdLoader, createTelemetryAuthorizationLoader },
  ] = await Promise.all([
    import("../src/aiscoo-account-policy/index.js"),
    import("../src/new-api/newApiAccountService.js"),
    import("../src/new-api/newApiSessionRepo.js"),
    import("../src/new-api/newApiClient.js"),
    import("../src/oauth/providers/newApiProviderAdapter.js"),
    import("../src/credential/providers/credentialCipherProvider.js"),
    import("../src/node.js"),
  ]);
  const origin = "https://account.example.com";
  const policy = createAiscooAccountPolicy({ adminBaseUrl: origin });
  const credentialsFile = join(home, "credentials.json");
  const cipherProvider = createCredentialCipherProvider({
    env: { ZCODE_CREDENTIAL_SECRET: randomBytes(32).toString("hex") },
  });
  const client = new NewApiClient(origin, {
    fetch: async () => {
      throw new Error("Network is forbidden");
    },
    redirectUri: "aiscoo-dev://oauth/callback",
  });
  const owner = new NewApiAccountService({
    adapter: new NewApiProviderAdapter(client),
    repo: new NewApiSessionRepo(origin, { credentialsFile, cipherProvider }),
  });
  const oauth = policy.wrapOAuth(owner.oauth);
  try {
    // 策略只包装凭据端口；历史凭据用内存仓储模拟，上游凭据服务无需为测试开放文件路径注入。
    const records = new Map<string, string>();
    const raw: LocalCredentialService = {
      load: async (key) => records.get(key) ?? null,
      save: async (key, value) => void records.set(key, value),
      delete: async (key) => void records.delete(key),
      recoverUnreadable: async (key) => records.get(key) ?? null,
    };
    await raw.save("oauth:active_provider", "zai");
    await raw.save(
      "oauth:zai:user_info",
      JSON.stringify({ id: "old", username: "old", displayName: "old" }),
    );
    await raw.save("zcodejwttoken", "old-jwt");
    const allowed = policy.wrapCredentials(raw);
    assert.equal(await createTelemetryUserIdLoader(allowed)(), "");
    assert.equal(await createTelemetryAuthorizationLoader(allowed)("old"), null);
    for (const key of [
      "mcp-oauth:thirdparty:token",
      "web-remote-control:device",
      "api-key:bigmodel",
    ]) {
      await allowed.save(key, "synthetic-user-credential");
      assert.equal(await allowed.load(key), "synthetic-user-credential");
      await allowed.delete(key);
      assert.equal(await allowed.load(key), null);
    }
    assert.equal(await raw.load("zcodejwttoken"), "old-jwt");
    assert.equal(await oauth.restoreCachedSession(), null);
    for (const provider of ["zai", "bigmodel"])
      await assert.rejects(oauth.startOAuth(provider), loginError);
    const authorization = await oauth.startOAuth("new-api");
    const url = new URL(authorization.authorizeUrl);
    assert.equal(url.origin, origin);
    assert.equal(url.searchParams.get("redirect_uri"), "aiscoo-dev://oauth/callback");
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    assert.match(url.searchParams.get("code_challenge")!, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(owner.getOwner(), null);
    await oauth.cancelPending("new-api");
    assert.equal(
      await oauth.handleCallback(
        `aiscoo-dev://oauth/callback?provider=new-api&state=${authorization.state}&code=${"c".repeat(43)}`,
      ),
      null,
    );
    await assert.rejects(
      oauth.handleCallback("aiscoo-dev://oauth/callback?provider=zai&code=old&state=old"),
      loginError,
    );
    const { resolveOfficialMcpCredentials, createOfficialMcpAuthHeadersResolver } =
      await import("../src/official-mcp/officialMcpCredentials.js");
    const official = { officialCloudHost: policy.unavailableOfficialCloud };
    assert.deepEqual(await resolveOfficialMcpCredentials(official), {
      ok: false,
      reason: "official_auth_unavailable",
    });
    assert.equal(
      (
        await createOfficialMcpAuthHeadersResolver(official).resolveHeaders({
          consumer: "plugin-command",
          captureOnly: true,
        } as never)
      ).ok,
      false,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Aiscoo Host downloads standard Built-in Releases only from its validated admin source", async () => {
  const home = await mkdtemp(join(tmpdir(), "aiscoo-host-builtin-"));
  const savedEnv = { ...process.env };
  Object.assign(process.env, {
    HOME: home,
    USERPROFILE: home,
    ZCODE_DATA_BASE_DIR: home,
    ZCODE_DESKTOP_HOME_DIR: home,
    ZCODE_SETTINGS_FILE_PATH: join(home, "setting.json"),
  });
  const { createAiscooAccountPolicy } = await import("../src/aiscoo-account-policy/index.js");
  const { createLocalServices, disposeServiceResourcesAndWait, setDataBaseDir } =
    await import("../src/node.js");
  const builtinPath = new URL("../../../config/provider/zcode-builtin.json", import.meta.url);
  const release = JSON.parse(await readFile(builtinPath, "utf8"));
  release.revision += 1;
  const origin = "https://admin.example";
  const requests: URL[] = [];
  setDataBaseDir(home);
  const services = createLocalServices({
    accountPolicy: createAiscooAccountPolicy({ adminBaseUrl: `${origin}/` }),
    serviceAuthorityMode: "desktop-local",
    zcodeBuiltinProviderConfigFilePath: builtinPath.pathname,
    runtimeProcessEnvPatch: { PATH: process.env.PATH ?? "" },
    hostApiNetworkTransport: {
      fetch: async (input, init) => {
        const url = new URL(String(input));
        requests.push(url);
        assert.equal(url.origin, origin);
        assert.equal(new Headers(init?.headers).has("Authorization"), false);
        assert.equal(init?.credentials, "omit");
        return Response.json(
          url.pathname === "/api/v1/client/configs"
            ? {
                code: 0,
                data: {
                  configs: {
                    builtin_provider_config_json: `${origin}/builtin/releases/${release.revision}`,
                  },
                },
              }
            : release,
        );
      },
      dispose() {},
      async disposeAndWait() {},
    },
    zcodeAgentCommandResolver: () => null,
  });
  try {
    await services.get(IProviderSettingsService).refresh("centralized-source-test");
    assert.ok(requests.some((url) => url.pathname === "/api/v1/client/configs"));
    assert.ok(requests.some((url) => url.pathname === `/builtin/releases/${release.revision}`));
    const configRequest = requests.find((url) => url.pathname === "/api/v1/client/configs")!;
    assert.ok(configRequest.searchParams.get("app_version"));
    assert.ok(configRequest.searchParams.get("platform"));
  } finally {
    await disposeServiceResourcesAndWait(services);
    setDataBaseDir(null);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await rm(home, { recursive: true, force: true });
  }
});
