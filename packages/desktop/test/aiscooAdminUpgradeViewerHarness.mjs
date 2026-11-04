import assert from "node:assert/strict";
import { assertNativeDisplayCookie } from "./aiscooAdminNativeDisplayCookieAssertions.mjs";

// XCODE: 真实 dialog guest 的挂载/测量/关闭交互保持与内联 harness 完全一致。
// XCODE: 观测当前 zen DOM，避免品牌更名后误报首帧展示投影丢失。
export function createViewerHarness({ win, origin }) {
  const mount = async (context) => {
    const next = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Native dialog did not attach guest")),
        12_000,
      );
      win.webContents.once("did-attach-webview", (_event, guest) => {
        clearTimeout(timer);
        resolve(guest);
      });
    });
    await win.webContents.executeJavaScript(`window.mountUpgrade(${JSON.stringify(context)})`);
    const guest = await next;
    await assertNativeDisplayCookie(guest.session, origin, {
      version: 1,
      theme: context.theme === "zai-dark" ? "dark" : "light",
      locale: context.locale,
      initialAudience: context.audience,
      uiFontSizePx: context.font,
    });
    await new Promise((resolve) => {
      if (!guest.isLoading()) resolve();
      else guest.once("did-finish-load", resolve);
    });
    await guest.executeJavaScript(
      `new Promise((resolve,reject)=>{const ready=()=>{if(document.querySelector('article,[role=alert]')||(document.querySelector('.zen-plan-notice')&&!document.querySelector('[role=status]'))){observer.disconnect();clearTimeout(timer);resolve();}};const observer=new MutationObserver(ready);observer.observe(document,{subtree:true,childList:true});const timer=setTimeout(()=>{observer.disconnect();reject(new Error('Viewer content missing: '+document.body.textContent.slice(0,1000)));},10000);ready();})`,
    );
    await guest.executeJavaScript(
      "new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))",
    );
    return guest;
  };
  const measure = (guest) =>
    guest.executeJavaScript(
      `(()=>{const rect=e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height,bottom:r.bottom}};return{innerWidth,innerHeight,dpr:devicePixelRatio,theme:document.documentElement.classList.contains('dark')?'dark':'light',locale:document.documentElement.lang,font:document.documentElement.style.getPropertyValue('--ui-font-size'),audience:document.documentElement.dataset.zenPlanAudience,scrollWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth,cards:[...document.querySelectorAll('article')].map(e=>({name:e.getAttribute('aria-label'),...rect(e),cta:e.querySelector('button')?rect(e.querySelector('button')):null})),frames:window.__upgradeFrames||[],body:document.body.textContent.slice(0,600)}})()`,
    );
  const close = async (guest) => {
    const partition = guest.session;
    const cleared = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        partition.cookies.removeListener("changed", inspect);
        reject(new Error("Native cleanup retained cookies"));
      }, 5000);
      async function inspect() {
        if ((await partition.cookies.get({})).length) return;
        clearTimeout(timer);
        partition.cookies.removeListener("changed", inspect);
        resolve();
      }
      partition.cookies.on("changed", inspect);
      void inspect();
    });
    await win.webContents.executeJavaScript("window.closeUpgrade()");
    await new Promise((resolve) => {
      if (guest.isDestroyed()) resolve();
      else guest.once("destroyed", resolve);
    });
    await cleared;
    assert.deepEqual(await partition.cookies.get({}), []);
  };
  return { mount, measure, close };
}
