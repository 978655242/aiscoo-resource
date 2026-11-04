import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, WebContentsView, webContents, session } from "electron";
import { assertOrdinaryPlanIsolation } from "./aiscooAdminOrdinaryGuestAssertions.mjs";
import {
  assertInvalidDisplayContexts,
  assertNativeDisplayCookie,
} from "./aiscooAdminNativeDisplayCookieAssertions.mjs";
import { createHandoffFixtureServer } from "./aiscooAdminWebHandoffFixtureServer.mjs";
import { assertDelayedDisplayCookieOwnerLoss } from "./aiscooAdminWebHandoffCookieAwaitAssertions.mjs";
import { buildOfficialPlanPreload } from "./aiscooAdminWebHandoffOfficialPreload.mjs";

import {
  setNativePlanWebviewOwner,
  authorizeNativePlanWebHandoff,
  registerNativePlanWebviewIpc,
  attachNativePlanWebview,
  canAttachNativePlanWebview,
} from "../src/main/nativePlanWebviewManager.ts";
import { createBrowserWindow } from "../src/main/desktopWindowChrome.ts";
import {
  assertNetworkCapturePreservesPlanGuards,
  assertNativeObserverPreservesPlanOwner,
} from "./aiscooAdminWebRequestGuardAssertions.mjs";
process.env.VITE_ZCODE_E2E_STORE_BRIDGE = "1";

assert.ok(process.argv[2], "Launch this fixture with runAiscooAdminElectronSmokes.mjs");

