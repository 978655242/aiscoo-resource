// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://127.0.0.1:5173/"}
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { IServiceAccessor } from "@zcode/services";
import type { IChannelServer } from "@zcode/rpc";
import type { BrowserNewApiAccount } from "@web/aiscoo-browser-account/index.js";
import type { AiscooWebConnectionPageProps } from "@web/aiscoo-account-login/index.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  roots: [] as Root[],
  windowListenerCleanups: [] as Array<() => void>,
  connections: [] as Array<{ dispose(): void }>,
  callback: vi.fn(),
  startOAuth: vi.fn(),
  account: vi.fn(),
  accountSessionSubscribed: vi.fn(),
  accountSessionDisposed: vi.fn(),
  connect: vi.fn<typeof import("@zcode/client").connectViaWebSocket>(),
  rootReady: vi.fn(),
  official: vi.fn(),
}));
vi.mock("react-dom/client", async (load) => {
  const actual = await load<typeof import("react-dom/client")>();
  return {
    ...actual,
    createRoot: (...args: Parameters<typeof actual.createRoot>) => {
      const root = actual.createRoot(...args);
      state.roots.push(root);
      return root;
    },
  };
});
vi.mock("@zcode/ui", () => ({
  AppErrorBoundary: ({ children }: { children: ReactNode }) => children,
  // 原空组件会掩盖“过早挂载 Root 后黑屏”；此标识只验证入口时序，真实 Root 另由浏览器验收。
  Root: (props: unknown) => {
    state.rootReady(props);
    return createElement("div", { "data-testid": "root-ready" }, "ROOT_READY");
  },
  Button: ({ children, ...props }: { children: ReactNode }) =>
    createElement("button", props, children),
  generateMobileDeviceFingerprint: () => "browser-entry",
  installDocumentHiddenMotionPause: vi.fn(),
  playTaskNotificationSound: vi.fn(),
  setStreamClientId: vi.fn(),
  setWebRemoteControlTerminalTransportState: vi.fn(),
}));
vi.mock("@zcode/ui/conversation-share-readonly", () => ({
  ConversationShareReadonlyTimeline: () => createElement("div", { "data-public-timeline": "true" }),
}));
vi.mock("@web/auth/webAuthService.js", () => ({ createWebAuthService: state.official }));
vi.mock("@web/aiscoo-browser-account/index.js", async (load) => ({
  // 保留真实连接控制器和反向 channel，不能用替身重新实现被回归的生命周期。
  ...(await load<typeof import("@web/aiscoo-browser-account/index.js")>()),
  createBrowserNewApiAccount: state.account,
}));
vi.mock("@zcode/client", async (load) => ({
  ...(await load<typeof import("@zcode/client")>()),
  connectViaWebSocket: state.connect,
}));
beforeEach(() => {
  vi.resetModules();
  state.account.mockReset().mockImplementation(() => ({
    oauth: {
      handleCallback: state.callback,
      startOAuth: state.startOAuth,
      onDidChangeSession: state.accountSessionSubscribed,
    },
    getOwner: vi.fn(() => null),
    getStorageIdentity: vi.fn(() => null),
    dispose: vi.fn(),
  }));
  state.callback.mockReset();
  state.startOAuth.mockReset();
  state.accountSessionSubscribed.mockReset().mockImplementation(() => ({
    dispose: state.accountSessionDisposed,
  }));
  state.accountSessionDisposed.mockReset();
  state.connect.mockReset().mockImplementation(() => {
    throw new Error("Unexpected WebSocket connection in entry fixture");
  });
  state.rootReady.mockReset();
  state.official.mockReset();
  const addEventListener = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
    if (type === "beforeunload" || type === "storage")
      state.windowListenerCleanups.push(() => window.removeEventListener(type, listener, options));
    addEventListener(type, listener, options);
  });
  vi.spyOn(navigator, "language", "get").mockReturnValue("en-US");
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected fetch in entry fixture");
    }),
  );
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubEnv("VITE_AISCOO_BROWSER_NEW_API_ORIGIN", "https://account.example");
  document.body.innerHTML = '<div id="root"></div>';
  window.history.replaceState(
    null,
    "",
    "/oauth/callback?provider=new-api&code=invalid&state=unknown",
  );
});
afterEach(async () => {
  await act(async () => {
    window.dispatchEvent(new Event("beforeunload"));
    for (const connection of state.connections.splice(0)) connection.dispose();
    for (const root of state.roots.splice(0)) root.unmount();
  });
  for (const cleanup of state.windowListenerCleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
it("invalid local callback displays the existing retry page instead of waiting forever", async () => {
  state.callback.mockResolvedValueOnce(null);
  await act(async () => {
    await import("@web/main.js");
  });
  expect(state.callback).toHaveBeenCalledExactlyOnceWith(window.location.href);
  expect(document.body.textContent).toContain("Sign-In Failed");
  expect(document.body.textContent).toContain("Sign In Again");
  expect(document.body.textContent).not.toContain("Finishing Sign-In");
  expect(state.official).not.toHaveBeenCalled();
});

it.each([
  "/remote/v4?sid=secret-device",
  "/remote/v4?state=secret-state&authCode=secret-code",
  "/share/callback?state=secret-state&code=secret-code",
  "/cn/share/callback?state=secret-state&authCode=secret-code",
  "/oauth/callback?provider=zai&state=secret-state&code=secret-code",
])(
  "unsupported entry never creates an official owner or consumes saved credentials: %s",
  async (path) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    localStorage.setItem("zcodejwttoken", "legacy-jwt");
    localStorage.setItem("oauth:zai:access_token", "legacy-token");
    window.history.replaceState(null, "", path);
    await act(async () => {
      await import("@web/main.js");
    });
    expect(document.body.textContent).toContain("Aiscoo sign-in unavailable");
    expect(document.body.textContent).not.toMatch(/Z\.ai|BigModel|secret-/);
    expect(document.querySelector("button")).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(state.account).not.toHaveBeenCalled();
    expect(state.official).not.toHaveBeenCalled();
    expect(state.callback).not.toHaveBeenCalled();
    expect(localStorage.getItem("oauth:zai:access_token")).toBe("legacy-token");
  },
);

it.each(["", "invalid", "http://example.com", "https://account.example/path"])(
  "missing or invalid browser account origin fails closed: %s",
  async (origin) => {
    vi.stubEnv("VITE_AISCOO_BROWSER_NEW_API_ORIGIN", origin);
    window.history.replaceState(null, "", "/");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await act(async () => {
      await import("@web/main.js");
    });
    expect(document.body.textContent).toContain("not configured");
    expect(fetch).not.toHaveBeenCalled();
    expect(state.official).not.toHaveBeenCalled();
  },
);

it("public read-only share remains available without configured sign-in or legacy credentials", async () => {
  vi.stubEnv("VITE_AISCOO_BROWSER_NEW_API_ORIGIN", "");
  window.history.replaceState(null, "", "/share/aiscoo-public");
  localStorage.setItem("zcodejwttoken", "legacy-jwt");
  const fetch = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        code: 0,
        msg: "",
        data: {
          schema_version: 1,
          share: {
            title: "AISCOO_PUBLIC_READONLY",
            access_mode: "public_readonly",
            created_at: 1,
            expires_at: 9999999999999,
          },
          rows: [],
          artifacts: [],
          integrity: { projection_sha256: "a".repeat(64), artifact_set_sha256: "b".repeat(64) },
        },
      }),
      { status: 200 },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  await act(async () => {
    await import("@web/main.js");
  });
  expect(document.body.textContent).toContain("AISCOO_PUBLIC_READONLY");
  expect(document.querySelector("[data-public-timeline]")).not.toBeNull();
  expect(document.body.textContent).not.toMatch(/Z\.ai|BigModel|sign-in unavailable/);
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit", redirect: "error" });
  expect(fetch.mock.calls[0]?.[1]?.headers).toBeUndefined();
  expect(state.official).not.toHaveBeenCalled();
});

