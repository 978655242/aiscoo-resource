// §7 的场景先于实现维护：真实退出 hook 独占副作用，夹具仅提供可暂停的端口。
export const logoutRenderer = `
import React from "react";
import { createRoot } from "react-dom/client";
import { DesktopCommandIds } from "./packages/shared/src/index.ts";
import { ServiceProvider } from "./packages/ui/src/hooks/useServices.tsx";
import { PlatformProvider } from "./packages/ui/src/hooks/usePlatform.tsx";
import { StoreProvider, useZCodeStore } from "./packages/ui/src/store/StoreProvider.tsx";
import { createTabStore } from "./packages/ui/src/store/tabStore.ts";
import { AiscooIntlProvider, AiscooLoginHeader } from "./packages/ui/src/xwork/brand/index.ts";
import { useZCodeIntl } from "./packages/ui/src/i18n/IntlProvider.tsx";
import { WelcomeScreen } from "./packages/ui/src/WelcomeScreen.tsx";
import { ConfirmDialogHost } from "./packages/ui/src/ConfirmDialog.tsx";
import { useRootWorkspaceActions } from "./packages/ui/src/root/useRootWorkspaceActions.ts";
import { AiscooLogoutPresentationBoundary, useAiscooLogoutPresentation } from "./packages/ui/src/aiscoo/account-login/logout-presentation.tsx";
import { createAiscooAccountLoginServices, createAiscooAccountLoginPlatform } from "./packages/ui/src/aiscoo/account-login/index.ts";
import { applyTheme } from "./packages/ui/src/useTheme.ts";
const params = new URLSearchParams(location.search);
const locale = params.get("locale") || "zh-CN";
const theme = params.get("theme") || "zai-light";
const desktop = params.get("mode") !== "web";
const enabled = desktop && !["remote", "generic"].includes(params.get("mode"));
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
  getProviders: async () => [{ id: "new-api", displayName: "New API", enabled: true, order: 0 }],
  getActiveProvider: async () => null,
  logout: () => step("logout"),
  startOAuth: async () => { events.push("unexpected-login"); throw new Error("Login must not start while exiting"); },
  cancelPending: async () => {},
};
const services = createAiscooAccountLoginServices({ oauthService, settingService: { get: async () => { await step("settings.get"); return {}; } }, providerSettingsService: {}, modelSelectionService: {} });
const platform = createAiscooAccountLoginPlatform({
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
});
const tabs = createTabStore(null);
const broadcastService = { send: async () => {}, onMessage: () => ({ dispose() {} }) };
let mounts = 0, unmounts = 0, sameFlight = null, latest = null, reentry = null, presentationAttached = null;
function LogoutRoot({ loggedOut }) {
  const presentation = useAiscooLogoutPresentation();
  presentationAttached = Boolean(presentation);
  const { intl } = useZCodeIntl();
  const [signedIn, setSignedIn] = React.useState(!loggedOut);
  const setStoreUser = useZCodeStore(s => s.setUser);
  React.useEffect(() => { mounts++; return () => { unmounts++; }; }, []);
  const { handleLogout } = useRootWorkspaceActions({
    intl, platform, services, tabStoreApi: tabs, addTab: tabs.getState().addTab,
    activeWorkspacePath: null, activeWorkspaceIdentity: null, supportsSettings: true,
    isDesktop: desktop, allowOpenWorkspace: false, preferDirectoryBrowser: false,
    refreshProviderState: () => step("provider"),
    updateAppSettings: async patch => { window.logoutFixture.patch = patch; await step("settings.update"); },
    setOAuthError: () => { events.push("oauthError.clear"); },
    setUser: value => { events.push("user.clear"); setStoreUser(value); setSignedIn(false); },
    onProviderFamilyDomainClearedAfterLogout: () => { events.push("domain.clear"); },
    ...(enabled ? { onLogoutConfirmed: () => { presentation.confirmed(); events.push("confirmed"); snapshot("confirmed"); } } : {}),
    workbenchGroupClientMode: params.get("mode") === "remote" ? "web-remote-replayable" : "desktop-continuous",
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
    {signedIn ? <button data-testid="fixture-logout" onClick={request}>Exit fixture</button> : <WelcomeScreen onComplete={() => events.push("complete")} header={<AiscooLoginHeader />} hideApiKeyLogin />}
    <ConfirmDialogHost />
  </div>;
}
let root;
function mount(loggedOut = false) {
  root = createRoot(document.getElementById("root"));
  const content = <LogoutRoot loggedOut={loggedOut} />;
  root.render(<ServiceProvider services={services}><PlatformProvider platform={platform}>
    <StoreProvider broadcastService={broadcastService}><AiscooIntlProvider initialLocale={locale}>
      {enabled ? <AiscooLogoutPresentationBoundary>{content}</AiscooLogoutPresentationBoundary> : content}
    </AiscooIntlProvider></StoreProvider>
  </PlatformProvider></ServiceProvider>);
}
window.logoutFixture = { events, snapshots, errors, controls,
  release: name => gates.get(name)?.release(),
  state: () => ({ mounts, unmounts, sameFlight, enabled, presentationAttached }),
  newRoot: () => { root.unmount(); mount(true); },
  repeat: () => reentry() === latest,
};
mount();
`;
