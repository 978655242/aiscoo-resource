import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
// 基于 Root 独立的受控服务夹具，只验证下游对三类客户端的登录页装配。
// Root 模块图的冷启动曾计入首个用例并触发超时；静态导入将加载与渲染断言的计时分开。
import { Root } from "@/Root.js";
import { createAiscooAccountLoginRoot } from "@/aiscoo/account-login/logout-presentation.js";
import type { IOAuthService, IServiceAccessor } from "@zcode/services";
import type { IPlatformService, OAuthCallbackEvent } from "@zcode/shared";
import {
  createAiscooAccountLoginServices,
  createAiscooAccountLoginPlatform,
} from "@/aiscoo/account-login/index.js";

const ProductRoot = createAiscooAccountLoginRoot(Root);

const mockSetUser = vi.fn();
const mockModelSelectionRead = { failed: false };
const mockWelcomeScreenOpen = vi.hoisted(() => ({ value: false }));
vi.mock("@/root/zcodeJwtInvalidRestartMarker.js", () => ({
  consumeZcodeJwtInvalidRestartMarker: () => mockWelcomeScreenOpen.value,
}));
vi.mock("@/hooks/useModelSelectionView.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useModelSelectionServiceView: () => ({
    state: mockModelSelectionRead.failed
      ? { status: "error", error: new Error("fixture provider read failed") }
      : { status: "loading" },
    reload: vi.fn(),
  }),
}));
const mockSetOAuthError = vi.fn();
const mockAddTab = vi.fn();
const mockActivateTabByPath = vi.fn(() => false);
const mockStartDraft = vi.fn();
const mockShouldBlockRootRender = vi.fn(() => false);
const tabStoreState = {
  tabs: [] as Array<{
    id: string;
    type: "workspace" | "settings";
    workspacePath?: string;
    label?: string;
  }>,
  activeTabId: null as string | null,
  activeWorkspacePath: null as string | null,
  addTab: mockAddTab,
  activateTabByPath: mockActivateTabByPath,
};

const tabStoreApiState = {
  activeWorkspacePath: null as string | null,
  activateTabByPath: mockActivateTabByPath,
};

vi.mock("@/App.js", () => ({
  App: () => createElement("div", { "data-testid": "workspace-app" }),
}));

// Root 用例只验证挂载与远控开关；营销业务由专属测试覆盖，避免拉入整棵媒体/供应商依赖树。
vi.mock("@/components/marketing-touch/MarketingTouchProvider.js", () => ({
  MarketingTouchProvider: ({ children }: { children: unknown }) => children,
  MarketingBanner: () => null,
}));

vi.mock("@/ConfirmDialog.js", () => ({
  ConfirmDialogHost: () => createElement("div", { "data-testid": "confirm-dialog-host" }),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  PlatformProvider: ({ children }: { children: unknown }) => children,
  useOptionalPlatform: () => ({
    getWebRemoteControlStatus: vi.fn(async () => ({ status: "idle" })),
  }),
  usePlatform: () => ({
    cancelPendingRemoteConnection: vi.fn(async () => {}),
  }),
}));

vi.mock("@/hooks/useServices.js", () => ({
  useComposerClientNamespace: () => "desktop",
  ServiceProvider: ({ children }: { children: unknown }) => children,
  useServices: () => ({
    systemService: {
      probeIntranet: vi.fn(async () => ({
        isIntranet: false,
        targets: [],
      })),
    },
  }),
  useOptionalServices: () => null,
}));

vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  CodingPlanUpgradeDialogProvider: ({ children }: { children: unknown }) => children,
  useCodingPlanUpgradeDialog: () => ({
    openCodingPlanUpgrade: vi.fn(),
  }),
}));

vi.mock("@/hooks/useWorkspaceServices.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/hooks/useWorkspaceServices.js")>();

  return {
    ...actual,
    // Bugfix: Root 现在会触发 useBaseWorkspaceServices；这里改为部分 mock，
    // 保留模块真实导出，避免新增 hook 导出时测试因 mock 漏项直接崩溃。
    // 此 hook 的首参是 workspacePath。旧 mock 原样返回首参，只因早期 return 未读取服务才未暴露。
    // 数据库 loading 提前订阅工作区服务后，测试也必须返回真实契约形状。
    useWorkspaceServices: () => ({
      zcodeAgentService: {
        prepareStorage: vi.fn(async () => {}),
        getStorageStartupState: vi.fn(async () => null),
        onDynamicStorageStartupState: vi.fn(() => () => ({ dispose: vi.fn() })),
      },
    }),
  };
});