it.each([401, 404])(
  "protected share is anonymous and cannot render official sign-in: %s",
  async (status) => {
    window.history.replaceState(null, "", "/share/aiscoo-public");
    localStorage.setItem("zcodejwttoken", "legacy-jwt");
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 3211, msg: "not_found" }), { status }),
      );
    vi.stubGlobal("fetch", fetch);
    await act(async () => {
      await import("@web/main.js");
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/shares/aiscoo-public/preview"),
      expect.objectContaining({ credentials: "omit", redirect: "error" }),
    );
    expect(fetch.mock.calls[0]?.[1]?.headers).toBeUndefined();
    expect(document.body.textContent).toContain("Aiscoo sign-in unavailable");
    expect(document.body.textContent).not.toMatch(/Z\.ai|BigModel/);
    expect(state.official).not.toHaveBeenCalled();
    expect(localStorage.getItem("zcodejwttoken")).toBe("legacy-jwt");
  },
);

type WebSocketOptions = NonNullable<
  Parameters<typeof import("@zcode/client").connectViaWebSocket>[1]
>;
type Providers = Awaited<ReturnType<IServiceAccessor["oauthService"]["getProviders"]>>;

function createBrowserTransport({ abortMetadata = true } = {}) {
  const opened = Promise.withResolvers<IServiceAccessor>();
  const metadata = Promise.withResolvers<Providers>();
  // 允许主动制造未被读取和关闭后才完成的结果，避免夹具自身产生未处理拒绝。
  void opened.promise.catch(() => {});
  void metadata.promise.catch(() => {});
  const registerChannel = vi.fn();
  const getProviders = vi.fn(() => metadata.promise);
  const services = {
    oauthService: {
      getProviders,
      startOAuth: vi.fn(),
      getActiveProvider: vi.fn(async () => null),
      onDidChangeSession: vi.fn(() => ({ dispose: vi.fn() })),
    },
    settingService: { get: vi.fn(async () => ({})), update: vi.fn(async () => {}) },
    broadcastService: { onMessage: vi.fn(() => ({ dispose: vi.fn() })) },
  } as unknown as IServiceAccessor;
  let options: WebSocketOptions | undefined;
  let transportClosed = false;
  const currentOptions = () => {
    expect(options).toBeDefined();
    return options!;
  };
  const closeSocket = vi.fn(() => {
    if (transportClosed) return;
    transportClosed = true;
    currentOptions().onClose?.({ code: 1000, reason: "", wasClean: true });
  });
  state.connect.mockImplementation((_url, suppliedOptions) => {
    options = suppliedOptions;
    const abort = () => {
      // 模拟现有 transport / ChannelClient 的取消语义，而非在测试中重写产品状态机。
      const error = new DOMException("Synthetic connection aborted", "AbortError");
      opened.reject(error);
      if (abortMetadata) metadata.reject(error);
      closeSocket();
    };
    if (options?.signal?.aborted) abort();
    else options?.signal?.addEventListener("abort", abort, { once: true });
    return opened.promise;
  });
  return {
    opened,
    metadata,
    getProviders,
    services,
    registerChannel,
    closeSocket,
    signal: () => {
      const signal = currentOptions().signal;
      expect(signal).toBeDefined();
      return signal!;
    },
    open() {
      const options = currentOptions();
      if (transportClosed || options.signal?.aborted) return;
      options.onOpenSocket?.({ close: closeSocket } as unknown as WebSocket);
      options.registerChannels?.({ registerChannel } as unknown as IChannelServer);
      // 上游 transport 在 open 时交服务；真实产品控制器仍须等首个元数据 RPC。
      opened.resolve(services);
    },
    close(code = 1006, reason = "") {
      transportClosed = true;
      currentOptions().onClose?.({ code, reason, wasClean: code === 1000 });
    },
  };
}

