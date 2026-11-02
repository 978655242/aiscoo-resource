import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { build } from "esbuild";
import {
  ProviderConfigResolver,
  ProviderConfigMap,
  ModelConfigRules,
  ProviderSettingsFacade,
} from "@zcode/provider";
import { createNewApiProviderAnchors } from "@zcode/provider-node";
import { resolveNewApiAccountProviders } from "../../services/src/new-api/newApiAccountProviderResolution.ts";
import { owner, catalog, entitlements } from "../../services/test/newApiRegistryFixtures.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const requireRoot = createRequire(new URL("../../../package.json", import.meta.url));
const requireDesktop = createRequire(new URL("../package.json", import.meta.url));
const id = "account:new-api-openai-chat-completions";
const plan = {
  id: "1",
  title: "Personal",
  subtitle: "Fixture personal plan",
  priceAmount: "118.00",
  currency: "CNY",
  durationUnit: "month",
  durationValue: "1",
  durationCustomSeconds: "0",
  totalQuota: "100",
  resetPeriod: "monthly",
  resetCustomSeconds: "0",
  enabled: true,
};
const snapshot = (status, title = "Fixture Plan A", used = "40") => ({
  source: "new-api",
  purchaseMode: "manual_admin",
  scope: "private-user",
  plans: [
    { ...plan, id: "disabled", priceAmount: "0.01", enabled: false },
    plan,
    { ...plan, id: "2", priceAmount: "98.00", subtitle: "Fixture cheaper personal plan" },
    {
      ...plan,
      id: "3",
      priceAmount: "258.00",
      durationValue: "3",
      subtitle: "Fixture quarterly plan",
    },
    { ...plan, id: "4", priceAmount: "18.00", currency: "USD", subtitle: "Fixture USD plan" },
  ],
  entitlement: {
    ...entitlements,
    status,
    subscription:
      status === "unassigned" ? null : { ...entitlements.subscription, plan_title: title },
    quota:
      status === "unassigned"
        ? null
        : {
            scope: "xcode-subscription",
            unit: "quota",
            unlimited: false,
            total: "100",
            used,
            remaining: String(100n - BigInt(used)),
            used_percentage: Number(used),
            reset_period: "monthly",
            reset_custom_seconds: "0",
            last_reset_time: null,
            next_reset_time: null,
            reset_time_zone: "UTC",
            reset_utc_offset_seconds: 0,
          },
  },
});

assert.ok(process.argv[2], "Launch this fixture with runNewApiElectronSmokes.mjs");

