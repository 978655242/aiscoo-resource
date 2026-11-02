import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow } from "electron";

const requireServices = createRequire(new URL("../../services/package.json", import.meta.url));
const { build } = requireServices("esbuild");
const requireRoot = createRequire(new URL("../../../package.json", import.meta.url));
const root = fileURLToPath(new URL("../../../", import.meta.url));
const trigger = '[data-testid="chat-context-usage-trigger"]';
const popup = '[data-slot="hover-card-content"]';

assert.ok(process.argv[2], "Launch this fixture with runNewApiElectronSmokes.mjs");

// XCODE: 真实 Composer 切换必须隔离缓存订阅，不能只测试额度 mapper 或替换浮层组件。
async function run() {
  const temporary = await mkdtemp(join(process.argv[2], "xwork-composer-context-"));
  app.setPath("userData", temporary);
  let win;
  let exitCode = 0;
  let stage = "custom draft";
  const deadline = setTimeout(() => app.exit(1), 45_000);
  try {
    const bundle = await build({
      stdin: {
        resolveDir: root,
        loader: "tsx",
        contents: `
          import React, { useLayoutEffect } from "react";
          import { createRoot } from "react-dom/client";
          import { flushSync } from "react-dom";
          import { V4ComposerModelControls } from "./packages/ui/src/v4/composer/V4ComposerToolbar.tsx";
          import { ZCodeIntlProvider } from "./packages/ui/src/i18n/IntlProvider.tsx";
          import { ServiceProvider } from "./packages/ui/src/hooks/useServices.tsx";
          import { PlatformProvider } from "./packages/ui/src/hooks/usePlatform.tsx";
          import { StoreProvider, useZCodeStore } from "./packages/ui/src/store/StoreProvider.tsx";
          import { TabStoreProvider } from "./packages/ui/src/store/TabStoreProvider.tsx";
          import { TooltipProvider } from "./packages/ui/src/components/ui/tooltip.tsx";
          import { connectProviderSettingsSnapshot } from "./packages/ui/src/lib/providerSettingsSnapshot.ts";
          import { mapNewApiEntitlement } from "./packages/services/src/new-api/newApiUsageMapper.ts";
          const providerId = "account:new-api-anthropic-messages";
          const access = { type: "new-api-account", accountType: "new-api", mode: "private-subscription", entitled: true };
          const entitlement = mapNewApiEntitlement({
            schema_version: 1, server_time: 1800000000000, status: "active", authorization_revision: "42",
            subscription: { id: "7", plan_id: "3", plan_title: "Fixture", source: "admin", usage_scope: "zen", start_time: null, end_time: null },
            quota: { scope: "zen-subscription", unit: "quota", unlimited: false, total: "100", used: "25", remaining: "75", used_percentage: 25,
              reset_period: "never", reset_custom_seconds: "0", last_reset_time: null, next_reset_time: null, reset_time_zone: "UTC", reset_utc_offset_seconds: 0 },
            funding_policy: { subscription_only: true, wallet_fallback: false, other_subscription_fallback: false }, self_service_reset: false, purchase_mode: "manual_admin"
          }, providerId);
          const broadcast = { onMessage: () => ({ dispose() {} }), send: async () => {} };
          window.entitlementCalls = [];
          const services = { settingService: { get: async () => ({}) }, broadcastService: broadcast,
            usageStatsService: { getEntitlementSnapshot: async request => {
              window.entitlementCalls.push(request.preferredProviderId);
              if (request.accountAccess?.type !== "new-api-account") throw new Error("Unexpected official query");
              return entitlement;
            } }
          };
          const usage = { contextWindow: { usedTokens: 32000, maxTokens: 128000, cache: { hitRate: 0.9 },
            breakdown: [{ source: "messages", chars: 300 }, { source: "system_prompt", chars: 100 }] } };
          const settings = connectProviderSettingsSnapshot({
            getView: async () => ({ revision: 1, providers: [{ providerId, providerName: "New API", effectiveConfig: { access }, accountState: { connectionKey: "fixture-owner" } }] }),
            onDidChange: () => ({ dispose() {} })
          });
          const renderer = createRoot(document.getElementById("root"));
          function Fixture({ selected, hasUsage }) {
            const setUser = useZCodeStore(state => state.setUser);
            useLayoutEffect(() => setUser({ id: "1", name: "Fixture" }), [setUser]);
            return <V4ComposerModelControls workspacePath="/fixture" sessionId={hasUsage ? "fixture-session" : null}
              phase={null} draftMode={!hasUsage} draftConfig={{ modelSelection: selected ? { providerId: selected, modelId: "fixture-model", options: {} } : undefined }}
              usage={hasUsage ? usage : null} disabled={false} activeConfigPicker={null}
              onConfigPickerOpenChange={() => {}} onSelectModel={() => {}} onSelectThought={() => {}} onSwitchMode={() => {}} />;
          }
          window.renderComposer = (selected, hasUsage) => flushSync(() => renderer.render(
            <ServiceProvider services={services}><PlatformProvider platform={{}}><StoreProvider broadcastService={broadcast}>
              <TabStoreProvider><ZCodeIntlProvider initialLocale="en-US"><TooltipProvider><Fixture selected={selected} hasUsage={hasUsage} /></TooltipProvider></ZCodeIntlProvider></TabStoreProvider>
            </StoreProvider></PlatformProvider></ServiceProvider>
          ));
          window.fixtureReady = settings.ready.then(() => window.renderComposer("custom-deepseek", false));
        `,
      },
      absWorkingDir: root,
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
      // The upgrade dialog is unrelated to context usage; keep all settings/usage hooks and popup components real.
      plugins: [
        {
          name: "unused-upgrade-entry",
          setup(builder) {
            builder.onLoad({ filter: /CodingPlanUpgradeDialogProvider\.tsx$/ }, () => ({
              contents:
                "export const useCodingPlanUpgradeDialog = () => ({ openCodingPlanUpgrade() {} }); export const useOptionalCodingPlanUpgradeDialog = () => null;",
              loader: "js",
            }));
            // LobeIcon 依赖 Vite import.meta.glob；本场景只验证上下文浮层，不渲染模型图标。
            builder.onLoad({ filter: /components[\\/]LobeIcon\.tsx$/ }, () => ({
              contents:
                "export const resolveLobeIcon = () => null; export const LobeIcon = () => null;",
              loader: "js",
            }));
          },
        },
      ],
      loader: { ".svg": "dataurl", ".png": "dataurl", ".css": "empty" },
      define: {
        "process.env.NODE_ENV": JSON.stringify("test"),
        "import.meta.env": JSON.stringify({ DEV: false }),
      },
    });
    await app.whenReady();
    win = new BrowserWindow({
      show: true,
      width: 800,
      height: 600,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    await win.loadURL(
      "data:text/html,<html><body><div id='root' style='margin:250px 100px'></div></body></html>",
    );
    const observe = (expression) => win.webContents.executeJavaScript(expression);
    // XCODE: CDP 输入不依赖原生窗口焦点，避免后台验证漏收鼠标移出事件。
    win.webContents.debugger.attach("1.3");
    const moveMouse = (position) =>
      win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        buttons: 0,
        ...position,
      });
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") console.error(event.message);
    });
    await observe(
      `try { ${bundle.outputFiles[0].text} } catch (error) { console.error(error.stack); throw error; }`,
    );
    await observe("window.fixtureReady");
    const frames = () =>
      observe(
        "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))",
      );
    await frames();
    assert.equal(
      await observe(`document.querySelector(${JSON.stringify(trigger)}) === null`),
      true,
      "a custom API-key draft must not show an unrelated subscription trigger",
    );
    const waitFor = (expression) =>
      observe(`new Promise((resolve, reject) => {
      const deadline = Date.now() + 5000;
      const check = () => { if (${expression}) resolve(true); else if (Date.now() >= deadline) reject(new Error('UI condition timed out: ' + ${JSON.stringify(expression)})); else setTimeout(check, 10); }; check();
    })`);
    const render = async (providerId, hasUsage) => {
      stage = `${providerId ?? "none"} (${hasUsage ? "context" : "draft"})`;
      await moveMouse({ x: 1, y: 1 });
      await waitFor(`document.querySelector(${JSON.stringify(popup)}) === null`);
      await observe(`window.renderComposer(${JSON.stringify(providerId)}, ${hasUsage})`);
      await frames();
    };
    const hover = async () => {
      const position = await observe(
        `(() => { const r = document.querySelector(${JSON.stringify(trigger)}).getBoundingClientRect(); return { x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2) }; })()`,
      );
      await moveMouse(position);
      await waitFor(`document.querySelector(${JSON.stringify(popup)}) !== null`);
    };
    for (const providerId of [
      "account:new-api-anthropic-messages",
      "account:new-api-openai-chat-completions",
      "account:new-api-openai-responses",
    ]) {
      await render(providerId, false);
      await hover();
      await waitFor(`document.querySelector(${JSON.stringify(popup)}).textContent.includes('75%')`);
      assert.equal(
        await observe(`!!document.querySelector(${JSON.stringify(popup)}).querySelector('button')`),
        true,
        "Native models retain the period-details action",
      );
    }
    await render("custom-deepseek", true);
    const callsBefore = await observe("window.entitlementCalls.length");
    await hover();
    const localText = await observe(`document.querySelector(${JSON.stringify(popup)}).textContent`);
    assert.match(localText, /32K\/128K \(25%\)/);
    assert.match(localText, /75%/); // Messages comprise 75% of the real context breakdown, not subscription quota.
    assert.match(localText, /90%/);
    assert.equal(
      await observe(
        `document.querySelector(${JSON.stringify(popup)}).querySelector('button') === null`,
      ),
      true,
      "local context has no subscription details or account usage action",
    );
    await frames();
    assert.equal(
      await observe("window.entitlementCalls.length"),
      callsBefore,
      "hovering custom context must not query the Native account",
    );
    await render("account:new-api-openai-chat-completions", true);
    await hover();
    await waitFor(`!!document.querySelector(${JSON.stringify(popup)}).querySelector('button')`);
    await render(null, false);
    assert.equal(
      await observe(`document.querySelector(${JSON.stringify(trigger)}) === null`),
      true,
    );
    await render("custom-deepseek", false);
    assert.equal(
      await observe(`document.querySelector(${JSON.stringify(trigger)}) === null`),
      true,
    );
    await render("custom-deepseek", true);
    stage = "custom touch";
    await win.webContents.debugger.sendCommand("Emulation.setTouchEmulationEnabled", {
      enabled: true,
    });
    await win.webContents.debugger.sendCommand("Emulation.setDeviceMetricsOverride", {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    assert.equal(await observe("window.matchMedia('(hover: none)').matches"), true);
    const position = await observe(
      `(() => { const r = document.querySelector(${JSON.stringify(trigger)}).getBoundingClientRect(); return { x: r.x+r.width/2, y: r.y+r.height/2 }; })()`,
    );
    await win.webContents.debugger.sendCommand("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [position],
    });
    await waitFor(`document.querySelector(${JSON.stringify(popup)}) !== null`);
    assert.equal(
      await observe(
        `document.querySelector(${JSON.stringify(popup)}).querySelector('button') === null`,
      ),
      true,
    );
    await win.webContents.debugger.sendCommand("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    console.log(
      JSON.stringify({
        customDraftHidden: true,
        nativeTransportsRetained: 3,
        cachedNativeToCustomContextOnly: true,
        customHoverDoesNotReadSubscription: true,
        nativeRestoredAfterSwitch: true,
        clearedSelectionHidden: true,
        touchPressContextOnly: true,
        localText,
      }),
    );
  } catch (error) {
    exitCode = 1;
    console.error(stage, error);
  } finally {
    clearTimeout(deadline);
    app.exit(exitCode);
  }
}
void run();