vi.mock("@/hooks/useTabPersistence.js", () => ({
  useTabPersistence: () => ({
    isRestoring: false,
    hasCompletedInitialRestore: true,
    hasCompletedFullRestore: true,
  }),
}));

vi.mock("@/hooks/useTokenRefresh.js", () => ({
  useTokenRefresh: () => ({
    tryRefresh: vi.fn(),
    clearCredentials: vi.fn(),
  }),
}));

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: {
      formatMessage: vi.fn(() => "loading"),
    },
  }),
}));

vi.mock("@/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@/SettingsPage.js", () => ({
  SettingsPage: () => createElement("div", { "data-testid": "settings-page" }),
}));

vi.mock("@/WelcomeScreen.js", () => ({
  WelcomeScreen: ({ hideApiKeyLogin }: { hideApiKeyLogin?: boolean }) =>
    createElement("div", {
      "data-testid": "welcome-screen",
      "data-hide-api-key-login": String(hideApiKeyLogin),
    }),
}));

vi.mock("@/lib/fileDisplay.js", () => ({
  setDefaultFileDisplayBasePath: vi.fn(),
}));

vi.mock("@/lib/rootStartupGate.js", () => ({
  isProviderStartupSyncPending: () => false,
  shouldEnableProviderAvailabilityLoginEntryGuard: ({
    isWebRemoteControlRoot,
  }: {
    isWebRemoteControlRoot: boolean;
  }) => !isWebRemoteControlRoot,
  shouldResolveProviderStartupState: ({
    isWebRemoteControlRoot,
    providerStartupSyncPending,
    providerAvailabilityStartupCheckCompleted,
  }: {
    isWebRemoteControlRoot: boolean;
    providerStartupSyncPending: boolean;
    providerAvailabilityStartupCheckCompleted: boolean;
  }) =>
    !isWebRemoteControlRoot &&
    (providerStartupSyncPending || !providerAvailabilityStartupCheckCompleted),
  shouldBlockRootRender: () => mockShouldBlockRootRender(),
  shouldShowRootStartupLoading: ({
    isDesktop,
    welcomeScreenOpen,
  }: {
    isDesktop?: boolean;
    welcomeScreenOpen: boolean;
  }) => Boolean(isDesktop) && !welcomeScreenOpen && mockShouldBlockRootRender(),
}));

vi.mock("@/store/StoreProvider.js", async (importOriginal) => ({
  // XCODE: 新版 Root 埋点读取同一 StoreContext，保留真实导出以免测试替身遮住扩展。
  ...(await importOriginal<object>()),
  StoreProvider: ({ children }: { children: unknown }) => children,
  useZCodeStoreWithDefault: () => true,
  useZCodeStore: (selector: (state: unknown) => unknown) =>
    selector({
      user: null,
      setUser: mockSetUser,
      setOAuthError: mockSetOAuthError,
    }),
}));

vi.mock("@/store/zcodeSessionStore.js", () => ({
  useZCodeSessionStore: Object.assign(
    (selector: (state: unknown) => unknown) =>
      selector({
        workspaces: {},
      }),
    {
      getState: () => ({
        startDraft: mockStartDraft,
        workspaces: {},
      }),
    },
  ),
}));

vi.mock("@/store/TabStoreProvider.js", () => ({
  TabStoreProvider: ({ children }: { children: unknown }) => children,
  useTabStore: (selector: (state: unknown) => unknown) => selector(tabStoreState),
  useTabStoreApi: () => ({
    getState: () => tabStoreApiState,
  }),
  useOptionalTabStore: (selector: (state: typeof tabStoreState) => unknown) =>
    selector(tabStoreState),
}));

vi.mock("@/store/tabStore.js", () => ({
  isSettingsTab: (tab: { type?: string } | null | undefined) => tab?.type === "settings",
  isWorkspaceTab: (tab: { type?: string } | null | undefined) => tab?.type === "workspace",
}));

vi.mock("@/store/remoteWorkspaceSessionStore.js", () => ({
  bindRemoteWorkspacePath: vi.fn(),
  getRemoteWorkspaceSession: vi.fn(() => null),
  unbindRemoteWorkspacePath: vi.fn(),
  unregisterRemoteWorkspaceSession: vi.fn(),
  useRemoteWorkspaceSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessionsById: {},
      sessionIdByWorkspacePath: {},
      sessionIdByWorkspaceIdentity: {},
    }),
}));

