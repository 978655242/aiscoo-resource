import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { app, BrowserWindow, ipcMain } from "electron";
import { build } from "esbuild";
import { createCapabilityHost } from "./newApiModelCapabilitiesHost.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const requireRoot = createRequire(new URL("../../../package.json", import.meta.url));
const requireDesktop = createRequire(new URL("../package.json", import.meta.url));
const nativeId = "account:aiscoo-openai-chat-completions";
const modelTrigger = '[data-testid="chat-model-select-trigger"]';
const thoughtSlider = '[data-testid="composer-thought-slider"]';
const providerTrigger = '[data-testid="composer-provider-trigger"]';

assert.ok(process.argv[2], "Launch this fixture with runNewApiElectronSmokes.mjs");

async function run() {
  const temporary = await mkdtemp(join(process.argv[2], "xwork-model-capabilities-electron-"));
  app.setPath("userData", join(temporary, "profile"));
  let win, vite, host;
  let exitCode = 0;
  let stage = "fixture setup";
  const deadline = setTimeout(() => app.exit(1), 90_000);
  try {
    host = await createCapabilityHost(ipcMain, () => win);
    await writeFile(
      join(temporary, "preload.cjs"),
      `const {contextBridge,ipcRenderer}=require("electron");contextBridge.exposeInMainWorld("capabilityHost",{view:input=>ipcRenderer.invoke("capability-view",input),settings:()=>ipcRenderer.invoke("capability-settings"),metrics:()=>ipcRenderer.invoke("capability-metrics"),stage:values=>ipcRenderer.invoke("capability-stage",values),refresh:()=>ipcRenderer.invoke("capability-refresh"),onChange:listener=>{ipcRenderer.on("capability-changed",listener);return()=>ipcRenderer.removeListener("capability-changed",listener)}});`,
    );
    const renderer = await build({
      stdin: {
        resolveDir: root,
        loader: "tsx",
        contents: `
import React,{useState,useLayoutEffect} from "react";
import {createRoot} from "react-dom/client";
import {flushSync} from "react-dom";
import {V4ComposerModelControls} from "./packages/ui/src/v4/composer/V4ComposerToolbar.tsx";
import {useDraftConfigControl} from "./packages/ui/src/v4/composer/useDraftConfigControl.ts";
import {createComposerSubmissionConfig} from "./packages/ui/src/v4/composer/composerSubmissionConfig.ts";
import {ZCodeIntlProvider} from "./packages/ui/src/i18n/IntlProvider.tsx";
import {AiscooIntlProvider} from "./packages/ui/src/aiscoo/brand/index.ts";
import {ChatErrorBanner} from "./packages/ui/src/ChatErrorBanner.tsx";
import {ServiceProvider} from "./packages/ui/src/hooks/useServices.tsx";
import {PlatformProvider} from "./packages/ui/src/hooks/usePlatform.tsx";
import {StoreProvider,useZCodeStore} from "./packages/ui/src/store/StoreProvider.tsx";
import {TabStoreProvider} from "./packages/ui/src/store/TabStoreProvider.tsx";
import {TooltipProvider} from "./packages/ui/src/components/ui/tooltip.tsx";
import {Button} from "./packages/ui/src/components/ui/button.tsx";
import {ArrowUpIcon} from "lucide-react";
import {useComposerToolbarFit} from "./packages/ui/src/prompt-editor/useComposerToolbarFit.ts";
import {connectProviderSettingsSnapshot} from "./packages/ui/src/lib/providerSettingsSnapshot.ts";
import {applyTheme} from "./packages/ui/src/useTheme.ts";
const listeners=new Set();
const modelSelectionService={getView:input=>window.capabilityHost.view(input),refresh:()=>window.capabilityHost.refresh(),onDidChange:listener=>{listeners.add(listener);return{dispose:()=>listeners.delete(listener)}}};
window.capabilityHost.onChange(async()=>{const view=await modelSelectionService.getView();for(const listener of listeners)listener(view)});
const broadcast={onMessage:()=>({dispose(){}}),send:async()=>{}};
const services={settingService:{get:async()=>({})},broadcastService:broadcast,modelSelectionService,usageStatsService:{getEntitlementSnapshot:async()=>null},providerSettingsService:{getView:()=>window.capabilityHost.settings(),onDidChange:()=>({dispose(){}})}};
await connectProviderSettingsSnapshot(services.providerSettingsService).ready;
window.submissions=[];
function Scene(){
  const setUser=useZCodeStore(state=>state.setUser);
  const toolbarRef=useComposerToolbarFit();
  useLayoutEffect(()=>setUser({id:"fixture",nickname:"Fixture",provider:"new-api"}),[setUser]);
  const control=useDraftConfigControl({workspacePath:"/isolated-capability-fixture",sessionId:null,agentStartupAllowed:false,modelSelectionService});
  const read=control.modelSelectionRead;
  const view=read.state.status==="ready"?read.state.view:null;
  // XCODE: 与 SessionPane 一致，保留目录仅供连续键盘展示；提交仍只接受 ready View。
  const displayView=view??(read.state.status==="loading"?read.state.catalog:null);
  const [picker,setPicker]=useState(null);
  const submission=createComposerSubmissionConfig(control.draftConfig,view);
  window.state={stored:control.composerDraft.modelSelection,effective:control.draftConfig.modelSelection,status:read.state.status,issue:view?.selectionIssue,canSubmit:submission!==null,providers:view?.providers};
  window.restore=selection=>flushSync(()=>control.replaceComposerDraft({text:"synthetic input",mode:"build",planEnabled:false,modelSelection:selection}));
  window.peek=()=>modelSelectionService.getView({selection:control.composerDraft.modelSelection??null});
  // XCODE: SessionPane 分离操作来源模型与显式档位，fixture 使用同一真实 callback 合同。
  const selectModel=(provider,model,_sourceModel,reasoningLevel)=>control.handleDraftSelectModel(provider,model,reasoningLevel);
  return <section className="@container/composer rounded-2xl border bg-card p-3" id="composer-surface">
    <div className="min-h-16 text-ui-base text-foreground-subtle" contentEditable suppressContentEditableWarning data-testid="v4-composer-input">Synthetic isolated input</div>
    <div ref={toolbarRef} className="group/toolbar flex items-end gap-3">
      <div className="flex min-w-0 flex-1 items-center" data-composer-leading-actions><div className="flex shrink-0 items-center gap-1" data-composer-leading-content /></div>
      <div className="ml-auto flex shrink-0 items-center justify-end gap-1.5" data-composer-trailing-actions>
      <V4ComposerModelControls workspacePath="/isolated-capability-fixture" sessionId={null} phase={null} draftMode draftConfig={control.draftConfig} modelSelectionView={displayView} modelSelectionState={read.state} modelSelectionReload={read.reload} modelSelectionRefresh={read.refresh} usage={null} disabled={false} activeConfigPicker={picker} onConfigPickerOpenChange={(next,open)=>setPicker(open?next:null)} onSelectModel={selectModel} onSelectThought={control.handleDraftSelectThought} onSwitchMode={control.handleDraftSwitchMode}/>
      <Button size="icon-md" aria-label="Submit" data-testid="fixture-submit" disabled={!submission} onClick={()=>{const frozen=createComposerSubmissionConfig(control.draftConfig,view);if(frozen)window.submissions.push(frozen)}}><ArrowUpIcon className="size-4"/></Button>
      </div>
    </div>
    <Button data-testid="fixture-refresh" variant="ghost" onClick={()=>modelSelectionService.refresh()}>Refresh catalog</Button>
  </section>;
}
const renderer=createRoot(document.getElementById("root"));
window.appearance=(theme,locale)=>{applyTheme(theme);flushSync(()=>renderer.render(<ServiceProvider services={services}><PlatformProvider platform={{}}><StoreProvider broadcastService={broadcast}><TabStoreProvider><ZCodeIntlProvider key={locale} initialLocale={locale}><TooltipProvider><Scene/></TooltipProvider></ZCodeIntlProvider></TabStoreProvider></StoreProvider></PlatformProvider></ServiceProvider>))};
window.appearance("light","zh-CN");
// 隔离构造缺模型横幅，使用真实组件和国际化 Provider；套餐入口仅注入测试清单。
window.bannerEvents=[];
window.recordBannerEvent=event=>{window.bannerEvents.push(event);document.body.dataset.bannerEvent=event};
window.bannerAppearance=(theme,locale,product,native)=>{
  applyTheme(theme);
  const IntlProvider=product?AiscooIntlProvider:ZCodeIntlProvider;
  window.fixtureNative=native;
  flushSync(()=>renderer.render(<IntlProvider key={locale} initialLocale={locale}><ChatErrorBanner error={{code:"model_config_missing",message:"fixture"}} onOpenUpgrade={()=>window.recordBannerEvent("plans")} onOpenModelSettings={()=>window.recordBannerEvent("settings")} onDismiss={()=>window.recordBannerEvent("dismiss")}/></IntlProvider>));
};
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
          name: "unused-upgrade-entry",
          setup(builder) {
            builder.onLoad({ filter: /CodingPlanUpgradeDialogProvider\.tsx$/ }, () => ({
              contents:
                'export const useCodingPlanUpgradeDialog=()=>({openCodingPlanUpgrade(){throw new Error("Unexpected purchase action")}});export const useOptionalCodingPlanUpgradeDialog=()=>window.fixtureNative===undefined?null:{inventory:{status:"ready",native:window.fixtureNative}};',
              loader: "js",
            }));
          },
        },
      ],
      loader: { ".svg": "dataurl", ".png": "dataurl", ".css": "empty" },
      define: {
        "process.env.NODE_ENV": JSON.stringify("test"),
        "import.meta.env": "{}",
      },
    });
    await writeFile(join(temporary, "renderer.js"), renderer.outputFiles[0].text);
    await writeFile(
      join(temporary, "index.html"),
      `<!doctype html><html data-zcode-browser-theme-surface><head><link rel="stylesheet" href="/@fs${root}/packages/ui/src/styles.css"></head><body><div id="root" style="padding:20px"></div><script type="module" src="/renderer.js"></script></body></html>`,
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
      show: true,
      width: 1000,
      height: 520,
      webPreferences: {
        preload: join(temporary, "preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    win.webContents.on("console-message", (event) => {
      if (event.level === "error") console.error(event.message);
    });
    await win.loadURL(`http://127.0.0.1:${vite.httpServer.address().port}`);
    const observe = (expression) => win.webContents.executeJavaScript(expression);
    const waitFor = (expression) =>
      observe(
        `new Promise((resolve,reject)=>{const timer=setTimeout(()=>{observer.disconnect();reject(new Error("UI condition failed: "+${JSON.stringify(expression)}+" state="+JSON.stringify(window.state)))},7000);const check=()=>{if(${expression}){clearTimeout(timer);observer.disconnect();resolve(true)}};const observer=new MutationObserver(check);observer.observe(document.body,{subtree:true,childList:true,attributes:true});check()})`,
      );
    const click = async (expression) => {
      await observe(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))).then(()=>Promise.all(document.body.getAnimations({subtree:true}).filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{}))))",
      );
      const point = await observe(
        `(()=>{const element=${expression};if(!element)throw new Error("Missing UI element: "+${JSON.stringify(expression)});const r=element.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
      );
      win.webContents.sendInputEvent({ type: "mouseMove", ...point });
      win.webContents.sendInputEvent({
        type: "mouseDown",
        button: "left",
        clickCount: 1,
        ...point,
      });
      win.webContents.sendInputEvent({
        type: "mouseUp",
        button: "left",
        clickCount: 1,
        ...point,
      });
    };
    const state = () => observe("window.state");
    const settleMenus = () =>
      waitFor(
        'document.body.style.pointerEvents!=="none" && document.querySelector("[role=listbox],[role=menu]")===null',
      );
    const closeMenus = async () => {
      for (let depth = 0; depth < 3; depth++) {
        if (!(await observe('document.querySelector("[role=menu]")!==null'))) break;
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await observe(
          "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
        );
      }
      await settleMenus();
    };
    const openModels = async () => {
      await closeMenus();
      await click(`document.querySelector(${JSON.stringify(modelTrigger)})`);
      await waitFor(`document.querySelector(${JSON.stringify(providerTrigger)})!==null`);
    };
    const openProviders = async () => {
      await observe(`document.querySelector(${JSON.stringify(providerTrigger)}).focus()`);
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
      await waitFor('document.querySelector("[data-composer-provider-list]")!==null');
    };
    const chooseModel = async (label) => {
      const modelId = {
        "Capability A": "capability-a",
        "Capability B": "capability-b",
        "Capability single": "capability-single",
        "custom-model": "custom-model",
      }[label];
      assert.ok(modelId, `Unknown fixture model ${label}`);
      const providerId = modelId === "custom-model" ? "custom" : nativeId;
      const value = `custom:${encodeURIComponent(providerId)}:${encodeURIComponent(modelId)}`;
      const selector = `[data-testid="chat-model-select-item-${value}"]`;
      await openModels();
      if (!(await observe(`document.querySelector(${JSON.stringify(selector)})!==null`))) {
        await openProviders();
        const groupKey = providerId === nativeId ? "composer-official" : "registry-provider:custom";
        await click(`document.querySelector('[data-model-provider-key="${groupKey}"]')`);
        await waitFor(
          `window.state.status==="ready" && document.querySelector(${JSON.stringify(selector)})!==null && document.querySelector(${JSON.stringify(modelTrigger)}).disabled===false`,
        );
      }
      await click(`document.querySelector(${JSON.stringify(selector)})`);
      await waitFor(
        `window.state.status==="ready" && window.state.canSubmit && window.state.stored?.providerId===${JSON.stringify(providerId)} && window.state.stored?.modelId===${JSON.stringify(modelId)}`,
      );
      await closeMenus();
    };
    const openThought = async () => {
      await openModels();
      await waitFor(`document.querySelector(${JSON.stringify(thoughtSlider)})!==null`);
    };
    const levels = () =>
      observe(
        `JSON.parse(document.querySelector(${JSON.stringify(thoughtSlider)}).dataset.levels)`,
      );
    const selectOpenLevel = async (level) => {
      const declared = await levels();
      const index = declared.indexOf(level);
      assert.ok(index >= 0, `Host did not declare reasoning level ${level}`);
      const waitForLevel = async (position) => {
        const expected = declared[position];
        await waitFor(
          `window.state.status==="ready" && window.state.stored?.options?.reasoningLevel===${JSON.stringify(expected)} && document.querySelector(${JSON.stringify(thoughtSlider)})?.getAttribute("aria-disabled")==="false" && Number(document.querySelector(${JSON.stringify(thoughtSlider)})?.value)===${position}`,
        );
        assert.equal(
          await observe(
            `document.activeElement===document.querySelector(${JSON.stringify(thoughtSlider)})`,
          ),
          true,
          "Host re-resolution must preserve the focused slider",
        );
      };
      await waitFor(
        `document.querySelector(${JSON.stringify(thoughtSlider)})?.getAttribute("aria-disabled")==="false"`,
      );
      await observe(`document.querySelector(${JSON.stringify(thoughtSlider)}).focus()`);
      win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Home" });
      win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Home" });
      await waitForLevel(0);
      for (let step = 1; step <= index; step++) {
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Right" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Right" });
        await waitForLevel(step);
      }
      const expectedSelection = (await state()).stored;
      assert.equal(expectedSelection.options.reasoningLevel, level);
      assert.deepEqual((await observe("window.peek()")).effectiveSelection, expectedSelection);
    };
    const chooseLevel = async (level) => {
      await openThought();
      await selectOpenLevel(level);
      await closeMenus();
    };
    await waitFor('window.state?.status==="ready"');
    stage = "catalog diagnostics stay in settings, not in the model picker";
    assert.deepEqual(
      (await observe("window.capabilityHost.settings()")).catalogIssues.map(
        (issue) => issue.displayName,
      ),
      ["Missing metadata", "Bad CEL"],
    );
    await openModels();
    await waitFor('document.querySelector("[data-testid^=chat-model-select-item]")!==null');
    await openProviders();
    assert.deepEqual(
      await observe(
        '[...document.querySelectorAll("[data-composer-provider-list] [data-model-provider-key]")].map(element=>element.dataset.modelProviderKey).sort()',
      ),
      ["composer-official", "registry-provider:custom"],
    );
    assert.equal(
      await observe(
        'document.querySelector("[role=menu]").textContent.includes("Missing metadata") || document.querySelector("[role=menu]").textContent.includes("Bad CEL")',
      ),
      false,
      "Unselectable catalog entries must not appear in the model picker",
    );
    assert.equal(
      await observe('document.querySelector("[data-model-footer-action=manage-models]")!==null'),
      true,
    );
    await observe(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))).then(()=>Promise.all(document.body.getAnimations({subtree:true}).filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{}))))",
    );
    await writeFile(
      join(tmpdir(), "xwork-model-picker-selectable.png"),
      (await win.webContents.capturePage()).toPNG(),
    );
    await closeMenus();
    stage = "original menus and highest new-model choices";
    assert.deepEqual(
      (await state()).providers.map((provider) => provider.providerId),
      [nativeId, "custom"],
    );
    await chooseModel("Capability B");
    const expectedB = {
      providerId: nativeId,
      modelId: "capability-b",
      options: { reasoningLevel: "high" },
    };
    assert.deepEqual((await state()).stored, expectedB);
    assert.deepEqual((await observe("window.peek()")).effectiveSelection, expectedB);
    await chooseModel("Capability A");
    const expectedA = {
      providerId: nativeId,
      modelId: "capability-a",
      options: { reasoningLevel: "max" },
    };
    assert.deepEqual((await state()).stored, expectedA);
    assert.deepEqual((await observe("window.peek()")).effectiveSelection, expectedA);
    await openThought();
    assert.deepEqual(await levels(), ["disabled", "low", "high", "max"]);
    assert.equal(
      await observe(`document.querySelector(${JSON.stringify(thoughtSlider)}).value`),
      "3",
    );
    assert.notEqual(
      await observe(
        `document.querySelector(${JSON.stringify(thoughtSlider)}).getAttribute("aria-valuetext")`,
      ),
      "—",
    );
    await selectOpenLevel("low");
    await waitFor('window.state.stored?.options?.reasoningLevel==="low" && window.state.canSubmit');
    await closeMenus();
    await click('document.querySelector("[data-testid=fixture-submit]")');
    await waitFor("window.submissions.length===1");
    await chooseLevel("high");
    assert.equal(
      await observe("window.submissions[0].modelSelection.options.reasoningLevel"),
      "low",
    );
    await chooseLevel("max");
    win.webContents.sendInputEvent({
      type: "keyDown",
      keyCode: "T",
      modifiers: ["control"],
    });
    win.webContents.sendInputEvent({
      type: "keyUp",
      keyCode: "T",
      modifiers: ["control"],
    });
    await waitFor('window.state.stored?.options?.reasoningLevel==="disabled"');
    stage = "single and custom providers";
    await chooseModel("Capability single");
    await openModels();
    assert.equal(
      await observe(`document.querySelector(${JSON.stringify(thoughtSlider)})===null`),
      true,
    );
    assert.ok(
      await observe(
        'document.querySelector("[data-testid=composer-thought-value]")?.textContent.trim().length>0',
      ),
    );
    assert.equal((await state()).stored.options.reasoningLevel, "disabled");
    await closeMenus();
    await chooseModel("custom-model");
    await openThought();
    assert.deepEqual(await levels(), ["neutral", "custom-deep"]);
    await selectOpenLevel("neutral");
    await closeMenus();
    await chooseModel("Capability A");
    await chooseLevel("low");
    stage = "view-only versus actual Host refresh";
    const before = await observe("window.capabilityHost.metrics()");
    await observe('window.capabilityHost.stage(["disabled","high","max"])');
    const peek = await observe("window.peek()");
    assert.equal(peek.selectionIssue, undefined);
    assert.equal(
      (await observe("window.capabilityHost.metrics()")).catalogReads,
      before.catalogReads,
    );
    await click('document.querySelector("[data-testid=fixture-refresh]")');
    await waitFor(
      'window.state.issue==="reasoning-level-not-supported" && !window.state.canSubmit',
    );
    assert.equal((await state()).stored.options.reasoningLevel, "low");
    assert.equal(
      (await observe("window.capabilityHost.metrics()")).catalogReads,
      before.catalogReads + 1,
    );
    await click('document.querySelector("[data-testid=fixture-submit]")');
    assert.equal(await observe("window.submissions.length"), 1);
    await chooseLevel("high");
    await waitFor("window.state.canSubmit");
    stage = "historical invalid and empty choices";
    for (const level of ["off", "nothink", null]) {
      const selection = {
        providerId: nativeId,
        modelId: "capability-a",
        ...(level === null ? {} : { options: { reasoningLevel: level } }),
      };
      await observe(`window.restore(${JSON.stringify(selection)})`);
      await waitFor('window.state.status==="ready" && !window.state.canSubmit');
      assert.deepEqual((await state()).stored, selection);
    }
    await chooseLevel("high");
    stage = "original styled light/dark Chinese/English and narrow layout";
    const evidence = resolve(
      root,
      ".superpowers/sdd/2026-10-12-new-api-model-capability-optimization",
    );
    for (const [theme, locale, width] of [
      ["light", "zh-CN", 1000],
      ["dark", "en-US", 1000],
      ["light", "en-US", 360],
      ["dark", "zh-CN", 360],
    ]) {
      win.setContentSize(width, 440);
      await observe(`window.appearance(${JSON.stringify(theme)},${JSON.stringify(locale)})`);
      await waitFor('window.state.status==="ready" && window.state.canSubmit');
      await waitFor(
        `document.querySelector(${JSON.stringify(modelTrigger)})?.textContent.includes("Capability A") && document.querySelector(${JSON.stringify(modelTrigger)})?.disabled===false`,
      );
      win.webContents.sendInputEvent({ type: "mouseMove", x: 10, y: 10 });
      await waitFor('document.querySelector("[role=tooltip]")===null');
      await observe(
        "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))).then(()=>Promise.all(document.body.getAnimations({subtree:true}).filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{}))))",
      );
      const geometry = await observe(
        `(()=>{const model=document.querySelector(${JSON.stringify(modelTrigger)});const thought=[...model.querySelectorAll("[data-composer-thought-label],[data-testid=composer-thought-meter]")].find(element=>element.getBoundingClientRect().width>0);if(!thought)throw new Error("Missing combined effort presentation");const a=model.getBoundingClientRect(),b=thought.getBoundingClientRect();return{model:{x:a.x,right:a.right,width:a.width},thought:{x:b.x,right:b.right,width:b.width},font:getComputedStyle(thought).fontSize,theme:document.documentElement.className}})()`,
      );
      assert.ok(geometry.model.x >= 0 && geometry.model.right <= width);
      assert.ok(
        geometry.thought.x >= geometry.model.x &&
          geometry.thought.right <= geometry.model.right + 1,
      );
      assert.ok(
        geometry.model.width > 0 && geometry.thought.width > 0 && parseFloat(geometry.font) > 0,
      );
      await writeFile(
        join(evidence, `composer-capabilities-${theme}-${locale}-${width}.png`),
        (await win.webContents.capturePage()).toPNG(),
      );
    }
    stage = "Aiscoo missing-model banner copy and actions";
    for (const [theme, locale, width, message, planLabel, settingsLabel] of [
      ["light", "zh-CN", 1000, "未订阅 Aiscoo Zen 套餐或者自定义模型", "查看订阅套餐", "配置"],
      [
        "dark",
        "en-US",
        1000,
        "No Aiscoo Zen subscription or custom model",
        "View subscription",
        "Set",
      ],
      [
        "light",
        "en-US",
        360,
        "No Aiscoo Zen subscription or custom model",
        "View subscription",
        "Set",
      ],
      ["dark", "zh-CN", 360, "未订阅 Aiscoo Zen 套餐或者自定义模型", "查看订阅套餐", "配置"],
    ]) {
      win.setContentSize(width, 440);
      await observe(
        `window.bannerAppearance(${JSON.stringify(theme)},${JSON.stringify(locale)},true,true)`,
      );
      const content = await observe(
        'document.querySelector("[data-testid=chat-error-banner]").textContent',
      );
      assert.ok(content.includes(message), `${locale}: ${content}`);
      assert.ok(!content.includes("New API"), `${locale}: ${content}`);
      for (const [label, event] of [
        [planLabel, "plans"],
        [settingsLabel, "settings"],
      ]) {
        const selector = `document.querySelector('[data-testid=chat-error-banner] button[aria-label="${label}"]')`;
        assert.equal(await observe(`${selector}!==null && !${selector}.disabled`), true);
        await click(selector);
        // Electron 的输入事件会异步抵达 Renderer，等待实际 callback 再验证。
        await waitFor(`document.body.dataset.bannerEvent===${JSON.stringify(event)}`);
        assert.equal((await observe("window.bannerEvents")).at(-1), event);
      }
      assert.equal(
        await observe("document.documentElement.scrollWidth <= window.innerWidth"),
        true,
      );
    }
    stage = "non-native and upstream banner copy";
    await observe('window.bannerAppearance("light","zh-CN",true,false)');
    assert.ok(
      (
        await observe('document.querySelector("[data-testid=chat-error-banner]").textContent')
      ).includes("当前没有可用模型"),
    );
    await observe('window.bannerAppearance("light","zh-CN",false,true)');
    assert.ok(
      (
        await observe('document.querySelector("[data-testid=chat-error-banner]").textContent')
      ).includes("当前没有可用的 New API 模型"),
    );
    console.log(
      "Original Composer capability controls and Aiscoo missing-model banner scenarios passed",
    );
  } catch (error) {
    exitCode = 1;
    console.error(stage, error);
    if (win)
      console.error(
        await win.webContents.executeJavaScript(
          'JSON.stringify({pointerEvents:document.body.style.pointerEvents,menus:[...document.querySelectorAll("[role=menu],[role=listbox]")].map(element=>({role:element.getAttribute("role"),state:element.getAttribute("data-state")})),body:document.body.innerText})',
        ),
      );
  } finally {
    clearTimeout(deadline);
    host?.dispose();
    await vite?.close();
    win?.destroy();
    app.exit(exitCode);
  }
}
void run();
