import { BrowserWindow, ipcMain, session } from "electron";
import type { Session, WebContents } from "electron";
import type { NativePlanDisplayContext, NativePlanWebviewPrepareRequest } from "@zcode/shared";
import { AiscooAdminPlanWebviewPolicy } from "./aiscooAdminPlanWebviewPolicy.js";
import type { NativePlanWebviewOwner } from "./aiscooAdminPlanWebviewPolicy.js";
import { subscribeBeforeRequestGuard } from "./observeBeforeRequest.js";

const windows = new Map<
  number,
  { policy: AiscooAdminPlanWebviewPolicy; guests: Map<string, WebContents> }
>();
const guardedSessions = new WeakMap<Session, { windowId: number; partition: string } | null>();

// XCODE: Validate the finite UI boundary before it can enter a page-readable Cookie.
function isNativePlanDisplayContext(value: unknown): value is NativePlanDisplayContext {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as NativePlanDisplayContext;
  const keys = Object.keys(context);
  return (
    keys.length === 5 &&
    keys.every(
      (key) =>
        key === "version" ||
        key === "theme" ||
        key === "locale" ||
        key === "initialAudience" ||
        key === "uiFontSizePx",
    ) &&
    context.version === 1 &&
    (context.theme === "light" || context.theme === "dark") &&
    (context.locale === "zh-CN" || context.locale === "en-US") &&
    (context.initialAudience === "personal" || context.initialAudience === "team") &&
    Number.isInteger(context.uiFontSizePx) &&
    context.uiFontSizePx >= 12 &&
    context.uiFontSizePx <= 20
  );
}

// XCODE: The desktop zoom owner calls this at every actual factor write, not just on events.
export function syncNativePlanWebviewZoom(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const guests = windows.get(win.id)?.guests;
  if (!guests) return;
  const factor = win.webContents.getZoomFactor();
  for (const guest of guests.values()) {
    if (!guest.isDestroyed()) guest.setZoomFactor(factor);
  }
}

/** XCODE: 私有只读路径必须经专用分区准入；普通 guest 不得在登录切换后保留旧 cookie。 */
export function isNativePlanPrivateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "http:" &&
      url.protocol !== "https:" &&
      url.protocol !== "ws:" &&
      url.protocol !== "wss:"
    )
      return false;
    const path = decodeURIComponent(url.pathname);
    return (
      path === "/xcode/plans" ||
      path.startsWith("/xcode/plans/") ||
      path === "/api/xcode/v1/web" ||
      path.startsWith("/api/xcode/v1/web/")
    );
  } catch {
    return false;
  }
}

/** XCODE: 默认宿主、普通与 Native guest 的安全准入不能被网络观测覆盖或移除。 */
export function guardPlanWebviewSession(partitionSession: Session): Session {
  if (guardedSessions.has(partitionSession)) return partitionSession;
  guardedSessions.set(partitionSession, null);
  subscribeBeforeRequestGuard(partitionSession.webRequest, ["<all_urls>"], (details) => {
    const native = guardedSessions.get(partitionSession);
    if (!native) return { cancel: isNativePlanPrivateUrl(details.url) };
    const entry = windows.get(native.windowId);
    const guest = entry?.guests.get(native.partition);
    const allowed = Boolean(
      entry &&
      guest &&
      guest.id === details.webContentsId &&
      entry.policy.canRequest(native.partition, details.url, details.resourceType === "mainFrame"),
    );
    return { cancel: !allowed };
  });
  return partitionSession;
}

export function guardOrdinaryNativePlanRequests(guest: WebContents): void {
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (isNativePlanPrivateUrl(url)) event.preventDefault();
  };
  guest.on("will-navigate", guard);
  guest.on("will-redirect", guard);
  guest.on("will-frame-navigate", (event) => guard(event, event.url));
  guardPlanWebviewSession(guest.session);
}

// XCODE: Only the validated Host message calls this; renderer cannot establish an owner.
export async function setNativePlanWebviewOwner(
  windowId: number,
  owner: NativePlanWebviewOwner | null,
): Promise<void> {
  let entry = windows.get(windowId);
  if (!entry && owner) {
    entry = { policy: new AiscooAdminPlanWebviewPolicy(), guests: new Map() };
    windows.set(windowId, entry);
  }
  if (!entry) return;
  const partitions = entry.policy.setOwner(owner);
  const cleanup = partitions.map((partition) => closeNativePlanWebview(windowId, partition));
  if (!owner) windows.delete(windowId);
  await Promise.all(cleanup);
}

/** Only the trusted Host may register a freshly issued short URL. No renderer IPC exposes this. */
export function authorizeNativePlanWebHandoff(
  windowId: number,
  request: { url: string; ownerGeneration: number },
): boolean {
  return windows.get(windowId)?.policy.authorize(request) === true;
}