vi.mock("@/UpdateStatusButton.js", () => ({
  UpdateStatusButton: () => createElement("div", { "data-testid": "update-ready-button" }),
}));

function renderRoot(options?: {
  product?: boolean;
  webRemoteControlFeatureEnabled?: boolean;
  isDesktop?: boolean;
  initialWorkspaceAbsPath?: string;
  initialWorkspaceLoadingFallback?: ReturnType<typeof createElement>;
  platformOverrides?: Record<string, unknown>;
  webRemoteControlWorkspaceSwitcher?: import("@/root/types.js").WebRemoteControlWorkspaceSwitcherApi;
  welcomeScreenPresentation?: {
    hideApiKeyLogin?: boolean;
  };
}) {
  const html = renderToStaticMarkup(
    createElement(options?.product ? ProductRoot : Root, {
      services: {
        broadcastService: {},
        settingService: {
          get: vi.fn(),
          update: vi.fn(),
        },
        credentialService: {
          delete: vi.fn(async () => {}),
          load: vi.fn(async () => null),
          save: vi.fn(async () => {}),
        },
        oauthService: {
          restoreCachedSession: vi.fn(),
          restoreSession: vi.fn(),
          handleCallback: vi.fn(),
          logout: vi.fn(),
        },
      },
      platform: {
        selectDirectory: vi.fn(async () => null),
        activateOrSetWorkspace: vi.fn(async () => ({ activated: false })),
        connectRemote: vi.fn(async () => ({ success: true })),
        disposeRemoteSession: vi.fn(async () => {}),
        isDockerAvailable: vi.fn(async () => false),
        listWSLDistros: vi.fn(async () => []),
        listDockerContainers: vi.fn(async () => []),
        listSSHConfigAliases: vi.fn(async () => []),
        openExternal: vi.fn(),
        openFeedback: vi.fn(async () => {}),
        openCommunity: vi.fn(async () => {}),
        canOpenCommunity: vi.fn(async () => false),
        openInFileManager: vi.fn(async () => ({ success: true })),
        registerOAuthState: vi.fn(),
        onOAuthCallback: vi.fn(() => () => {}),
        notifyRendererReady: vi.fn(),
        showTaskNotification: vi.fn(),
        syncWindowTabs: vi.fn(),
        syncWindowUnreadCount: vi.fn(),
        onFocusTab: vi.fn(() => () => {}),
        onNewTab: vi.fn(() => () => {}),
        onNewTask: vi.fn(() => () => {}),
        onOpenWorkspace: vi.fn(() => () => {}),
        onWindowFullscreenChanged: vi.fn(() => () => {}),
        onTaskNotificationClick: vi.fn(() => () => {}),
        exportLogs: vi.fn(async () => ({
          success: false,
          error: "unsupported",
        })),
        onUpdateReady: vi.fn(() => () => {}),
        onUpdateStateChanged: vi.fn(() => () => {}),
        getUpdateState: vi.fn(async () => ({ kind: "idle", enabled: true })),
        onUpdateCheckResult: vi.fn(() => () => {}),
        onPostUpdateReleaseNotes: vi.fn(() => () => {}),
        quitAndInstallUpdate: vi.fn(async () => {}),
        getInstalledEditors: vi.fn(async () => []),
        openInEditor: vi.fn(),
        executeDesktopCommand: vi.fn(async () => {}),
        setApplicationLocale: vi.fn(async () => {}),
        setTitleBarTheme: vi.fn(async () => {}),
        ...options?.platformOverrides,
      },
      webRemoteControlFeatureEnabled: options?.webRemoteControlFeatureEnabled,
      webRemoteControlWorkspaceSwitcher: options?.webRemoteControlWorkspaceSwitcher,
      isDesktop: options?.isDesktop,
      initialWorkspaceAbsPath: options?.initialWorkspaceAbsPath,
      initialWorkspaceLoadingFallback: options?.initialWorkspaceLoadingFallback,
      ...(options?.welcomeScreenPresentation
        ? { welcomeScreenPresentation: options.welcomeScreenPresentation }
        : {}),
    }),
  );

  return html;
}

