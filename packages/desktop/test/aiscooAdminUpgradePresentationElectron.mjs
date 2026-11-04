import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, ipcMain } from "electron";
import { build } from "esbuild";
import { createBrowserWindow } from "../src/main/desktopWindowChrome.ts";
import {
  authorizeNativePlanWebHandoff,
  registerNativePlanWebviewIpc,
  setNativePlanWebviewOwner,
} from "../src/main/nativePlanWebviewManager.ts";
import { fixtureView } from "./aiscooAdminUpgradeFixtureView.mjs";
import { createUpgradeFixtureServer } from "./aiscooAdminUpgradeFixtureServer.mjs";
import { createViewerHarness } from "./aiscooAdminUpgradeViewerHarness.mjs";
import { runUpgradeZoomMatrix } from "./aiscooAdminUpgradeZoomMatrix.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
// XCODE: 与 handoff smoke 共用受审后端来源，品牌迁名不再落到不存在的旧目录。
const webRoot = resolve(
  process.env.XCODE_AISCOO_ADMIN_SOURCE_DIR?.trim() || resolve(root, "../aiscoo-admin"),
  "web",
);
const requireDesktop = createRequire(new URL("../package.json", import.meta.url));
const requireRoot = createRequire(new URL("../../../package.json", import.meta.url));

assert.ok(process.argv[2], "Launch this fixture with runAiscooAdminElectronSmokes.mjs");