export async function closeNativePlanWebview(windowId: number, partition: string): Promise<void> {
  const entry = windows.get(windowId);
  const guest = entry?.guests.get(partition);
  entry?.policy.close(partition);
  entry?.guests.delete(partition);
  const win = BrowserWindow.fromId(windowId);
  if (win && !win.isDestroyed())
    win.webContents.send("zcode:native-plan-webview-invalidated", partition);
  if (guest && !guest.isDestroyed()) guest.close({ waitForBeforeUnload: false });
  const partitionSession = session.fromPartition(partition);
  await Promise.all([partitionSession.clearStorageData(), partitionSession.clearCache()]);
}

export function isNativePlanWebviewPartition(partition: string | undefined): boolean {
  return partition?.startsWith("xcode-native-plan:") === true;
}

export function canAttachNativePlanWebview(
  windowId: number,
  partition: string,
  url: string,
): boolean {
  return windows.get(windowId)?.policy.canAttach(partition, url) === true;
}

export function attachNativePlanWebview(
  windowId: number,
  partition: string,
  initialUrl: string,
  guest: WebContents,
  logger: { warn: (...args: unknown[]) => void },
): void {
  const entry = windows.get(windowId);
  const partitionSession = session.fromPartition(partition);
  if (guest.session !== partitionSession || !entry?.policy.claim(partition, initialUrl)) {
    guest.close({ waitForBeforeUnload: false });
    return;
  }
  const win = BrowserWindow.fromId(windowId);
  if (!win || win.isDestroyed()) {
    guest.close({ waitForBeforeUnload: false });
    return;
  }
  guest.setZoomFactor(win.webContents.getZoomFactor());
  guest.on("did-finish-load", () => {
    if (!win.isDestroyed() && entry.guests.get(partition) === guest)
      guest.setZoomFactor(win.webContents.getZoomFactor());
  });
  guardPlanWebviewSession(partitionSession);
  entry.guests.set(partition, guest);
  guardedSessions.set(partitionSession, { windowId, partition });
  const guard = (event: { preventDefault(): void }, url: string) => {
    if (!entry.policy.canNavigate(partition, url)) event.preventDefault();
  };
  guest.setWindowOpenHandler(() => ({ action: "deny" }));
  guest.on("will-navigate", guard);
  guest.on("will-redirect", guard);
  guest.on("will-frame-navigate", (event) => guard(event, event.url));
  guest.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  guest.session.on("will-download", (event) => event.preventDefault());
  guest.once("destroyed", () => {
    if (entry.guests.get(partition) !== guest) return;
    void closeNativePlanWebview(windowId, partition).catch((error) =>
      logger.warn("[NativePlanWebview] partition cleanup failed", { error }),
    );
  });
}

export function registerNativePlanWebviewIpc(): void {
  ipcMain.handle(
    "zcode:native-plan-webview-prepare",
    async (event, request: NativePlanWebviewPrepareRequest) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const entry = win ? windows.get(win.id) : undefined;
      if (
        !win ||
        win.isDestroyed() ||
        win.webContents !== event.sender ||
        !entry ||
        !request ||
        typeof request !== "object" ||
        Array.isArray(request) ||
        Object.keys(request).length !== 3 ||
        !Object.keys(request).every(
          (key) => key === "url" || key === "ownerGeneration" || key === "displayContext",
        ) ||
        typeof request.url !== "string" ||
        !Number.isSafeInteger(request.ownerGeneration)
      )
        throw new Error("XCODE_STALE_WEB_HANDOFF");
      if (!isNativePlanDisplayContext(request.displayContext))
        throw new Error("XCODE_INVALID_PLAN_DISPLAY_CONTEXT");
      const prepared = entry.policy.prepare(request);
      try {
        const origin = new URL(request.url).origin;
        await session.fromPartition(prepared.partition).cookies.set({
          url: `${origin}/xcode/plans`,
          name: "xcode_plan_display_v1",
          value: encodeURIComponent(JSON.stringify(request.displayContext)),
          path: "/xcode/plans",
          sameSite: "strict",
          secure: origin.startsWith("https:"),
          httpOnly: false,
        });
        // XCODE: A's awaited write can finish after logout/B login; only A's partition is disposable.
        if (
          win.isDestroyed() ||
          event.sender.isDestroyed() ||
          BrowserWindow.fromWebContents(event.sender) !== win ||
          win.webContents !== event.sender ||
          windows.get(win.id) !== entry ||
          !entry.policy.canAttach(prepared.partition, request.url)
        )
          throw new Error("XCODE_STALE_WEB_HANDOFF");
        return prepared;
      } catch (error) {
        await closeNativePlanWebview(win.id, prepared.partition);
        throw error;
      }
    },
  );
  ipcMain.handle("zcode:native-plan-webview-close", async (event, partition: string) => {
    const windowId = BrowserWindow.fromWebContents(event.sender)?.id;
    if (
      windowId === undefined ||
      typeof partition !== "string" ||
      !isNativePlanWebviewPartition(partition)
    )
      return;
    const entry = windows.get(windowId);
    if (!entry?.policy.close(partition)) return;
    await closeNativePlanWebview(windowId, partition);
  });
}
