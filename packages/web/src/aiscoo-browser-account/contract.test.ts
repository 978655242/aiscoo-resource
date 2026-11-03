import { describe, expect, it } from "vitest";
import { createBrowserAiscooAdminAccount } from "./index.js";
import type { BrowserAiscooAdminAccount, BrowserAiscooAdminAccountOptions } from "./contract.js";

describe("browser account public contract", () => {
  it("starts signed out and exposes OAuth without leaking bundle storage", async () => {
    const options: BrowserAiscooAdminAccountOptions = {
      origin: "https://aiscoo-admin.example.test",
      browserOrigin: "http://127.0.0.1:5173",
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      locks: { request: async (_name, run) => run() },
      fetch: async () => {
        throw new Error("unexpected network access");
      },
    };
    const account: BrowserAiscooAdminAccount = createBrowserAiscooAdminAccount(options);
    expect(account.getOwner()).toBeNull();
    expect(account.getStorageIdentity()).toBeNull();
    expect(await account.oauth.restoreCachedSessionState()).toEqual({ status: "signed-out" });
    expect(await account.oauth.getActiveProvider()).toBeNull();
    expect(await account.oauth.getProviders()).toMatchObject([{ id: "new-api", enabled: true }]);
    // 跨标签刷新已公开身份戳接口；精确清单仍需防止 bundle 和 refresh token 泄露。
    expect(Object.keys(account).sort()).toEqual([
      "dispose",
      "getControlCredential",
      "getOwner",
      "getRelayCredential",
      "getStorageIdentity",
      "invalidateCredential",
      "oauth",
    ]);
    await expect(account.oauth.startOAuth("zai")).rejects.toThrow("XCODE_PROVIDER_INVALID");
    await expect(account.oauth.startOAuthWithPolling("new-api")).rejects.toThrow(
      "XCODE_PRIVATE_POLLING_UNSUPPORTED",
    );
    account.dispose();
    expect(account.getOwner()).toBeNull();
  });
});
