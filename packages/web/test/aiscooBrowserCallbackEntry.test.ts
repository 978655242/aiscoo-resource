// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://127.0.0.1:5173/"}
import { act } from "react";
import { createElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  roots: [] as Root[],
  callback: vi.fn(),
  account: vi.fn(),
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
  AppErrorBoundary: () => null,
  Root: () => null,
  Button: ({ children }: { children: unknown }) =>
    createElement("button", null, children as string),
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
vi.mock("@web/aiscoo-browser-account/index.js", () => ({
  createBrowserNewApiAccount: state.account,
  registerBrowserAccountChannel: vi.fn(),
}));
beforeEach(() => {
  vi.resetModules();
  state.account
    .mockReset()
    .mockImplementation(() => ({ oauth: { handleCallback: state.callback } }));
  state.callback.mockReset();
  state.official.mockReset();
  localStorage.clear();
  sessionStorage.clear();
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
    for (const root of state.roots.splice(0)) root.unmount();
  });
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
