import assert from "node:assert/strict";

// 原因：真实确认弹窗退场期间仍以 aria-hidden 隔离背景，test-id 可见不等于角色查询已可访问。
export async function waitForLogoutWelcome(page, mode) {
  const inspect = () =>
    page.evaluate(() => {
      const brand = document.querySelector('[role="img"][aria-label="Aiscoo"]');
      return {
        theme: document.documentElement.className,
        brandAttached: Boolean(brand),
        brandHiddenForAria: Boolean(brand?.closest('[aria-hidden="true"]')),
        brandVisibility: brand ? getComputedStyle(brand).visibility : null,
        dialogs: Array.from(
          document.querySelectorAll('[data-slot="dialog-content"]'),
          (element) => ({
            state: element.getAttribute("data-state"),
            animation: getComputedStyle(element).animationName,
          }),
        ),
      };
    });
  const before = await inspect();
  try {
    // 完成条件是原确认内容真正卸载、品牌回到可访问树；保留动画与产品可见性要求。
    await page.getByTestId("confirm-dialog-confirm").waitFor({ state: "detached" });
    if (mode !== "generic")
      await page.getByRole("img", { name: "Aiscoo", exact: true }).waitFor({ state: "visible" });
  } catch (cause) {
    throw new Error(
      `退出登录页未就绪: ${JSON.stringify({ mode, before, after: await inspect() })}`,
      { cause },
    );
  }
  return { before, after: await inspect() };
}

// 原始轻量 Root 的正向对照必须实际发起官方委托，并保留 Aiscoo 原文与 API key 表单。
export async function checkUpstreamLoginControls(page, openLoginPage) {
  await openLoginPage(page, { locale: "zh-CN", upstream: "1" });
  await page
    .getByRole("button", { name: "登录 Aiscoo", exact: true })
    .waitFor({ state: "visible" });
  assert.equal(await page.getByRole("img", { name: "Aiscoo", exact: true }).count(), 0);
  await page.getByRole("button", { name: "使用 API key", exact: true }).click();
  await page.getByRole("heading", { name: "API Key", exact: true }).waitFor({ state: "visible" });

  await openLoginPage(page, { locale: "zh-CN", upstream: "1", providers: "official" });
  const cancel = page.getByRole("button", { name: "取消", exact: true });
  for (const [provider, label] of [
    ["zai", /连接 Z\.ai 继续使用/u],
    ["bigmodel", /连接 BigModel 继续使用/u],
  ]) {
    const button = page.getByRole("button", { name: label });
    await button.waitFor({ state: "visible" });
    await button.click();
    await cancel.waitFor({ state: "visible" });
    await page.waitForFunction(
      (count) =>
        window.loginFixture.events.filter((event) => event[0] === "open-synthetic").length ===
        count,
      provider === "zai" ? 1 : 2,
    );
    await cancel.click();
    await button.waitFor({ state: "visible" });
  }
  assert.deepEqual(await page.evaluate(() => window.loginFixture.events), [
    ["start-polling", "zai"],
    ["register", "zai"],
    ["open-synthetic"],
    ["cancel", "zai"],
    ["start-polling", "bigmodel"],
    ["register", "bigmodel"],
    ["open-synthetic"],
    ["cancel", "bigmodel"],
  ]);
  assert.equal(await page.getByRole("button", { name: "登录 Aiscoo", exact: true }).count(), 0);
  assert.equal(await page.getByRole("img", { name: "Aiscoo", exact: true }).count(), 0);
  await page.getByRole("button", { name: "使用 API key", exact: true }).click();
  await page.getByRole("heading", { name: "API Key", exact: true }).waitFor({ state: "visible" });
}

