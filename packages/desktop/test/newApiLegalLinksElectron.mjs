import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const requireRoot = createRequire(new URL("../../../package.json", import.meta.url));
const requireServices = createRequire(new URL("../../services/package.json", import.meta.url));
const requireDesktop = createRequire(new URL("../package.json", import.meta.url));
const { build } = requireServices("esbuild");

// XCODE: 单独启动此场景，避免运行其他 Native smoke；不启动真实 Host 或读取用户配置。
async function launchStandalone() {
  const temporary = await mkdtemp(join(tmpdir(), "aiscoo-legal-electron-launch-"));
  try {
    const output = join(temporary, "newApiLegalLinksElectron.mjs");
    await build({
      entryPoints: [fileURLToPath(import.meta.url)],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      external: ["electron", requireServices.resolve("esbuild")],
      alias: { esbuild: requireServices.resolve("esbuild") },
      define: { "import.meta.url": JSON.stringify(import.meta.url) },
      banner: {
        js: `import {createRequire as smokeRequire} from "node:module"; const require=smokeRequire(${JSON.stringify(new URL("../package.json", import.meta.url).href)});`,
      },
    });
    const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(requireDesktop("electron"), [output, temporary], { env, stdio: "inherit" });
    await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        code === 0 ? done() : reject(new Error(`Legal links smoke failed: ${signal ?? code}`)),
      );
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runElectron() {
  const { app, BrowserWindow } = await import("electron");
  const { NewApiClient } = await import("../../services/src/new-api/newApiClient.ts");
  const { NewApiProviderAdapter } =
    await import("../../services/src/oauth/providers/newApiProviderAdapter.ts");
  assert.ok(process.argv[2], "Launch this fixture with Node or the Native smoke runner");
  const temporary = await mkdtemp(join(process.argv[2], "aiscoo-legal-"));
  // 每次验收独占证据目录，不覆盖原仓库或其他 worktree 的截图。
  const evidenceRoot = resolve(root, "packages/desktop/.e2e-artifacts");
  await mkdir(evidenceRoot, { recursive: true });
  const evidence = await mkdtemp(join(evidenceRoot, "legal-validation-"));
  app.setPath("userData", join(temporary, "profile"));
  app.setPath("sessionData", join(temporary, "sessions"));
  let win, vite;
  let exitCode = 0;
  let stage = "compile";
  const deadline = setTimeout(() => {
    console.error(`Legal links smoke timed out: ${stage}`);
    app.exit(1);
  }, 55_000);
  try {
    await mkdir(evidence, { recursive: true });
    const provider = new NewApiProviderAdapter(new NewApiClient("http://127.0.0.1:3001")).meta;
    const renderer = await build({
      stdin: {
        resolveDir: root,
        loader: "tsx",
        contents: `
import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {flushSync} from "react-dom";
import {ServiceProvider} from "./packages/ui/src/hooks/useServices.tsx";
import {PlatformProvider} from "./packages/ui/src/hooks/usePlatform.tsx";
import {StoreProvider} from "./packages/ui/src/store/StoreProvider.tsx";
import {AiscooIntlProvider, AiscooLoginHeader} from "./packages/ui/src/aiscoo/brand/index.ts";
import {AiscooLegalLinks, AiscooLegalSettings} from "./packages/ui/src/aiscoo/legal/index.ts";
import {TooltipProvider} from "./packages/ui/src/components/ui/tooltip.tsx";
import {WelcomeScreen} from "./packages/ui/src/WelcomeScreen.tsx";
import {GeneralSectionContent} from "./packages/ui/src/settingsPageHelpers.tsx";
import {applyTheme} from "./packages/ui/src/useTheme.ts";
const native=${JSON.stringify(provider)};
const state=window.legalSmoke={opened:[],authCalls:[],errors:[]};
let providers=[native];
const broadcast={send:async()=>{},onMessage:()=>({dispose(){}})};
const services={broadcastService:broadcast,settingService:{get:async()=>({}),update:async()=>{}},oauthService:{
 getProviders:async()=>providers,getActiveProvider:async()=>null,
 startOAuth:async()=>{state.authCalls.push("start");throw new Error("Unexpected authorization")},
 startOAuthWithPolling:async()=>{state.authCalls.push("polling");throw new Error("Unexpected authorization")},
 cancelPending:async()=>{}
}};
const platform={openExternal:url=>state.opened.push(url),registerOAuthState:()=>state.authCalls.push("state"),executeDesktopCommand:async()=>{}};
const save=async()=>{};
const general={localePreference:"system",notificationEnabled:true,notificationSoundEnabled:true,closeToTrayOnWindows:false,
 receivePreviewUpdates:false,autoDownloadAndInstallUpdates:false,dataBaseDir:"",terminalInheritSystemProfile:true,terminalFontFamily:"",
 nativeSearchEnhancementsEnabled:true,defaultHomeDir:"",isDesktop:true,setLocalePreference:()=>{},setNotificationEnabled:()=>{},setNotificationSoundEnabled:()=>{},
 messageStreamShowReasoning:true,messageStreamShowTodos:true,toolGroupingExploreEnabled:true,toolGroupingTerminalEnabled:true,toolGroupingChangesEnabled:true,
 zcodeInteractionBehavior:"queue",onDataBaseDirChange:save,onSelectDataBaseDir:async()=>null,onTerminalInheritSystemProfileChange:save,
 onTerminalFontFamilyChange:save,onNativeSearchEnhancementsEnabledChange:save,onToolSearchModeChange:save,onCloseToTrayOnWindowsChange:save,
 onReceivePreviewUpdatesChange:save,onAutoDownloadAndInstallUpdatesChange:save,onMessageStreamShowReasoningChange:save,onMessageStreamShowTodosChange:save,
 onToolGroupingExploreEnabledChange:save,onToolGroupingTerminalEnabledChange:save,onToolGroupingChangesEnabledChange:save,onZCodeInteractionBehaviorChange:save,onOpenOnboardingDialog:()=>{}};
function Scene(){
 const [scene,setScene]=useState({page:"login",locale:"zh-CN",available:true});
 state.change=next=>flushSync(()=>{providers=next.available===false?[{...native,legalLinks:undefined}]:[native];applyTheme(next.theme??"zai-light");setScene(next)});
 return <AiscooIntlProvider key={scene.locale} initialLocale={scene.locale}><TooltipProvider>
 {scene.page==="login"?<WelcomeScreen key={String(scene.available)} header={<AiscooLoginHeader/>} footer={items=><AiscooLegalLinks providers={items} placement="login"/>} onComplete={()=>state.authCalls.push("complete")}/>:<main className="min-h-dvh bg-background p-4 text-foreground"><GeneralSectionContent key={String(scene.available)} {...general} footer={<AiscooLegalSettings/>}/></main>}
 </TooltipProvider></AiscooIntlProvider>;
}
window.addEventListener("error",event=>state.errors.push(event.message));
window.addEventListener("unhandledrejection",event=>state.errors.push(String(event.reason?.stack??event.reason)));
applyTheme("zai-light");
createRoot(document.getElementById("root")).render(<ServiceProvider services={services}><PlatformProvider platform={platform}><StoreProvider broadcastService={broadcast}><Scene/></StoreProvider></PlatformProvider></ServiceProvider>);
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
      `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/@fs${root}/packages/ui/src/styles.css"><link rel="stylesheet" href="/@fs${root}/packages/ui/src/aiscoo/brand/brand.css"></head><body><div id="root"></div><script type="module" src="/renderer.js"></script></body></html>`,
    );
    stage = "start isolated Vite";
    const { createServer } = await import(requireDesktop.resolve("vite"));
    const { default: tailwindcss } = await import(requireDesktop.resolve("@tailwindcss/vite"));
    vite = await createServer({
      configFile: false,
      root: temporary,
      plugins: [tailwindcss()],
      server: { host: "127.0.0.1", port: 0, fs: { allow: [root, temporary] } },
    });
    await vite.listen();
    const origin = `http://127.0.0.1:${vite.httpServer.address().port}`;
    stage = "Electron readiness";
    await app.whenReady();
    win = new BrowserWindow({
      show: true,
      width: 1000,
      height: 760,
      webPreferences: {
        partition: `legal-smoke-${process.pid}`,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    });
    const blocked = [];
    win.webContents.session.webRequest.onBeforeRequest(
      { urls: ["<all_urls>"] },
      (details, callback) => {
        const url = new URL(details.url);
        const external =
          ["http:", "https:", "ws:", "wss:"].includes(url.protocol) &&
          url.host !== new URL(origin).host;
        if (external) blocked.push(url.origin);
        callback({ cancel: external });
      },
    );
    const observe = (expression) => win.webContents.executeJavaScript(expression);
    const frames = () =>
      observe("new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done)))");
    const waitFor = (expression) =>
      observe(`new Promise((done,reject)=>{
 const observer=new MutationObserver(check); const timer=setTimeout(()=>{observer.disconnect();reject(new Error(${JSON.stringify(expression)}))},6000);
 function check(){if(${expression}){clearTimeout(timer);observer.disconnect();done(true)}}
 observer.observe(document.body,{childList:true,subtree:true});check();})`);
    stage = "load isolated renderer";
    await win.loadURL(origin);
    await waitFor('document.querySelectorAll("[data-aiscoo-legal] a").length===2');
    win.webContents.debugger.attach("1.3");
    const clickLink = async (path) => {
      const point = await observe(
        `(()=>{const e=document.querySelector('[data-aiscoo-legal] a[href$="${path}"]');e.scrollIntoView({block:"center"});const r=e.getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`,
      );
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
        await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
          type,
          ...point,
          button: type === "mouseMoved" ? "none" : "left",
          clickCount: type === "mouseMoved" ? 0 : 1,
        });
    };
    const observations = [];
    for (const page of ["login", "settings"]) {
      for (const locale of ["zh-CN", "en-US"]) {
        for (const theme of ["zai-light", "zai-dark"]) {
          for (const width of [390, 1000]) {
            stage = `${page}/${locale}/${theme}/${width}`;
            win.setContentSize(width, 760);
            await observe(
              `window.legalSmoke.change(${JSON.stringify({ page, locale, theme, available: true })})`,
            );
            await waitFor('document.querySelectorAll("[data-aiscoo-legal] a").length===2');
            await frames();
            await observe(
              "Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))",
            );
            const metrics = await observe(`(()=>{
 const entry=document.querySelector('[data-aiscoo-legal]');entry.scrollIntoView({block:'center'});
 const r=entry.getBoundingClientRect(), links=Array.from(entry.querySelectorAll('a'));
 const login=document.querySelector('[data-testid="oauth-login-button-new-api"]');
 return{placement:entry.dataset.aiscooLegal,text:entry.innerText,width:innerWidth,left:r.left,right:r.right,
 links:links.map(a=>{const b=a.getBoundingClientRect(),s=getComputedStyle(a);return{href:a.href,color:s.color,left:b.left,right:b.right,top:b.top,bottom:b.bottom}}),
 afterLogin:!login||Boolean(login.compareDocumentPosition(entry)&Node.DOCUMENT_POSITION_FOLLOWING),
 last:entry.parentElement.lastElementChild===entry};})()`);
            assert.equal(metrics.placement, page);
            assert.ok(metrics.text.includes("杭州艾思酷国际贸易有限公司"), stage);
            assert.ok(
              metrics.text.includes(locale === "zh-CN" ? "用户协议" : "User Agreement"),
              stage,
            );
            assert.ok(
              metrics.text.includes(locale === "zh-CN" ? "隐私政策" : "Privacy Policy"),
              stage,
            );
            assert.ok(metrics.afterLogin, "Legal links must follow login controls");
            if (page === "settings")
              assert.ok(metrics.last, "Legal information must be the last General group");
            for (const link of metrics.links) {
              assert.ok(
                link.left >= 0 &&
                  link.right <= metrics.width &&
                  link.top >= 0 &&
                  link.bottom <= 760,
                `${stage}: legal links must be visible and within viewport`,
              );
              assert.equal(new URL(link.href).search, "");
            }
            const before = await observe("window.legalSmoke.opened.length");
            await clickLink("/user-agreement");
            await clickLink("/privacy-policy");
            assert.deepEqual(await observe(`window.legalSmoke.opened.slice(${before})`), [
              "http://127.0.0.1:3001/user-agreement",
              "http://127.0.0.1:3001/privacy-policy",
            ]);
            await win.webContents.debugger.sendCommand("Input.dispatchMouseEvent", {
              type: "mouseMoved",
              x: 2,
              y: 2,
              button: "none",
            });
            await observe(
              "Promise.all(document.getAnimations().filter(animation=>animation.effect?.getTiming().iterations!==Infinity).map(animation=>animation.finished.catch(()=>{})))",
            );
            await writeFile(
              join(evidence, `${page}-${locale}-${theme}-${width}.png`),
              (await win.webContents.capturePage()).toPNG(),
            );
            observations.push({ stage, ...metrics });
          }
        }
      }
    }
    for (const page of ["login", "settings"]) {
      await observe(
        `window.legalSmoke.change(${JSON.stringify({ page, locale: "zh-CN", theme: "zai-light", available: false })})`,
      );
      await frames();
      assert.equal(
        await observe('document.querySelectorAll("[data-aiscoo-legal]").length'),
        0,
        "Missing metadata has no fallback",
      );
    }
    assert.deepEqual(await observe("window.legalSmoke.authCalls"), []);
    assert.deepEqual(await observe("window.legalSmoke.errors"), []);
    assert.deepEqual(
      blocked,
      [],
      "The fixture must not reach any auth, handoff or external network endpoint",
    );
    await writeFile(join(evidence, "observations.json"), JSON.stringify(observations, null, 2));
    console.log(
      `Legal links Electron: PASS (${observations.length} layouts, 32 clicks, anonymous/no-auth, missing metadata); evidence=${evidence}`,
    );
  } catch (error) {
    console.error(`Legal links Electron failed at ${stage}`, error);
    exitCode = 1;
  } finally {
    clearTimeout(deadline);
    win?.destroy();
    await vite?.close();
    app.exit(exitCode);
  }
}

// XCODE: Electron 入口求值先完成，避免 top-level await 与 app.whenReady 互相等待。
void (process.versions.electron ? runElectron() : launchStandalone()).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