async function run() {
  const temporary = await mkdtemp(join(process.argv[2], "xwork-model-settings-electron-"));
  app.setPath("userData", join(temporary, "profile"));
  let win,
    vite,
    exitCode = 0;
  const deadline = setTimeout(() => app.exit(1), 55_000);
  try {
    let scene = { status: "unassigned", userId: "A", connected: true };
    let revision = 0;
    let heldRead;
    let readStarted = false;
    function view() {
      const account = resolveNewApiAccountProviders({
        owner: scene.connected ? { ...owner, userId: scene.userId } : null,
        catalog,
        entitlements: {
          ...entitlements,
          status: scene.status,
          subscription: scene.status === "unassigned" ? null : entitlements.subscription,
        },
      });
      const builtins = createNewApiProviderAnchors(owner.origin);
      const resolution = new ProviderConfigResolver().resolve({
        zcodeBuiltinProviders: builtins,
        personalProviders: ProviderConfigMap.empty(),
        personalModels: ModelConfigRules.empty(),
        zcodeBuiltinModelRules: ModelConfigRules.empty(),
        accountProviders: account.providers,
        accountModelConfigs: account.modelConfigs,
        accountStates: account.states,
      });
      const registry = { revision: ++revision, providers: resolution.registryProviders };
      const state = {
        registry,
        resolution,
        account,
        config: {
          zcodeBuiltinProviders: builtins,
          personalProviders: ProviderConfigMap.empty(),
          personalModels: ModelConfigRules.empty(),
        },
        sourceRevisions: { config: "fixture", account: String(revision) },
      };
      return new ProviderSettingsFacade({
        getView: () => registry,
        getSnapshot: () => state,
        refresh: async () => state,
        onDidChange: () => () => {},
      }).getView();
    }
    ipcMain.handle("native-settings-view", () => view());
    ipcMain.handle("native-settings-scene", (_event, next) => {
      scene = next;
      return view();
    });
    ipcMain.handle("native-settings-read", async () => {
      readStarted = true;
      const captured = snapshot(scene.status, `Fixture Plan ${scene.userId}`, scene.used);
      if (scene.empty) captured.plans = [];
      if (scene.error) throw new Error("fixture backend unavailable");
      if (scene.hold)
        await new Promise((resolveRead) => {
          heldRead = resolveRead;
        });
      return captured;
    });
    await writeFile(
      join(temporary, "preload.cjs"),
      'const {contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("nativeSettingsSmoke",{view:()=>ipcRenderer.invoke("native-settings-view"),read:()=>ipcRenderer.invoke("native-settings-read"),scene:next=>ipcRenderer.invoke("native-settings-scene",next)});',
    );
    const renderer = await build({
      stdin: {
        resolveDir: root,
        loader: "tsx",
        contents: `
import React,{useLayoutEffect} from "react";
import {createRoot} from "react-dom/client";
import {flushSync} from "react-dom";
import {ServiceProvider} from "./packages/ui/src/hooks/useServices.tsx";
import {StoreProvider,useZCodeStore} from "./packages/ui/src/store/StoreProvider.tsx";
import {connectProviderSettingsSnapshot} from "./packages/ui/src/lib/providerSettingsSnapshot.ts";
import {projectProviderSettingsViewToFormProviders} from "./packages/ui/src/lib/providerSettingsFormProjection.ts";
import {useNativePlanSettings} from "./packages/ui/src/hooks/useNativePlanSettings.ts";
import {useProviderSettingsView} from "./packages/ui/src/hooks/useProviderSettingsView.ts";
import {ZCodeIntlProvider} from "./packages/ui/src/i18n/IntlProvider.tsx";
import {NativePlanProviderDetail} from "./packages/ui/src/settings/model-provider-section/NativePlanProviderDetail.tsx";
import {applyTheme} from "./packages/ui/src/useTheme.ts";
let currentView=await window.nativeSettingsSmoke.view();
const listeners=new Set();
const providerSettingsService={getView:async()=>currentView,onDidChange:listener=>{listeners.add(listener);return{dispose:()=>listeners.delete(listener)}}};
const services={providerSettingsService,codingPlanSubscriptionService:{getStaticProducts:()=>window.nativeSettingsSmoke.read()}};
const broadcastService={send:async()=>{},onMessage:()=>()=>{}};
await connectProviderSettingsSnapshot(providerSettingsService).ready;
let setUser, initialized=false, fixtureUserId="A";
function Scene(){
  setUser=useZCodeStore(state=>state.setUser);
  useLayoutEffect(()=>{if(!initialized){initialized=true;setUser({id:"fixture-A",nickname:"Fixture",provider:"new-api"})}},[]);
  const settings=useProviderSettingsView();
  const provider=settings.state.status==="ready"?projectProviderSettingsViewToFormProviders(settings.state.view).find(item=>item.providerId===${JSON.stringify(id)}):null;
  const read=useNativePlanSettings(${JSON.stringify(id)});
  window.refreshPlans=read.refresh;
  return provider?<NativePlanProviderDetail provider={provider} read={read} onOpenPlans={()=>{throw new Error("A disabled team card must not open a purchase")}}/>:null;
}
const renderer=createRoot(document.getElementById("root"));
const mount=locale=>flushSync(()=>renderer.render(<ServiceProvider services={services}><StoreProvider broadcastService={broadcastService}><ZCodeIntlProvider key={locale} initialLocale={locale}><Scene/></ZCodeIntlProvider></StoreProvider></ServiceProvider>));
window.setScene=async next=>{currentView=await window.nativeSettingsSmoke.scene(next);flushSync(()=>{const nextUserId=next.connected?next.userId:null;if(nextUserId!==fixtureUserId){fixtureUserId=nextUserId;setUser(next.connected?{id:"fixture-"+next.userId,nickname:"Fixture",provider:"new-api"}:null)}for(const listener of listeners)listener(currentView)});return document.body.innerText};
window.setAppearance=(theme,locale)=>{applyTheme(theme);mount(locale)};
mount("zh-CN");
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
    await writeFile(join(temporary, "renderer.js"), renderer.outputFiles[0].text);
    await writeFile(
      join(temporary, "index.html"),
      `<!doctype html><html><head><link rel="stylesheet" href="/@fs${root}/packages/ui/src/styles.css"></head><body><div id="root" style="max-width:780px;padding:40px"></div><script type="module" src="/renderer.js"></script></body></html>`,
    );
    const { createServer } = await import(requireDesktop.resolve("vite"));
    const { default: tailwindcss } = await import(requireDesktop.resolve("@tailwindcss/vite"));
    vite = await createServer({
      configFile: false,
      root: temporary,
      plugins: [tailwindcss()],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [root, temporary] } },
    });
    await vite.listen();
    await app.whenReady();
    win = new BrowserWindow({
      width: 1000,
      height: 900,
      show: true,
      webPreferences: {
        preload: join(temporary, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.webContents.setBackgroundThrottling(false);
    await win.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}`);
    const waitFor = (expression) =>
      win.webContents.executeJavaScript(
        `new Promise((resolve,reject)=>{let timer;const check=()=>{if(${expression}){clearTimeout(timer);observer.disconnect();resolve(document.body.innerText)}};const observer=new MutationObserver(check);observer.observe(document.body,{subtree:true,childList:true,attributes:true});timer=setTimeout(()=>{observer.disconnect();reject(new Error("UI condition failed: "+document.body.innerText))},6000);check()})`,
      );
    const change = (next) =>
      win.webContents.executeJavaScript(`window.setScene(${JSON.stringify(next)})`);
    const body = () => win.webContents.executeJavaScript("document.body.innerText");
    // 修复：套餐详情已展示剩余百分比，原始额度文案断言无法验证当前界面或迟到结果。
    const meter = '[data-native-plan-detail="true"] [role="progressbar"][aria-label="每月剩余"]';
    const remaining = () =>
      win.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(meter)})?.getAttribute("aria-valuenow") ?? null`,
      );
    const waitForRemaining = (value) =>
      waitFor(
        `document.querySelector(${JSON.stringify(meter)})?.getAttribute("aria-valuenow") === ${JSON.stringify(String(value))}`,
      );
    await waitFor('document.body.innerText.includes("未开通，开通后启用")');
    assert.match(await body(), /Aiscoo Zen/);
    assert.doesNotMatch(await body(), /XWork Zen/);
    // 首套餐摘要必须保留目录顺序，不能被低价模板替换或拼入其他周期和说明。
    assert.match(await body(), /¥118\.00/);
    assert.match(await body(), /Fixture personal plan/);
    assert.doesNotMatch(
      await body(),
      /¥98\.00|¥258\.00|\$18\.00|Fixture cheaper|Fixture quarterly|Fixture USD/,
    );
    assert.equal(
      await win.webContents.executeJavaScript(
        '[...document.querySelectorAll("button")].find(e=>e.textContent.includes("个人套餐")).querySelectorAll(".text-ui-xl").length',
      ),
      1,
      "The personal plan entry must render exactly one reference price",
    );
    const teamDisabled = await win.webContents.executeJavaScript(
      '[...document.querySelectorAll("button")].find(e=>e.textContent.includes("团队套餐")).disabled',
    );
    assert.equal(teamDisabled, true);
    await change({ status: "active", userId: "A", connected: true });
    await waitFor('document.body.innerText.includes("Fixture Plan A")');
    await waitForRemaining(60);
    assert.match(await body(), /剩余额度[\s\S]*60%/);
    for (const [status, label] of [
      ["exhausted", "额度已耗尽"],
      ["expired", "授权已过期"],
      ["revoked", "授权已撤销"],
    ]) {
      await change({ status, userId: "A", connected: true });
      await waitFor(`document.body.innerText.includes(${JSON.stringify(label)})`);
    }
    await change({ status: "active", userId: "A", connected: true, error: true });
    await waitFor('document.querySelector("[role=alert]")');
    assert.doesNotMatch(await body(), /未开通，开通后启用|¥118\.00/);
    await change({ status: "active", userId: "A", connected: true, empty: true });
    await waitFor('document.body.innerText.includes("暂无已启用的套餐")');
    assert.doesNotMatch(await body(), /¥118\.00/);
    await change({ status: "active", userId: "A", connected: true });
    await waitFor('document.body.innerText.includes("Fixture Plan A")');
    readStarted = false;
    await change({ status: "active", userId: "A", connected: true, hold: true });
    await waitFor('document.body.innerText.includes("查询中")');
    assert.equal(readStarted, true);
    const firstBFrame = await change({ status: "active", userId: "B", connected: true });
    assert.doesNotMatch(firstBFrame, /Fixture Plan A/);
    await waitFor('document.body.innerText.includes("Fixture Plan B")');
    heldRead();
    await win.webContents.executeJavaScript(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    assert.doesNotMatch(await body(), /Fixture Plan A/);
    await change({ status: "active", userId: "B", connected: true, hold: true, used: "45" });
    await waitFor('document.body.innerText.includes("查询中")');
    await change({ status: "active", userId: "B", connected: true, used: "70" });
    await waitForRemaining(30);
    heldRead();
    await win.webContents.executeJavaScript(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    assert.equal(await remaining(), "30");
    await win.webContents.executeJavaScript(
      'window.nativeSettingsSmoke.scene({status:"active",userId:"B",connected:true,used:"72"})',
    );
    await win.webContents.executeJavaScript("window.refreshPlans()");
    await waitForRemaining(28);
    const firstLogoutFrame = await change({ status: "unassigned", userId: "B", connected: false });
    assert.doesNotMatch(firstLogoutFrame, /Fixture Plan B|28%|¥118\.00/);
    await waitFor('document.body.innerText.includes("未登录")');
    await change({ status: "active", userId: "B", connected: true });
    await waitFor('document.body.innerText.includes("Fixture Plan B")');
    await win.webContents.executeJavaScript('window.setAppearance("zai-dark","en-US")');
    await waitFor('document.body.innerText.includes("Team plans are not supported.")');
    assert.equal(
      await win.webContents.executeJavaScript(
        'document.documentElement.classList.contains("dark")',
      ),
      true,
      "English remount must preserve the requested dark theme",
    );
    win.setContentSize(393, 852);
    await win.webContents.executeJavaScript(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    const geometry = await win.webContents.executeJavaScript(
      "({scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,overflow:[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>document.documentElement.clientWidth+1).map(e=>({tag:e.tagName,class:e.className,text:e.textContent.slice(0,80),right:e.getBoundingClientRect().right})).slice(0,10)})",
    );
    assert.equal(geometry.scrollWidth <= geometry.clientWidth, true, JSON.stringify(geometry));
    console.log(
      "Native model settings: real Electron state/price/error/owner-switch/logout/theme/locale/mobile regressions passed",
    );
  } catch (error) {
    exitCode = 1;
    console.error(error);
  } finally {
    clearTimeout(deadline);
    await vite?.close();
    win?.destroy();
    app.exit(exitCode);
  }
}
void run();
