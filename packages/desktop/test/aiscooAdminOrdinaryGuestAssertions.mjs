import assert from "node:assert/strict";

export async function assertOrdinaryPlanIsolation(
  ordinaryWindow,
  origin,
  createWebviewGuest,
  readPrivateRequests,
) {
  for (const partition of ["", "persist:ordinary-plan-regression", "ordinary-plan-regression"]) {
    const ordinary = await createWebviewGuest(partition);
    const before = readPrivateRequests();
    await assert.rejects(
      ordinary.loadURL(`${origin}/xcode/plans?handoff=ordinary-late`),
      "programmatic loadURL must not redeem a private ticket in an ordinary partition",
    );
    assert.equal(readPrivateRequests(), before);
    assert.equal(
      (await ordinary.session.cookies.get({ url: `${origin}/api/xcode/v1/web/view` })).length,
      0,
    );
    await ordinary.loadURL(`${origin}/custom`);
    assert.match(
      await ordinary.executeJavaScript("document.body.textContent"),
      /Ordinary browsing/,
    );
    const beforeSocket = readPrivateRequests();
    await ordinary.executeJavaScript(`new Promise(resolve => {
      const socket = new WebSocket(${JSON.stringify(`${origin.replace("http:", "ws:")}/xcode/plans?handoff=ordinary-socket`)});
      socket.onopen = () => { socket.close(); resolve(); };
      socket.onerror = () => resolve();
    })`);
    assert.equal(
      readPrivateRequests(),
      beforeSocket,
      "a failed WebSocket handshake must not redeem the private ticket",
    );
    assert.equal(
      (await ordinary.session.cookies.get({ url: `${origin}/api/xcode/v1/web/view` })).length,
      0,
    );
    assert.equal(
      await ordinary.executeJavaScript(
        `fetch(${JSON.stringify(`${origin}/xcode/plans?handoff=ordinary-fetch`)}).then(() => false, () => true)`,
      ),
      true,
    );
    assert.equal(
      await ordinary.executeJavaScript(
        `fetch(${JSON.stringify(`${origin}/api/xcode/v1/web/view`)}).then(() => false, () => true)`,
      ),
      true,
    );
    await assert.rejects(ordinary.loadURL(`${origin}/xcode/%70lans?handoff=ordinary-encoded`));
    await ordinary.loadURL(`${origin}/custom`);
    const frameNavigation = new Promise((resolve) =>
      ordinary.once("will-frame-navigate", (event) => resolve(event.defaultPrevented)),
    );
    await ordinary.executeJavaScript(`(() => {
      const frame = document.createElement('iframe');
      frame.src = ${JSON.stringify(`${origin}/xcode/plans?handoff=ordinary-frame`)};
      document.body.append(frame);
    })()`);
    assert.equal(await frameNavigation, true, "private subframe navigation must be cancelled");
    await assert.rejects(ordinary.loadURL(`${origin}/redirect-private`));
    await assert.rejects(ordinary.loadURL(`${origin}/xcode/plans`));
    assert.equal(
      readPrivateRequests(),
      before,
      "fetch, subframes, redirects and cookie-only plan URLs must never reach the private server",
    );
    assert.equal(
      (await ordinary.session.cookies.get({ url: `${origin}/api/xcode/v1/web/view` })).length,
      0,
    );
    await ordinary.loadURL(`${origin}/coding-plan?embedded=app`);
    assert.match(
      await ordinary.executeJavaScript("document.body.textContent"),
      /Ordinary browsing/,
    );
  }
  for (const url of [`${origin}/xcode/plans?handoff=ordinary-initial`, `${origin}/xcode/plans`]) {
    const blocked = new Promise((resolve) =>
      ordinaryWindow.webContents.once("will-attach-webview", (event) =>
        resolve(event.defaultPrevented),
      ),
    );
    await ordinaryWindow.webContents.executeJavaScript(`(() => {
      const view = document.createElement('webview'); view.src = ${JSON.stringify(url)}; document.body.append(view);
    })()`);
    assert.equal(await blocked, true, "initial private-plan guests must be denied before creation");
  }
}
