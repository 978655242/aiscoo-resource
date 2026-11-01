/* oxlint-disable eslint(max-lines) -- Deep Link 路由必须在同一模块内保持协议校验和投递原子性。 */
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import type { WebContents } from "electron";
import {
  type Locale,
  type OAuthProviderId,
  type OAuthPurpose,
  type OAuthStateRegistration,
  PlatformChannels,
  parseNewApiAuthorizationCallback,
} from "@zcode/shared";
import {
  extractWorkspaceOpenPath,
  extractShareImportCode,
  isOAuthCallbackUrl,
  isPaymentCallbackUrl,
  isWorkspaceOpenUrl,
  isShareImportUrl,
} from "./desktopDeepLinkUrl.js";
import { PRODUCT_NAME } from "@zcode/shared/aiscoo-brand";
import { registerLinuxDeepLinkProtocol } from "./desktopLinuxDeepLinkRegistration.js";
import { resolveAiscooDesktopIdentity } from "@zcode/shared/aiscoo-desktop-identity";

// XCODE: Main 只投影渠道身份，不接管 Host 的 pending/PKCE 或账号状态。
const desktopIdentity = resolveAiscooDesktopIdentity();

interface DeepLinkWorkspaceGateOptions {
  canOpenWorkspace?: (workspacePath: string) => boolean;
  confirmationCopy?: ExternalWorkspaceOpenDialogCopy;
  onWorkspaceOpenBlocked?: (workspacePath: string) => void;
  /** 业务窗口解析器；必须排除 CUA indicator 等 Main 辅助窗口。 */
  resolveApplicationWindow?: () => BrowserWindow | null;
}

export interface ExternalWorkspaceOpenDialogCopy {
  buttons: [string, string];
  title: string;
  message: string;
  detail: (path: string) => string;
}

interface OAuthRouteTarget {
  windowId: number;
  provider: OAuthProviderId;
  purpose: OAuthPurpose;
}

const oauthStateToWindow = new Map<string, OAuthRouteTarget>();
const rendererReadyWebContentsIds = new Set<number>();
// XCODE: 仅缓存已登记且未 ready 的目标窗口，未知回调绝不能落入全局槽。
const pendingOAuthCallbacks = new Map<string, { url: string; target: OAuthRouteTarget }>();
let pendingPaymentDeepLinkUrl: string | null = null;
let pendingOpenWorkspaceRequest: {
  path: string;
  targetWebContentsId?: number;
} | null = null;
const pendingShareImports: { shareCode: string; targetWebContentsId?: number }[] = [];
const MAX_PENDING_SHARE_IMPORTS = 8;

function enqueuePendingShareImport(
  payload: { shareCode: string },
  targetWebContentsId?: number,
): void {
  if (
    pendingShareImports.some(
      (item) =>
        item.shareCode === payload.shareCode && item.targetWebContentsId === targetWebContentsId,
    )
  ) {
    return;
  }
  pendingShareImports.push(
    targetWebContentsId === undefined ? { ...payload } : { ...payload, targetWebContentsId },
  );
  if (pendingShareImports.length > MAX_PENDING_SHARE_IMPORTS) {
    pendingShareImports.shift();
  }
}