async function startBrowserMain(language = "en-US") {
  vi.spyOn(navigator, "language", "get").mockReturnValue(language);
  window.history.replaceState(null, "", "/");
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    expect(input).toBe("/api/server-info");
    return new Response(JSON.stringify({ workspaces: [] }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetch);
  await act(async () => {
    await import("@web/main.js");
  });
  expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/server-info", { cache: "no-store" });
  expect(state.official).not.toHaveBeenCalled();
}

async function startMismatchPage(
  account = state.account() as BrowserNewApiAccount,
  locale = "en-US",
  withDom = false,
) {
  const transport = createBrowserTransport();
  const { createAiscooBrowserWebStartup } = await import("@web/aiscoo-account-login/index.js");
  const root = withDom ? createRoot(document.getElementById("root")!) : undefined;
  const assign = vi.fn();
  const reload = vi.fn();
  const page = Object.assign(new EventTarget(), { location: { assign, reload } });
  vi.stubGlobal("window", page);
  const render = vi.fn((node: ReactNode) => root?.render(node));
  let unloading = false;
  const connection = createAiscooBrowserWebStartup({
    account,
    render,
    locale,
    isPageUnloading: () => unloading,
  });
  state.connections.push(connection);
  await act(async () => {
    void connection.connect("ws://127.0.0.1:5173/ws").catch(() => {});
  });
  await act(async () => transport.open());
  await act(async () => transport.close(1008, "Browser account does not match"));
  const props = (render.mock.calls.at(-1)![0] as { props: AiscooWebConnectionPageProps }).props;
  return {
    connection,
    transport,
    assign,
    reload,
    page,
    props,
    setUnloading: () => {
      unloading = true;
    },
  };
}

function expectConnectionPage(
  expectedState: "connecting" | "account-in-use" | "account-mismatch" | "disconnected",
) {
  const page = document.querySelector<HTMLElement>('[data-testid="aiscoo-web-connection-page"]');
  expect(page).not.toBeNull();
  expect(page?.dataset.state).toBe(expectedState);
  expect(page?.textContent?.trim()).toBeTruthy();
  expect(document.querySelector('[data-testid="root-ready"]')).toBeNull();
  return page!;
}

const connectionLocales = [
  {
    language: "en-US",
    connecting: "Connecting to Aiscoo",
    inUse: "Account connection in use",
    mismatch: "Account connection mismatch",
    disconnected: "Connection lost",
    retry: "Retry",
  },
  {
    language: "zh-CN",
    connecting: "正在连接 Aiscoo",
    inUse: "账号连接已被其他页面占用",
    mismatch: "账号连接不匹配",
    disconnected: "与 Aiscoo 的连接已断开",
    retry: "重试",
  },
];

it.each(connectionLocales)(
  "$language main shows a nonempty connecting page until OAuth metadata is ready",
  async ({ language, connecting }) => {
    const transport = createBrowserTransport();
    await startBrowserMain(language);
    const page = expectConnectionPage("connecting");
    expect(page.querySelector("h1")?.textContent).toBe(connecting);
    expect(page.querySelector("button")).toBeNull();
    expect(state.rootReady).not.toHaveBeenCalled();
    expect(transport.getProviders).not.toHaveBeenCalled();
    expect(transport.signal().aborted).toBe(false);

    await act(async () => transport.open());
    expect(transport.registerChannel).toHaveBeenCalledWith(
      "aiscoo/browser-account",
      expect.objectContaining({ call: expect.any(Function), listen: expect.any(Function) }),
    );
    expect(transport.getProviders).toHaveBeenCalledOnce();
    expectConnectionPage("connecting");
    expect(state.rootReady).not.toHaveBeenCalled();

    await act(async () => transport.metadata.resolve([]));
    expect(document.querySelector('[data-testid="root-ready"]')?.textContent).toBe("ROOT_READY");
    expect(document.querySelector('[data-testid="aiscoo-web-connection-page"]')).toBeNull();
    expect(state.rootReady).toHaveBeenCalled();
    expect(transport.signal().aborted).toBe(false);
  },
);

it.each(connectionLocales)(
  "$language open then 1008 renders account-in-use and keeps late metadata from mounting Root",
  async ({ language, inUse, retry }) => {
    // 故意让这次元数据忽略取消，检验迟到成功也不能覆盖连接终态。
    const transport = createBrowserTransport({ abortMetadata: false });
    localStorage.setItem("aiscoo:browser-new-api:fixture", "synthetic-recoverable-session");
    sessionStorage.setItem("aiscoo:browser-new-api:pending:fixture", "synthetic-pending-proof");
    await startBrowserMain(language);
    await act(async () => transport.open());
    expect(transport.getProviders).toHaveBeenCalledOnce();

    await act(async () => transport.close(1008, "Browser account is already attached"));
    const page = expectConnectionPage("account-in-use");
    expect(page.querySelector("h1")?.textContent).toBe(inUse);
    expect(page.querySelector("button")?.textContent).toBe(retry);
    expect(transport.signal().aborted).toBe(true);
    expect(state.accountSessionDisposed).toHaveBeenCalledOnce();
    expect(state.rootReady).not.toHaveBeenCalled();
    expect(page.textContent).not.toContain("Browser account is already attached");
    expect(page.querySelector('[data-testid="oauth-login-button-new-api"]')).toBeNull();
    const failureHtml = page.outerHTML;

    await act(async () => transport.metadata.resolve([]));
    expect(expectConnectionPage("account-in-use").outerHTML).toBe(failureHtml);
    expect(state.rootReady).not.toHaveBeenCalled();
    expect(state.connect).toHaveBeenCalledOnce();
    expect(localStorage.getItem("aiscoo:browser-new-api:fixture")).toBe(
      "synthetic-recoverable-session",
    );
    expect(sessionStorage.getItem("aiscoo:browser-new-api:pending:fixture")).toBe(
      "synthetic-pending-proof",
    );
    expect(localStorage.length).toBe(1);
    expect(sessionStorage.length).toBe(1);
  },
);

it.each(connectionLocales)(
  "$language a conflicting account shows mismatch with explicit retry, including after late metadata",
  async ({ language, mismatch, inUse, retry }) => {
    const transport = createBrowserTransport({ abortMetadata: false });
    await startBrowserMain(language);
    state.account.mock.results[0]!.value.getOwner.mockReturnValue({
      origin: "https://account.example",
      userId: "2",
      sid: "synthetic-conflicting-owner",
      authGeneration: 2,
    });
    await act(async () => transport.open());
    await act(async () => transport.close(1008, "Browser account does not match"));
    const page = expectConnectionPage("account-mismatch");
    expect(page.querySelector("h1")?.textContent).toBe(mismatch);
    expect(page.querySelector("button")?.textContent).toBe(retry);
    expect(page.textContent).not.toContain(inUse);
    expect(page.textContent).not.toContain("Browser account does not match");
    expect(page.querySelector('[data-testid="oauth-login-button-new-api"]')).toBeNull();
    expect(transport.signal().aborted).toBe(true);
    expect(state.accountSessionDisposed).toHaveBeenCalledOnce();
    const failureHtml = page.outerHTML;
    await act(async () => transport.metadata.resolve([]));
    expect(expectConnectionPage("account-mismatch").outerHTML).toBe(failureHtml);
    expect(state.rootReady).not.toHaveBeenCalled();
    expect(state.connect).toHaveBeenCalledOnce();
  },
);

it.each(connectionLocales)(
  "$language an unconfirmed mismatch page signs in locally with one busy attempt and fixed errors",
  async ({ language, retry }) => {
    const started = Promise.withResolvers<{ authorizeUrl: string }>();
    state.startOAuth.mockReturnValueOnce(started.promise);
    const f = await startMismatchPage(undefined, language, true);
    const page = expectConnectionPage("account-mismatch");
    const zh = language === "zh-CN";
    expect(page.querySelector("h1")?.textContent).toBe(zh ? "登录 Aiscoo" : "Sign in to Aiscoo");
    const login = page.querySelector<HTMLButtonElement>(
      '[data-testid="oauth-login-button-new-api"]',
    );
    expect(login).not.toBeNull();
    expect(login?.textContent).toBe(zh ? "登录" : "Sign in");
    const retryButton = [...page.querySelectorAll("button")].find(
      (button) => button.textContent === retry,
    )!;
    await act(async () => {
      login!.click();
      login!.click();
    });
    expect(state.startOAuth).toHaveBeenCalledExactlyOnceWith("new-api");
    expect(login!.disabled).toBe(true);
    expect(login!.getAttribute("aria-busy")).toBe("true");
    expect(retryButton.disabled).toBe(true);
    await act(async () =>
      started.reject(new Error("raw-secret https://account.example/authorize?code=hidden")),
    );
    expect(page.querySelector('p[role="alert"]')?.textContent).toBe(
      zh ? "无法发起登录，请重试。" : "Unable to start sign-in. Please try again.",
    );
    expect(page.textContent).not.toMatch(/raw-secret|authorize|hidden/);
    expect(login!.disabled).toBe(false);
    expect(retryButton.disabled).toBe(false);
    const authorizeUrl = "https://account.example/api/xcode/v1/auth/authorize?state=synthetic";
    state.startOAuth.mockResolvedValueOnce({ authorizeUrl });
    await act(async () => login!.click());
    expect(f.assign).toHaveBeenCalledExactlyOnceWith(authorizeUrl);
    expect(state.startOAuth).toHaveBeenCalledTimes(2);
    expect(f.transport.services.oauthService.startOAuth).not.toHaveBeenCalled();
    expect(f.connection.closed).toBe(true);
    expect(state.connect).toHaveBeenCalledOnce();
    expect(state.rootReady).not.toHaveBeenCalled();
    expect(page.textContent).not.toContain(authorizeUrl);
  },
);

it.each(["beforeunload", "dispose", "retry", "unloading-flag"] as const)(
  "a late local login cannot navigate after %s and its duplicate command shares one attempt",
  async (stop) => {
    const started = Promise.withResolvers<{ authorizeUrl: string }>();
    state.startOAuth.mockReturnValueOnce(started.promise);
    const f = await startMismatchPage();
    expect(f.props.onLogin).toEqual(expect.any(Function));
    const first = f.props.onLogin!();
    const duplicate = f.props.onLogin!();
    expect(duplicate).toBe(first);
    if (stop === "beforeunload") f.page.dispatchEvent(new Event("beforeunload"));
    if (stop === "dispose") f.connection.dispose();
    if (stop === "retry") f.props.onRetry();
    if (stop === "unloading-flag") f.setUnloading();
    started.resolve({ authorizeUrl: "https://account.example/late-login" });
    await Promise.all([first, duplicate]);
    await f.props.onLogin!();
    expect(f.assign).not.toHaveBeenCalled();
    expect(state.startOAuth).toHaveBeenCalledExactlyOnceWith("new-api");
    expect(state.connect).toHaveBeenCalledOnce();
    expect(f.transport.services.oauthService.startOAuth).not.toHaveBeenCalled();
  },
);

it("a clean rejected page uses the real local account PKCE without Host RPC or other credentials", async () => {
  const { createBrowserNewApiAccount } = await vi.importActual<
    typeof import("@web/aiscoo-browser-account/index.js")
  >("@web/aiscoo-browser-account/index.js");
  const { webcrypto } = await import("node:crypto");
  const storage = () => {
    const values = new Map<string, string>();
    return {
      values,
      getItem: vi.fn((key: string) => values.get(key) ?? null),
      setItem: vi.fn((key: string, value: string) => {
        values.set(key, value);
      }),
      removeItem: vi.fn((key: string) => {
        values.delete(key);
      }),
    };
  };
  const local = storage();
  const session = storage();
  session.values.set("unrelated-origin:pending", "synthetic-other-proof");
  const fetch = vi.fn();
  const account = createBrowserNewApiAccount({
    origin: "https://account.example",
    browserOrigin: "http://127.0.0.1:5173",
    localStorage: local,
    sessionStorage: session,
    fetch,
    crypto: webcrypto as unknown as Crypto,
    locks: {
      async request<T>(_name: string, run: () => Promise<T>) {
        return run();
      },
    },
  });
  const f = await startMismatchPage(account, "en-US", true);
  const login = document.querySelector<HTMLButtonElement>(
    '[data-testid="oauth-login-button-new-api"]',
  );
  expect(login).not.toBeNull();
  await act(async () => {
    login!.click();
    await f.props.onLogin!();
  });
  expect(f.assign).toHaveBeenCalledOnce();
  const url = new URL(f.assign.mock.calls[0]![0]);
  expect(url.origin + url.pathname).toBe("https://account.example/api/xcode/v1/auth/authorize");
  const prefix = `aiscoo:browser-new-api:${encodeURIComponent("https://account.example")}`;
  const pending = JSON.parse(session.values.get(`${prefix}:pending`)!);
  expect(pending.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(pending.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const challenge = Buffer.from(
    await webcrypto.subtle.digest("SHA-256", new TextEncoder().encode(pending.codeVerifier)),
  ).toString("base64url");
  expect(Object.fromEntries(url.searchParams)).toMatchObject({
    client_id: "xwork-cli",
    redirect_uri: "http://127.0.0.1:5173/oauth/callback",
    state: pending.state,
    code_challenge_method: "S256",
    code_challenge: challenge,
  });
  expect(local.getItem.mock.calls.every(([key]) => key === `${prefix}:session`)).toBe(true);
  expect(local.setItem).not.toHaveBeenCalled();
  expect(local.removeItem).not.toHaveBeenCalled();
  expect(session.values.get("unrelated-origin:pending")).toBe("synthetic-other-proof");
  expect(fetch).not.toHaveBeenCalled();
  expect(f.transport.services.oauthService.startOAuth).not.toHaveBeenCalled();
  expect(state.connect).toHaveBeenCalledOnce();
  expect(account.getOwner()).toBeNull();
  expect(state.rootReady).not.toHaveBeenCalled();
  account.dispose();
});

it.each(connectionLocales)(
  "$language a ready connection replaces Root with a retry page on disconnect",
  async ({ language, disconnected, retry }) => {
    const transport = createBrowserTransport();
    await startBrowserMain(language);
    await act(async () => {
      transport.open();
      transport.metadata.resolve([]);
    });
    expect(document.querySelector('[data-testid="root-ready"]')).not.toBeNull();

    await act(async () => transport.close(1006, "synthetic transport detail"));
    const page = expectConnectionPage("disconnected");
    expect(page.querySelector("h1")?.textContent).toBe(disconnected);
    expect(page.querySelector("button")?.textContent).toBe(retry);
    expect(page.textContent).not.toContain("synthetic transport detail");
    expect(page.querySelector('[data-testid="oauth-login-button-new-api"]')).toBeNull();
    expect(transport.signal().aborted).toBe(true);
    expect(state.accountSessionDisposed).toHaveBeenCalledOnce();
    const failureHtml = page.outerHTML;
    await act(async () => transport.close());
    expect(expectConnectionPage("disconnected").outerHTML).toBe(failureHtml);
    expect(state.accountSessionDisposed).toHaveBeenCalledOnce();
    expect(state.connect).toHaveBeenCalledOnce();
  },
);

it.each(["transport", "metadata"] as const)(
  "%s startup rejection renders the real retry page and aborts the connection",
  async (phase) => {
    const transport = createBrowserTransport();
    await startBrowserMain();
    await act(async () => {
      const error = new Error("synthetic-secret https://account.example/authorize?code=hidden");
      if (phase === "transport") transport.opened.reject(error);
      else {
        transport.open();
        await Promise.resolve();
        transport.metadata.reject(error);
      }
    });
    const page = expectConnectionPage("disconnected");
    expect(page.querySelector("h1")?.textContent).toBe("Connection lost");
    expect(page.querySelector("button")?.textContent).toBe("Retry");
    expect(page.textContent).not.toMatch(/synthetic-secret|authorize|hidden/);
    expect(transport.signal().aborted).toBe(true);
    expect(state.rootReady).not.toHaveBeenCalled();
    if (phase === "metadata") expect(state.accountSessionDisposed).toHaveBeenCalledOnce();
    expect(state.connect).toHaveBeenCalledOnce();
  },
);

it.each(["opening", "metadata", "ready"] as const)(
  "main beforeunload during %s silently cancels the current connection",
  async (phase) => {
    const transport = createBrowserTransport();
    await startBrowserMain();
    await act(async () => {
      if (phase !== "opening") {
        transport.open();
        if (phase === "ready") transport.metadata.resolve([]);
      }
    });
    const beforeUnloadHtml = document.getElementById("root")!.innerHTML;
    const mountedBeforeUnload = state.rootReady.mock.calls.length;
    await act(async () => window.dispatchEvent(new Event("beforeunload")));
    expect(transport.signal().aborted).toBe(true);
    await act(async () => {
      transport.close(1000);
      // 导航后迟到的 open / 元数据成功都不能交付旧 Root。
      if (phase === "opening") transport.open();
      transport.metadata.resolve([]);
    });
    expect(document.getElementById("root")!.innerHTML).toBe(beforeUnloadHtml);
    expect(state.rootReady).toHaveBeenCalledTimes(mountedBeforeUnload);
    expect(document.querySelector('[data-state="disconnected"]')).toBeNull();
    expect(document.querySelector('[data-state="account-in-use"]')).toBeNull();
  },
);

it.each([
  { code: 1008, detail: "Browser account is already attached", reason: "account-in-use" },
  { code: 1008, detail: "Browser account does not match", reason: "account-mismatch" },
  { code: 1008, detail: "Browser account changed", reason: "account-changed" },
  { code: 1008, detail: "Unrecognized policy close", reason: "disconnected" },
  { code: 1006, detail: "Browser account does not match", reason: "disconnected" },
  { code: 1006, detail: "Browser account changed", reason: "disconnected" },
  { code: 1000, detail: "Browser account is already attached", reason: "disconnected" },
])(
  "the real controller classifies $code / $detail and terminates only once",
  async ({ code, detail, reason }) => {
    const transport = createBrowserTransport();
    const { createBrowserAccountWebConnection } =
      await import("@web/aiscoo-browser-account/index.js");
    const onFailure = vi.fn();
    const connection = createBrowserAccountWebConnection({
      account: state.account() as BrowserNewApiAccount,
      onFailure,
    });
    state.connections.push(connection);
    const outcome = vi.fn();
    void connection.connect("ws://127.0.0.1:5173/ws").then(
      (services) => outcome({ status: "resolved", services }),
      () => outcome({ status: "rejected" }),
    );
    await act(async () => transport.open());
    expect(transport.getProviders).toHaveBeenCalledOnce();
    expect(outcome).not.toHaveBeenCalled();

    await act(async () => transport.close(code, detail));
    expect(connection.closed).toBe(true);
    expect(transport.signal().aborted).toBe(true);
    expect(outcome).toHaveBeenCalledExactlyOnceWith({ status: "rejected" });
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({ reason });
    expect(state.accountSessionDisposed).toHaveBeenCalledOnce();
    await act(async () => {
      transport.metadata.resolve([]);
      transport.close();
      connection.dispose();
    });
    expect(outcome).toHaveBeenCalledExactlyOnceWith({ status: "rejected" });
    expect(onFailure).toHaveBeenCalledExactlyOnceWith({ reason });
    expect(state.accountSessionDisposed).toHaveBeenCalledOnce();
  },
);

it("a mismatching account requires explicit retry without an automatic reload", async () => {
  const transport = createBrowserTransport();
  const { createAiscooBrowserWebStartup } = await import("@web/aiscoo-account-login/index.js");
  const render = vi.fn();
  const reload = vi.fn();
  vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { reload } }));
  const connection = createAiscooBrowserWebStartup({
    account: state.account() as BrowserNewApiAccount,
    render,
    isPageUnloading: () => false,
  });
  state.connections.push(connection);
  void connection.connect("ws://127.0.0.1:5173/ws").catch(() => {});
  await act(async () => transport.open());
  await act(async () => transport.close(1008, "Browser account does not match"));
  expect(connection.closed).toBe(true);
  expect(reload).not.toHaveBeenCalled();
  expect(render).toHaveBeenLastCalledWith(
    expect.objectContaining({
      props: expect.objectContaining({ failure: { reason: "account-mismatch" } }),
    }),
  );
});

