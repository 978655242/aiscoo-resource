import assert from "node:assert/strict";
import { after, mock, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { PlatformChannels } from "@zcode/shared";
import { getAiscooDesktopIdentity } from "@zcode/shared/aiscoo-desktop-identity";
import { createOAuthCallbackHandler } from "../src/preload/oauthCallbackBridge.js";

const delivered: Array<{ windowId: number; channel: string; value: unknown }> = [];
const registeredSchemes: string[] = [];
const windows = [1, 2].map((id) => ({
  webContents: {
    id,
    send: (channel: string, value: unknown) => delivered.push({ windowId: id, channel, value }),
  },
  isMinimized: () => false,
  isVisible: () => true,
  focus() {},
}));
mock.module("electron", {
  namedExports: {
    app: {
      show() {},
      setAsDefaultProtocolClient(scheme: string) {
        registeredSchemes.push(scheme);
        return true;
      },
    },
    dialog: {},
    BrowserWindow: { getAllWindows: () => windows, getFocusedWindow: () => windows[1] },
  },
});
// Electron 不是普通 Node 模块：先安装原生投递 mock，再加载真实 Main 路由。
const {
  parseOAuthStateRegistration,
  registerOAuthState,
  handleDeepLink,
  deliverPendingDeepLink,
  clearOAuthRoutesForWindow,
} = await import("../src/main/desktopOAuthDeepLink.js");
mock.timers.enable({ apis: ["setTimeout"] });
const logger = { info() {}, warn() {} };
const nativeState = "n".repeat(32);
const closedState = "c".repeat(32);
const callback = (state: string, provider = "new-api") =>
  `zcode://oauth/callback?provider=${provider}&state=${state}&code=${"c".repeat(43)}`;
const reset = () => {
  clearOAuthRoutesForWindow(1);
  clearOAuthRoutesForWindow(2);
  delivered.length = 0;
};

// XCODE: 每个渠道单独编译真实 Main，验证编译期身份与 Electron 注册/投递一致。
const compiledRoot = await mkdtemp(join(tmpdir(), "aiscoo-oauth-routes-"));
after(() => rm(compiledRoot, { recursive: true, force: true }));
const require = createRequire(import.meta.url);
async function loadChannelRoutes(channel: "production" | "development" | "preview") {
  const outfile = join(compiledRoot, `${channel}.mjs`);
  await build({
    entryPoints: [fileURLToPath(new URL("../src/main/desktopOAuthDeepLink.ts", import.meta.url))],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    external: [require.resolve("electron")],
    alias: { electron: require.resolve("electron"), zod: require.resolve("zod") },
    define: { __AISCOO_DESKTOP_CHANNEL__: JSON.stringify(channel) },
    logLevel: "silent",
  });
  return import(pathToFileURL(outfile).href) as Promise<
    typeof import("../src/main/desktopOAuthDeepLink.js")
  >;
}
async function loadChannelScheduler(channel: "production" | "development" | "preview") {
  const outfile = join(compiledRoot, `${channel}-scheduler.mjs`);
  await build({
    entryPoints: [
      fileURLToPath(new URL("../src/scheduler/offPeakOwnerAdmission.ts", import.meta.url)),
    ],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    define: { __AISCOO_DESKTOP_CHANNEL__: JSON.stringify(channel) },
    logLevel: "silent",
  });
  return import(pathToFileURL(outfile).href) as Promise<
    typeof import("../src/scheduler/offPeakOwnerAdmission.js")
  >;
}
for (const channel of ["production", "development", "preview"] as const) {
  test(`${channel} accepts only its native callback and preserves route ownership`, async () => {
    reset();
    registeredSchemes.length = 0;
    const profile = getAiscooDesktopIdentity(channel);
    const routes = await loadChannelRoutes(channel);
    // XCODE: 配置缺失也保持空 owner，旧 Main 消息不能恢复官方闲时执行资格。
    const scheduler = await loadChannelScheduler(channel);
    assert.equal(scheduler.requiresOffPeakOwnerAdmission(), true);
    assert.deepEqual(scheduler.captureOffPeakOwnerFence().ownerKeys, []);
    scheduler.updateOffPeakOwnerAdmission(["historical-official-owner"]);
    assert.deepEqual(scheduler.captureOffPeakOwnerFence().ownerKeys, []);
    assert.throws(() =>
      scheduler.captureOffPeakOwnerFence("historical-official-owner").assertCurrentSync?.(),
    );
    for (const provider of ["zai", "bigmodel"] as const) {
      for (const purpose of ["primary-account", "official-cloud"] as const) {
        const registration = { state: `old-${provider}-${purpose}`, provider, purpose };
        // 路由表只经 IPC parser 登记；parser 拒绝后 Main 不会调用 registerOAuthState。
        const parsed = routes.parseOAuthStateRegistration(registration);
        assert.equal(parsed, null);
        if (parsed) routes.registerOAuthState(1, parsed);
        assert.equal(
          routes.handleDeepLink(
            `${profile.oauthRedirectUri}?provider=${provider}&purpose=${purpose}&state=${registration.state}&code=old`,
            logger,
          ),
          false,
        );
      }
    }
    routes.deliverPendingDeepLink(windows[0]!.webContents as never);
    assert.deepEqual(delivered, []);
    routes.clearOAuthRoutesForWindow(1);
    routes.registerDeepLinkProtocol(logger);
    assert.deepEqual(registeredSchemes, [profile.scheme]);
    const ownCallback = (state: string, provider = "new-api") =>
      `${profile.oauthRedirectUri}?provider=${provider}&state=${state}&code=${"c".repeat(43)}`;
    const register = () =>
      routes.registerOAuthState(1, {
        state: nativeState,
        provider: "new-api",
        purpose: "primary-account",
      });
    assert.equal(routes.handleDeepLink(ownCallback(closedState), logger), false);
    routes.deliverPendingDeepLink(windows[1]!.webContents as never);
    assert.deepEqual(delivered, []);
    register();
    for (const scheme of ["zcode", "aiscoo", "aiscoo-dev", "aiscoo-preview"]) {
      if (scheme !== profile.scheme) {
        assert.equal(
          routes.handleDeepLink(
            ownCallback(nativeState).replace(`${profile.scheme}:`, `${scheme}:`),
            logger,
          ),
          false,
        );
      }
    }
    for (const url of [
      ownCallback(nativeState, "zai"),
      `${ownCallback(nativeState)}&purpose=official-cloud`,
      `${ownCallback(nativeState)}&state=${closedState}`,
      `${ownCallback(nativeState)}&code=${"d".repeat(43)}`,
      `${ownCallback(nativeState)}#fragment`,
      ownCallback(nativeState).replace("/callback?", "/callback/extra?"),
      ownCallback(nativeState).replace("://oauth/", "://user@oauth/"),
      ownCallback(nativeState).replace("://oauth/", "://oauth:123/"),
    ]) {
      assert.equal(routes.handleDeepLink(url, logger), false, url);
    }
    assert.equal(routes.handleDeepLink(ownCallback(nativeState), logger), true);
    assert.deepEqual(delivered, []);
    routes.deliverPendingDeepLink(windows[1]!.webContents as never);
    assert.deepEqual(delivered, []);
    routes.deliverPendingDeepLink(windows[0]!.webContents as never);
    assert.deepEqual(delivered, [
      {
        windowId: 1,
        channel: PlatformChannels.OAuthCallback,
        value: { url: ownCallback(nativeState), provider: "new-api", purpose: "primary-account" },
      },
    ]);
    assert.equal(routes.handleDeepLink(ownCallback(nativeState), logger), false);
    assert.equal(delivered.length, 1);
    register();
    mock.timers.tick(5 * 60 * 1000);
    assert.equal(routes.handleDeepLink(ownCallback(nativeState), logger), false);
    register();
    routes.clearOAuthRoutesForWindow(1);
    assert.equal(routes.handleDeepLink(ownCallback(nativeState), logger), false);
    routes.clearOAuthRoutesForWindow(2);
    reset();
  });
}

test("unconfigured Main keeps zcode registration and rejects Aiscoo schemes", async () => {
  reset();
  registeredSchemes.length = 0;
  const { registerDeepLinkProtocol } = await import("../src/main/desktopOAuthDeepLink.js");
  registerDeepLinkProtocol(logger);
  assert.deepEqual(registeredSchemes, ["zcode"]);
  registerOAuthState(1, { state: nativeState, provider: "new-api", purpose: "primary-account" });
  for (const scheme of ["aiscoo", "aiscoo-dev", "aiscoo-preview"]) {
    assert.equal(
      handleDeepLink(callback(nativeState).replace("zcode:", `${scheme}:`), logger),
      false,
    );
  }
  reset();
});

// XCODE: 真实 Main 路由必须保护窗口/用途；只替换 Electron 原生投递，不替换被测路由。
test("registration rejects missing or conflicting provider/purpose", () => {
  assert.equal(parseOAuthStateRegistration({ state: "s" }), null);
  assert.equal(
    parseOAuthStateRegistration({ state: "s", provider: "new-api", purpose: "official-cloud" }),
    null,
  );
  assert.equal(
    parseOAuthStateRegistration({ state: "s", provider: "zai", purpose: "unknown" }),
    null,
  );
});
test("legacy official primary login retains its window-purpose route", async () => {
  reset();
  deliverPendingDeepLink(windows[0]!.webContents as never);
  const registration = parseOAuthStateRegistration({
    state: "legacy-primary-state",
    provider: "bigmodel",
    purpose: "primary-account",
  });
  assert.ok(registration);
  registerOAuthState(1, registration);
  const url = callback("legacy-primary-state", "bigmodel");
  assert.equal(handleDeepLink(url, logger), true);
  const message = delivered.find((entry) => entry.channel === PlatformChannels.OAuthCallback);
  assert.ok(message);
  assert.deepEqual(message, {
    windowId: 1,
    channel: PlatformChannels.OAuthCallback,
    value: { url, provider: "bigmodel", purpose: "primary-account" },
  });
  let acceptedPurpose: string | undefined;
  let handled = false;
  await createOAuthCallbackHandler(
    (event) => {
      acceptedPurpose = event.purpose;
    },
    () => {
      handled = true;
    },
  )(null, message.value);
  assert.equal(acceptedPurpose, "primary-account");
  assert.equal(handled, true);
  reset();
});
test("unmatched OAuth cannot populate the next ready window's global callback slot", () => {
  reset();
  assert.equal(handleDeepLink(callback("unregistered"), logger), false);
  deliverPendingDeepLink(windows[1]!.webContents as never);
  assert.deepEqual(
    delivered.filter((entry) => entry.channel === PlatformChannels.OAuthCallback),
    [],
  );
});
test("registered not-ready callback only reaches its original window", () => {
  reset();
  registerOAuthState(1, { state: nativeState, provider: "new-api", purpose: "primary-account" });
  handleDeepLink(callback(nativeState), logger);
  assert.deepEqual(delivered, []);
  deliverPendingDeepLink(windows[1]!.webContents as never);
  assert.deepEqual(delivered, []);
  deliverPendingDeepLink(windows[0]!.webContents as never);
  const deliveredEvent = delivered[0];
  assert.equal(deliveredEvent?.windowId, 1);
  assert.equal(deliveredEvent?.channel, PlatformChannels.OAuthCallback);
  assert.ok(
    deliveredEvent.value &&
      typeof deliveredEvent.value === "object" &&
      "provider" in deliveredEvent.value &&
      deliveredEvent.value.provider === "new-api" &&
      "purpose" in deliveredEvent.value &&
      deliveredEvent.value.purpose === "primary-account",
  );
  handleDeepLink(callback(nativeState), logger);
  assert.equal(delivered.length, 1);
});
test("wrong provider, duplicate state and closed-window callback never change route owner", () => {
  reset();
  deliverPendingDeepLink(windows[0]!.webContents as never);
  registerOAuthState(1, { state: nativeState, provider: "new-api", purpose: "primary-account" });
  registerOAuthState(2, { state: nativeState, provider: "new-api", purpose: "primary-account" });
  assert.equal(handleDeepLink(callback(nativeState, "zai"), logger), false);
  assert.equal(handleDeepLink(`${callback(nativeState)}&state=other`, logger), false);
  assert.equal(delivered.length, 0);
  assert.equal(handleDeepLink(callback(nativeState), logger), true);
  assert.equal(delivered[0]?.windowId, 1);
  registerOAuthState(1, { state: closedState, provider: "new-api", purpose: "primary-account" });
  clearOAuthRoutesForWindow(1);
  handleDeepLink(callback(closedState), logger);
  deliverPendingDeepLink(windows[1]!.webContents as never);
  assert.equal(delivered.length, 1);
  reset();
});

test("new primary flow retires only its window-purpose predecessor and preserves official routing", () => {
  reset();
  deliverPendingDeepLink(windows[0]!.webContents as never);
  registerOAuthState(1, { state: nativeState, provider: "new-api", purpose: "primary-account" });
  registerOAuthState(1, { state: "official-state", provider: "zai", purpose: "official-cloud" });
  registerOAuthState(1, { state: closedState, provider: "new-api", purpose: "primary-account" });
  assert.equal(handleDeepLink(callback(nativeState), logger), false);
  assert.equal(handleDeepLink(callback("official-state", "zai"), logger), true);
  assert.equal(handleDeepLink(callback(closedState), logger), true);
  assert.deepEqual(
    delivered.map(({ value }) => {
      assert.ok(
        value &&
          typeof value === "object" &&
          "purpose" in value &&
          typeof value.purpose === "string",
      );
      return value.purpose;
    }),
    ["official-cloud", "primary-account"],
  );
  reset();
});