async function run() {
  const temporary = await mkdtemp(join(process.argv[2], "xwork-upgrade-electron-"));
  app.setPath("userData", join(temporary, "profile"));
  let win, vite, fixture, fixtureOrigin;
  const counters = { writes: 0 };
  const result = [];
  let exitCode = 0;
  const deadline = setTimeout(
    () => {
      console.error("Upgrade presentation timed out");
      app.exit(1);
    },
    process.env.XCODE_UPGRADE_SMOKE_SEED ? 240_000 : 180_000,
  );
  try {
    const liveSeed = process.env.XCODE_UPGRADE_SMOKE_SEED
      ? JSON.parse(await readFile(process.env.XCODE_UPGRADE_SMOKE_SEED, "utf8"))
      : null;
    let ownerGeneration = 1;
    let currentUser = 0;
    if (!liveSeed) {
      // XCODE: 缺失真实 dist 时在挂载 guest 前报来源错误，不把 404 空页误报 viewerContentMissing。
      const entryPath = resolve(webRoot, "dist/index.html");
      await readFile(entryPath, "utf8").catch((cause) => {
        throw new Error(
          `Native upgrade dist unavailable: ${entryPath}; set XCODE_AISCOO_ADMIN_SOURCE_DIR`,
          { cause },
        );
      });
      fixture = createUpgradeFixtureServer({ webRoot, counters });
      fixture.state.viewer = fixtureView();
      fixtureOrigin = await fixture.start();
    }
    const origin = liveSeed?.origin || fixtureOrigin;
    await writeFile(
      join(temporary, "preload.cjs"),
      `const {contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("upgradeSmoke",{handoff:()=>ipcRenderer.invoke("upgrade-smoke-handoff"),prepare:request=>ipcRenderer.invoke("zcode:native-plan-webview-prepare",request),close:partition=>ipcRenderer.invoke("zcode:native-plan-webview-close",partition),onInvalidated:handler=>{const listener=(_,partition)=>handler(partition);ipcRenderer.on("zcode:native-plan-webview-invalidated",listener);return()=>ipcRenderer.removeListener("zcode:native-plan-webview-invalidated",listener)}});`,
    );
    const renderer = await build({
      stdin: {
        resolveDir: root,
        loader: "tsx",
        contents: `
      import React from "react";
      import {createRoot} from "react-dom/client";
      import {flushSync} from "react-dom";
      import {NativePlanEmbeddedWebviewDialog} from "./packages/ui/src/settings/NativePlanEmbeddedWebviewDialog.tsx";
      import {ServiceProvider} from "./packages/ui/src/hooks/useServices.tsx";
      import {PlatformProvider} from "./packages/ui/src/hooks/usePlatform.tsx";
      import {ZCodeIntlProvider} from "./packages/ui/src/i18n/IntlProvider.tsx";
      import {StoreProvider} from "./packages/ui/src/store/StoreProvider.tsx";
      import {applyTheme} from "./packages/ui/src/useTheme.ts";
      import {applyUiFontSizePx,UI_FONT_SIZE_STORAGE_KEY} from "./packages/ui/src/lib/uiFontSize.ts";
      const bridge=window.upgradeSmoke;
      const services={codingPlanSubscriptionService:{createPlanWebHandoff:()=>bridge.handoff()},providerSettingsService:{refresh:async()=>{}}};
      const platform={prepareNativePlanWebview:request=>bridge.prepare(request),closeNativePlanWebview:partition=>bridge.close(partition),onNativePlanWebviewInvalidated:handler=>bridge.onInvalidated(handler)};
      const broadcastService={send:async()=>{},onMessage:()=>()=>{}};
      const renderer=createRoot(document.getElementById("root"));
      let scene=0;
      window.mountUpgrade=({theme,locale,font,audience})=>{applyTheme(theme);applyUiFontSizePx(font);localStorage.setItem("zcode-theme",theme);localStorage.setItem(UI_FONT_SIZE_STORAGE_KEY,String(font));flushSync(()=>renderer.render(<ServiceProvider services={services}><PlatformProvider platform={platform}><StoreProvider key={++scene} broadcastService={broadcastService}><ZCodeIntlProvider initialLocale={locale}><NativePlanEmbeddedWebviewDialog initialAudience={audience} onClose={()=>flushSync(()=>renderer.render(null))}/></ZCodeIntlProvider></StoreProvider></PlatformProvider></ServiceProvider>));};
      window.closeUpgrade=()=>flushSync(()=>renderer.render(null));
    `,
      },
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
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
      join(temporary, "index.html"),
      `<!doctype html><html><head><link rel="stylesheet" href="/@fs${root}/packages/ui/src/styles.css"></head><body><div id="root"></div><script src="/renderer.js"></script></body></html>`,
    );
    const { createServer: createViteServer } = await import(requireDesktop.resolve("vite"));
    const { default: tailwindcss } = await import(requireDesktop.resolve("@tailwindcss/vite"));
    vite = await createViteServer({
      configFile: false,
      root: temporary,
      plugins: [tailwindcss()],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [root, temporary] } },
    });
    await vite.listen();
    const hostOrigin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    await app.whenReady();
    process.env.ELECTRON_RENDERER_URL = hostOrigin;
    registerNativePlanWebviewIpc();
    win = createBrowserWindow({
      iconPath: "",
      preloadPath: join(temporary, "preload.cjs"),
      logger: console,
      initialWindowSize: { width: 1568, height: 947 },
    });
    win.setContentSize(1568, 947);
    win.webContents.setBackgroundThrottling(false);
    ipcMain.handle("upgrade-smoke-handoff", async () => {
      let url;
      if (liveSeed) {
        const response = await fetch(origin + "/api/xcode/v1/web-handoffs", {
          method: "POST",
          headers: { Authorization: "Bearer " + liveSeed.users[currentUser].bundle.access_token },
        });
        const body = await response.json();
        assert.equal(body.success, true);
        url = body.data.url;
      } else url = origin + "/xcode/plans?handoff=" + randomBytes(32).toString("base64url");
      const handoff = { url, ownerGeneration };
      assert.equal(authorizeNativePlanWebHandoff(win.id, handoff), true);
      return handoff;
    });
    app.on("web-contents-created", (_event, contents) => {
      if (contents === win.webContents) return;
      contents.setBackgroundThrottling(false);
      contents.debugger.attach("1.3");
      contents.debugger.on("message", (_event, method, params) => {
        if (method === "Network.requestWillBeSent" && params.request.method !== "GET")
          counters.writes++;
      });
      void contents.debugger.sendCommand("Network.enable");
      void contents.debugger.sendCommand("Page.enable").then(() =>
        contents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", {
          runImmediately: true,
          source: `window.__upgradeFrames=[];function probe(){if(document.body&&document.body.textContent.trim()){const h=document.documentElement;window.__upgradeFrames.push({theme:h.classList.contains('dark')?'dark':'light',locale:h.lang,font:h.style.getPropertyValue('--ui-font-size'),audience:h.dataset.zenPlanAudience});}if(window.__upgradeFrames.length<20)requestAnimationFrame(probe);}requestAnimationFrame(probe);`,
        }),
      );
    });
    await setNativePlanWebviewOwner(win.id, { origin, ownerGeneration });
    await new Promise((resolve) => {
      if (!win.webContents.isLoading()) resolve();
      else win.webContents.once("did-finish-load", resolve);
    });
    win.show();
    const { mount, measure, close } = createViewerHarness({ win, origin });
    for (const theme of ["zai-light", "zai-dark"])
      for (const locale of ["zh-CN", "en-US"])
        for (const audience of ["personal", "team"]) {
          const context = { theme, locale, font: 14, audience };
          const guest = await mount(context);
          const measured = await measure(guest);
          assert.equal(measured.theme, theme === "zai-dark" ? "dark" : "light");
          assert.equal(measured.locale, locale);
          assert.equal(measured.font, "14px");
          assert.equal(measured.audience, audience);
          assert.ok(measured.scrollWidth <= measured.clientWidth + 1);
          assert.ok(measured.frames.length > 0, "observe first actual content frame");
          for (const frame of measured.frames) {
            assert.equal(frame.theme, measured.theme);
            assert.equal(frame.locale, locale);
            assert.equal(frame.audience, audience);
          }
          if (audience === "personal") {
            assert.equal(measured.cards.length, 4);
            const tops = measured.cards.map((c) => c.y),
              heights = measured.cards.map((c) => c.height),
              bottoms = measured.cards.map((c) => c.cta?.bottom);
            assert.ok(Math.max(...tops) - Math.min(...tops) <= 1);
            assert.ok(Math.max(...heights) - Math.min(...heights) <= 2);
            assert.ok(Math.max(...bottoms) - Math.min(...bottoms) <= 2);
            if (locale === "zh-CN") {
              assert.ok(
                Math.max(...bottoms) <= measured.innerHeight,
                `baseline CTA visibility: ${JSON.stringify({ context, bounds: win.getContentBounds(), innerHeight: measured.innerHeight, bottoms })}`,
              );
            } else {
              await guest.executeJavaScript(
                `document.querySelector('article button').scrollIntoView({ block: 'end' })`,
              );
              const scrolled = await measure(guest);
              assert.ok(
                scrolled.cards.every(
                  (card) =>
                    card.cta && card.cta.y >= 0 && card.cta.bottom <= scrolled.innerHeight + 1,
                ),
                "English CTAs remain reachable by scrolling",
              );
            }
            if (theme === "zai-dark" && locale === "zh-CN")
              await writeFile(
                join(temporary, "upgrade-dark-zh.png"),
                (await win.webContents.capturePage()).toPNG(),
              );
            await guest.executeJavaScript(`document.querySelector('article button').click()`);
            assert.equal(
              await guest.executeJavaScript(
                `new Promise(resolve=>requestAnimationFrame(()=>resolve(!!document.querySelector('[role=dialog]'))))`,
              ),
              true,
            );
          } else assert.equal(measured.cards.length, 0);
          result.push({
            context,
            bounds: win.getContentBounds(),
            zoom: guest.getZoomFactor(),
            ...measured,
            body: undefined,
            frames: measured.frames.slice(0, 1),
          });
          await close(guest);
        }
    // shortcut: live 冷加载按原生默认120次/180秒限流分批；部署预算变化时按真实预算调整。
    if (liveSeed) await new Promise((resolve) => setTimeout(resolve, 180_000));
    await runUpgradeZoomMatrix({ win, temporary, mount, measure, close, result });
    const cycleGuest = await mount({
      theme: "zai-light",
      locale: "en-US",
      font: 14,
      audience: "personal",
    });
    const assignedStatusCount = () =>
      cycleGuest.executeJavaScript(
        `document.querySelectorAll('article[aria-label="Pro"] .zen-plan-card-heading .zen-plan-tag').length`,
      );
    if (!liveSeed) assert.equal(await assignedStatusCount(), 1);
    for (const cycle of ["Monthly", "Yearly", "Quarterly"]) {
      await cycleGuest.executeJavaScript(
        `(()=>{const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(cycle)});if(!button)throw new Error('Missing cycle');button.click();})()`,
      );
      await cycleGuest.executeJavaScript(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
      );
      const measured = await measure(cycleGuest);
      assert.equal(measured.cards.length, 4);
      if (!liveSeed)
        assert.equal(
          await assignedStatusCount(),
          cycle === "Quarterly" ? 1 : 0,
          "only the exact designated fixture template may show the current authorization",
        );
      result.push({ cycle, cards: measured.cards });
    }
    await close(cycleGuest);
    for (const font of [12, 20]) {
      const guest = await mount({
        theme: "zai-light",
        locale: "en-US",
        font,
        audience: "personal",
      });
      const measured = await measure(guest);
      assert.equal(measured.font, font + "px");
      assert.ok(measured.scrollWidth <= measured.clientWidth + 1);
      result.push({ font, ...measured, body: undefined, frames: undefined });
      await close(guest);
    }
    if (!liveSeed) {
      for (const mode of ["loading", "error"]) {
        fixture.state.responseMode = mode;
        const guest = await mount({
          theme: "zai-light",
          locale: "en-US",
          font: 14,
          audience: "personal",
        });
        const measured = await measure(guest);
        assert.equal(measured.theme, "light");
        assert.equal(measured.locale, "en-US");
        result.push({ mode, firstContentFrame: measured.frames[0] });
        await close(guest);
      }
      fixture.state.responseMode = "ready";
      fixture.state.viewer.plans.items = [];
      fixture.state.viewer.plan_presentations = [];
      const empty = await mount({
        theme: "zai-dark",
        locale: "zh-CN",
        font: 14,
        audience: "personal",
      });
      assert.equal((await measure(empty)).cards.length, 0);
      await close(empty);
      fixture.state.viewer = fixtureView();
      for (const item of fixture.state.viewer.plan_presentations) {
        item.metadata.group_title = ("LongNativeGroup" + item.metadata.group_key)
          .repeat(6)
          .slice(0, 128);
        item.metadata.features = Array.from({ length: 16 }, (_, i) =>
          ("Feature" + i + " very-long-unbroken-native-metadata-").repeat(6).slice(0, 256),
        );
      }
      const longGuest = await mount({
        theme: "zai-light",
        locale: "en-US",
        font: 20,
        audience: "personal",
      });
      const long = await measure(longGuest);
      assert.equal(long.cards.length, 4);
      assert.ok(long.scrollWidth <= long.clientWidth + 1);
      assert.ok(
        long.cards.every((card) => card.height > long.innerHeight),
        "long benefits may scroll vertically, not be clipped",
      );
      result.push({ longMetadata: true, innerWidth: long.innerWidth, cards: long.cards });
      await close(longGuest);
      fixture.state.viewer = fixtureView();
    }
    for (const user of [1, 0]) {
      currentUser = user;
      ownerGeneration++;
      await setNativePlanWebviewOwner(win.id, { origin, ownerGeneration });
      const guest = await mount({
        theme: user ? "zai-light" : "zai-dark",
        locale: user ? "en-US" : "zh-CN",
        font: 14,
        audience: user ? "team" : "personal",
      });
      const measured = await measure(guest);
      assert.equal(measured.audience, user ? "team" : "personal");
      result.push({ ownerGeneration, contextReset: true });
      await close(guest);
    }
    assert.equal(counters.writes, 0, "CTA makes no payment/order/application writes");
    console.log(
      JSON.stringify({
        productionNativeDialog: true,
        compiledViewer: true,
        liveBackend: Boolean(liveSeed),
        noPaymentWrites: true,
        results: result,
        screenshot: join(temporary, "upgrade-dark-zh.png"),
      }),
    );
    if (process.env.XCODE_UPGRADE_SMOKE_EVIDENCE)
      await writeFile(
        process.env.XCODE_UPGRADE_SMOKE_EVIDENCE,
        JSON.stringify(
          { results: result, screenshot: join(temporary, "upgrade-dark-zh.png") },
          null,
          2,
        ),
      );
    if (process.env.XCODE_UPGRADE_SMOKE_SCREENSHOT)
      await writeFile(
        process.env.XCODE_UPGRADE_SMOKE_SCREENSHOT,
        await readFile(join(temporary, "upgrade-dark-zh.png")),
      );
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    clearTimeout(deadline);
    // 保留最后一个窗口直到异步清理结束，避免默认退出0抢在 app.exit(1) 前掩盖断言失败。
    await vite?.close();
    await (fixture?.close() ?? Promise.resolve());
    app.exit(exitCode);
  }
}
void run();