// §9 的 runtime 夹具复用公开产品装配；轻量 Root 仅持有 Context 与真实上游组件。
export const loginRenderer = `
import React from "react";
import { createRoot } from "react-dom/client";
import { ServiceProvider } from "./packages/ui/src/hooks/useServices.tsx";
import { PlatformProvider } from "./packages/ui/src/hooks/usePlatform.tsx";
import { StoreProvider, useZCodeStore } from "./packages/ui/src/store/StoreProvider.tsx";
import { AiscooIntlProvider } from "./packages/ui/src/aiscoo/brand/index.ts";
import { ZCodeIntlProvider } from "./packages/ui/src/i18n/IntlProvider.tsx";
import { WelcomeScreen } from "./packages/ui/src/WelcomeScreen.tsx";
import { createAiscooAccountLoginRoot } from "@zcode/ui/aiscoo-account-login-root";
import { applyTheme } from "./packages/ui/src/useTheme.ts";
import { handleOAuthCallbackSuccess } from "./packages/ui/src/root/useRootOAuthEffects.ts";
const params = new URLSearchParams(location.search);
const locale = params.get("locale") || "zh-CN";
const theme = params.get("theme") || "zai-light";
const upstream = params.get("upstream") === "1";
const providerMode = params.get("providers") || "native";
const events = [];
let fail = false;
window.loginFixture = { events, ready: false, failNext: () => { fail = true; } };
localStorage.setItem("zcode-theme", theme);
applyTheme(theme);
async function start(provider, method) {
  events.push([method, provider]);
  if (fail) { fail = false; throw new Error("synthetic failure"); }
  return { authorizeUrl: "https://example.invalid/synthetic", state: "synthetic", provider, purpose: "primary-account" };
}
const oauthService = {
  getProviders: async () => {
    const official = [{ id: "zai", displayName: "Z.ai", enabled: true, order: 0 }, { id: "bigmodel", displayName: "BigModel", enabled: true, order: 1 }];
    const native = { id: "new-api", displayName: "Aiscoo", enabled: true, order: 2 };
    return providerMode === "empty" ? [] : providerMode === "official" ? official : providerMode === "mixed" ? [...official, native] : providerMode === "disabled" ? [{ ...native, enabled: false }] : [native];
  },
  getActiveProvider: async () => null,
  startOAuth: provider => start(provider, "start"),
  startOAuthWithPolling: provider => start(provider, "start-polling"),
  cancelPending: async provider => { events.push(["cancel", provider]); },
};
if (params.get("recovery") === "1") {
  for (const method of ["getProviders", "getActiveProvider", "startOAuth", "cancelPending", "handleCallback"]) {
    oauthService[method] = (...args) => window.recoveryRpc(method, args);
  }
}
const broadcastService = { send: async () => {}, onMessage: () => ({ dispose() {} }) };
const services = { oauthService, broadcastService, providerSettingsService: {}, modelSelectionService: {}, settingService: {} };
const platform = {
  executeDesktopCommand: async () => {},
  registerOAuthState: registration => { events.push(["register", registration.provider]); },
  openExternal: () => { events.push(["open-synthetic"]); },
};
function LoginContent({ services, platform, welcomeScreenPresentation }) {
  const setUser = useZCodeStore(s => s.setUser);
  const setOAuthError = useZCodeStore(s => s.setOAuthError);
  const markOAuthSuccess = useZCodeStore(s => s.markOAuthSuccess);
  React.useEffect(() => {
    if (params.get("recovery") === "1") window.acceptRecoveryCallback = async url => {
      const result = await services.oauthService.handleCallback(url);
      if (result?.kind !== "session") throw new Error("Expected verified session");
      await handleOAuthCallbackSuccess({ result, platform, setUser, setOAuthError,
        refreshProviderState: async () => {}, setProviderFamilyDomain: async () => {} });
      markOAuthSuccess(result.provider);
    };
    window.loginFixture.ready = true;
    return () => { window.loginFixture.ready = false; delete window.acceptRecoveryCallback; };
  }, [services, platform, setUser, setOAuthError, markOAuthSuccess]);
  return <WelcomeScreen onComplete={() => events.push(["complete"])} {...welcomeScreenPresentation} />;
}
function FixtureRoot({ services, platform, welcomeScreenPresentation }) {
  return <ServiceProvider services={services}><PlatformProvider platform={platform}>
    <StoreProvider broadcastService={services.broadcastService}>
      <LoginContent services={services} platform={platform} welcomeScreenPresentation={welcomeScreenPresentation} />
    </StoreProvider>
  </PlatformProvider></ServiceProvider>;
}
const LoginRoot = upstream ? FixtureRoot : createAiscooAccountLoginRoot(FixtureRoot);
const Intl = upstream ? ZCodeIntlProvider : AiscooIntlProvider;
createRoot(document.getElementById("root")).render(
  <Intl initialLocale={locale}><LoginRoot services={services} platform={platform} isDesktop={params.get("desktop") === "1"} /></Intl>
);
`;