it.each([
  { phase: "metadata", unloading: false },
  { phase: "ready", unloading: false },
  { phase: "metadata", unloading: true },
])(
  "owner change during $phase reloads once unless unloading=$unloading",
  async ({ phase, unloading }) => {
    const transport = createBrowserTransport({ abortMetadata: false });
    const { createAiscooBrowserWebStartup } = await import("@web/aiscoo-account-login/index.js");
    const render = vi.fn();
    const reload = vi.fn();
    vi.stubGlobal("window", Object.assign(new EventTarget(), { location: { reload } }));
    const connection = createAiscooBrowserWebStartup({
      account: state.account() as BrowserNewApiAccount,
      render,
      isPageUnloading: () => unloading,
    });
    state.connections.push(connection);
    const outcome = vi.fn();
    void connection.connect("ws://127.0.0.1:5173/ws").then(
      (services) => outcome({ status: "resolved", services }),
      () => outcome({ status: "rejected" }),
    );
    await act(async () => {
      transport.open();
      if (phase === "ready") transport.metadata.resolve([]);
    });
    const renders = render.mock.calls.length;
    reload.mockImplementation(() => {
      // 先取消正向 RPC 和反向账号订阅，重载后的新作用域不能继续借用旧连接。
      expect(connection.closed).toBe(true);
      expect(transport.signal().aborted).toBe(true);
      expect(state.accountSessionDisposed).toHaveBeenCalledOnce();
    });
    await act(async () => transport.close(1008, "Browser account changed"));
    expect(connection.closed).toBe(true);
    expect(transport.signal().aborted).toBe(true);
    expect(reload).toHaveBeenCalledTimes(unloading ? 0 : 1);
    expect(render).toHaveBeenCalledTimes(renders);
    await act(async () => {
      transport.close(1008, "Browser account changed");
      transport.metadata.resolve([]);
    });
    expect(reload).toHaveBeenCalledTimes(unloading ? 0 : 1);
    expect(render).toHaveBeenCalledTimes(renders);
    expect(outcome).toHaveBeenCalledExactlyOnceWith(
      phase === "ready"
        ? { status: "resolved", services: transport.services }
        : { status: "rejected" },
    );
  },
);

