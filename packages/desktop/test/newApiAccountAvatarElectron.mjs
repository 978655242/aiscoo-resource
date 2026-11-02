import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const requireServices = createRequire(new URL("../../services/package.json", import.meta.url));
const { build } = requireServices("esbuild");
const requireRoot = createRequire(new URL("../../../package.json", import.meta.url));
const requireDesktop = createRequire(new URL("../package.json", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const trigger = '[data-testid="login-trigger"]';
const header = '[data-testid="profile-menu-header"]';
const menu = '[data-slot="dropdown-menu-content"]';

// XCODE: 可单独运行此文件；编译与既有 runner 相同，只启动头像 smoke，不改 runner 的执行合同。
async function launchStandalone() {
  const temporary = await mkdtemp(join(tmpdir(), "aiscoo-avatar-electron-launch-"));
  try {
    const output = join(temporary, "newApiAccountAvatarElectron.mjs");
    await build({
      entryPoints: [fileURLToPath(import.meta.url)],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: ["electron", requireServices.resolve("esbuild"), "ssh2", "cpu-features"],
      alias: { esbuild: requireServices.resolve("esbuild") },
      define: {
        "import.meta.url": JSON.stringify(import.meta.url),
        "import.meta.dirname": JSON.stringify(
          fileURLToPath(new URL("../out/main/", import.meta.url)),
        ),
      },
      banner: {
        js: `import { createRequire as smokeCreateRequire } from "node:module"; const require = smokeCreateRequire(${JSON.stringify(new URL("../package.json", import.meta.url).href)});`,
      },
    });
    // XCODE: profile 使用临时目录，证据使用父进程临时根，避免随 profile 一起删除。
    const env = {
      ...process.env,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
      XCODE_AVATAR_SMOKE_EVIDENCE: process.env.XCODE_AVATAR_SMOKE_EVIDENCE ?? tmpdir(),
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(requireDesktop("electron"), [output, temporary], {
      env,
      stdio: "inherit",
    });
    await new Promise((resolveExit, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolveExit();
        else reject(new Error(`Account avatar Electron smoke failed: ${signal ?? code}`));
      });
    });
  } finally {
    // Electron/GPU 退出后才删除 profile，与共享 runner 保持一致。
    await rm(temporary, { recursive: true, force: true });
  }
}

// XCODE: 在真实 BrowserWindow 解码 SVG、点击真实 Footer 菜单；不替换头像、Footer 或 usage hooks。
async function runElectron() {
  const { app, BrowserWindow } = await import("electron");
  assert.ok(process.argv[2], "Launch with Node or runNewApiElectronSmokes.mjs");
  const temporary = await mkdtemp(join(process.argv[2], "aiscoo-account-avatar-"));
  // XCODE: 每次运行建立独立证据目录，不覆盖既有验收文件。
  const evidenceRoot = resolve(process.env.XCODE_AVATAR_SMOKE_EVIDENCE ?? tmpdir());
  await mkdir(evidenceRoot, { recursive: true });
  const evidenceDirectory = await mkdtemp(join(evidenceRoot, "aiscoo-avatar-evidence-"));
  app.setPath("userData", join(temporary, "profile"));
  let win, vite;
  let exitCode = 0;
  let stage = "compile real renderer";
  const deadline = setTimeout(() => {
    console.error(`Account avatar Electron smoke timed out at ${stage}`);
    app.exit(1);
  }, 55_000);
  try {
    await mkdir(evidenceDirectory, { recursive: true });
    const renderer = await build({
      stdin: {
        resolveDir: root,
        loader: "tsx",
        contents: `
import React, { useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { WorkspaceSidebarFooter } from "./packages/ui/src/WorkspaceSidebarFooter.tsx";
import { createAiscooAccountAvatarRoot } from "./packages/ui/src/aiscoo/account-avatar/index.ts";
import { ServiceProvider } from "./packages/ui/src/hooks/useServices.tsx";
import { PlatformProvider } from "./packages/ui/src/hooks/usePlatform.tsx";
import { StoreProvider, useZCodeStore } from "./packages/ui/src/store/StoreProvider.tsx";
import { ZCodeIntlProvider } from "./packages/ui/src/i18n/IntlProvider.tsx";
import { TooltipProvider } from "./packages/ui/src/components/ui/tooltip.tsx";
import { connectProviderSettingsSnapshot } from "./packages/ui/src/lib/providerSettingsSnapshot.ts";
import { mapNewApiEntitlement } from "./packages/services/src/new-api/newApiUsageMapper.ts";
import { applyTheme } from "./packages/ui/src/useTheme.ts";
const providerId = "account:new-api-anthropic-messages";
const access = { type: "new-api-account", accountType: "new-api", mode: "private-subscription", entitled: true };
const native = mapNewApiEntitlement({
  schema_version: 1, server_time: 1800000000000, status: "active", authorization_revision: "42",
  subscription: { id: "7", plan_id: "3", plan_title: "Fixture", source: "admin", usage_scope: "zen", start_time: null, end_time: null },
  quota: { scope: "zen-subscription", unit: "quota", unlimited: false, total: "100", used: "25", remaining: "75", used_percentage: 25,
    reset_period: "never", reset_custom_seconds: "0", last_reset_time: null, next_reset_time: null, reset_time_zone: "UTC", reset_utc_offset_seconds: 0 },
  funding_policy: { subscription_only: true, wallet_fallback: false, other_subscription_fallback: false }, self_service_reset: false, purchase_mode: "manual_admin"
}, providerId);
const broadcast = { onMessage: () => ({ dispose() {} }), send: async () => {} };
window.avatarSmoke = { entitlementCalls: [] };
let activeProvider = "new-api";
const oauthListeners = new Set();
const oauthService = {
  getProviders: async () => [{ id: "new-api" }],
  getActiveProvider: async () => activeProvider,
  onDidChangeSession: listener => { oauthListeners.add(listener); return { dispose: () => oauthListeners.delete(listener) }; }
};
const services = { oauthService, broadcastService: broadcast, settingService: { get: async () => ({}) },
  usageStatsService: { getEntitlementSnapshot: async request => {
    window.avatarSmoke.entitlementCalls.push(request.preferredProviderId);
    if (request.accountAccess?.type !== "new-api-account") throw new Error("Unexpected official entitlement request");
    return native;
  } }
};
const providerConnection = connectProviderSettingsSnapshot({
  getView: async () => ({ revision: 1, providers: [{ providerId, providerName: "New API", effectiveConfig: { access }, accountState: { connectionKey: "fixture-owner" } }] }),
  onDidChange: () => ({ dispose() {} })
});
const platform = { getDesktopZoomLevel: async () => ({ zoomLevel: 0 }), executeDesktopCommand: async () => {} };
const renderer = createRoot(document.getElementById("root"));
function Scene() {
  const user = useZCodeStore(state => state.user);
  const setUser = useZCodeStore(state => state.setUser);
  const setRestoring = useZCodeStore(state => state.setIsRestoringOAuthSession);
  const [injected, setInjected] = useState(true);
  const [theme, setTheme] = useState("zai-light");
  const [sidebarWidth, setSidebarWidth] = useState(320);
  useLayoutEffect(() => { setUser({ id: "42", username: "ada42", displayName: "Ada42" }); }, [setUser]);
  window.avatarSmoke.change = next => flushSync(() => {
    if (Object.hasOwn(next, "user")) setUser(next.user);
    if (Object.hasOwn(next, "restoring")) setRestoring(next.restoring);
    if (Object.hasOwn(next, "injected")) setInjected(next.injected);
    if (Object.hasOwn(next, "activeProvider")) {
      activeProvider = next.activeProvider;
      for (const listener of oauthListeners) listener(activeProvider === "new-api" ? "signed-in" : "signed-out");
    }
    if (next.theme) { applyTheme(next.theme); setTheme(next.theme); }
    if (next.sidebarWidth) setSidebarWidth(next.sidebarWidth);
  });
  const footerProps = { theme, localeMenuValue: "en-US", onLocaleChange: () => {}, onThemeChange: () => {},
    onSettingsButtonClick: () => {}, onLogin: () => {}, onLogout: user ? () => {} : undefined, user, isDesktop: true };
  return <main style={{ display: "flex", width: "100%", height: "100%", background: "var(--color-background)" }}>
    <aside style={{ width: sidebarWidth, maxWidth: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "flex-end", background: "var(--color-sidebar)" }}>
      {injected ? <WrappedFooter services={services} {...footerProps} /> : <WorkspaceSidebarFooter {...footerProps} />}
    </aside>
  </main>;
}
const WrappedFooter = createAiscooAccountAvatarRoot(WorkspaceSidebarFooter);
window.avatarSmoke.ready = providerConnection.ready.then(() => {
  applyTheme("zai-light");
  flushSync(() => renderer.render(<ServiceProvider services={services}><PlatformProvider platform={platform}>
    <StoreProvider broadcastService={broadcast}><ZCodeIntlProvider initialLocale="en-US"><TooltipProvider><Scene /></TooltipProvider></ZCodeIntlProvider></StoreProvider>
  </PlatformProvider></ServiceProvider>));
});
`,
      },
      absWorkingDir: root,
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
    await writeFile(join(temporary, "renderer.js"), renderer.outputFiles[0].text);
    await writeFile(
      join(temporary, "security.js"),
      `window.avatarCspViolations=[];window.avatarRuntimeErrors=[];document.addEventListener("securitypolicyviolation",event=>window.avatarCspViolations.push({directive:event.effectiveDirective,blocked:event.blockedURI,source:event.sourceFile,line:event.lineNumber,column:event.columnNumber,sample:event.sample}));window.addEventListener("error",event=>{if(event.message)window.avatarRuntimeErrors.push(event.message)});window.addEventListener("unhandledrejection",event=>window.avatarRuntimeErrors.push(String(event.reason?.stack??event.reason)));`,
    );
    await writeFile(
      join(temporary, "index.html"),
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><script src="/security.js"></script><link rel="stylesheet" href="/@fs${root}/packages/ui/src/styles.css"></head><body><div id="root"></div><script type="module" src="/renderer.js"></script></body></html>`,
    );
    const { createServer } = await import(requireDesktop.resolve("vite"));
    const { default: tailwindcss } = await import(requireDesktop.resolve("@tailwindcss/vite"));
    vite = await createServer({
      configFile: false,
      root: temporary,
      plugins: [
        tailwindcss(),
        {
          name: "avatar-decode-fixture",
          configureServer(server) {
            server.middlewares.use("/broken-avatar.svg", (_request, response) => {
              response.setHeader("Content-Type", "image/svg+xml");
              response.end("<svg");
            });
          },
        },
      ],
      server: {
        host: "127.0.0.1",
        port: 0,
        fs: { allow: [root, temporary] },
        headers: {
          "Content-Security-Policy":
            "default-src 'none'; script-src 'self' 'report-sample'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:*; object-src 'none'; base-uri 'none'; form-action 'none'",
        },
      },
    });
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    await app.whenReady();
    win = new BrowserWindow({
      show: true,
      width: 960,
      height: 720,
      webPreferences: {
        partition: `avatar-smoke-${process.pid}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const externalRequests = [];
    const requests = [];
    const rendererErrors = [];
    win.webContents.session.webRequest.onBeforeRequest(
      { urls: ["<all_urls>"] },
      (details, callback) => {
        const url = new URL(details.url);
        const external =
          ["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
          !(url.hostname === "127.0.0.1" && url.port === new URL(origin).port);
        if (external) externalRequests.push(details.url);
        else if (["http:", "https:"].includes(url.protocol)) requests.push(url.pathname);
        callback({ cancel: external });
      },
    );
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") rendererErrors.push(event.message);
    });
    win.webContents.debugger.attach("1.3");
    const observe = (expression) => win.webContents.executeJavaScript(expression);
    const frames = () =>
      observe(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
    const waitFor = (expression) =>
      observe(`new Promise((resolve, reject) => {
      const check = () => { if (${expression}) { clearTimeout(deadline); observer.disconnect(); document.removeEventListener('load',check,true); document.removeEventListener('error',check,true); resolve(true); } };
      const observer = new MutationObserver(check);
      observer.observe(document.body, {subtree:true,childList:true,attributes:true});
      document.addEventListener('load',check,true); document.addEventListener('error',check,true);
      const deadline = setTimeout(() => { observer.disconnect(); document.removeEventListener('load',check,true); document.removeEventListener('error',check,true); reject(new Error('Avatar condition failed: ' + ${JSON.stringify(expression)} + ' body=' + document.body.innerText)); }, 6000);
      check();
    })`);
    const change = async (scene) => {
      await observe(`window.avatarSmoke.change(${JSON.stringify(scene)})`);
      await frames();
    };
    const avatar = (container = trigger) =>
      observe(`(async () => {
      const holder = document.querySelector(${JSON.stringify(container)});
      const image = holder?.querySelector('[data-slot="avatar"] img');
      if (!image) return null;
      await image.decode();
      const rect=image.getBoundingClientRect(), style=getComputedStyle(image);
      return {src:image.getAttribute('src'),slot:image.dataset.slot??null,alt:image.alt,complete:image.complete,naturalWidth:image.naturalWidth,naturalHeight:image.naturalHeight,width:rect.width,height:rect.height,objectFit:style.objectFit,borderRadius:style.borderRadius};
    })()`);
    const waitForAvatar = (slot) =>
      waitFor(
        `document.querySelector(${JSON.stringify(trigger)})?.querySelector(${JSON.stringify(slot === "real" ? '[data-slot="avatar-image"]' : '[data-slot="avatar-fallback"] img')})?.complete`,
      );
    const openMenu = async () => {
      if (
        await observe(
          `document.querySelector(${JSON.stringify(trigger)}).getAttribute('aria-expanded') === 'true'`,
        )
      )
        return;
      const position = await observe(
        `(() => { const r=document.querySelector(${JSON.stringify(trigger)}).getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`,
      );
      await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        buttons: 0,
        ...position,
      });
      for (const type of ["mousePressed", "mouseReleased"])
        await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type,
          button: "left",
          buttons: type === "mousePressed" ? 1 : 0,
          clickCount: 1,
          ...position,
        });
      await waitFor(
        `document.querySelector(${JSON.stringify(trigger)}).getAttribute('aria-expanded') === 'true' && document.querySelector(${JSON.stringify(header)})`,
      );
      await observe(
        `Promise.all(document.querySelector(${JSON.stringify(menu)}).getAnimations({subtree:true}).filter(a=>a.effect.getComputedTiming().iterations!==Infinity).map(a=>a.finished))`,
      );
      await frames();
    };
    const closeMenu = async () => {
      await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      await win.webContents.debugger.sendCommand("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Escape",
        code: "Escape",
        windowsVirtualKeyCode: 27,
      });
      await waitFor(
        `document.querySelector(${JSON.stringify(trigger)}).getAttribute('aria-expanded') === 'false'`,
      );
      await observe(
        `Promise.all([...(document.querySelector(${JSON.stringify(menu)})?.getAnimations({subtree:true})??[])].filter(a=>a.effect.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{})))`,
      );
      await frames();
    };
    const userA = { id: "42", username: "ada42", displayName: "Ada42" };
    const userB = { id: "43", username: "ben43", displayName: "Ben43" };
    stage = "missing avatar and actual SVG decode";
    await win.loadURL(origin);
    await waitFor("window.avatarSmoke?.ready");
    await observe("window.avatarSmoke.ready");
    await waitForAvatar("generated");
    const generatedA = await avatar();
    assert.match(generatedA.src, /^data:image\/svg\+xml;charset=utf-8,/);
    assert.ok(generatedA.complete && generatedA.naturalWidth > 0 && generatedA.naturalHeight > 0);
    const svg = decodeURIComponent(generatedA.src.slice(generatedA.src.indexOf(",") + 1));
    assert.doesNotMatch(svg, /<script|<image|<foreignObject|https?:\/\/(?!www\.w3\.org)/u);
    const svgSha256 = createHash("sha256").update(svg).digest("hex");
    assert.equal(svgSha256, "f0d93b3eb893342c11ba3dfd82ac35b8e525bd4658437d8be1bd4ef1f3d91892");
    await openMenu();
    assert.deepEqual(
      await avatar(header),
      generatedA,
      "real profile menu header uses the same decoded image",
    );
    await waitFor(
      "document.querySelector('[data-testid=\"profile-menu-plan\"]')?.textContent.includes('Fixture')",
    );
    await closeMenu();

    stage = "real image priority and failed/blank image fallback";
    const realSource = `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64"><rect width="64" height="64" fill="#2463eb"/><circle cx="32" cy="32" r="16" fill="#ffffff"/></svg>')}`;
    await change({ user: { ...userA, avatarUrl: realSource } });
    await waitForAvatar("real");
    assert.equal((await avatar()).src, realSource);
    assert.equal((await avatar()).slot, "avatar-image");
    assert.equal(
      await observe(
        `document.querySelector(${JSON.stringify(trigger)}).querySelector('[data-slot="avatar-fallback"]')`,
      ),
      null,
    );
    await openMenu();
    await waitFor(
      `document.querySelector(${JSON.stringify(header)})?.querySelector('[data-slot="avatar-image"]')?.complete`,
    );
    assert.equal((await avatar(header)).src, realSource);
    await closeMenu();
    for (const avatarUrl of [`${origin}/broken-avatar.svg`, "", " \t\n"]) {
      await change({ user: { ...userA, avatarUrl } });
      await waitForAvatar("generated");
      assert.equal(
        (await avatar()).src,
        generatedA.src,
        `fallback after ${JSON.stringify(avatarUrl)}`,
      );
    }
    assert.ok(
      requests.includes("/broken-avatar.svg"),
      "Chromium attempted to load the broken real image",
    );

    stage = "rename, A42 to B43 to A42, and sign-in restoration";
    await change({ user: { ...userA, displayName: "Renamed Ada42" } });
    await waitForAvatar("generated");
    assert.equal((await avatar()).src, generatedA.src);
    assert.equal((await avatar()).alt, "Renamed Ada42");
    await change({ user: userB });
    await waitForAvatar("generated");
    const generatedB = await avatar();
    assert.notEqual(generatedB.src, generatedA.src);
    await change({ user: userA });
    await waitForAvatar("generated");
    assert.equal((await avatar()).src, generatedA.src);
    await change({ user: null, restoring: true });
    assert.deepEqual(
      await observe(
        `(() => {const e=document.querySelector(${JSON.stringify(trigger)});return {image:!!e.querySelector('img'),spinner:!!e.querySelector('.lucide-loader-circle'),user:!!e.querySelector('.lucide-user'),label:e.querySelector('.sr-only')?.textContent};})()`,
      ),
      { image: false, spinner: true, user: false, label: "Loading..." },
    );
    await change({ user: null, restoring: false });
    assert.deepEqual(
      await observe(
        `(() => {const e=document.querySelector(${JSON.stringify(trigger)});return {image:!!e.querySelector('img'),spinner:!!e.querySelector('.animate-spin'),user:!!e.querySelector('.lucide-user')};})()`,
      ),
      { image: false, spinner: false, user: true },
    );
    await change({ user: userA });
    await waitForAvatar("generated");
    assert.equal((await avatar()).src, generatedA.src);

    stage = "other provider and missing identity fallback";
    for (const user of [
      { id: "bigmodel-customer", username: "bigmodel", displayName: "BigModel" },
      { id: "zai-user", username: "zai", displayName: "Zai" },
      { id: "unknown", username: "user", displayName: "User" },
    ]) {
      await change({ user });
      await waitFor(
        `document.querySelector(${JSON.stringify(trigger)})?.querySelector('[data-slot="avatar-fallback"]')?.textContent === ${JSON.stringify(user.displayName[0])}`,
      );
      assert.equal(await avatar(), null);
    }
    await change({ user: { id: "", username: "user", displayName: "User" } });
    await waitFor(
      `document.querySelector(${JSON.stringify(trigger)})?.querySelector('[data-slot="avatar-fallback"] .lucide-user')`,
    );
    assert.equal(await avatar(), null);
    await change({ user: userA });
    await waitForAvatar("generated");

    stage = "official numeric identity and delayed provider verification";
    await change({ user: userA, activeProvider: "zai" });
    await waitFor(
      `document.querySelector(${JSON.stringify(trigger)})?.querySelector('[data-slot="avatar-fallback"]')?.textContent === 'A'`,
    );
    assert.equal(await avatar(), null);
    await change({ activeProvider: "new-api" });
    await waitForAvatar("generated");
    assert.equal((await avatar()).src, generatedA.src);

    stage = "upstream default without avatar provider";
    await change({ injected: false });
    await waitFor(
      `document.querySelector(${JSON.stringify(trigger)})?.querySelector('[data-slot="avatar-fallback"]')?.textContent === 'A'`,
    );
    assert.equal(await avatar(), null);
    await openMenu();
    assert.equal(
      await observe(
        `document.querySelector(${JSON.stringify(header)}).querySelector('[data-slot="avatar-fallback"]').textContent`,
      ),
      "A",
    );
    assert.equal(await avatar(header), null);
    await closeMenu();
    await change({ injected: true });
    await waitForAvatar("generated");

    stage = "compiled styles, light/dark and wide/narrow screenshots";
    const screenshots = [];
    const geometry = [];
    for (const theme of ["zai-light", "zai-dark"]) {
      for (const [size, width, height, sidebarWidth] of [
        ["wide", 960, 720, 320],
        ["narrow", 360, 740, 224],
      ]) {
        win.setContentSize(width, height);
        await change({
          theme,
          sidebarWidth,
          user: { ...userA, displayName: "Ada42 · A long account display name" },
        });
        await waitForAvatar("generated");
        await openMenu();
        const footerImage = await avatar();
        const headerImage = await avatar(header);
        assert.equal(footerImage.src, generatedA.src);
        assert.equal(headerImage.src, generatedA.src);
        for (const image of [footerImage, headerImage]) {
          assert.equal(image.width, 32, "real Tailwind avatar width");
          assert.equal(image.height, 32, "real Tailwind avatar height");
          assert.equal(image.objectFit, "cover");
          assert.ok(parseFloat(image.borderRadius) >= 16, "avatar remains circular");
        }
        const layout = await observe(`(() => {
          const e=document.querySelector(${JSON.stringify(menu)}),r=e.getBoundingClientRect(),a=document.querySelector('aside').getBoundingClientRect();
          return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,dark:document.documentElement.classList.contains('dark'),menu:{left:r.left,right:r.right,top:r.top,bottom:r.bottom,background:getComputedStyle(e).backgroundColor},sidebarRight:a.right};
        })()`);
        assert.equal(layout.dark, theme === "zai-dark");
        assert.ok(layout.scrollWidth <= width, "no horizontal overflow");
        assert.ok(layout.menu.left >= -1 && layout.menu.right <= width + 1);
        assert.ok(layout.menu.top >= -1 && layout.menu.bottom <= height + 1);
        const screenshot = join(evidenceDirectory, `account-avatar-${theme}-${size}.png`);
        await writeFile(screenshot, (await win.webContents.capturePage()).toPNG());
        screenshots.push(screenshot);
        geometry.push({ theme, size, ...layout });
        await closeMenu();
      }
    }
    assert.notEqual(
      geometry[0].menu.background,
      geometry[2].menu.background,
      "actual compiled theme colors change",
    );
    stage = "renderer reload and CSP/network audit";
    const previousAudit = await observe(
      "({csp:window.avatarCspViolations,errors:window.avatarRuntimeErrors})",
    );
    await win.loadURL(origin);
    await waitFor("window.avatarSmoke?.ready");
    await observe("window.avatarSmoke.ready");
    await waitForAvatar("generated");
    assert.equal((await avatar()).src, generatedA.src, "same ID survives renderer reload");
    const audit = await observe(
      "({csp:window.avatarCspViolations,errors:window.avatarRuntimeErrors,entitlementCalls:window.avatarSmoke.entitlementCalls})",
    );
    const bundleLines = renderer.outputFiles[0].text.split("\n");
    const cspWarnings = [];
    for (const violation of [...previousAudit.csp, ...audit.csp]) {
      // Zod v4 util.js:218 的空 Function 能力探测会被 CSP 拒绝后自行降级。
      // 只允许此确切行、空函数 sample 与 allowsEval 上下文；头像及其它脚本拒绝继续失败。
      const context = bundleLines
        .slice(Math.max(0, violation.line - 14), violation.line + 5)
        .join("\n");
      const knownZodProbe =
        violation.directive === "script-src" &&
        violation.blocked === "eval" &&
        violation.source === `${origin}/renderer.js` &&
        violation.sample === "(function anonymous(\n) {\n\n})" &&
        bundleLines[violation.line - 1]?.trim() === 'new F3("");' &&
        context.includes("var allowsEval =") &&
        context.includes("globalConfig.jitless");
      assert.ok(knownZodProbe, `Unexpected CSP violation: ${JSON.stringify(violation)}`);
      cspWarnings.push({ dependency: "zod/v4/core/util.js:218 allowsEval", ...violation });
    }
    assert.deepEqual([...previousAudit.errors, ...audit.errors], []);
    assert.deepEqual(rendererErrors, []);
    assert.deepEqual(
      externalRequests,
      [],
      "no Multiavatar/CDN or other external request was attempted",
    );
    assert.ok(
      audit.entitlementCalls.length > 0,
      "real Footer usage hook received its Native snapshot",
    );
    assert.ok(audit.entitlementCalls.every((id) => id === "account:new-api-anthropic-messages"));
    const result = {
      realFooterAndProfileMenu: true,
      svgDecodedWithCsp: true,
      realAvatarPriority: true,
      brokenAndBlankAvatarFallback: true,
      renameAndAccountSwitchStable: true,
      authRestoreAndSignedOutIconsUnchanged: true,
      otherProviderFallbackUnchanged: true,
      officialNumericProviderFallbackUnchanged: true,
      missingIdentityNeutralIcon: true,
      withoutProviderInitialUnchanged: true,
      rendererReloadStable: true,
      noExternalRequests: true,
      svgSha256,
      cspWarnings,
      screenshots,
      geometry,
    };
    await writeFile(
      join(evidenceDirectory, "account-avatar-electron-result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } catch (error) {
    exitCode = 1;
    console.error(`Account avatar Electron smoke failed at ${stage}`, error);
    if (win && !win.isDestroyed()) {
      console.error(
        await win.webContents.executeJavaScript(
          `({bodyPointerEvents:getComputedStyle(document.body).pointerEvents,expanded:document.querySelector(${JSON.stringify(trigger)})?.getAttribute('aria-expanded'),menu:document.querySelector(${JSON.stringify(menu)})?.dataset.state,csp:window.avatarCspViolations,errors:window.avatarRuntimeErrors})`,
        ),
      );
    }
  } finally {
    clearTimeout(deadline);
    await vite?.close();
    // 保留窗口直到清理完成，防止默认退出 0 掩盖断言失败。
    win?.destroy();
    app.exit(exitCode);
  }
}

void (process.versions.electron ? runElectron() : launchStandalone()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