// §7 的场景先于实现维护：真实退出 hook 独占副作用，夹具仅提供可暂停的端口。
export const logoutRenderer = `
import React from "react";
import { createRoot } from "react-dom/client";
import { DesktopCommandIds } from "./packages/shared/src/index.ts";
import { ServiceProvider, useServices } from "./packages/ui/src/hooks/useServices.tsx";
import { PlatformProvider, usePlatform } from "./packages/ui/src/hooks/usePlatform.tsx";
import { StoreProvider, useZCodeStore } from "./packages/ui/src/store/StoreProvider.tsx";
import { createTabStore } from "./packages/ui/src/store/tabStore.ts";
import { AiscooIntlProvider } from "./packages/ui/src/aiscoo/brand/index.ts";
import { ZCodeIntlProvider, useZCodeIntl } from "./packages/ui/src/i18n/IntlProvider.tsx";
import { WelcomeScreen } from "./packages/ui/src/WelcomeScreen.tsx";
import { ConfirmDialogHost } from "./packages/ui/src/ConfirmDialog.tsx";
import { useRootWorkspaceActions } from "./packages/ui/src/root/useRootWorkspaceActions.ts";
import { createAiscooAccountLoginRoot } from "@zcode/ui/aiscoo-account-login-root";
import { applyTheme } from "./packages/ui/src/useTheme.ts";
const params = new URLSearchParams(location.search);
const locale = params.get("locale") || "zh-CN";
const theme = params.get("theme") || "zai-light";
const mode = params.get("mode");
const desktop = mode !== "web";
const os = params.get("os") || "mac";
if (desktop && os !== "mac") document.documentElement.classList.add("platform-" + os + "-desktop");
localStorage.setItem("zcode-theme", theme);
applyTheme(theme);
const events = [], snapshots = [], errors = [], controls = [];
const failures = new Error("synthetic-" + (params.get("fail") || "none"));
const gates = new Map();
for (const name of (params.get("hold") || "provider,webview").split(",")) {
  let release; const promise = new Promise(resolve => { release = resolve; });
  gates.set(name, { promise, release });
}
function snapshot(name) {
  const overlay = document.querySelector('[data-testid="aiscoo-logout-transition"]');
  const oldRoot = document.querySelector('[data-testid="old-root"]');
  snapshots.push({ name, overlay: Boolean(overlay), inert: Boolean(oldRoot?.closest("[inert]")), hidden: oldRoot ? getComputedStyle(oldRoot).visibility : null });
}
async function step(name) {
  events.push(name); snapshot(name);
  if (params.get("fail") === name) throw failures;
  await gates.get(name)?.promise;
}
const oauthService = {
  getProviders: async () => [{ id: "new-api", displayName: "Aiscoo", enabled: true, order: 0 }],
  getActiveProvider: async () => null,
  logout: () => step("logout"),
  startOAuth: async () => { events.push("unexpected-login"); throw new Error("Login must not start while exiting"); },
  cancelPending: async () => {},
};
const broadcastService = { send: async () => {}, onMessage: () => ({ dispose() {} }) };
const services = { oauthService, broadcastService, settingService: { get: async () => { await step("settings.get"); return {}; } }, providerSettingsService: {}, modelSelectionService: {} };
const platform = {
  getDesktopSessionActivity: async () => ({ runningAgentSessionCount: 0 }),
  reportTelemetryEvent: async () => {},
  executeDesktopCommand: async command => {
    if (command === DesktopCommandIds.ClearCodingPlanWebviewStorage) return step("webview");
    if (command === DesktopCommandIds.RelaunchApp) return step("relaunch");
    controls.push(command);
  },
  getDesktopWindowChromeState: async () => ({ isMaximized: false }),
  onDesktopWindowChromeStateChanged: () => () => {},
  registerOAuthState: () => {}, openExternal: () => { events.push("unexpected-external"); },
};
const tabs = createTabStore(null);
let mounts = 0, unmounts = 0, sameFlight = null, latest = null, reentry = null, presentationAttached = null;
let adaptersStable = true, contextsMatch = true, loggedOutForMount = false, effectMounts = 0, effectUnmounts = 0;
function LogoutContent({ services, platform, welcomeScreenPresentation, logoutPresentation: presentation, isDesktop, webRemoteControlWorkspaceSwitcher }) {
  presentationAttached = Boolean(presentation);
  const initial = React.useRef({ services, platform, presentation });
  adaptersStable = adaptersStable && initial.current.services === services && initial.current.platform === platform && initial.current.presentation === presentation;
  const contextServices = useServices(), contextPlatform = usePlatform();
  contextsMatch = contextsMatch && contextServices === services && contextPlatform === platform;
  React.useEffect(() => { effectMounts++; return () => { effectUnmounts++; }; }, [services, platform]);
  const { intl } = useZCodeIntl();
  const [signedIn, setSignedIn] = React.useState(!loggedOutForMount);
  const setStoreUser = useZCodeStore(s => s.setUser);
  React.useEffect(() => { mounts++; window.logoutFixture.ready = true; return () => { unmounts++; window.logoutFixture.ready = false; }; }, []);
  const { handleLogout } = useRootWorkspaceActions({
    intl, platform, services, tabStoreApi: tabs, addTab: tabs.getState().addTab,
    activeWorkspacePath: null, activeWorkspaceIdentity: null, supportsSettings: true,
    isDesktop, allowOpenWorkspace: false, preferDirectoryBrowser: false,
    refreshProviderState: () => step("provider"),
    updateAppSettings: async patch => { window.logoutFixture.patch = patch; await step("settings.update"); },
    setOAuthError: () => { events.push("oauthError.clear"); },
    setUser: value => { events.push("user.clear"); setStoreUser(value); setSignedIn(false); },
    onProviderFamilyDomainClearedAfterLogout: () => { events.push("domain.clear"); },
    ...(presentation ? { onLogoutConfirmed: () => { presentation.confirmed(); events.push("confirmed"); snapshot("confirmed"); } } : {}),
    workbenchGroupClientMode: webRemoteControlWorkspaceSwitcher ? "web-remote-replayable" : "desktop-continuous",
  });
  function request() {
    const action = () => handleLogout();
    const flight = presentation ? presentation.run(action) : action();
    latest = flight;
    reentry = () => presentation ? presentation.run(action) : action();
    if (presentation && params.get("duplicate") === "1") sameFlight = flight === presentation.run(action);
    void flight.then(() => { events.push("resolved"); }, error => {
      errors.push({ same: error === failures, message: error.message }); events.push("rejected");
    });
  }
  return <div data-testid="old-root">
    {signedIn ? <button data-testid="fixture-logout" onClick={request}>Exit fixture</button> : <WelcomeScreen onComplete={() => events.push("complete")} {...welcomeScreenPresentation} />}
    <ConfirmDialogHost />
  </div>;
}
function FixtureRoot(props) {
  return <ServiceProvider services={props.services}><PlatformProvider platform={props.platform}>
    <StoreProvider broadcastService={props.services.broadcastService}><LogoutContent {...props} /></StoreProvider>
  </PlatformProvider></ServiceProvider>;
}
const LogoutRoot = mode === "generic" ? FixtureRoot : createAiscooAccountLoginRoot(FixtureRoot);
const Intl = mode === "generic" ? ZCodeIntlProvider : AiscooIntlProvider;
const switcher = mode === "remote" ? {} : undefined;
let root, rerenderParent, parentRevision = 0;
function FixtureParent() {
  const [revision, setRevision] = React.useState(0);
  rerenderParent = () => setRevision(value => value + 1);
  React.useEffect(() => { parentRevision = revision; }, [revision]);
  return <Intl initialLocale={locale}><LogoutRoot services={services} platform={platform}
    isDesktop={desktop} webRemoteControlWorkspaceSwitcher={switcher} /></Intl>;
}
function mount(loggedOut = false) {
  loggedOutForMount = loggedOut;
  root = createRoot(document.getElementById("root"));
  root.render(<FixtureParent />);
}
window.logoutFixture = { events, snapshots, errors, controls, ready: false,
  release: name => gates.get(name)?.release(),
  rerender: () => { const target = parentRevision + 1; rerenderParent(); return target; },
  state: () => ({ mounts, unmounts, sameFlight, presentationAttached, adaptersStable, contextsMatch, effectMounts, effectUnmounts, parentRevision }),
  newRoot: () => { root.unmount(); mount(true); },
  repeat: () => reentry() === latest,
};
mount();
`;
