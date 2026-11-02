import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
            scope: "zen-subscription",
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
        // XCODE: 可见 transport 同时覆盖正常、无 metadata 和完整但 CEL 非法的真实目录投影。
        catalog: {
          ...catalog,
          models: catalog.models
            .filter((model) => !scene.allIssues || model.model_id !== "real-model")
            .map((model) => ({
              ...model,
              api_type: model.api_type ? "openai-chat-completions" : null,
              ...(model.model_id === "real-model"
                ? {
                    icon: "OpenAI",
                    model_config: {
                      ...model.model_config,
                      properties: {
                        ...model.model_config.properties,
                        inputFormat: {
                          ...model.model_config.properties.inputFormat,
                          supportsImage: true,
                        },
                      },
                    },
                  }
                : {}),
            })),
        },
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
import React,{useLayoutEffect,useState} from "react";
import {createRoot} from "react-dom/client";
import {flushSync} from "react-dom";
import {ServiceProvider} from "./packages/ui/src/hooks/useServices.tsx";
import {StoreProvider,useZCodeStore} from "./packages/ui/src/store/StoreProvider.tsx";
import {connectProviderSettingsSnapshot} from "./packages/ui/src/lib/providerSettingsSnapshot.ts";
import {projectProviderSettingsViewToFormProviders} from "./packages/ui/src/lib/providerSettingsFormProjection.ts";
import {useNativePlanSettings} from "./packages/ui/src/hooks/useNativePlanSettings.ts";
import {useProviderSettingsView} from "./packages/ui/src/hooks/useProviderSettingsView.ts";
import {ZCodeIntlProvider} from "./packages/ui/src/i18n/IntlProvider.tsx";
import {ModelProviderSectionDetail} from "./packages/ui/src/settings/model-provider-section/Detail.tsx";
import {PlatformProvider} from "./packages/ui/src/hooks/usePlatform.tsx";
import {TooltipProvider} from "./packages/ui/src/components/ui/tooltip.tsx";
import {applyTheme} from "./packages/ui/src/useTheme.ts";
let currentView=await window.nativeSettingsSmoke.view();
const listeners=new Set();
const providerSettingsService={getView:async()=>currentView,onDidChange:listener=>{listeners.add(listener);return{dispose:()=>listeners.delete(listener)}}};
const services={providerSettingsService,usageStatsService:{getEntitlementSnapshot:async()=>null},codingPlanSubscriptionService:{getStaticProducts:()=>window.nativeSettingsSmoke.read()}};
const broadcastService={send:async()=>{},onMessage:()=>()=>{}};
await connectProviderSettingsSnapshot(providerSettingsService).ready;
let setUser, initialized=false, fixtureUserId="A";
window.modelTests=[];
window.modelWrites=[];
const unexpectedWrite=(...args)=>{window.modelWrites.push(args);throw new Error("Read-only fixture must not save")};
function Scene(){
  setUser=useZCodeStore(state=>state.setUser);
  const [custom,setCustom]=useState(false);
  useLayoutEffect(()=>{if(!initialized){initialized=true;setUser({id:"fixture-A",nickname:"Fixture",provider:"new-api"})}},[]);
  const settings=useProviderSettingsView();
  const provider=settings.state.status==="ready"?projectProviderSettingsViewToFormProviders(settings.state.view).find(item=>item.providerId===${JSON.stringify(id)}):null;
  const read=useNativePlanSettings(${JSON.stringify(id)});
  window.refreshPlans=read.refresh;
  if(!provider)return null;
  const customProvider={...provider,providerId:"fixture-custom",providerName:"Fixture Custom",models:[],config:{group:"standard-personal",access:{type:"api-key",apiKey:""},api:{type:"openai-chat-completions",baseUrl:"https://fixture.invalid/v1"}}};
  const selectedNavItem=custom?{key:"custom",type:"custom",label:"Fixture Custom",provider:customProvider,statusActive:true}:{key:"native",type:"nativePlan",label:provider.providerName,provider,statusActive:provider.executable};
  return <>
    <button data-testid="fixture-native" onClick={()=>setCustom(false)}>Native</button>
    <button data-testid="fixture-custom" onClick={()=>setCustom(true)}>Custom</button>
    <ModelProviderSectionDetail selectedNavItem={selectedNavItem} nativePlanRead={read} providerSettingsView={settings.state.view} presetLoading={false} codingPlanPurchaseTokenAuthenticatedByProviderId={{}} onSave={unexpectedWrite} onAddPersonalModel={unexpectedWrite} onSavePersonalModelDraft={unexpectedWrite} onSetPersonalModelEnabled={unexpectedWrite} onDeletePersonalModel={unexpectedWrite} onDelete={unexpectedWrite} onReorderProviderModels={unexpectedWrite} onTestModel={async(providerId,modelId)=>{window.modelTests.push({providerId,modelId});return{success:true}}} onCodingPlanLogin={unexpectedWrite} onCodingPlanDisconnect={unexpectedWrite} onRetryCodingPlan={unexpectedWrite} onOpenApiKeyUrl={unexpectedWrite} onOpenBigModelRegistration={unexpectedWrite} onCodingPlanPurchaseComplete={unexpectedWrite}/>
  </>;
}
const renderer=createRoot(document.getElementById("root"));
const mount=locale=>flushSync(()=>renderer.render(<ServiceProvider services={services}><PlatformProvider platform={{}}><StoreProvider broadcastService={broadcastService}><ZCodeIntlProvider key={locale} initialLocale={locale}><TooltipProvider><Scene/></TooltipProvider></ZCodeIntlProvider></StoreProvider></PlatformProvider></ServiceProvider>));
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
      plugins: [
        {
          name: "isolated-upgrade-entry",
          setup(builder) {
            // XCODE: esbuild 无 Vite glob 转换；只装配 fixture 使用的真实 SVG，LobeIcon 逻辑保持原样。
            builder.onLoad({ filter: /\/LobeIcon\.tsx$/ }, async ({ path }) => {
              const iconPath = join(
                root,
                "node_modules/@lobehub/icons-static-svg/icons/openai.svg",
              );
              const iconUrl = `data:image/svg+xml;base64,${(await readFile(iconPath)).toString("base64")}`;
              return {
                contents: (await readFile(path, "utf8")).replace(
                  /import\.meta\.glob<string>\([\s\S]*?\);/,
                  `({${JSON.stringify(iconPath)}:()=>Promise.resolve(${JSON.stringify(iconUrl)})});`,
                ),
                loader: "tsx",
                resolveDir: dirname(path),
              };
            });
            builder.onLoad({ filter: /CodingPlanUpgradeDialogProvider\.tsx$/ }, () => ({
              contents:
                'export const useCodingPlanUpgradeDialog=()=>({openCodingPlanUpgrade(){throw new Error("A disabled team card must not open a purchase")}});export const useOptionalCodingPlanUpgradeDialog=()=>({inventory:{status:"ready",native:true}});',
              loader: "js",
            }));
          },
        },
      ],
      loader: { ".svg": "dataurl", ".png": "dataurl", ".css": "empty" },
      define: { "process.env.NODE_ENV": JSON.stringify("test"), "import.meta.env": "{}" },
    });
    await writeFile(join(temporary, "renderer.js"), renderer.outputFiles[0].text);
    // XCODE: 源版根节点为 vibrancy 强制透明；隔离窗口须显式承接同一主题背景并允许文档滚动。
    await writeFile(
      join(temporary, "index.html"),
      `<!doctype html><html><head><link rel="stylesheet" href="/@fs${root}/packages/ui/src/styles.css"><style>html,body,#root{background:var(--color-background)!important}body{color:var(--color-foreground);overflow:auto}#root{height:auto;min-height:100%}</style></head><body><div id="root" style="max-width:780px;padding:40px"></div><script type="module" src="/renderer.js"></script></body></html>`,
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
    // XCODE: 真实详情和上游模型行验收同列表诊断；无 metadata 的条目不能获得能力、排序或操作。
    await win.webContents.executeJavaScript('window.setAppearance("zai-light","zh-CN")');
    await change({ status: "active", userId: "B", connected: true });
    await waitFor('document.body.innerText.includes("Missing metadata")');
    await waitFor(
      'document.querySelector("[data-testid=model-provider-model-input-0]")?.parentElement.querySelector("[style*=mask-image]")',
    );
    const diagnostic = '[data-native-plan-detail] [data-native-catalog-issue="unconfigured"]';
    const inspectList = () =>
      win.webContents.executeJavaScript(`(()=>{
        const issue=document.querySelector(${JSON.stringify(diagnostic)});
        const list=issue?.parentElement;
        const valid=document.querySelector('[data-testid="model-provider-model-input-0"]');
        return {
          diagnostic:!!issue,
          singleList:!!list?.contains(valid),
          topNote:!!document.querySelector('[role="note"]'),
          diagnosticText:issue?.textContent,
          fakeCapacity:!!issue?.querySelector('[aria-label*="上下文"],[aria-label*="Context"]'),
          operations:issue?.querySelectorAll('button,input,[role="switch"]').length,
          sortable:!!issue?.closest('[data-model-provider-model-id]'),
          invalidModelReason:[...list?.children??[]].find(row=>row.textContent.includes("Bad CEL"))?.textContent,
          validModelText:valid?.parentElement?.textContent,
          validModelIcon:!!valid?.parentElement?.querySelector("[style*=mask-image]"),
          nativeEdits:!!document.querySelector('[data-native-plan-detail] [data-testid="model-provider-add-model-button"],[data-native-plan-detail] [data-slot="dialog-trigger"],[data-native-plan-detail] [role="switch"]')
        };
      })()`);
    const mixed = await inspectList();
    assert.equal(
      mixed.diagnostic,
      true,
      "Missing metadata must remain visible in the Native model list",
    );
    assert.equal(mixed.singleList, true, JSON.stringify(mixed));
    assert.equal(mixed.topNote, false);
    assert.match(mixed.diagnosticText, /XCODE_MODEL_CONFIG_MISSING/);
    assert.equal(mixed.fakeCapacity, false);
    assert.equal(mixed.operations, 0);
    assert.equal(mixed.sortable, false);
    assert.equal(mixed.nativeEdits, false);
    assert.match(mixed.invalidModelReason, /XCODE_MODEL_CONFIG_INVALID/);
    assert.match(mixed.validModelText, /Real.*8\.192K.*视觉/);
    assert.equal(mixed.validModelIcon, true);
    await win.webContents.executeJavaScript(
      'document.querySelector("[data-testid=model-provider-model-input-0]").closest(".space-y-2").querySelector("button").click()',
    );
    assert.deepEqual(await win.webContents.executeJavaScript("window.modelTests"), [
      { providerId: id, modelId: "real-model" },
    ]);
    const evidence = join(root, "packages/desktop/.e2e-artifacts/model-provider-upstream-ui");
    await mkdir(evidence, { recursive: true });
    await writeFile(
      join(evidence, "mixed-zh-CN-393.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    win.setContentSize(1000, 1000);
    await win.webContents.executeJavaScript(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    await writeFile(
      join(evidence, "mixed-zh-CN-1000.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await change({ status: "active", userId: "B", connected: true, allIssues: true });
    await waitFor(
      'document.body.innerText.includes("Missing metadata") && !document.body.innerText.includes("Real")',
    );
    assert.equal((await inspectList()).diagnostic, true);
    assert.match(await body(), /Bad CEL/);
    await win.webContents.executeJavaScript(
      'document.querySelector("[data-testid=fixture-custom]").click()',
    );
    await waitFor('document.body.innerText.includes("Fixture Custom")');
    assert.doesNotMatch(await body(), /Missing metadata|Bad CEL|XCODE_MODEL_CONFIG_MISSING/);
    assert.equal(
      await win.webContents.executeJavaScript(
        '!!document.querySelector("[data-testid=model-provider-add-model-button]")',
      ),
      true,
      "Custom provider must retain model editing controls",
    );
    await win.webContents.executeJavaScript(
      'document.querySelector("[data-testid=fixture-native]").click()',
    );
    await waitFor('document.body.innerText.includes("Missing metadata")');
    for (const [theme, locale] of [
      ["zai-light", "zh-CN"],
      ["zai-dark", "zh-CN"],
      ["zai-light", "en-US"],
      ["zai-dark", "en-US"],
    ]) {
      await win.webContents.executeJavaScript(
        `window.setAppearance(${JSON.stringify(theme)},${JSON.stringify(locale)})`,
      );
      await waitFor('document.querySelector("[data-native-catalog-issue=unconfigured]")');
      const surface = await win.webContents.executeJavaScript(
        "({background:getComputedStyle(document.body).backgroundColor,color:getComputedStyle(document.body).color})",
      );
      assert.notEqual(
        surface.background,
        "rgba(0, 0, 0, 0)",
        `${theme}: fixture must paint the theme surface`,
      );
      assert.notEqual(surface.background, surface.color, `${theme}: text must remain visible`);
      for (const width of [1000, 393]) {
        win.setContentSize(width, 1000);
        await win.webContents.executeJavaScript(
          "window.scrollTo(0,0);new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
        const widths = await win.webContents.executeJavaScript(
          "({scroll:document.documentElement.scrollWidth,client:document.documentElement.clientWidth})",
        );
        assert.ok(widths.scroll <= widths.client, JSON.stringify({ theme, locale, width, widths }));
        await writeFile(
          join(evidence, `${theme}-${locale}-${width}.png`),
          (await win.webContents.capturePage()).toPNG(),
        );
        for (const modelId of ["unconfigured", "bad-cel"]) {
          const visible = await win.webContents.executeJavaScript(`(async()=>{
            const row=document.querySelector('[data-native-catalog-issue="${modelId}"]');
            row.scrollIntoView({block:"center"});
            await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
            const rect=row.getBoundingClientRect();
            return rect.top>=0 && rect.bottom<=innerHeight;
          })()`);
          assert.equal(visible, true, `${theme}/${locale}/${width}: ${modelId} must be scrollable`);
        }
        await writeFile(
          join(evidence, `${theme}-${locale}-${width}-models.png`),
          (await win.webContents.capturePage()).toPNG(),
        );
      }
    }
    assert.deepEqual(await win.webContents.executeJavaScript("window.modelWrites"), []);
    assert.deepEqual(await win.webContents.executeJavaScript("window.modelTests"), [
      { providerId: id, modelId: "real-model" },
    ]);
    console.log(
      "Native model settings: real Electron state/price/owner and upstream single-list mixed/all-issue/custom-isolation/zh-en/light-dark/393px regressions passed",
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