// XCODE: Main ESM 在模块求值结束后才触发 ready，异步 smoke 不阻塞入口模块。
async function run() {
  const dataDirectory = await mkdtemp(join(process.argv[2], "xcode-handoff-electron-"));
  app.setPath("userData", dataDirectory);
  const { origin, counters, close: closeFixtureServer } = await createHandoffFixtureServer();
  const deadline = setTimeout(() => {
    console.error("Native handoff Electron regression timed out");
    app.exit(1);
  }, 40_000);
  let win;
  let ordinaryWindow;
  let exitCode = 0;
  try {
    await app.whenReady();
    registerNativePlanWebviewIpc();
    process.env.ELECTRON_RENDERER_URL = origin;
    process.env.ZCODE_ENDPOINT_ORIGIN = origin;
    ordinaryWindow = createBrowserWindow({
      iconPath: "",
      preloadPath: fileURLToPath(
        new URL("./aiscooAdminWebHandoffElectron.preload.cjs", import.meta.url),
      ),
      logger: console,
    });
    // XCODE: 源码 Main 没有产物 .cjs；只为真实官方 preload 编译临时产物，不替换其 bridge 行为。
    const officialPreloadPath = join(dataDirectory, "official-plan-preload.cjs");
    await writeFile(officialPreloadPath, await buildOfficialPlanPreload(origin));
    ordinaryWindow.webContents.on("will-attach-webview", (_event, preferences) => {
      if (
        preferences.preload ===
        fileURLToPath(new URL("../out/preload/codingPlanWebview.cjs", import.meta.url))
      )
        preferences.preload = officialPreloadPath;
    });
    ordinaryWindow.hide();
    if (ordinaryWindow.webContents.isLoading())
      await new Promise((resolve) => ordinaryWindow.webContents.once("did-finish-load", resolve));
    const beforeHostFetch = counters.private;
    const hostFetchRejected = await ordinaryWindow.webContents.executeJavaScript(
      `fetch(${JSON.stringify(`${origin}/xcode/plans?handoff=host-default`)}).then(() => false, () => true)`,
    );
    const hostCookieCount = (
      await ordinaryWindow.webContents.session.cookies.get({
        url: `${origin}/api/xcode/v1/web/view`,
      })
    ).length;
    assert.deepEqual(
      {
        rejected: hostFetchRejected,
        privateRequests: counters.private - beforeHostFetch,
        cookieCount: hostCookieCount,
      },
      { rejected: true, privateRequests: 0, cookieCount: 0 },
      "host/default Session must not redeem a private ticket before any guest exists",
    );
    const createWebviewGuest = async (partition, src = "about:blank") => {
      const id = await ordinaryWindow.webContents
        .executeJavaScript(`new Promise((resolve, reject) => {
      const view = document.createElement('webview');
      view.style.cssText = 'width:500px;height:300px';
      if (${JSON.stringify(partition)}) view.setAttribute('partition', ${JSON.stringify(partition)});
      view.src = ${JSON.stringify(src)};
      view.addEventListener('did-finish-load', () => resolve(view.getWebContentsId()), { once: true });
      view.addEventListener('did-fail-load', () => reject(new Error('webview guest failed')), { once: true });
      document.body.append(view);
    })`);
      return webContents.fromId(id);
    };
    await assertOrdinaryPlanIsolation(
      ordinaryWindow,
      origin,
      createWebviewGuest,
      () => counters.private,
    );
    await assertNetworkCapturePreservesPlanGuards({
      ordinaryWindow,
      origin,
      createWebviewGuest,
      counters,
    });

    const displayContext = {
      version: 1,
      theme: "light",
      locale: "zh-CN",
      initialAudience: "team",
      uiFontSizePx: 14,
    };
    const assertDisplayCookie = (partition, cookieOrigin = origin) =>
      assertNativeDisplayCookie(session.fromPartition(partition), cookieOrigin, displayContext);
    const nativeRequest = {
      url: `${origin}/xcode/plans?handoff=attached-native`,
      ownerGeneration: 10,
      displayContext,
    };
    await setNativePlanWebviewOwner(ordinaryWindow.id, { origin, ownerGeneration: 10 });
    assert.equal(authorizeNativePlanWebHandoff(ordinaryWindow.id, nativeRequest), true);
    const nativePrepared = await ordinaryWindow.webContents.executeJavaScript(
      `window.nativeHandoffTest.prepare(${JSON.stringify(nativeRequest)})`,
    );
    await assertDisplayCookie(nativePrepared.partition);
    const nativeAttached = await createWebviewGuest(nativePrepared.partition, nativeRequest.url);
    assert.equal(
      canAttachNativePlanWebview(ordinaryWindow.id, nativePrepared.partition, nativeRequest.url),
      false,
      "a claimed partition must reject repeated attachment",
    );
    assert.match(
      await nativeAttached.executeJavaScript("document.body.textContent"),
      /Assigned plan/,
    );
    assert.ok(
      counters.bootstrap > 0,
      "the actual head bootstrap must load through the guest guard",
    );
    assert.deepEqual(
      await nativeAttached.executeJavaScript(`({
        audience: document.documentElement.dataset.zenPlanAudience,
        theme: document.documentElement.dataset.zenPlanTheme,
        locale: document.documentElement.dataset.zenPlanLocale,
        font: document.documentElement.dataset.zenPlanFontSize,
        dark: document.documentElement.classList.contains("dark"),
        lang: document.documentElement.lang,
        uiFont: document.documentElement.style.getPropertyValue("--ui-font-size")
      })`),
      {
        audience: "team",
        theme: "light",
        locale: "zh-CN",
        font: "14",
        dark: false,
        lang: "zh-CN",
        uiFont: "14px",
      },
      "same-origin static bootstrap must apply App display before the guest app starts",
    );
    assert.deepEqual(
      await nativeAttached.executeJavaScript(
        "[typeof window.zcodeBridge, typeof window.zcode, typeof require, typeof process]",
      ),
      ["undefined", "undefined", "undefined", "undefined"],
    );
    const attachedSession = nativeAttached.session;
    assert.ok(
      (await attachedSession.cookies.get({ url: `${origin}/api/xcode/v1/web/view` })).some(
        (cookie) => cookie.name === "xcode_plan",
      ),
    );
    assert.deepEqual(
      await nativeAttached.executeJavaScript(
        "fetch('/api/xcode/v1/web/view').then(response => response.json())",
      ),
      { plan: "Assigned plan" },
    );
    const beforeOtherTicket = counters.private;
    assert.equal(
      await nativeAttached.executeJavaScript(
        "fetch('/xcode/plans?handoff=other-owner').then(() => false, () => true)",
      ),
      true,
    );
    assert.equal(
      await nativeAttached.executeJavaScript(
        "fetch('/xcode/%70lans?handoff=other-owner').then(() => false, () => true)",
      ),
      true,
    );
    assert.equal(
      counters.private,
      beforeOtherTicket,
      "Native XHR cannot replace the current owner's Cookie with another ticket",
    );
    const rogueView = new WebContentsView({
      webPreferences: {
        partition: nativePrepared.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const beforeRogue = counters.private;
    try {
      await assert.rejects(
        rogueView.webContents.loadURL(nativeRequest.url),
        "knowing an admitted partition must not admit an untracked guest",
      );
      assert.equal(counters.private, beforeRogue);
    } finally {
      rogueView.webContents.close({ waitForBeforeUnload: false });
    }
    await assertNativeObserverPreservesPlanOwner({
      nativeAttached,
      origin,
      partition: nativePrepared.partition,
      initialUrl: nativeRequest.url,
      counters,
    });
    await setNativePlanWebviewOwner(ordinaryWindow.id, null);
    assert.equal(nativeAttached.isDestroyed(), true);
    assert.equal((await attachedSession.cookies.get({})).length, 0);

    win = new BrowserWindow({
      show: false,
      webPreferences: {
        preload: fileURLToPath(
          new URL("./aiscooAdminWebHandoffElectron.preload.cjs", import.meta.url),
        ),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    await win.loadURL("data:text/html,<html><body>Isolated handoff harness</body></html>");
    const requestFor = (ownerGeneration) => ({
      url: `${origin}/xcode/plans?handoff=short-code-${ownerGeneration}`,
      ownerGeneration,
      displayContext,
    });
    const prepare = (ownerGeneration) =>
      win.webContents.executeJavaScript(
        `window.nativeHandoffTest.prepare(${JSON.stringify(requestFor(ownerGeneration))})`,
      );
    await setNativePlanWebviewOwner(win.id, { origin, ownerGeneration: 1 });
    assert.equal(authorizeNativePlanWebHandoff(win.id, requestFor(1)), true);
    // XCODE: Reject display/identity pollution before consuming the legitimate Host admission.
    await assertInvalidDisplayContexts(win, requestFor(1), displayContext);
    await assert.rejects(
      win.webContents.executeJavaScript(
        `window.nativeHandoffTest.prepare(${JSON.stringify({
          url: requestFor(1).url,
          ownerGeneration: 1,
        })})`,
      ),
      /XCODE_STALE_WEB_HANDOFF/,
      "old untyped prepare requests must not get a compatibility bypass",
    );
    const a = await prepare(1);
    await assertDisplayCookie(a.partition);
    await assert.rejects(prepare(1), /XCODE_STALE_WEB_HANDOFF/, "reload must mint a new handoff");
    const guestView = new WebContentsView({
      webPreferences: {
        partition: a.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.contentView.addChildView(guestView);
    guestView.setBounds({ x: 0, y: 0, width: 500, height: 300 });
    const guest = guestView.webContents;
    const partitionSession = guest.session;
    attachNativePlanWebview(win.id, a.partition, requestFor(1).url, guest, console);
    await guest.loadURL(requestFor(1).url);
    assert.ok(counters.css > 0, "the first same-origin stylesheet must load");
    assert.equal(
      await guest.executeJavaScript("getComputedStyle(document.body).color"),
      "rgb(1, 2, 3)",
    );
    assert.equal(counters.foreign, 0, "a foreign resource must not receive the short handoff");
    assert.ok(
      (await partitionSession.cookies.get({ url: `${origin}/api/xcode/v1/web/view` })).some(
        (cookie) => cookie.name === "xcode_plan" && cookie.httpOnly,
      ),
    );

    const clearStorage = partitionSession.clearStorageData.bind(partitionSession);
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    // Delay the real Session cleanup; do not replace its result or storage behavior.
    partitionSession.clearStorageData = async (options) => {
      await gate;
      return clearStorage(options);
    };
    const oldCleanup = setNativePlanWebviewOwner(win.id, null);
    await setNativePlanWebviewOwner(win.id, { origin, ownerGeneration: 2 });
    release();
    await oldCleanup;
    partitionSession.clearStorageData = clearStorage;
    assert.equal(authorizeNativePlanWebHandoff(win.id, requestFor(2)), true);
    await assert.rejects(
      win.webContents.executeJavaScript(
        `window.nativeHandoffTest.prepare(${JSON.stringify({ ...requestFor(1), ownerGeneration: 2 })})`,
      ),
      /XCODE_STALE_WEB_HANDOFF/,
    );
    const b = await prepare(2);
    await assertDisplayCookie(b.partition);
    assert.ok(
      canAttachNativePlanWebview(win.id, b.partition, requestFor(2).url),
      "late A cleanup must not erase B's policy",
    );
    assert.notEqual(a.partition, b.partition);
    assert.equal(
      (await partitionSession.cookies.get({})).length,
      0,
      "A's real cookies must be cleared",
    );
    await assert.rejects(prepare(1), /XCODE_STALE_WEB_HANDOFF/);
    await assert.rejects(prepare(2), /XCODE_STALE_WEB_HANDOFF/);

    // XCODE: Pause the actual Cookie write, then replace A with a fully attached B.
    await assertDelayedDisplayCookieOwnerLoss({
      win,
      origin,
      requestFor,
      prepare,
      assertDisplayCookie,
    });

    const secureOrigin = "https://native.example";
    const secureRequest = {
      url: `${secureOrigin}/xcode/plans?handoff=secure-cookie`,
      ownerGeneration: 5,
      displayContext,
    };
    await setNativePlanWebviewOwner(win.id, { origin: secureOrigin, ownerGeneration: 5 });
    assert.equal(authorizeNativePlanWebHandoff(win.id, secureRequest), true);
    const secure = await win.webContents.executeJavaScript(
      `window.nativeHandoffTest.prepare(${JSON.stringify(secureRequest)})`,
    );
    await assertDisplayCookie(secure.partition, secureOrigin);
    const officialUrl = `${origin}/coding-plan?embedded=app`;
    const officialGuest = await createWebviewGuest("persist:official-plan-regression", officialUrl);
    assert.equal(
      await officialGuest.executeJavaScript("typeof window.zcodeBridge?.notifyPurchaseComplete"),
      "function",
      "ordinary official purchasing must keep its actual completion bridge",
    );
    assert.match(
      await officialGuest.executeJavaScript("document.body.textContent"),
      /Ordinary browsing/,
    );
    console.log(
      JSON.stringify({
        ordinaryLateRequestsDenied: true,
        ordinaryInitialAttachDenied: true,
        unrelatedBrowsingUnaffected: true,
        networkCaptureTogglesPreservePrivateGuards: true,
        lastObserverRemovalPreservesGuard: true,
        nativeObserverTogglesPreserveOwnerAndGuest: true,
        sameOriginCss: true,
        sameOriginBootstrap: true,
        hostOnlySessionDisplayCookie: true,
        secureDisplayCookieOnHttps: true,
        cookieAwaitOwnerLossRejected: true,
        lateCookieClearsOnlyA: true,
        oldAttachDenied: true,
        foreignResourceDenied: true,
        nullToNewOwner: true,
        oldPartitionCookiesCleared: true,
        relabeledOldUrlDenied: true,
      }),
    );
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    clearTimeout(deadline);
    if (ordinaryWindow && !ordinaryWindow.isDestroyed()) {
      await setNativePlanWebviewOwner(ordinaryWindow.id, null);
    }
    if (win && !win.isDestroyed()) {
      await setNativePlanWebviewOwner(win.id, null);
    }
    await closeFixtureServer();
    app.exit(exitCode);
  }
}
void run().catch((error) => {
  console.error("Native handoff bootstrap failed", error);
  app.exit(1);
});
