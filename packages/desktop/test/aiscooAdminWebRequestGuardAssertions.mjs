import assert from "node:assert/strict";
import { WebContentsView, session } from "electron";
import {
  startResourceManagerNetwork,
  stopResourceManagerNetwork,
} from "../src/main/resourceManagerNetwork.ts";
import { subscribeBeforeRequest } from "../src/main/observeBeforeRequest.ts";

export async function assertNetworkCapturePreservesPlanGuards({
  ordinaryWindow,
  origin,
  createWebviewGuest,
  counters,
}) {
  const captureGuest = await createWebviewGuest("persist:zcode-coding-plan", `${origin}/custom`);
  const observedUrls = new Set();
  const stopHostObserver = subscribeBeforeRequest(
    session.defaultSession.webRequest,
    ["http://*/*"],
    (details) => observedUrls.add(details.url),
  );
  try {
    // XCODE: 在真实 Electron 单 listener 槽开关捕获，不能替换或清除私有请求准入。
    for (const [index, active] of [false, true, false, true, false].entries()) {
      if (active) startResourceManagerNetwork(ordinaryWindow.webContents.id, () => []);
      else stopResourceManagerNetwork([]);
      const before = counters.private;
      for (const contents of [ordinaryWindow.webContents, captureGuest]) {
        const publicUrl = `${origin}/custom?capture-phase=${index}&guest=${contents.id}`;
        assert.equal(
          await contents.executeJavaScript(
            `fetch(${JSON.stringify(publicUrl)}).then(response => response.ok)`,
          ),
          true,
        );
        if (contents === ordinaryWindow.webContents)
          assert.ok(observedUrls.has(publicUrl), "normal host requests remain observable");
        for (const path of ["/xcode/plans?handoff=capture", "/api/xcode/v1/web/view"]) {
          assert.equal(
            await contents.executeJavaScript(
              `fetch(${JSON.stringify(`${origin}${path}`)}).then(() => false, () => true)`,
            ),
            true,
            `capture active=${active} must preserve private request denial`,
          );
        }
      }
      assert.equal(counters.private, before);
    }
    stopHostObserver();
    assert.equal(
      await ordinaryWindow.webContents.executeJavaScript(
        `fetch(${JSON.stringify(`${origin}/xcode/plans?handoff=last-observer-removed`)}).then(() => false, () => true)`,
      ),
      true,
      "removing the last observer must leave the session guard installed",
    );
  } finally {
    stopResourceManagerNetwork([]);
    stopHostObserver();
  }
}

export async function assertNativeObserverPreservesPlanOwner({
  nativeAttached,
  origin,
  partition,
  initialUrl,
  counters,
}) {
  const nativeObserved = [];
  const stopNativeObserver = subscribeBeforeRequest(
    nativeAttached.session.webRequest,
    ["http://*/*"],
    (details) => nativeObserved.push(details.url),
  );
  try {
    for (const active of [true, false]) {
      if (!active) stopNativeObserver();
      assert.deepEqual(
        await nativeAttached.executeJavaScript(
          "fetch('/api/xcode/v1/web/view').then(response => response.json())",
        ),
        { plan: "Assigned plan" },
      );
      if (active) assert.ok(nativeObserved.includes(`${origin}/api/xcode/v1/web/view`));
      const before = counters.private;
      assert.equal(
        await nativeAttached.executeJavaScript(
          "fetch('/xcode/plans?handoff=observer-other-owner').then(() => false, () => true)",
        ),
        true,
      );
      const rogue = new WebContentsView({
        webPreferences: {
          partition,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      try {
        await assert.rejects(rogue.webContents.loadURL(initialUrl));
      } finally {
        rogue.webContents.close({ waitForBeforeUnload: false });
      }
      assert.equal(
        counters.private,
        before,
        "Native owner and guest checks survive observer toggles",
      );
    }
  } finally {
    stopNativeObserver();
  }
}