export function parseOAuthStateRegistration(payload: unknown): OAuthStateRegistration | null {
  if (!payload || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as {
    state?: unknown;
    provider?: unknown;
    purpose?: unknown;
  };

  if (typeof candidate.state !== "string" || !/^[A-Za-z0-9._~-]{1,256}$/.test(candidate.state)) {
    return null;
  }

  if (
    typeof candidate.provider !== "string" ||
    !["new-api", "bigmodel", "zai"].includes(candidate.provider) ||
    (candidate.purpose !== "primary-account" && candidate.purpose !== "official-cloud") ||
    (candidate.provider === "new-api" && candidate.purpose !== "primary-account") ||
    (candidate.provider === "new-api" && candidate.state.length < 22) ||
    // XCODE: Aiscoo 渠道只接收主账号登录。路由表只经 IPC 登记，此处是唯一入口，
    // 官方 state 进不了路由表，后续回调派发与 pending 投递无需重复判断。
    (desktopIdentity &&
      (candidate.provider !== "new-api" || candidate.purpose !== "primary-account"))
  ) {
    return null;
  }

  return {
    state: candidate.state,
    provider: candidate.provider,
    purpose: candidate.purpose,
  };
}

function focusDeepLinkTargetWindow(targetWindow: BrowserWindow): void {
  // macOS 的 open-url 回调只会把 URL 投递给当前实例，不会自动把窗口带回前台。
  // 之前这里只做了 IPC 转发，用户完成 OAuth 或从系统服务打开目录后仍停留在外部应用。
  // 这里在路由成功后显式激活并聚焦目标窗口，统一多平台回跳体验。
  if (targetWindow.isMinimized()) {
    targetWindow.restore();
  }

  if (!targetWindow.isVisible()) {
    targetWindow.show();
  }

  if (process.platform === "darwin") {
    app.show();
  }

  targetWindow.focus();
}

function hasOAuthAuthorizationCode(parsedUrl: URL): boolean {
  return parsedUrl.searchParams.has("code") || parsedUrl.searchParams.has("authCode");
}

export function isValidLocalWorkspaceDirectory(path: string): boolean {
  if (!path || path.includes("\0") || isNetworkWorkspacePath(path) || !isAbsolute(path)) {
    return false;
  }

  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isNetworkWorkspacePath(path: string): boolean {
  // 仅当原路径以 // 或 \\ 开头时规范化后才会以 \\ 开头；
  // 单 / 的 Unix 绝对路径不会被误判为 UNC 网络路径。
  const normalized = path.replace(/\//gu, "\\");
  return normalized.startsWith("\\\\") || /^\\\\\?\\UNC\\/iu.test(normalized);
}

// XCODE: 投影自有静态文案，文件夹路径留给 detail 原样插入。
export function resolveExternalWorkspaceOpenDialogCopy(
  locale: Locale,
): ExternalWorkspaceOpenDialogCopy {
  // TODO(i18n): 新增 Locale 时把这里收敛成完整 Record<Locale, ...>，
  // 避免未覆盖语言静默回退英文。
  if (locale === "zh-CN") {
    return {
      buttons: ["打开文件夹", "取消"],
      // XCODE: 外部链接确认显示产品名，URL scheme 保持兼容。
      title: `打开外部 ${PRODUCT_NAME} 链接？`,
      message: `是否在 ${PRODUCT_NAME} 中打开此文件夹？`,
      detail: (path) => `${path}\n\n只打开你信任来源的文件夹。项目设置可能影响 agent runtime。`,
    };
  }

  return {
    buttons: ["Open folder", "Cancel"],
    title: `Open external ${PRODUCT_NAME} link?`,
    message: `Open this folder in ${PRODUCT_NAME}?`,
    detail: (path) =>
      `${path}\n\nOnly open folders from sources you trust. Project settings may affect the agent runtime.`,
  };
}

export function confirmExternalWorkspaceOpen(
  path: string,
  logger: { warn: (...args: unknown[]) => void },
  parentWindow: BrowserWindow | null,
  copy: ExternalWorkspaceOpenDialogCopy = resolveExternalWorkspaceOpenDialogCopy("en-US"),
): boolean {
  const options = {
    type: "warning" as const,
    buttons: copy.buttons,
    defaultId: 1,
    cancelId: 1,
    title: copy.title,
    message: copy.message,
    detail: copy.detail(path),
    noLink: true,
  };
  const response = parentWindow
    ? dialog.showMessageBoxSync(parentWindow, options)
    : dialog.showMessageBoxSync(options);
  const confirmed = response === 0;
  if (!confirmed) {
    logger.warn("[deep-link] 用户取消打开外部链接工作区", { path });
  }
  return confirmed;
}

export function handleOpenWorkspacePath(
  path: string,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  options: {
    allowWithoutReadyWindow?: boolean;
    resolveApplicationWindow?: () => BrowserWindow | null;
  } = {},
): boolean {
  if (!isValidLocalWorkspaceDirectory(path)) {
    logger.warn("[deep-link] 打开工作区路径无效，已忽略", { path });
    return false;
  }

  const targetWindow = options.resolveApplicationWindow
    ? options.resolveApplicationWindow()
    : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
  if (targetWindow) {
    const targetWebContentsId = targetWindow.webContents.id;
    if (!rendererReadyWebContentsIds.has(targetWebContentsId)) {
      pendingOpenWorkspaceRequest = {
        path,
        targetWebContentsId,
      };
      focusDeepLinkTargetWindow(targetWindow);
      // 冷启动 argv deep link 会在主窗口创建后、renderer 注册
      // onOpenWorkspacePath 之前到达。此时直接 webContents.send 会丢 IPC，
      // 必须等 renderer 主动上报 ready 后再投递目录路径。
      logger.warn("[deep-link] 工作区打开请求命中未就绪窗口，先缓存等待 renderer ready", {
        windowId: targetWebContentsId,
        path,
      });
      return true;
    }

    targetWindow.webContents.send(PlatformChannels.OpenWorkspacePath, path);
    focusDeepLinkTargetWindow(targetWindow);
    logger.info("[deep-link] 工作区打开请求路由成功", {
      windowId: targetWebContentsId,
      path,
    });
    return true;
  }

  if (!options.allowWithoutReadyWindow) {
    logger.warn("[deep-link] 工作区打开请求暂未命中窗口，已忽略", { path });
    return false;
  }

  pendingOpenWorkspaceRequest = { path };
  logger.warn("[deep-link] 工作区打开请求暂未命中窗口，先缓存等待 renderer ready", { path });
  return false;
}

export function handleDeepLink(
  url: string,
  logger: { info: (...args: unknown[]) => void; warn: (...args: unknown[]) => void },
  options: DeepLinkWorkspaceGateOptions = {},
): boolean {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    logger.warn("[deep-link] 无法解析 URL");
    return false;
  }

  if (isWorkspaceOpenUrl(parsedUrl)) {
    const workspacePath = extractWorkspaceOpenPath(parsedUrl);
    if (!workspacePath) {
      logger.warn("[deep-link] 工作区打开请求缺少 path，已忽略", {
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return false;
    }

    if (isNetworkWorkspacePath(workspacePath)) {
      // Windows UNC 路径在 statSync 校验阶段就会触发 SMB 认证。
      // deep link 是外部输入，必须在任何文件系统探测前拒绝网络路径。
      logger.warn("[deep-link] 网络工作区路径已拒绝", { path: workspacePath });
      return false;
    }

    if (options.canOpenWorkspace && !options.canOpenWorkspace(workspacePath)) {
      // 强制升级是进程级 gate，workspace deep link 不能先进入缓存/投递路径。
      logger.warn("[deep-link] 工作区打开请求被当前启动 gate 阻止", { path: workspacePath });
      options.onWorkspaceOpenBlocked?.(workspacePath);
      return true;
    }

    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    // zcode://workspace/open 来自浏览器/IM 等外部应用，不能等同于用户在
    // ZCode 内部选择目录；确认必须发生在 statSync 之前，避免项目配置被静默信任。
    if (
      !confirmExternalWorkspaceOpen(workspacePath, logger, targetWindow, options.confirmationCopy)
    ) {
      return true;
    }

    return handleOpenWorkspacePath(workspacePath, logger, {
      allowWithoutReadyWindow: true,
      resolveApplicationWindow: options.resolveApplicationWindow,
    });
  }

  if (isPaymentCallbackUrl(parsedUrl)) {
    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    if (targetWindow) {
      targetWindow.webContents.send(PlatformChannels.PaymentCallback, url);
      focusDeepLinkTargetWindow(targetWindow);
      logger.info("[deep-link] 支付回调路由成功", {
        windowId: targetWindow.webContents.id,
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return true;
    }

    pendingPaymentDeepLinkUrl = url;
    logger.warn("[deep-link] 支付回调暂未命中窗口，先缓存等待 renderer ready", {
      host: parsedUrl.hostname,
      path: parsedUrl.pathname,
    });
    return false;
  }

  if (isShareImportUrl(parsedUrl)) {
    const shareCode = extractShareImportCode(parsedUrl);
    if (!shareCode) {
      logger.warn("[deep-link] share import code 无效，已忽略", {
        host: parsedUrl.hostname,
        path: parsedUrl.pathname,
      });
      return false;
    }
    const payload = { shareCode };
    // share 分支也必须走 resolveApplicationWindow——聚焦兜底
    // getAllWindows()[0] 会命中 CUA indicator 等辅助窗口；且 pending 队列必须绑定目标窗口，
    // 否则多窗口时导入会投递给先 ready 的 renderer，写入错误 workspace 的 .zcode-share。
    const targetWindow = options.resolveApplicationWindow
      ? options.resolveApplicationWindow()
      : (BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null);
    if (targetWindow) {
      if (!rendererReadyWebContentsIds.has(targetWindow.webContents.id)) {
        enqueuePendingShareImport(payload, targetWindow.webContents.id);
        focusDeepLinkTargetWindow(targetWindow);
        logger.info("[deep-link] share import 等待 renderer ready", {
          windowId: targetWindow.webContents.id,
        });
        return true;
      }
      targetWindow.webContents.send(PlatformChannels.ShareImport, payload);
      focusDeepLinkTargetWindow(targetWindow);
      logger.info("[deep-link] share import 路由成功", {
        windowId: targetWindow.webContents.id,
      });
      return true;
    }
    enqueuePendingShareImport(payload);
    logger.info("[deep-link] share import 等待主窗口");
    return false;
  }

  if (!isOAuthCallbackUrl(parsedUrl)) {
    return false;
  }

  const state = parsedUrl.searchParams.get("state");
  if (!state) {
    logger.warn("[deep-link] OAuth 回调缺少 state，忽略此次回调", {
      protocol: parsedUrl.protocol,
      host: parsedUrl.hostname,
      path: parsedUrl.pathname,
    });
    return false;
  }

  const routeTarget = oauthStateToWindow.get(state);
  // XCODE: 官方旧回调允许省略 provider；只采用已登记 state 的身份，不猜当前账号/窗口。
  const providers = parsedUrl.searchParams.getAll("provider");
  const purposes = parsedUrl.searchParams.getAll("purpose");
  if (
    !routeTarget ||
    parsedUrl.searchParams.getAll("state").length !== 1 ||
    parsedUrl.username ||
    parsedUrl.password ||
    parsedUrl.hash ||
    providers.length > 1 ||
    purposes.length > 1 ||
    (providers.length === 1 && providers[0] !== routeTarget.provider) ||
    (purposes.length === 1 && purposes[0] !== routeTarget.purpose) ||
    (routeTarget.provider === "new-api" && providers[0] !== "new-api")
  ) {
    logger.warn("[deep-link] 未匹配已登记 OAuth 身份或用途，忽略此次回调");
    return false;
  }
  // XCODE: Native 校验与 Host 换码使用同一精确 redirect，未注入采用 parser 的上游默认值。
  if (
    routeTarget.provider === "new-api" &&
    !parseNewApiAuthorizationCallback(url, desktopIdentity?.oauthRedirectUri)
  ) {
    logger.warn("[deep-link] 拒绝非canonical原生授权回调");
    return false;
  }
  const targetWindow = BrowserWindow.getAllWindows().find(
    (window) => window.webContents.id === routeTarget.windowId,
  );
  if (!targetWindow) {
    oauthStateToWindow.delete(state);
    pendingOAuthCallbacks.delete(state);
    return false;
  }
  if (!rendererReadyWebContentsIds.has(routeTarget.windowId)) {
    pendingOAuthCallbacks.set(state, { url, target: routeTarget });
    focusDeepLinkTargetWindow(targetWindow);
    return true;
  }
  const completed = hasOAuthAuthorizationCode(parsedUrl);
  if (completed) oauthStateToWindow.delete(state);
  pendingOAuthCallbacks.delete(state);
  targetWindow.webContents.send(PlatformChannels.OAuthCallback, {
    url,
    provider: routeTarget.provider,
    purpose: routeTarget.purpose,
  });
  focusDeepLinkTargetWindow(targetWindow);
  logger.info("[deep-link] OAuth 回调路由成功", {
    windowId: routeTarget.windowId,
    provider: routeTarget.provider,
    purpose: routeTarget.purpose,
    completed,
  });
  return true;
}

export function registerDeepLinkProtocol(
  logger: {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
  },
  options: { iconPath?: string } = {},
) {
  // XCODE: 每个渠道只声明自己的协议，未注入时继续注册 zcode。
  const scheme = desktopIdentity?.scheme ?? "zcode";

  // 外部 URL 必须位于 -- 后；否则 Windows 引号拆分可把 URL 内容变成 Electron 启动参数。
  // Inspector 早于应用 JS 和单实例锁启动，不能依赖后续 handleDeepLink 校验拦截。
  if (process.defaultApp && process.argv.length >= 2) {
    const entry = resolve(process.argv[1]!);
    const args = process.platform === "win32" ? [entry, "--"] : [entry];
    const ok = app.setAsDefaultProtocolClient(scheme, process.execPath, args);
    if (!ok) {
      logger.warn("[deep-link] 注册协议失败（defaultApp）", {
        scheme,
        execPath: process.execPath,
        entry: process.argv[1],
      });
    } else {
      logger.info("[deep-link] 注册协议成功（defaultApp）", {
        scheme,
        execPath: process.execPath,
        entry: process.argv[1],
      });
    }
    return;
  }

  const ok =
    process.platform === "win32"
      ? app.setAsDefaultProtocolClient(scheme, process.execPath, ["--"])
      : app.setAsDefaultProtocolClient(scheme);
  if (!ok) {
    logger.warn("[deep-link] 注册协议失败", { scheme });
  } else {
    logger.info("[deep-link] 注册协议成功", { scheme });
  }

  if (process.platform === "linux" && app.isPackaged) {
    registerLinuxDeepLinkProtocol({
      executablePath: process.execPath,
      homeDir: app.getPath("home"),
      productName: app.name,
      iconSourcePath: options.iconPath,
      env: process.env,
      argv: process.argv,
      logger,
    });
  }
}

export function registerOAuthState(windowId: number, registration: OAuthStateRegistration): void {
  if (oauthStateToWindow.has(registration.state)) return;
  // XCODE: 新flow退休同窗口同purpose的旧state，不触碰其他窗口/用途。
  for (const [state, target] of oauthStateToWindow) {
    if (target.windowId === windowId && target.purpose === registration.purpose) {
      oauthStateToWindow.delete(state);
      pendingOAuthCallbacks.delete(state);
    }
  }
  const target = { windowId, provider: registration.provider, purpose: registration.purpose };
  oauthStateToWindow.set(registration.state, target);
  setTimeout(
    () => {
      if (oauthStateToWindow.get(registration.state) !== target) return;
      oauthStateToWindow.delete(registration.state);
      pendingOAuthCallbacks.delete(registration.state);
    },
    5 * 60 * 1000,
  ).unref();
}

export function deliverPendingDeepLink(webContents: WebContents): boolean {
  rendererReadyWebContentsIds.add(webContents.id);

  let hasPendingOAuthCallback = false;
  // pending share import 绑定目标窗口后，只投递给目标窗口（或冷启动时未绑定目标的
  // 条目）；非目标窗口 ready 时保留条目，否则导入会写进错误窗口的 workspace。
  const undeliveredShareImports: typeof pendingShareImports = [];
  for (const pending of pendingShareImports.splice(0)) {
    if (pending.targetWebContentsId == null || pending.targetWebContentsId === webContents.id) {
      webContents.send(PlatformChannels.ShareImport, { shareCode: pending.shareCode });
    } else {
      undeliveredShareImports.push(pending);
    }
  }
  pendingShareImports.push(...undeliveredShareImports);
  for (const [state, pending] of pendingOAuthCallbacks) {
    if (oauthStateToWindow.get(state) !== pending.target) {
      pendingOAuthCallbacks.delete(state);
      continue;
    }
    if (pending.target.windowId !== webContents.id) continue;
    pendingOAuthCallbacks.delete(state);
    if (hasOAuthAuthorizationCode(new URL(pending.url))) oauthStateToWindow.delete(state);
    webContents.send(PlatformChannels.OAuthCallback, {
      url: pending.url,
      provider: pending.target.provider,
      purpose: pending.target.purpose,
    });
    hasPendingOAuthCallback = true;
  }
  if (pendingPaymentDeepLinkUrl) {
    webContents.send(PlatformChannels.PaymentCallback, pendingPaymentDeepLinkUrl);
    pendingPaymentDeepLinkUrl = null;
  }
  if (
    pendingOpenWorkspaceRequest &&
    (pendingOpenWorkspaceRequest.targetWebContentsId == null ||
      pendingOpenWorkspaceRequest.targetWebContentsId === webContents.id)
  ) {
    webContents.send(PlatformChannels.OpenWorkspacePath, pendingOpenWorkspaceRequest.path);
    pendingOpenWorkspaceRequest = null;
  }
  return hasPendingOAuthCallback;
}

export function clearOAuthRoutesForWindow(windowId: number): void {
  rendererReadyWebContentsIds.delete(windowId);
  if (pendingOpenWorkspaceRequest?.targetWebContentsId === windowId) {
    pendingOpenWorkspaceRequest = null;
  }
  // pending share import 绑定目标窗口后，目标窗口关闭必须同步清理，
  // 否则队列条目永不过期，可能投递给后续 ready 的其他窗口（错误 workspace）。
  for (let index = pendingShareImports.length - 1; index >= 0; index -= 1) {
    if (pendingShareImports[index]!.targetWebContentsId === windowId) {
      pendingShareImports.splice(index, 1);
    }
  }

  for (const [state, routeTarget] of oauthStateToWindow) {
    if (routeTarget.windowId === windowId) {
      oauthStateToWindow.delete(state);
      pendingOAuthCallbacks.delete(state);
    }
  }
}