it.each(["opening", "metadata", "ready"] as const)(
  "explicit disposal during %s is terminal without drawing a failure page",
  async (phase) => {
    const transport = createBrowserTransport();
    const { createAiscooBrowserWebStartup } = await import("@web/aiscoo-account-login/index.js");
    const root = createRoot(document.getElementById("root")!);
    const render = vi.fn((node: ReactNode) => root.render(node));
    const connection = createAiscooBrowserWebStartup({
      account: state.account() as BrowserNewApiAccount,
      render,
      isPageUnloading: () => false,
    });
    state.connections.push(connection);
    const outcome = vi.fn();
    await act(async () => {
      void connection.connect("ws://127.0.0.1:5173/ws").then(
        (services) => outcome({ status: "resolved", services }),
        () => outcome({ status: "rejected" }),
      );
      if (phase !== "opening") {
        transport.open();
        if (phase === "ready") transport.metadata.resolve([]);
      }
    });
    expectConnectionPage("connecting");
    if (phase === "ready")
      expect(outcome).toHaveBeenCalledExactlyOnceWith({
        status: "resolved",
        services: transport.services,
      });
    else expect(outcome).not.toHaveBeenCalled();
    const renderCount = render.mock.calls.length;
    await act(async () => {
      connection.dispose();
      connection.dispose();
    });
    expect(connection.closed).toBe(true);
    expect(transport.signal().aborted).toBe(true);
    await act(async () => {
      transport.close(1008, "Browser account is already attached");
      if (phase === "opening") transport.open();
      transport.metadata.resolve([]);
    });
    expect(render).toHaveBeenCalledTimes(renderCount);
    expectConnectionPage("connecting");
    if (phase !== "ready") expect(outcome).toHaveBeenCalledExactlyOnceWith({ status: "rejected" });
    expect(state.accountSessionDisposed).toHaveBeenCalledTimes(
      state.accountSessionSubscribed.mock.calls.length,
    );
  },
);

