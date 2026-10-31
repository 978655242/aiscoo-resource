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
import { ServiceProvider } from "./packages/ui/src/hooks/useServices.tsx";
import { PlatformProvider } from "./packages/ui/src/hooks/usePlatform.tsx";
import { StoreProvider } from "./packages/ui/src/store/StoreProvider.tsx";
import { AiscooIntlProvider } from "./packages/ui/src/xwork/brand/index.ts";
import { AiscooLogoutPresentationBoundary, useAiscooLogoutPresentation } from "./packages/ui/src/aiscoo/account-login/logout-presentation.tsx";
import { createAiscooAccountLoginPlatform } from "./packages/ui/src/aiscoo/account-login/index.ts";
import { useAppKeyboard } from "./packages/ui/src/hooks/useAppKeyboard.ts";
import { applyTheme } from "./packages/ui/src/useTheme.ts";
applyTheme("zai-light");
document.documentElement.classList.add("platform-windows-desktop");
const events = [], handlers = new Map();
const source = {
  onOpenWorkspace: handler => { handlers.set("workspace", handler); return () => handlers.delete("workspace"); },
  onOAuthCallback: handler => { handlers.set("oauth", handler); return () => handlers.delete("oauth"); },
  executeDesktopCommand: async command => { events.push(command); },
  getDesktopWindowChromeState: async () => ({ isMaximized: false }),
  onDesktopWindowChromeStateChanged: () => () => {},
};
const services = { settingService: { get: async () => ({}) }, broadcastService: {} };
const broadcastService = { send: async () => {}, onMessage: () => ({ dispose() {} }) };
let release, reject, root;
function Keys({ platform }) {
  useAppKeyboard({ openSettings: () => events.push("settings"), toggleSidebar: () => events.push("sidebar") });
  React.useEffect(() => {
    const disposeWorkspace = platform.onOpenWorkspace(() => events.push("workspace"));
    const disposeOAuth = platform.onOAuthCallback(() => events.push("oauth"));
    return () => { disposeWorkspace(); disposeOAuth(); };
  }, [platform]);
  return null;
}
function Content() {
  const presentation = useAiscooLogoutPresentation();
  const platform = React.useMemo(() => createAiscooAccountLoginPlatform(source, presentation.isExiting), [presentation]);
  const start = () => presentation.run(async () => {
    presentation.confirmed();
    await new Promise((resolve, fail) => { release = resolve; reject = fail; });
  }).then(() => events.push("resolved"), () => events.push("rejected"));
  return <PlatformProvider platform={platform}>
    <Keys platform={platform} />
    <button data-testid="start" onClick={start}>Start exit</button>
  </PlatformProvider>;
}
function mount() {
  root = createRoot(document.getElementById("root"));
  root.render(<ServiceProvider services={services}><PlatformProvider platform={source}>
    <StoreProvider broadcastService={broadcastService}><AiscooIntlProvider initialLocale="en-US">
      <AiscooLogoutPresentationBoundary><Content /></AiscooLogoutPresentationBoundary>
    </AiscooIntlProvider></StoreProvider>
  </PlatformProvider></ServiceProvider>);
}
window.fixture = {
  events,
  emitWorkspace: () => handlers.get("workspace")?.(),
  emitOAuth: () => handlers.get("oauth")?.({ provider: "new-api", purpose: "primary-account", url: "aiscoo-dev://oauth/callback?provider=new-api" }),
  fail: () => reject(new Error("synthetic failure")),
  finish: () => release(),
  newRoot: () => { root.unmount(); mount(); },
};
mount();
`,
    },
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
    `<!doctype html><html><head><link rel="stylesheet" href="/@fs${root}/packages/ui/src/styles.css"><link rel="stylesheet" href="/@fs${root}/packages/ui/src/xwork/brand/brand.css"></head><body><div id="root"></div><script type="module" src="/renderer.js"></script></body></html>`,
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
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const button = page.getByTestId("start");
  const transition = page.getByTestId("aiscoo-logout-transition");
  await button.waitFor();
  await page.keyboard.press("Meta+,");
  await page.keyboard.press("Meta+b");
  await page.evaluate(() => window.fixture.emitWorkspace());
  assert.deepEqual(await page.evaluate(() => window.fixture.events), [
    "settings",
    "sidebar",
    "workspace",
  ]);
  await button.click();
  await transition.waitFor();
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
  await transition.getByTestId("window-control-minimize").focus();
  await page.keyboard.press("Enter");
  assert.deepEqual(await page.evaluate(() => window.fixture.events.slice(-2)), [
    "oauth",
    "minimizeWindow",
  ]);
  await page.evaluate(() => window.fixture.fail());
  await transition.waitFor({ state: "detached" });
  await page.keyboard.press("Meta+,");
  await page.evaluate(() => window.fixture.emitWorkspace());
  assert.deepEqual(await page.evaluate(() => window.fixture.events.slice(-3)), [
    "rejected",
    "settings",
    "workspace",
  ]);
  await button.click();
  await transition.waitFor();
  await page.evaluate(() => window.fixture.finish());
  await page.waitForFunction(() => window.fixture.events.includes("resolved"));
  assert.equal(await transition.isVisible(), true);
  await page.keyboard.press("Meta+,");
  assert.equal(await page.evaluate(() => window.fixture.events.at(-1)), "resolved");
  await page.evaluate(() => window.fixture.newRoot());
  await button.waitFor();
  await page.keyboard.press("Meta+,");
  assert.equal(await page.evaluate(() => window.fixture.events.at(-1)), "settings");
  assert.deepEqual(errors, []);
  console.log(
    "PASS: real global shortcut hook + native-intent adapter; idle/busy/failure/new-Root gates, OAuth and window control preserved; isolated Electron, no actual OS accelerator or relaunch",
  );
} finally {
  await app?.close();
  await server?.close();
  await rm(temporary, { recursive: true, force: true });
}
