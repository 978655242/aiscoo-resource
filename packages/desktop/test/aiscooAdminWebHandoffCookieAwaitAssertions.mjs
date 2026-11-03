import assert from "node:assert/strict";
import { WebContentsView, session } from "electron";
import {
  attachNativePlanWebview,
  authorizeNativePlanWebHandoff,
  canAttachNativePlanWebview,
  setNativePlanWebviewOwner,
} from "../src/main/nativePlanWebviewManager.ts";

// XCODE: 暂停真实 prepare Cookie 写入后再换 owner 的完整场景；断言与主 smoke 原本一致。
export async function assertDelayedDisplayCookieOwnerLoss({
  win,
  origin,
  requestFor,
  prepare,
  assertDisplayCookie,
}) {
  const fromPartition = session.fromPartition;
  let delayedPartition;
  let delayedSession;
  let restoreCookieSet;
  let releaseCookieWrite;
  const cookieGate = new Promise((resolve) => {
    releaseCookieWrite = resolve;
  });
  let cookieWriteStarted;
  const cookieStarted = new Promise((resolve) => {
    cookieWriteStarted = resolve;
  });
  let pendingPrepare;
  session.fromPartition = (partition, options) => {
    const partitionSession = fromPartition(partition, options);
    if (partition.startsWith("xcode-native-plan:3:") && !delayedSession) {
      delayedPartition = partition;
      delayedSession = partitionSession;
      const cookieSet = partitionSession.cookies.set;
      restoreCookieSet = () => {
        partitionSession.cookies.set = cookieSet;
      };
      partitionSession.cookies.set = async (details) => {
        if (details.name === "xcode_plan_display_v1") {
          cookieWriteStarted();
          await cookieGate;
        }
        return cookieSet.call(partitionSession.cookies, details);
      };
    }
    return partitionSession;
  };
  try {
    await setNativePlanWebviewOwner(win.id, { origin, ownerGeneration: 3 });
    assert.equal(authorizeNativePlanWebHandoff(win.id, requestFor(3)), true);
    pendingPrepare = prepare(3).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    assert.equal(
      await Promise.race([
        cookieStarted.then(() => "cookie-write"),
        pendingPrepare.then(() => "prepare-returned"),
      ]),
      "cookie-write",
      "prepare must not return before its real Cookie write starts and completes",
    );
    assert.ok(delayedSession);
    await setNativePlanWebviewOwner(win.id, null);
    await setNativePlanWebviewOwner(win.id, { origin, ownerGeneration: 4 });
    assert.equal(authorizeNativePlanWebHandoff(win.id, requestFor(4)), true);
    const current = await prepare(4);
    await assertDisplayCookie(current.partition);
    const currentView = new WebContentsView({
      webPreferences: {
        partition: current.partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.contentView.addChildView(currentView);
    currentView.setBounds({ x: 0, y: 0, width: 500, height: 300 });
    const currentGuest = currentView.webContents;
    attachNativePlanWebview(win.id, current.partition, requestFor(4).url, currentGuest, console);
    await currentGuest.loadURL(requestFor(4).url);
    const currentCookies = await currentGuest.session.cookies.get({});

    releaseCookieWrite();
    const late = await pendingPrepare;
    assert.ok(late.error, "A's prepare must reject, never return a late attachable partition");
    assert.match(String(late.error), /XCODE_STALE_WEB_HANDOFF/);
    assert.equal((await delayedSession.cookies.get({})).length, 0, "late A Cookie must be cleared");
    assert.equal(canAttachNativePlanWebview(win.id, delayedPartition, requestFor(3).url), false);
    const oldView = new WebContentsView({
      webPreferences: {
        partition: delayedPartition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    const oldGuest = oldView.webContents;
    const oldDestroyed = new Promise((resolve) => oldGuest.once("destroyed", resolve));
    attachNativePlanWebview(win.id, delayedPartition, requestFor(3).url, oldGuest, console);
    await oldDestroyed;
    assert.equal(oldGuest.isDestroyed(), true, "late A cannot attach an old guest");
    assert.equal(currentGuest.isDestroyed(), false, "late A cleanup must not close B's guest");
    assert.deepEqual(
      await currentGuest.session.cookies.get({}),
      currentCookies,
      "late A cleanup must clear only A's real Session, not B's cookies",
    );
    assert.deepEqual(
      await currentGuest.executeJavaScript(
        "fetch('/api/xcode/v1/web/view').then(response => response.json())",
      ),
      { plan: "Assigned plan" },
      "B must retain its current owner request policy after A rejects",
    );
    await assert.rejects(prepare(3), /XCODE_STALE_WEB_HANDOFF/);
  } finally {
    releaseCookieWrite();
    await pendingPrepare;
    restoreCookieSet?.();
    session.fromPartition = fromPartition;
  }
}