describe("Aiscoo Root 登录展示", () => {
  beforeEach(() => {
    mockWelcomeScreenOpen.value = false;
    tabStoreState.tabs = [];
    tabStoreState.activeTabId = null;
    tabStoreState.activeWorkspacePath = null;
    tabStoreApiState.activeWorkspacePath = null;
    mockSetUser.mockClear();
    mockSetOAuthError.mockClear();
    mockAddTab.mockClear();
    mockActivateTabByPath.mockClear();
    mockStartDraft.mockClear();
    mockShouldBlockRootRender.mockReset();
    mockShouldBlockRootRender.mockReturnValue(false);
  });

  it.each(["desktop", "web", "remote"] as const)(
    "%s 未装配的共享 Root 保留默认 API key 入口",
    (mode) => {
      mockWelcomeScreenOpen.value = true;
      const html = renderRoot({
        isDesktop: mode === "desktop",
        webRemoteControlWorkspaceSwitcher:
          mode === "remote" ? { listWorkspaces: vi.fn(), switchWorkspace: vi.fn() } : undefined,
      });
      expect(html).toContain('data-testid="welcome-screen"');
      expect(html).toContain('data-hide-api-key-login="undefined"');
      expect(html).not.toContain('data-testid="aiscoo-logout-content"');
    },
  );

  it.each(["desktop", "web", "remote"] as const)(
    "%s 产品 Root 固定隐藏 API key 且只给本地桌面挂退出边界",
    (mode) => {
      mockWelcomeScreenOpen.value = true;
      const html = renderRoot({
        product: true,
        isDesktop: mode === "desktop",
        webRemoteControlWorkspaceSwitcher:
          mode === "remote" ? { listWorkspaces: vi.fn(), switchWorkspace: vi.fn() } : undefined,
      });
      expect(html).toContain('data-hide-api-key-login="true"');
      expect(html.includes('data-testid="aiscoo-logout-content"')).toBe(mode === "desktop");
    },
  );

  it("产品 Root 向下传递过滤后的唯一服务实例与可选展示端口", async () => {
    const source = {
      oauthService: {
        getProviders: vi.fn(async () => [
          { id: "zai", displayName: "Z.ai", enabled: true, order: 0 },
          { id: "new-api", displayName: "New API", enabled: true, order: 1 },
        ]),
      },
    } as unknown as IServiceAccessor;
    const received: ComponentProps<typeof Root>[] = [];
    const ProductProbe = createAiscooAccountLoginRoot((props) => {
      received.push(props);
      return null;
    });
    renderToStaticMarkup(
      createElement(ProductProbe, { services: source, platform: {} as IPlatformService }),
    );
    expect(received).toHaveLength(1);
    const props = received[0]!;
    expect(props.services).not.toBe(source);
    expect((await props.services.oauthService.getProviders()).map(({ id }) => id)).toEqual([
      "new-api",
    ]);
    expect(
      (
        props.platform as import("@/oauth-lifecycle/contract.js").OAuthLifecyclePlatform
      ).oauthAccountPolicy?.acceptsProvider("zai"),
    ).toBe(false);
    expect(props.welcomeScreenPresentation?.hideApiKeyLogin).toBe(true);
    expect(props.logoutPresentation).toBeUndefined();
  });

  it("共享 Root 透传显式欢迎页展示配置", () => {
    mockWelcomeScreenOpen.value = true;
    expect(renderRoot({ welcomeScreenPresentation: { hideApiKeyLogin: false } })).toContain(
      'data-hide-api-key-login="false"',
    );
  });

  it.each(["empty", "official", "mixed", "disabled"])(
    "%s providers 不恢复旧官方身份",
    async (mode) => {
      const restoreCachedSessionState = vi.fn(async () => ({
        status: "authenticated",
        userInfo: { id: "legacy", username: "legacy", displayName: "legacy" },
      }));
      const getProviders = vi.fn(async () =>
        mode === "empty"
          ? []
          : [
              { id: "zai", displayName: "Z.ai", enabled: true, order: 0 },
              ...(mode === "mixed" || mode === "disabled"
                ? [
                    {
                      id: "new-api",
                      displayName: "New API",
                      enabled: mode !== "disabled",
                      order: 1,
                    },
                  ]
                : []),
            ],
      );
      const underlying = {
        getProviders,
        getActiveProvider: vi.fn(async () => "zai"),
        restoreCachedSessionState,
        restoreCachedSession: vi.fn(),
        restoreSession: vi.fn(),
        startOAuthWithPolling: vi.fn(),
        pollPendingOAuth: vi.fn(),
        cancelPending: vi.fn(),
      };
      const service = createAiscooAccountLoginServices({
        oauthService: underlying,
      } as unknown as IServiceAccessor).oauthService;
      expect((await service.getProviders()).map((provider) => provider.id)).toEqual(
        mode === "mixed" ? ["new-api"] : [],
      );
      expect(await service.getActiveProvider()).toBeNull();
      expect(await service.restoreCachedSessionState()).toEqual({ status: "signed-out" });
      expect(await service.restoreCachedSession()).toBeNull();
      expect(await service.restoreSession()).toBeNull();
      expect(restoreCachedSessionState).not.toHaveBeenCalled();
      expect(underlying.restoreCachedSession).not.toHaveBeenCalled();
      expect(underlying.restoreSession).not.toHaveBeenCalled();
      await expect(service.startOAuth("zai")).rejects.toThrow("AISCOO_ACCOUNT_LOGIN_UNSUPPORTED");
      await expect(service.startOAuthWithPolling("bigmodel")).rejects.toThrow(
        "AISCOO_ACCOUNT_LOGIN_UNSUPPORTED",
      );
      await expect(service.pollPendingOAuth()).rejects.toThrow("AISCOO_ACCOUNT_LOGIN_UNSUPPORTED");
      expect(underlying.startOAuthWithPolling).not.toHaveBeenCalled();
      expect(underlying.pollPendingOAuth).not.toHaveBeenCalled();
      if (mode !== "mixed") await expect(service.cancelPending()).resolves.toBeUndefined();
    },
  );

  it.each(["restoreCachedSessionState", "restoreSession"] as const)(
    "真实 Native owner 冷启动经 %s 恢复既有会话",
    async (method) => {
      const { NewApiAccountService } =
        await import("../../services/src/new-api/newApiAccountService.js");
      const { NewApiClient } = await import("../../services/src/new-api/newApiClient.js");
      const { NewApiProviderAdapter } =
        await import("../../services/src/oauth/providers/newApiProviderAdapter.js");
      const now = 1_800_000_000_000;
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const bundle = {
        schema_version: 1,
        server_time: now,
        access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: "new-api", aud: ["new-api-xcode"], token_use: "xcode_access", sub: "1", sid: "synthetic-sid", exp: (now + 60_000) / 1000, uv: 1, sv: 1, nbf: now / 1000, iat: now / 1000, scopes: ["profile:read", "wallet:read", "usage:read"] })}.${Buffer.alloc(32, 1).toString("base64url")}`,
        access_expires_at: now + 60_000,
        refresh_token: "synthetic-refresh",
        refresh_expires_at: now + 600_000,
        token_type: "Bearer",
        session_id: "synthetic-sid",
        user: { id: "1", username: "synthetic", display_name: "Synthetic", avatar_url: null },
        relay_credential: { token: "sk-synthetic-relay", expires_at: now + 600_000 },
      };
      const fetch = vi.fn(async (input: unknown) => {
        expect(String(input)).toBe("https://native.example/api/xcode/v1/me");
        return new Response(
          JSON.stringify({
            success: true,
            data: {
              schema_version: 1,
              server_time: now,
              session_id: bundle.session_id,
              user: bundle.user,
              authorization_revision: "0",
            },
          }),
        );
      });
      const repo = {
        loadActive: vi.fn(async () => ({
          schemaVersion: 1,
          origin: "https://native.example",
          bundle,
        })),
      };
      const owner = new NewApiAccountService({
        adapter: new NewApiProviderAdapter(
          new NewApiClient("https://native.example", {
            fetch: fetch as typeof globalThis.fetch,
            now: () => now,
          }),
        ),
        repo: repo as unknown as ConstructorParameters<typeof NewApiAccountService>[0]["repo"],
        now: () => now,
      });
      expect(await owner.oauth.getActiveProvider()).toBeNull();
      const service = createAiscooAccountLoginServices({
        oauthService: owner.oauth,
      } as IServiceAccessor).oauthService;
      const userInfo = { id: "1", username: "synthetic", displayName: "Synthetic" };
      const result = await service[method]();
      expect(result).toEqual(
        method === "restoreCachedSessionState" ? { status: "authenticated", userInfo } : userInfo,
      );
      expect(await service.getActiveProvider()).toBe("new-api");
      expect(repo.loadActive).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["logout", "restore"],
    ["logoutAll", "restore"],
    ["logout", "pending"],
    ["logoutAll", "pending"],
    ["cancelPending", "pending"],
  ] as const)("真实 Native %s 同步失效 %s，迟到结果不可重新登录", async (command, phase) => {
    const { NewApiAccountService } =
      await import("../../services/src/new-api/newApiAccountService.js");
    const { NewApiClient } = await import("../../services/src/new-api/newApiClient.js");
    const { NewApiProviderAdapter } =
      await import("../../services/src/oauth/providers/newApiProviderAdapter.js");
    const now = 1_800_000_000_000;
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const bundle = {
      schema_version: 1,
      server_time: now,
      access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ iss: "new-api", aud: ["new-api-xcode"], token_use: "xcode_access", sub: "1", sid: "synthetic-sid", exp: (now + 60_000) / 1000, uv: 1, sv: 1, nbf: now / 1000, iat: now / 1000, scopes: ["profile:read", "wallet:read", "usage:read"] })}.${Buffer.alloc(32, 1).toString("base64url")}`,
      access_expires_at: now + 60_000,
      refresh_token: "synthetic-refresh",
      refresh_expires_at: now + 600_000,
      token_type: "Bearer",
      session_id: "synthetic-sid",
      user: { id: "1", username: "synthetic", display_name: "Synthetic", avatar_url: null },
      relay_credential: { token: "sk-synthetic-relay", expires_at: now + 600_000 },
    };
    const record = { schemaVersion: 1, origin: "https://native.example", bundle };
    let stored: typeof record | null = phase === "restore" ? record : null;
    let releaseMe!: () => void;
    let startedMe!: () => void;
    const meBlocked = new Promise<void>((resolve) => {
      releaseMe = resolve;
    });
    const meStarted = new Promise<void>((resolve) => {
      startedMe = resolve;
    });
    const requests: string[] = [];
    const success = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
    const fetch = vi.fn(async (input: unknown) => {
      const path = new URL(String(input)).pathname;
      requests.push(path);
      if (path.endsWith("/me")) {
        startedMe();
        await meBlocked;
        return success({
          schema_version: 1,
          server_time: now,
          session_id: bundle.session_id,
          user: bundle.user,
          authorization_revision: "0",
        });
      }
      if (path.endsWith("/auth/token")) return success(bundle);
      if (path.endsWith("/auth/logout"))
        return success({ schema_version: 1, server_time: now, revoked: true });
      throw new Error("Unexpected synthetic endpoint");
    });
    const repo = {
      loadActive: vi.fn(async () => stored),
      commit: vi.fn(async (next) => {
        stored = next;
      }),
      remove: vi.fn(async () => {
        const previous = stored;
        stored = null;
        return previous;
      }),
    };
    const owner = new NewApiAccountService({
      adapter: new NewApiProviderAdapter(
        new NewApiClient("https://native.example", {
          fetch: fetch as typeof globalThis.fetch,
          now: () => now,
        }),
      ),
      repo: repo as unknown as ConstructorParameters<typeof NewApiAccountService>[0]["repo"],
      now: () => now,
    });
    const service = createAiscooAccountLoginServices({
      oauthService: owner.oauth,
    } as IServiceAccessor).oauthService;
    const events: string[] = [];
    owner.oauth.onDidChangeSession((event) => events.push(event));
    if (phase === "restore") {
      const restore = service.restoreCachedSessionState();
      await meStarted;
      expect(await owner.oauth.getActiveProvider()).toBeNull();
      const logout = service[command]();
      const synchronouslyInvalidated = events.includes("signed-out");
      releaseMe();
      await logout;
      expect(await restore).toEqual({ status: "signed-out" });
      expect(synchronouslyInvalidated).toBe(true);
    } else {
      const flow = await service.startOAuth("new-api");
      events.length = 0;
      expect(await owner.oauth.getActiveProvider()).toBeNull();
      const logout = service[command]();
      const synchronouslyInvalidated = events.includes("signed-out");
      releaseMe();
      const callback = owner.oauth.handleCallback(
        `zcode://oauth/callback?provider=new-api&state=${flow.state}&code=${"c".repeat(43)}`,
      );
      await logout;
      expect(await callback).toBeNull();
      expect(synchronouslyInvalidated).toBe(true);
      expect(requests).not.toContain("/api/xcode/v1/auth/token");
    }
    expect(events).not.toContain("signed-in");
    expect(await owner.oauth.getActiveProvider()).toBeNull();
  });

  it.each(["only-official", "mixed-official"])(
    "%s 的退出始终限制 new-api 作用域，不删除官方凭据",
    async (mode) => {
      const legacy = { token: "untouched-official", pending: true };
      const scopedLogout = vi.fn(async (provider?: string) => {
        if (provider === "zai" || provider === undefined) {
          legacy.token = "";
          legacy.pending = false;
        }
      });
      const logoutAll = vi.fn();
      const service = createAiscooAccountLoginServices({
        oauthService: {
          getProviders: async () => [
            { id: "zai", displayName: "Z.ai", enabled: true, order: 0 },
            ...(mode === "mixed-official"
              ? [{ id: "new-api", displayName: "Aiscoo", enabled: true, order: 1 }]
              : []),
          ],
          getActiveProvider: async () => "zai",
          logout: scopedLogout,
          logoutAll,
        },
      } as unknown as IServiceAccessor).oauthService;
      await expect(service.logout("zai")).rejects.toThrow("AISCOO_ACCOUNT_LOGIN_UNSUPPORTED");
      await service.logout();
      await service.logoutAll();
      expect(scopedLogout.mock.calls).toEqual([["new-api"], ["new-api"]]);
      expect(logoutAll).not.toHaveBeenCalled();
      expect(legacy).toEqual({ token: "untouched-official", pending: true });
    },
  );

  it.each(["cached", "validated"])(
    "Aiscoo 冷启动 %s 由原 owner 恢复后建立 active 身份",
    async (mode) => {
      let active: string | null = null;
      const userInfo = { id: "cold-start", username: "cold-start", displayName: "cold-start" };
      const restoreCachedSessionState = vi.fn(async () => {
        active = "new-api";
        return { status: "authenticated", userInfo };
      });
      const restoreSession = vi.fn(async () => {
        active = "new-api";
        return userInfo;
      });
      const underlying = {
        getProviders: vi.fn(async () => [
          { id: "new-api", displayName: "New API", enabled: true, order: 0 },
        ]),
        getActiveProvider: vi.fn(async () => active),
        restoreCachedSessionState,
        restoreSession,
      };
      const service = createAiscooAccountLoginServices({
        oauthService: underlying,
      } as unknown as IServiceAccessor).oauthService;
      if (mode === "cached") {
        expect(await service.restoreCachedSessionState()).toEqual({
          status: "authenticated",
          userInfo,
        });
        expect(restoreCachedSessionState).toHaveBeenCalledOnce();
      } else {
        expect(await service.restoreSession()).toEqual(userInfo);
        expect(restoreSession).toHaveBeenCalledOnce();
      }
      expect(await service.getActiveProvider()).toBe("new-api");
    },
  );

  it.each([
    { status: "reauthentication-required", reason: "jwt-expired" },
    { status: "unavailable", reason: "credential-recovery-required" },
    { status: "unavailable", reason: "backend-unavailable" },
  ] as const)("Aiscoo 冷启动保留 $status / $reason 的 owner 投影", async (result) => {
    const service = createAiscooAccountLoginServices({
      oauthService: {
        getProviders: async () => [
          { id: "new-api", displayName: "New API", enabled: true, order: 0 },
        ],
        getActiveProvider: async () => null,
        restoreCachedSessionState: async () => result,
      },
    } as unknown as IServiceAccessor).oauthService;
    expect(await service.restoreCachedSessionState()).toEqual(result);
  });

  it("合法 Aiscoo 继续委托既有 owner，回调与 refresh 不接受官方 provider", async () => {
    const userInfo = { id: "native", username: "native", displayName: "native" };
    const underlying = {
      getProviders: vi.fn(async () => [
        { id: "new-api", displayName: "New API", enabled: true, order: 0 },
      ]),
      getActiveProvider: vi.fn(async () => "new-api"),
      restoreCachedSessionState: vi.fn(async () => ({ status: "authenticated", userInfo })),
      startOAuth: vi.fn(async (provider) => ({
        provider,
        purpose: "primary-account",
        state: "synthetic",
        authorizeUrl: "https://example.invalid/synthetic",
      })),
      handleCallback: vi.fn(async () => ({ kind: "session", provider: "new-api", userInfo })),
      refreshToken: vi.fn(),
      cancelPending: vi.fn(),
      logout: vi.fn(),
    } as unknown as IOAuthService;
    const service = createAiscooAccountLoginServices({
      oauthService: underlying,
    } as IServiceAccessor).oauthService;
    expect(await service.restoreCachedSessionState()).toEqual({
      status: "authenticated",
      userInfo,
    });
    expect((await service.startOAuth("new-api")).provider).toBe("new-api");
    await expect(
      service.handleCallback("zcode://oauth/callback?provider=zai&state=legacy&code=legacy"),
    ).rejects.toThrow("AISCOO_ACCOUNT_LOGIN_UNSUPPORTED");
    expect(underlying.handleCallback).not.toHaveBeenCalled();
    await expect(service.refreshToken("bigmodel")).rejects.toThrow(
      "AISCOO_ACCOUNT_LOGIN_UNSUPPORTED",
    );
    expect(underlying.refreshToken).not.toHaveBeenCalled();
    await service.cancelPending("new-api");
    await service.logout();
    expect(underlying.cancelPending).toHaveBeenCalledWith("new-api");
    expect(underlying.logout).toHaveBeenCalledWith("new-api");
  });

  it("退出过渡仅阻止原生菜单的新用户意图，失败恢复后重新放行且窗控和认证事件保持", async () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const controls = vi.fn(async () => {});
    let blocked = false;
    const source = {
      executeDesktopCommand: controls,
      onOpenWorkspace(handler: () => void) {
        handlers.set("workspace", handler);
        return () => handlers.delete("workspace");
      },
      onNewTask(handler: () => void) {
        handlers.set("task", handler);
        return () => handlers.delete("task");
      },
      onOAuthCallback(handler: (event: OAuthCallbackEvent) => void) {
        handlers.set("oauth", handler as (...args: unknown[]) => void);
        return () => handlers.delete("oauth");
      },
    };
    const platform = createAiscooAccountLoginPlatform(
      source as unknown as IPlatformService,
      () => blocked,
    );
    const workspace = vi.fn();
    const task = vi.fn();
    const callback = vi.fn();
    const disposeWorkspace = platform.onOpenWorkspace(workspace);
    platform.onNewTask(task);
    platform.onOAuthCallback(callback);
    handlers.get("workspace")?.();
    handlers.get("task")?.();
    expect(workspace).toHaveBeenCalledOnce();
    expect(task).toHaveBeenCalledOnce();
    blocked = true;
    handlers.get("workspace")?.();
    handlers.get("task")?.();
    expect(workspace).toHaveBeenCalledOnce();
    expect(task).toHaveBeenCalledOnce();
    handlers.get("oauth")?.({
      provider: "new-api",
      purpose: "primary-account",
      url: "aiscoo-dev://oauth/callback?provider=new-api",
    });
    expect(callback).toHaveBeenCalledOnce();
    await platform.executeDesktopCommand("minimizeWindow");
    expect(controls).toHaveBeenCalledWith("minimizeWindow");
    blocked = false;
    handlers.get("workspace")?.();
    expect(workspace).toHaveBeenCalledTimes(2);
    disposeWorkspace();
    expect(handlers.has("workspace")).toBe(false);
    expect(source.executeDesktopCommand).toBe(controls);
  });

  it("平台拒绝官方 state 注册且回调不触发官方处理器", () => {
    const registerOAuthState = vi.fn();
    let receive: ((event: OAuthCallbackEvent) => void) | undefined;
    const onOAuthCallback = vi.fn((handler) => {
      receive = handler;
      return () => {};
    });
    const platform = createAiscooAccountLoginPlatform({
      registerOAuthState,
      onOAuthCallback,
    } as unknown as IPlatformService);
    const callback = vi.fn();
    platform.onOAuthCallback(callback);
    expect(() =>
      platform.registerOAuthState({ provider: "zai", purpose: "primary-account", state: "old" }),
    ).toThrow("AISCOO_ACCOUNT_LOGIN_UNSUPPORTED");
    expect(() =>
      platform.registerOAuthState({ provider: "new-api", purpose: "official-cloud", state: "old" }),
    ).toThrow("AISCOO_ACCOUNT_LOGIN_UNSUPPORTED");
    receive?.({
      provider: "bigmodel",
      purpose: "official-cloud",
      url: "zcode://oauth/callback?provider=bigmodel",
    });
    expect(callback).not.toHaveBeenCalled();
    platform.registerOAuthState({
      provider: "new-api",
      purpose: "primary-account",
      state: "native",
    });
    receive?.({
      provider: "new-api",
      purpose: "primary-account",
      url: "zcode://oauth/callback?provider=new-api",
    });
    expect(registerOAuthState).toHaveBeenCalledExactlyOnceWith({
      provider: "new-api",
      purpose: "primary-account",
      state: "native",
    });
    expect(callback).toHaveBeenCalledOnce();
  });
});