it.each(["omitted", "callbacks-only"] as const)(
  "generic WebSocket without signal preserves open-time readiness: %s options",
  async (mode) => {
    // Aiscoo 控制器测试的 transport mock 无法证明上游默认行为；此处使用真实客户端且不建立网络。
    const { connectViaWebSocket } =
      await vi.importActual<typeof import("@zcode/client")>("@zcode/client");
    const sockets: SyntheticWebSocket[] = [];
    class SyntheticWebSocket extends EventTarget {
      static OPEN = 1;
      readyState = 0;
      binaryType = "blob";
      send = vi.fn();
      close = vi.fn(() => {
        this.readyState = 3;
        this.dispatchEvent(
          new CloseEvent("close", { code: 1000, reason: "Synthetic close", wasClean: true }),
        );
      });
      constructor(readonly url: string) {
        super();
        sockets.push(this);
      }
    }
    vi.stubGlobal("WebSocket", SyntheticWebSocket);
    const onOpenSocket = vi.fn();
    const onClose = vi.fn();
    const outcome = vi.fn();
    const wsUrl = "ws://127.0.0.1:5173/ws";
    const connected =
      mode === "omitted"
        ? connectViaWebSocket(wsUrl)
        : connectViaWebSocket(wsUrl, { onOpenSocket, onClose });
    void connected.then(
      (services) => outcome({ status: "resolved", services }),
      () => outcome({ status: "rejected" }),
    );
    expect(sockets).toHaveLength(1);
    const socket = sockets[0]!;
    expect(socket.url).toBe(wsUrl);
    expect(outcome).not.toHaveBeenCalled();
    await act(async () => {
      socket.readyState = SyntheticWebSocket.OPEN;
      socket.dispatchEvent(new Event("open"));
    });
    expect(outcome).toHaveBeenCalledExactlyOnceWith({
      status: "resolved",
      services: expect.objectContaining({ oauthService: expect.any(Object) }),
    });
    expect(socket.send).not.toHaveBeenCalled();
    socket.close();
    if (mode === "callbacks-only") {
      expect(onOpenSocket).toHaveBeenCalledExactlyOnceWith(socket);
      expect(onClose).toHaveBeenCalledExactlyOnceWith({
        code: 1000,
        reason: "Synthetic close",
        wasClean: true,
      });
    }
    expect(state.connect).not.toHaveBeenCalled();
    expect(state.account).not.toHaveBeenCalled();
  },
);
