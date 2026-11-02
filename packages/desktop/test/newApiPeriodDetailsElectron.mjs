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
assert.ok(process.argv[2], "Launch this fixture with runNewApiElectronSmokes.mjs");

// XCODE: 不在 Electron ESM 入口顶层等待 ready，避免启动互锁。
async function run() {
  const temporary = await mkdtemp(join(process.argv[2], "xwork-period-details-"));
  app.setPath("userData", temporary);
  let win;
  let exitCode = 0;
  const deadline = setTimeout(() => {
    console.error("Native period details regression timed out");
    app.exit(1);
  }, 40_000);
  try {
    const bundle = await build({
      stdin: {
        resolveDir: root,
        loader: "tsx",
        contents: `
      import React from "react";
      import { createRoot } from "react-dom/client";
      import { flushSync } from "react-dom";
      import { ChatCodingPlanUsageRemainingPanel } from "./packages/ui/src/chat-input-toolbar/CodingPlanContextUsage.tsx";
      import { ZCodeIntlProvider, useZCodeIntl } from "./packages/ui/src/i18n/IntlProvider.tsx";
      import { ServiceProvider } from "./packages/ui/src/hooks/useServices.tsx";
      import { mapNewApiEntitlement } from "./packages/services/src/new-api/newApiUsageMapper.ts";
      import { CodingPlanUsageBarChart } from "./packages/ui/src/settings/usage-stats/CodingPlanUsageBarChart.tsx";
      import { CodingPlanUsagePanel } from "./packages/ui/src/settings/usage-stats/CodingPlanUsagePanel.tsx";
      import { mapNewApiUsage } from "./packages/services/src/new-api/newApiUsageMapper.ts";
      import { TooltipProvider } from "./packages/ui/src/components/ui/tooltip.tsx";
      import { useLayoutEffect } from "react";
      import { PlatformProvider } from "./packages/ui/src/hooks/usePlatform.tsx";
      import { StoreProvider, useZCodeStore } from "./packages/ui/src/store/StoreProvider.tsx";
      import { connectProviderSettingsSnapshot } from "./packages/ui/src/lib/providerSettingsSnapshot.ts";
      const providerId = "account:new-api-anthropic-messages";
      const accountAccess = { type: "new-api-account", accountType: "new-api", mode: "private-subscription", entitled: true };
      const entitlement = {
        schema_version: 1, server_time: 1800000000000, status: "active", authorization_revision: "42",
        subscription: { id: "7", plan_id: "3", plan_title: "Private", source: "admin", usage_scope: "zen", start_time: null, end_time: null },
        quota: { scope: "zen-subscription", unit: "quota", unlimited: false, total: "100", used: "25", remaining: "75", used_percentage: 25,
          reset_period: "monthly", reset_custom_seconds: "0", last_reset_time: Date.parse("2026-10-01T16:00:00Z"), next_reset_time: Date.parse("2026-11-01T16:00:00Z"), reset_time_zone: "server-local", reset_utc_offset_seconds: 28800 },
        funding_policy: { subscription_only: true, wallet_fallback: false, other_subscription_fallback: false }, self_service_reset: false, purchase_mode: "manual_admin"
      };
      window.periodCalls = [];
      const forbidden = (method) => async () => { window.periodCalls.push(method); throw new Error("Native must not call official " + method); };
      // 用量 hook 按服务实例缓存权益快照；每个授权状态使用独立服务实例，保证真实重读。
      const usageServicesFor = (native) => ({ ...services, usageStatsService: { ...services.usageStatsService,
        getEntitlementSnapshot: async (request) => mapNewApiEntitlement(native, request.preferredProviderId) } });
      const usage = { schema_version: 1, server_time: 1800000000000, as_of: 1800000000000, scope: "new-api-account",
        source: "native-consume-logs", retention_basis: "all-retained-consume-logs", time_zone: "UTC",
        range_start_date: "2026-10-14", range_end_date: "2026-10-20", granularity: "day",
        display: { quota_per_unit: "500000", display_type: "USD", currency: "USD", currency_symbol: "$", usd_to_currency_rate: null },
        summary: { consume_record_count: "3", prompt_tokens: "10", completion_tokens: "5", total_tokens: "15", charged_quota: "20", refunded_quota: "0", net_quota: "20" },
        buckets: [], models: [], unsupported_metrics: ["agent_duration", "tool_usage", "cache_tokens", "reasoning_tokens", "decode_speed"] };
      const services = { usageStatsService: {
        getCodingPlanResetStatus: forbidden("status"), getCodingPlanResetOpportunity: forbidden("opportunity"),
        useCodingPlanReset: forbidden("reset"), markCodingPlanResetHistoryRead: forbidden("history"),
        getCodingPlanUsageSnapshot: async (request) => mapNewApiUsage(usage, request.range, request.preferredProviderId)
      }, broadcastService: { onMessage: () => ({ dispose() {} }), send: async () => {} },
        settingService: { get: async () => ({}) },
        oauthService: { getProviders: async () => [{ id: "new-api" }] },
        officialCloudConnectionService: { getSnapshot: async () => ({ status: "disconnected" }), onDidChange: () => ({ dispose() {} }) } };
      // 与 Composer smoke 一致：Host provider 快照带 opaque owner，Native 用量才会按账号作用域请求。
      window.usageSettings = connectProviderSettingsSnapshot({
        getView: async () => ({ revision: 1, providers: [{ providerId, providerName: "New API", effectiveConfig: { access: accountAccess }, accountState: { connectionKey: "fixture-owner" } }] }),
        onDidChange: () => ({ dispose() {} })
      });
      function SignedIn({ children }) {
        const setUser = useZCodeStore(state => state.setUser);
        useLayoutEffect(() => setUser({ id: "1", name: "Fixture" }), [setUser]);
        return children;
      }
      // 设置页用量统计：真实 CodingPlanUsagePanel 与 hooks，按授权状态切换后端快照。
      window.renderUsagePage = (status, quotaOverrides = {}) => {
        const quota = status === "exhausted"
          ? { ...entitlement.quota, used: "100", remaining: "0", used_percentage: 100 }
          : { ...entitlement.quota, ...quotaOverrides };
        const native = { ...entitlement, status, subscription: status === "unassigned" ? null : entitlement.subscription, quota: status === "unassigned" ? null : quota };
        const scoped = usageServicesFor(native);
        flushSync(() => renderer.render(null));
        flushSync(() => renderer.render(
          <ServiceProvider services={scoped}><PlatformProvider platform={{}}><StoreProvider broadcastService={services.broadcastService}>
            <ZCodeIntlProvider initialLocale="en-US"><TooltipProvider><SignedIn>
              <CodingPlanUsagePanel key={status} loadingSources={false} selectedSource={{ id: providerId, providerId, label: "New API", accountAccess }} />
            </SignedIn></TooltipProvider></ZCodeIntlProvider>
          </StoreProvider></PlatformProvider></ServiceProvider>
        ));
      };
      const configFor = (status, quota = entitlement.quota) => {
        const value = { ...entitlement, status, quota, subscription: status === "unassigned" ? null : entitlement.subscription };
        return { availableProviders: [{ providerId, accountAccess, label: "New API" }],
          entitlements: [{ providerId, accountAccess, snapshot: mapNewApiEntitlement(value, providerId), loading: false, error: null }],
          modelProvidersLoading: false, selectedProviderId: providerId };
      };
      let config = configFor("active");
      function Panel() {
        const { intl, locale } = useZCodeIntl();
        return <ChatCodingPlanUsageRemainingPanel config={config} intl={intl} locale={locale} />;
      }
      window.renderPanel = (status, withQuota = true) => {
        config = configFor(status, withQuota ? entitlement.quota : null);
        flushSync(() => renderer.render(
          <ServiceProvider services={services}><ZCodeIntlProvider initialLocale="en-US"><Panel /></ZCodeIntlProvider></ServiceProvider>
        ));
        return document.getElementById("root").innerText;
      };
      const renderer = createRoot(document.getElementById("root"));
      window.renderUsageChart = (granularity, xTime) => flushSync(() => renderer.render(
        <ZCodeIntlProvider initialLocale="en-US"><CodingPlanUsageBarChart granularity={granularity}
          xTime={xTime} series={[{name:"Native fixture",values:xTime.map(()=>1)}]} emptyDescription="No usage" /></ZCodeIntlProvider>
      ));
      flushSync(() => renderer.render(
        <ServiceProvider services={services}><ZCodeIntlProvider initialLocale="en-US"><Panel /></ZCodeIntlProvider></ServiceProvider>
      ));
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
      loader: { ".svg": "dataurl", ".png": "dataurl", ".css": "empty" },
      define: { "process.env.NODE_ENV": JSON.stringify("test") },
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
      "data:text/html,<html><head><style>[data-slot=chart]{width:740px;height:350px}</style></head><body><div id='root'></div></body></html>",
    );
    await win.webContents.executeJavaScript(bundle.outputFiles[0].text);
    const observe = (expression) => win.webContents.executeJavaScript(expression);
    // 浮层与原生 ZCode 一致：只渲染额度条，Native 不追加授权行、只读按钮或独立弹窗。
    const text = await observe("document.getElementById('root').textContent");
    assert.match(text, /75%/);
    assert.doesNotMatch(
      text,
      /Period details|Active authorization|Five.hour|Weekly quota|Reset quota/,
    );
    assert.equal(await observe("document.querySelectorAll('.bg-surface-hover').length"), 1);
    assert.equal(
      await observe(
        "[...document.querySelectorAll('button')].some(b => /Period details|Reset/.test(b.textContent))",
      ),
      false,
    );
    assert.equal(await observe("document.querySelector('[role=dialog]') === null"), true);
    assert.deepEqual(await observe("window.periodCalls"), []);
    // 后端对 expired/revoked 仍下发 quota；失效套餐必须走原生“未开通”提示，不能显示剩余额度。
    for (const [status, withQuota, valid] of [
      ["active", true, true],
      ["exhausted", true, true],
      ["expired", true, false],
      ["revoked", true, false],
      ["unassigned", false, false],
    ]) {
      const shown = await observe(`window.renderPanel(${JSON.stringify(status)}, ${withQuota})`);
      if (valid) {
        // XCODE: spec 要求使用服务端唯一月周期及 UTC+8 重置日，旧“当前周期”断言已过期。
        assert.match(shown, /Usage remaining\nMonthly\n75% · Nov 2/, status);
        assert.equal(
          await observe("document.querySelectorAll('.bg-surface-hover').length"),
          1,
          status,
        );
        assert.equal(
          await observe(
            "[...document.querySelectorAll('span')].filter(node => node.textContent === 'Monthly').length",
          ),
          1,
          status,
        );
      } else {
        assert.match(shown, /Usage remaining\nNo active Coding Plan/, status);
        assert.doesNotMatch(shown, /Current subscription period|75%/, status);
      }
      assert.doesNotMatch(shown, /authorization|Period details|Reset/i, status);
    }
    assert.deepEqual(await observe("window.periodCalls"), []);
    // 设置页只展示真实剩余进度：耗尽为 0，过期/撤销仍可只读查看，未分配不制造额度卡。
    const usagePageText = (status, quota = {}) =>
      observe(`(async () => { window.renderUsagePage(${JSON.stringify(status)}, ${JSON.stringify(quota)});
      const root = document.getElementById("root");
      for (let i = 0; i < 100 && !/Consumption records/.test(root.innerText); i++) await new Promise(r => setTimeout(r, 50));
      return root.innerText; })()`);
    const quotaCardView = () =>
      observe(`(() => {
      const card = document.querySelector('[role="group"][aria-label]');
      if (!card) return null;
      const meter = card.querySelector('[role="progressbar"]');
      return { progress: meter ? {
        remaining: Number(meter.getAttribute("aria-valuenow")),
        width: meter.firstElementChild.style.width,
        visiblePercentage: card.innerText.match(/\\d+(?:\\.\\d+)?%/)?.[0] ?? null,
      } : null, resetAt: card.querySelector("time")?.dateTime ?? null, text: card.innerText };
    })()`);
    for (const [status, remaining] of [
      ["active", 75],
      ["exhausted", 0],
      ["expired", 75],
      ["revoked", 75],
      ["unassigned", null],
    ]) {
      await usagePageText(status);
      const card = await quotaCardView();
      if (remaining === null) assert.equal(card, null, status);
      else {
        assert.deepEqual(
          card?.progress,
          {
            remaining,
            width: `${remaining}%`,
            visiblePercentage: `${remaining}%`,
          },
          status,
        );
        assert.equal(card.resetAt, "2026-11-01T16:00:00.000Z", status);
      }
    }
    await usagePageText("active", {
      used: "13",
      remaining: "87",
      used_percentage: 13,
      reset_period: "never",
      last_reset_time: null,
      next_reset_time: null,
    });
    const neverReset = await quotaCardView();
    assert.deepEqual(neverReset?.progress, {
      remaining: 87,
      width: "87%",
      visiblePercentage: "87%",
    });
    assert.equal(neverReset.resetAt, null, "never must not imply a scheduled reset");
    for (const quota of [
      { unlimited: true, total: null, remaining: null, used_percentage: null },
      { used_percentage: null },
    ]) {
      await usagePageText("active", quota);
      const card = await quotaCardView();
      assert.ok(card, "unlimited or unknown quota must keep its card");
      assert.equal(card.progress, null, "unlimited or unknown quota has no finite meter");
      assert.doesNotMatch(card.text, /\d+(?:\.\d+)?%/);
    }
    assert.deepEqual(await observe("window.periodCalls"), []);
    win.webContents.debugger.attach("1.3");
    await win.webContents.debugger.sendCommand("Emulation.setTimezoneOverride", {
      timezoneId: "America/Los_Angeles",
    });
    const chartLabels = async (granularity, xTime) => {
      await observe(
        `window.renderUsageChart(${JSON.stringify(granularity)}, ${JSON.stringify(xTime)})`,
      );
      return observe(`new Promise(resolve => {
        const labels = () => [...document.querySelectorAll('.recharts-xAxis-tick-labels .recharts-cartesian-axis-tick-value')].map(e=>e.textContent);
        const finish = () => { const values=labels(); if (!values.length) return; observer.disconnect(); resolve(values); };
        const observer = new MutationObserver(finish); observer.observe(document.getElementById('root'),{childList:true,subtree:true});
        setTimeout(() => { observer.disconnect(); resolve(labels()); }, 1500); finish();
      })`);
    };
    const dailyLabels = await chartLabels("day", ["2026-10-09"]);
    const hourlyLabels = await chartLabels("hour", ["01:00 -04:00", "01:00 -05:00"]);
    assert.deepEqual(
      { dailyLabels, hourlyLabels },
      {
        dailyLabels: ["Oct 9"],
        hourlyLabels: ["01:00 -04:00", "01:00 -05:00"],
      },
      "actual chart axes must keep server calendar days and distinguish repeated DST hours",
    );
    console.log(
      JSON.stringify({
        singleNativeQuotaMeter: true,
        noExtraNativeRowOrDialog: true,
        noOfficialResetCalls: true,
        dailyLabels,
        hourlyLabels,
      }),
    );
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    clearTimeout(deadline);
    app.exit(exitCode);
  }
}
void run();
