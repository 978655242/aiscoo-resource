// Focused isolated Electron acceptance for the exit presentation's DOM and native-event gates.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const requireRoot = createRequire(new URL("../../../package.json", import.meta.url));
const requireDesktop = createRequire(new URL("../package.json", import.meta.url));
const requireServices = createRequire(new URL("../../services/package.json", import.meta.url));
const { build } = requireServices("esbuild");
const { _electron: electron } = requireDesktop("playwright-core");
const { createServer } = await import(requireDesktop.resolve("vite"));
const { default: tailwindcss } = await import(requireDesktop.resolve("@tailwindcss/vite"));
const temporary = await mkdtemp(join(tmpdir(), "aiscoo-logout-shortcuts-"));
let app;
let server;
try {
  const compiled = await build({
    stdin: {
      resolveDir: root,
      loader: "tsx",
      contents: `
import React from "react";
import { createRoot } from "react-dom/client";
import { DesktopCommandIds } from "./packages/shared/src/index.ts";
import { ServiceProvider, useServices } from "./packages/ui/src/hooks/useServices.tsx";
import { PlatformProvider, usePlatform } from "./packages/ui/src/hooks/usePlatform.tsx";
import { StoreProvider } from "./packages/ui/src/store/StoreProvider.tsx";
import { createTabStore } from "./packages/ui/src/store/tabStore.ts";
import { AiscooIntlProvider } from "./packages/ui/src/aiscoo/brand/index.ts";
import { useZCodeIntl } from "./packages/ui/src/i18n/IntlProvider.tsx";
import { ConfirmDialogHost } from "./packages/ui/src/ConfirmDialog.tsx";
import { useRootWorkspaceActions } from "./packages/ui/src/root/useRootWorkspaceActions.ts";
import { createAiscooAccountLoginRoot } from "@zcode/ui/aiscoo-account-login-root";
import { useAppKeyboard } from "./packages/ui/src/hooks/useAppKeyboard.ts";
import { applyTheme } from "./packages/ui/src/useTheme.ts";
applyTheme("zai-light");
document.documentElement.classList.add("platform-windows-desktop");
const events = [], cleanup = [], handlers = new Map();
const subscriptions = { workspace: 0, oauth: 0 };
const source = {
  onOpenWorkspace: handler => { subscriptions.workspace++; handlers.set("workspace", handler); return () => handlers.delete("workspace"); },
  onOAuthCallback: handler => { subscriptions.oauth++; handlers.set("oauth", handler); return () => handlers.delete("oauth"); },
  getDesktopSessionActivity: async () => ({ runningAgentSessionCount: 0 }),
  reportTelemetryEvent: async () => {},
  executeDesktopCommand: async command => {
    if (command === DesktopCommandIds.ClearCodingPlanWebviewStorage) cleanup.push("webview");
    else if (command === DesktopCommandIds.RelaunchApp) cleanup.push("relaunch");
    else events.push(command);
  },
  getDesktopWindowChromeState: async () => ({ isMaximized: false }),
  onDesktopWindowChromeStateChanged: () => () => {},
};
const broadcastService = { send: async () => {}, onMessage: () => ({ dispose() {} }) };
const services = {
  oauthService: {
    getProviders: async () => [{ id: "new-api", displayName: "Aiscoo", enabled: true, order: 0 }],
    getActiveProvider: async () => null,
    logout: async () => { cleanup.push("logout"); await new Promise((resolve, fail) => { release = resolve; reject = fail; }); },
  },
  settingService: { get: async () => ({}) }, broadcastService,
  providerSettingsService: {}, modelSelectionService: {},
};
const tabs = createTabStore(null);
let release, reject, root, contextsMatch = true, adaptersStable = true, presentationAttached = false;
let effectMounts = 0, effectUnmounts = 0, rerenderParent, parentRevision = 0;
function Keys({ platform, services }) {
  const contextPlatform = usePlatform(), contextServices = useServices();
  contextsMatch = contextsMatch && contextPlatform === platform && contextServices === services;
  useAppKeyboard({ openSettings: () => events.push("settings"), toggleSidebar: () => events.push("sidebar") });
  React.useEffect(() => {
    const disposeWorkspace = platform.onOpenWorkspace(() => events.push("workspace"));
    const disposeOAuth = platform.onOAuthCallback(() => events.push("oauth"));
    effectMounts++; window.fixture.ready = true;
    return () => { effectUnmounts++; window.fixture.ready = false; disposeWorkspace(); disposeOAuth(); };
  }, [services, platform]);
  return null;
}
function Content({ services, platform, logoutPresentation: presentation, isDesktop }) {
  presentationAttached = Boolean(presentation);
  const initial = React.useRef({ services, platform, presentation });
  adaptersStable = adaptersStable && initial.current.services === services && initial.current.platform === platform && initial.current.presentation === presentation;
  const { intl } = useZCodeIntl();
  const { handleLogout } = useRootWorkspaceActions({
    intl, platform, services, tabStoreApi: tabs, addTab: tabs.getState().addTab,
    activeWorkspacePath: null, activeWorkspaceIdentity: null, supportsSettings: true,
    isDesktop, allowOpenWorkspace: false, preferDirectoryBrowser: false,
    refreshProviderState: async () => { cleanup.push("provider"); },
    updateAppSettings: async () => { cleanup.push("settings.update"); },
    setOAuthError: () => { cleanup.push("oauthError.clear"); },
    setUser: () => { cleanup.push("user.clear"); },
    onProviderFamilyDomainClearedAfterLogout: () => { cleanup.push("domain.clear"); },
    onLogoutConfirmed: presentation?.confirmed,
  });
  const start = () => {
    const action = () => handleLogout();
    const flight = presentation ? presentation.run(action) : action();
    void flight.then(() => events.push("resolved"), () => events.push("rejected"));
  };
  return <>
    <Keys services={services} platform={platform} />
    <button data-testid="start" onClick={start}>Start exit</button>
    <ConfirmDialogHost />
  </>;
}
function FixtureRoot(props) {
  return <ServiceProvider services={props.services}><PlatformProvider platform={props.platform}>
    <StoreProvider broadcastService={props.services.broadcastService}><Content {...props} /></StoreProvider>
  </PlatformProvider></ServiceProvider>;
}
const ProductRoot = createAiscooAccountLoginRoot(FixtureRoot);
function FixtureParent() {
  const [revision, setRevision] = React.useState(0);
  rerenderParent = () => setRevision(value => value + 1);
  React.useEffect(() => { parentRevision = revision; }, [revision]);
  return <AiscooIntlProvider initialLocale="en-US"><ProductRoot services={services} platform={source} isDesktop /></AiscooIntlProvider>;
}
function mount() {
  root = createRoot(document.getElementById("root"));
  root.render(<FixtureParent />);
}
window.fixture = {
  events, cleanup, ready: false,
  rerender: () => { const target = parentRevision + 1; rerenderParent(); return target; },
  state: () => ({ contextsMatch, adaptersStable, presentationAttached, subscriptions, effectMounts, effectUnmounts, parentRevision }),
  emitWorkspace: () => handlers.get("workspace")?.(),
  emitOAuth: () => handlers.get("oauth")?.({ provider: "new-api", purpose: "primary-account", url: "aiscoo-dev://oauth/callback?provider=new-api" }),
  fail: () => reject(new Error("synthetic failure")),
  finish: () => release(),
  newRoot: () => { root.unmount(); mount(); },
};
mount();
`,
    },
    absWorkingDir: root,
    nodePaths: [resolve(root, "packages/desktop/node_modules")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "esm",
    jsx: "automatic",
    tsconfig: resolve(root, "packages/ui/tsconfig.json"),
    alias: {
      "@": resolve(root, "packages/ui/src"),
      react: dirname(requireRoot.resolve("react/package.json")),
      "react-dom": dirname(requireRoot.resolve("react-dom/package.json")),
    },
    loader: { ".svg": "dataurl", ".png": "dataurl", ".css": "empty" },
    define: { "process.env.NODE_ENV": JSON.stringify("test"), "import.meta.env": "{}" },
  });
  await writeFile(join(temporary, "renderer.js"), compiled.outputFiles[0].text);
  await writeFile(
    join(temporary, "index.html"),
    `<!doctype html><html><head><link rel="stylesheet" href="/@fs${root}/packages/ui/src/styles.css"><link rel="stylesheet" href="/@fs${root}/packages/ui/src/aiscoo/brand/brand.css"></head><body><div id="root"></div><script type="module" src="/renderer.js"></script></body></html>`,
  );
  server = await createServer({
    configFile: false,
    root: temporary,
    plugins: [tailwindcss()],
    server: { host: "127.0.0.1", port: 0, fs: { allow: [root, temporary] } },
  });
  await server.listen();
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  await writeFile(
    join(temporary, "main.cjs"),
    `const { app, BrowserWindow } = require("electron"); app.setPath("userData", ${JSON.stringify(join(temporary, "profile"))}); app.whenReady().then(() => { const win = new BrowserWindow({ width: 1000, height: 720, show: false }); win.loadURL(${JSON.stringify(origin)}); });`,
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  app = await electron.launch({
    executablePath: requireDesktop("electron"),
    args: [join(temporary, "main.cjs")],
    env,
  });
  const page = await app.firstWindow();
  page.setDefaultTimeout(5000);
  const runtimeErrors = [];
  page.on("pageerror", (error) => runtimeErrors.push(error.message));
  const button = page.getByTestId("start");
  const transition = page.getByTestId("aiscoo-logout-transition");
  // 原因：Main 已发起唯一初始导航；再次 goto 会与 loadURL 竞争，只等待订阅就绪和按钮可见。
  await page.waitForFunction(() => window.fixture?.ready === true);
  await button.waitFor({ state: "visible" });
  async function assertAssembly(subscriptions = 1) {
    const target = await page.evaluate(() => window.fixture.rerender());
    await page.waitForFunction(
      (revision) => window.fixture.state().parentRevision === revision,
      target,
    );
    assert.deepEqual(await page.evaluate(() => window.fixture.state()), {
      contextsMatch: true,
      adaptersStable: true,
      presentationAttached: true,
      subscriptions: { workspace: subscriptions, oauth: subscriptions },
      effectMounts: subscriptions,
      effectUnmounts: subscriptions - 1,
      parentRevision: target,
    });
  }
  async function startExit() {
    await button.click();
    await page.getByTestId("confirm-dialog-confirm").waitFor({ state: "visible" });
    assert.equal(await transition.count(), 0, "The real confirmation must precede exit isolation");
    await page.getByTestId("confirm-dialog-confirm").click();
    await transition.waitFor({ state: "visible" });
    await page.waitForFunction(() => window.fixture.cleanup.at(-1) === "logout");
    await assertAssembly();
  }
  await assertAssembly();
  await page.keyboard.press("Meta+,");
  await page.keyboard.press("Meta+b");
  await page.evaluate(() => window.fixture.emitWorkspace());
  assert.deepEqual(await page.evaluate(() => window.fixture.events), [
    "settings",
    "sidebar",
    "workspace",
  ]);
  await startExit();
  await page.keyboard.press("Meta+,");
  await page.keyboard.press("Meta+b");
  await page.keyboard.press("f");
  await page.evaluate(() => window.fixture.emitWorkspace());
  assert.deepEqual(await page.evaluate(() => window.fixture.events), [
    "settings",
    "sidebar",
    "workspace",
  ]);
  await page.evaluate(() => window.fixture.emitOAuth());
  assert.equal(
    await transition
      .getByTestId("window-control-minimize")
      .locator("svg")
      .getAttribute("stroke-width"),
    "1.5",
    "Exit window controls must retain the production Lucide stroke width",
  );
  await transition.getByTestId("window-control-minimize").focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => window.fixture.events.slice(-2)), [
    "oauth",
    "minimizeWindow",
  ]);
  await page.evaluate(() => window.fixture.fail());
  await transition.waitFor({ state: "detached" });
  await assertAssembly();
  assert.deepEqual(await page.evaluate(() => window.fixture.cleanup), ["logout"]);
  await page.keyboard.press("Meta+,");
  await page.evaluate(() => window.fixture.emitWorkspace());
  assert.deepEqual(await page.evaluate(() => window.fixture.events.slice(-3)), [
    "rejected",
    "settings",
    "workspace",
  ]);
  await startExit();
  await page.evaluate(() => window.fixture.finish());
  await page.waitForFunction(() => window.fixture.events.includes("resolved"));
  assert.equal(await transition.isVisible(), true);
  await assertAssembly();
  assert.deepEqual(await page.evaluate(() => window.fixture.cleanup), [
    "logout",
    "logout",
    "settings.update",
    "domain.clear",
    "oauthError.clear",
    "user.clear",
    "provider",
    "webview",
    "relaunch",
  ]);
  await page.keyboard.press("Meta+,");
  assert.equal(await page.evaluate(() => window.fixture.events.at(-1)), "resolved");
  await page.evaluate(() => window.fixture.newRoot());
  await page.waitForFunction(() => window.fixture.ready === true);
  await button.waitFor({ state: "visible" });
  await assertAssembly(2);
  await page.keyboard.press("Meta+,");
  assert.equal(await page.evaluate(() => window.fixture.events.at(-1)), "settings");
  assert.deepEqual(runtimeErrors, []);
  console.log(
    "PASS: public product Root assembly + real exit/confirmation/global shortcut hooks; idle/busy/failure/new-Root gates, stable adapter subscriptions, OAuth and window control preserved; isolated Electron, no actual OS accelerator or relaunch",
  );
} finally {
  await app?.close();
  await server?.close();
  await rm(temporary, { recursive: true, force: true });
}
