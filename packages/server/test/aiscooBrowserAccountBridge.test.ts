import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ChannelClient,
  ChannelServer,
  createQueuePair,
  Emitter,
  type IChannel,
  type IChannelClient,
} from "@zcode/rpc";
import type { NewApiOwner, OAuthSessionState } from "@zcode/shared";
import {
  BROWSER_ACCOUNT_CHANNEL,
  createBrowserAccountBridge,
  type BrowserAccountBridgeOptions,
  type BrowserAccountRestoreResult,
  type BrowserAccountSessionEvent,
} from "../src/aiscoo-browser-account/index.js";

const origin = "https://account.example.test";
const owner: NewApiOwner = { origin, userId: "1", sid: "session-a", authGeneration: 1 };
const nextOwner: NewApiOwner = { ...owner, userId: "2", sid: "session-b", authGeneration: 2 };
const restoreResult = (account: NewApiOwner | null = owner): BrowserAccountRestoreResult => ({
  owner: account,
  session: account
    ? {
        status: "authenticated",
        userInfo: { id: account.userId, username: "user", displayName: "User" },
      }
    : { status: "signed-out" },
});
const cleanups: (() => void)[] = [];
afterEach(() =>
  cleanups
    .splice(0)
    .reverse()
    .forEach((dispose) => dispose()),
);

function peer(account: NewApiOwner | null = owner) {
  const events = new Emitter<BrowserAccountSessionEvent>();
  const call = vi.fn(async (command: string, _arg?: unknown): Promise<unknown> => {
    switch (command) {
      case "restore":
        return restoreResult(account);
      case "control":
        return { owner: account, accessToken: "test-control" };
      case "relay":
        return { token: "sk-test-relay", expiresAt: Date.now() + 60_000 };
      case "oauth":
        return undefined;
      default:
        throw new Error("unexpected command");
    }
  });
  const channel: IChannel = {
    call: <T>(command: string, arg?: unknown) => call(command, arg) as Promise<T>,
    listen: <T>(event: string) => {
      expect(event).toBe("session");
      return events.event as import("@zcode/rpc").Event<T>;
    },
  };
  const client: IChannelClient = {
    getChannel<T extends IChannel>(name: string): T {
      expect(name).toBe(BROWSER_ACCOUNT_CHANNEL);
      return channel as T;
    },
  };
  cleanups.push(() => events.dispose());
  return { client, channel, events, call };
}
function fixture(options: BrowserAccountBridgeOptions = {}, account: NewApiOwner | null = owner) {
  const bridge = createBrowserAccountBridge(origin, options);
  const browser = peer(account);
  cleanups.push(() => bridge.dispose());
  return { bridge, authority: bridge.authority, browser };
}

// 连接身份与 owner 修订必须同时校验，避免断连或换号后的迟到凭据进入新请求。
describe("browser account reverse bridge", () => {
  it("rejects inactive background OAuth through the IOAuthService Promise contract", async () => {
    const { authority, browser } = fixture();
    const oauth = authority.oauth;
    const calls = [
      () => oauth.getProviders(),
      () => oauth.getActiveProvider(),
      () => oauth.restoreCachedSession(),
      () => oauth.restoreCachedSessionState(),
      () => oauth.restoreSession(),
      () => oauth.startOAuth("new-api"),
      () => oauth.startOAuthWithPolling("new-api"),
      () => oauth.pollPendingOAuth(),
      () => oauth.handleCallback("http://127.0.0.1:5173/oauth/callback?state=synthetic"),
      () => oauth.refreshToken("new-api"),
      () => oauth.logout("new-api"),
      () => oauth.logoutAll(),
      () => oauth.cancelPending("new-api"),
    ];
    for (const invoke of calls) {
      const result = invoke();
      expect(result).toBeInstanceOf(Promise);
      await expect(result).rejects.toThrow("XCODE_BROWSER_ACCOUNT_UNAVAILABLE");
    }
    expect(browser.call).not.toHaveBeenCalled();
  });

  it("restores over the existing RPC transport and exposes only OAuth methods", async () => {
    const { bridge, authority, browser } = fixture();
    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "browser");
    const client = new ChannelClient(clientProtocol);
    server.registerChannel(BROWSER_ACCOUNT_CHANNEL, {
      call: <T>(_ctx: string, command: string, arg?: unknown) =>
        browser.channel.call<T>(command, arg),
      listen: <T>(_ctx: string, event: string) => browser.channel.listen<T>(event),
    });
    cleanups.push(() => {
      client.dispose();
      server.dispose();
    });
    const changes: OAuthSessionState[] = [];
    authority.oauth.onDidChangeSession((state) => changes.push(state));
    const attachment = bridge.attach(client);
    await attachment.ready;
    expect(authority.getOwner()).toEqual(owner);
    expect(changes).toEqual(["signed-in"]);
    expect(browser.call).toHaveBeenCalledExactlyOnceWith("restore", undefined);
    expect(Object.keys(attachment.oauth).sort()).toEqual(Object.keys(authority.oauth).sort());
    for (const oauth of [attachment.oauth, authority.oauth]) {
      expect(Object.keys(oauth)).not.toContain("getRelayCredential");
      expect(Object.keys(oauth)).not.toContain("withControlSession");
      expect(Object.isFrozen(oauth)).toBe(true);
    }
    expect(Object.isFrozen(authority.getOwner())).toBe(true);
  });

  it("accepts the initial session echo before the full-duplex restore result and waits for its hook", async () => {
    const accepted = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const { bridge, authority, browser } = fixture({
      onOwnerChanged: () => {
        entered.resolve();
        return accepted.promise;
      },
    });
    const [serverProtocol, clientProtocol] = createQueuePair();
    const server = new ChannelServer(serverProtocol, "browser");
    const client = new ChannelClient(clientProtocol);
    server.registerChannel(BROWSER_ACCOUNT_CHANNEL, {
      call: async <T>(_ctx: string, command: string) => {
        expect(command).toBe("restore");
        browser.events.fire({ owner });
        return restoreResult() as T;
      },
      listen: <T>(_ctx: string, event: string) => browser.channel.listen<T>(event),
    });
    cleanups.push(() => {
      client.dispose();
      server.dispose();
    });
    const changes: OAuthSessionState[] = [];
    authority.oauth.onDidChangeSession((state) => changes.push(state));
    const attached = bridge.attach(client);
    await entered.promise;
    expect(authority.getOwner()).toEqual(owner);
    expect(changes).toEqual([]);
    accepted.resolve();
    await attached.ready;
    expect(changes).toEqual(["signed-in"]);
  });

  // restore 期间的 session 只是回声，必须拿到最终结果再接受，不能提前改变 Host。
  it("collects an initial session echo without changing the Host before restore resolves", async () => {
    const hook = vi.fn();
    const { bridge, authority, browser } = fixture({ onOwnerChanged: hook });
    const restored = Promise.withResolvers<BrowserAccountRestoreResult>();
    browser.call.mockImplementationOnce(() => restored.promise);
    const attachment = bridge.attach(browser.client);
    const ready = vi.fn();
    void attachment.ready.then(ready, () => undefined);
    browser.events.fire({ owner });
    await Promise.resolve();
    expect(authority.getOwner()).toBeNull();
    expect(hook).not.toHaveBeenCalled();
    expect(ready).not.toHaveBeenCalled();
    restored.resolve(restoreResult());
    await attachment.ready;
    expect(hook).toHaveBeenCalledExactlyOnceWith(owner);
  });

  it("rejects a conflicting initial echo without letting the pending connection replace the incumbent", async () => {
    const hook = vi.fn();
    const { bridge, authority, browser } = fixture({ onOwnerChanged: hook });
    await bridge.attach(browser.client).ready;
    const acceptedOwner = authority.getOwner();
    const secondBrowser = peer();
    const restored = Promise.withResolvers<BrowserAccountRestoreResult>();
    secondBrowser.call.mockImplementationOnce(() => restored.promise);
    const second = bridge.attach(secondBrowser.client);
    const rejected = expect(second.ready).rejects.toThrow("XCODE_PROTOCOL_INVALID");
    const invalidated: string[] = [];
    second.onDidInvalidate((reason) => invalidated.push(reason));
    secondBrowser.events.fire({ owner: nextOwner });
    expect(authority.getOwner()).toBe(acceptedOwner);
    expect(hook).toHaveBeenCalledExactlyOnceWith(owner);
    restored.resolve(restoreResult());
    await rejected;
    expect(invalidated).toEqual(["unavailable"]);
    expect(authority.getOwner()).toBe(acceptedOwner);
    expect(hook).toHaveBeenCalledTimes(1);
    await expect(authority.getRelayCredential(owner)).resolves.toHaveProperty("token");
  });

  it.each([
    { label: "another user", account: { ...owner, userId: "2" } },
    { label: "the same user with another SID", account: { ...owner, sid: "other-session" } },
    {
      label: "the same user and SID with another generation",
      account: { ...owner, authGeneration: 2 },
    },
    { label: "a signed-out page", account: null },
  ])(
    "rejects ready for $label without changing or exposing the incumbent account",
    async ({ account }) => {
      const hook = vi.fn();
      const { bridge, authority, browser } = fixture({ onOwnerChanged: hook });
      await bridge.attach(browser.client).ready;
      const acceptedOwner = authority.getOwner();
      const otherBrowser = peer(account);
      const other = bridge.attach(otherBrowser.client);
      const invalidated: string[] = [];
      other.onDidInvalidate((reason) => invalidated.push(reason));
      await expect(other.ready).rejects.toThrow("XCODE_BROWSER_ACCOUNT_MISMATCH");
      expect(invalidated).toEqual(["account-mismatch"]);
      expect(authority.getOwner()).toBe(acceptedOwner);
      expect(hook).toHaveBeenCalledExactlyOnceWith(owner);
      // 从未准入的 facade 继承 ready 的拒绝，不能绕过准入发起任何后续反向命令。
      await expect(other.oauth.restoreCachedSessionState()).rejects.toThrow(
        "XCODE_BROWSER_ACCOUNT_MISMATCH",
      );
      await expect(other.oauth.startOAuth("new-api")).rejects.toThrow(
        "XCODE_BROWSER_ACCOUNT_MISMATCH",
      );
      otherBrowser.events.fire({ owner: account });
      other.dispose();
      expect(authority.getOwner()).toBe(acceptedOwner);
      await expect(authority.withControlSession(async (token) => token)).resolves.toBe(
        "test-control",
      );
      await expect(authority.getRelayCredential(owner)).resolves.toHaveProperty("token");
      expect(otherBrowser.call).toHaveBeenCalledExactlyOnceWith("restore", undefined);
      expect(browser.call.mock.calls.map(([command]) => command)).toEqual([
        "restore",
        "control",
        "relay",
      ]);
    },
  );

  // 同会话标签共享唯一 Host owner；增加或移除一个连接不能重复接受或撤销仍在用的账号。
  it("shares one initial owner acceptance and signed-in event across concurrent matching restores", async () => {
    const accepted = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const hook = vi.fn(() => {
      entered.resolve();
      return accepted.promise;
    });
    const { bridge, authority, browser } = fixture({ onOwnerChanged: hook });
    const secondBrowser = peer();
    const changes: OAuthSessionState[] = [];
    authority.oauth.onDidChangeSession((state) => changes.push(state));
    const first = bridge.attach(browser.client);
    const second = bridge.attach(secondBrowser.client);
    const firstReady = vi.fn();
    const secondReady = vi.fn();
    void first.ready.then(firstReady, () => undefined);
    void second.ready.then(secondReady, () => undefined);
    await entered.promise;
    await Promise.resolve();
    await Promise.resolve();
    expect(hook).toHaveBeenCalledExactlyOnceWith(owner);
    expect(changes).toEqual([]);
    expect(firstReady).not.toHaveBeenCalled();
    expect(secondReady).not.toHaveBeenCalled();
    accepted.resolve();
    await Promise.all([first.ready, second.ready]);
    expect(hook).toHaveBeenCalledTimes(1);
    expect(changes).toEqual(["signed-in"]);
    expect(authority.getOwner()).toEqual(owner);
    expect(browser.call).toHaveBeenCalledExactlyOnceWith("restore", undefined);
    expect(secondBrowser.call).toHaveBeenCalledExactlyOnceWith("restore", undefined);
  });

  it("lets B finish the shared acceptance when initiating A closes while the hook is pending", async () => {
    const accepted = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const hook = vi.fn(() => {
      entered.resolve();
      return accepted.promise;
    });
    const { bridge, authority, browser } = fixture({ onOwnerChanged: hook });
    const first = bridge.attach(browser.client);
    const firstRejected = expect(first.ready).rejects.toThrow("XCODE_STALE_OWNER");
    const second = bridge.attach(peer().client);
    const secondReady = vi.fn();
    void second.ready.then(secondReady, () => undefined);
    await entered.promise;
    await Promise.resolve();
    first.dispose();
    expect(hook).toHaveBeenCalledExactlyOnceWith(owner);
    expect(secondReady).not.toHaveBeenCalled();
    accepted.resolve();
    await Promise.all([firstRejected, second.ready]);
    expect(authority.isCurrent(owner)).toBe(true);
    expect(hook).toHaveBeenCalledTimes(1);
    await expect(authority.getRelayCredential(owner)).resolves.toHaveProperty("token");
  });

  it("admits C with its own owner only after the incumbent's final member leaves", async () => {
    const hook = vi.fn();
    const { bridge, authority, browser } = fixture({ onOwnerChanged: hook });
    const first = bridge.attach(browser.client);
    const second = bridge.attach(peer().client);
    await Promise.all([first.ready, second.ready]);
    const thirdBrowser = peer(nextOwner);
    const rejected = bridge.attach(thirdBrowser.client);
    await expect(rejected.ready).rejects.toThrow("XCODE_BROWSER_ACCOUNT_MISMATCH");
    first.dispose();
    expect(authority.isCurrent(owner)).toBe(true);
    second.dispose();
    expect(authority.getOwner()).toBeNull();
    const retried = bridge.attach(thirdBrowser.client);
    await retried.ready;
    expect(authority.getOwner()).toEqual(nextOwner);
    rejected.dispose();
    browser.events.fire({ owner });
    expect(authority.getOwner()).toEqual(nextOwner);
    expect(hook.mock.calls).toEqual([[owner], [null], [nextOwner]]);
    await expect(authority.getRelayCredential(nextOwner)).resolves.toHaveProperty("token");
    expect(thirdBrowser.call.mock.calls.map(([command]) => command)).toEqual([
      "restore",
      "restore",
      "relay",
    ]);
  });

  it("keeps a matching source usable after the first tab closes and clears only on final detach", async () => {
    const hook = vi.fn();
    const { bridge, authority, browser } = fixture({ onOwnerChanged: hook });
    const first = bridge.attach(browser.client);
    const secondBrowser = peer();
    const second = bridge.attach(secondBrowser.client);
    await Promise.all([first.ready, second.ready]);
    const acceptedOwner = authority.getOwner();
    const changes: OAuthSessionState[] = [];
    authority.oauth.onDidChangeSession((state) => changes.push(state));
    first.dispose();
    first.dispose();
    expect(authority.getOwner()).toBe(acceptedOwner);
    expect(hook).toHaveBeenCalledExactlyOnceWith(owner);
    expect(changes).toEqual([]);
    await expect(authority.withControlSession(async (token) => token)).resolves.toBe(
      "test-control",
    );
    await expect(authority.getRelayCredential(owner)).resolves.toHaveProperty(
      "token",
      "sk-test-relay",
    );
    expect(browser.call).toHaveBeenCalledExactlyOnceWith("restore", undefined);
    expect(secondBrowser.call.mock.calls.map(([command]) => command)).toEqual([
      "restore",
      "control",
      "relay",
    ]);
    second.dispose();
    expect(authority.getOwner()).toBeNull();
    expect(hook.mock.calls).toEqual([[owner], [null]]);
    await vi.waitFor(() => expect(changes).toEqual(["signed-out"]));
    bridge.dispose();
    expect(() => bridge.attach(browser.client)).toThrow("XCODE_BROWSER_ACCOUNT_DISPOSED");
  });

  it.each(["control", "relay"])(
    "keeps B's pending %s current when matching A closes without changing owner revision",
    async (command) => {
      const hook = vi.fn();
      const { bridge, authority, browser } = fixture({ onOwnerChanged: hook });
      const first = bridge.attach(browser.client);
      await first.ready;
      const secondBrowser = peer();
      await bridge.attach(secondBrowser.client).ready;
      const acceptedOwner = authority.getOwner();
      const response = Promise.withResolvers<unknown>();
      const entered = Promise.withResolvers<void>();
      secondBrowser.call.mockImplementationOnce(() => {
        entered.resolve();
        return response.promise;
      });
      const action = vi.fn(async (token: string) => token);
      const reading =
        command === "control"
          ? authority.withControlSession(action)
          : authority.getRelayCredential(owner);
      await entered.promise;
      first.dispose();
      expect(authority.getOwner()).toBe(acceptedOwner);
      expect(hook).toHaveBeenCalledExactlyOnceWith(owner);
      const credential =
        command === "control"
          ? { owner, accessToken: "surviving-b-control" }
          : { token: "sk-surviving-b-relay", expiresAt: Date.now() + 60_000 };
      response.resolve(credential);
      await expect(reading).resolves.toEqual(
        command === "control" ? "surviving-b-control" : credential,
      );
      expect(action).toHaveBeenCalledTimes(command === "control" ? 1 : 0);
      expect(browser.call).toHaveBeenCalledExactlyOnceWith("restore", undefined);
    },
  );

  it("rejects a late initial restore after that source closes while a matching source remains", async () => {
    const hook = vi.fn();
    const { bridge, authority, browser } = fixture({ onOwnerChanged: hook });
    const pending = Promise.withResolvers<BrowserAccountRestoreResult>();
    browser.call.mockImplementationOnce(() => pending.promise);
    const first = bridge.attach(browser.client);
    const rejected = expect(first.ready).rejects.toThrow("XCODE_STALE_OWNER");
    const second = bridge.attach(peer().client);
    await second.ready;
    const acceptedOwner = authority.getOwner();
    first.dispose();
    pending.resolve(restoreResult());
    await rejected;
    expect(authority.getOwner()).toBe(acceptedOwner);
    expect(hook).toHaveBeenCalledExactlyOnceWith(owner);
    await expect(authority.getRelayCredential(owner)).resolves.toHaveProperty("token");
  });

  it.each(["control", "relay"])(
    "rejects late %s from closed A without using surviving B or executing the control action",
    async (command) => {
      const { bridge, authority, browser } = fixture();
      const first = bridge.attach(browser.client);
      await first.ready;
      const response = Promise.withResolvers<unknown>();
      browser.call.mockImplementationOnce(() => response.promise);
      const action = vi.fn(async () => "completed");
      const reading =
        command === "control"
          ? authority.withControlSession(action)
          : authority.getRelayCredential(owner);
      const rejected = expect(reading).rejects.toThrow("XCODE_STALE_OWNER");
      const secondBrowser = peer();
      await bridge.attach(secondBrowser.client).ready;
      first.dispose();
      response.resolve(
        command === "control"
          ? { owner, accessToken: "late-control" }
          : { token: "sk-late-relay", expiresAt: Date.now() + 60_000 },
      );
      await rejected;
      expect(action).not.toHaveBeenCalled();
      expect(secondBrowser.call).toHaveBeenCalledExactlyOnceWith("restore", undefined);
      expect(authority.isCurrent(owner)).toBe(true);
      await expect(authority.withControlSession(async (token) => token)).resolves.toBe(
        "test-control",
      );
      await expect(authority.getRelayCredential(owner)).resolves.toHaveProperty("token");
    },
  );

  it("fails both concurrent ready promises closed when their shared owner hook rejects", async () => {
    const accepted = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const hook = vi.fn(() => {
      entered.resolve();
      return accepted.promise;
    });
    const { bridge, authority, browser } = fixture({ onOwnerChanged: hook });
    const secondBrowser = peer();
    const first = bridge.attach(browser.client);
    const second = bridge.attach(secondBrowser.client);
    const firstRejected = expect(first.ready).rejects.toThrow("XCODE_BACKEND_UNAVAILABLE");
    const secondRejected = expect(second.ready).rejects.toThrow("XCODE_BACKEND_UNAVAILABLE");
    const firstInvalidated: string[] = [];
    const secondInvalidated: string[] = [];
    first.onDidInvalidate((reason) => firstInvalidated.push(reason));
    second.onDidInvalidate((reason) => secondInvalidated.push(reason));
    const changes: OAuthSessionState[] = [];
    authority.oauth.onDidChangeSession((state) => changes.push(state));
    await entered.promise;
    await Promise.resolve();
    expect(hook).toHaveBeenCalledExactlyOnceWith(owner);
    accepted.reject(Object.assign(new Error("hook secret"), { code: "XCODE_BACKEND_UNAVAILABLE" }));
    await Promise.all([firstRejected, secondRejected]);
    expect(authority.getOwner()).toBeNull();
    expect(authority.isCurrent(owner)).toBe(false);
    expect(changes).not.toContain("signed-in");
    expect(firstInvalidated).toEqual(["unavailable"]);
    expect(secondInvalidated).toEqual(["unavailable"]);
    const action = vi.fn();
    await expect(authority.withControlSession(action)).rejects.toThrow();
    expect(action).not.toHaveBeenCalled();
    browser.events.fire({ owner });
    secondBrowser.events.fire({ owner });
    expect(authority.getOwner()).toBeNull();
  });

  it("routes B login and cancellation only to B while both pages are signed out", async () => {
    const { bridge, authority, browser } = fixture({}, null);
    const secondBrowser = peer(null);
    const first = bridge.attach(browser.client);
    const second = bridge.attach(secondBrowser.client);
    await Promise.all([first.ready, second.ready]);
    const started = {
      provider: "new-api",
      purpose: "primary-account",
      authorizeUrl: `${origin}/oauth/authorize?state=only-b`,
      state: "only-b",
    };
    secondBrowser.call.mockResolvedValueOnce({ ...started, refreshToken: "must-not-escape" });
    await expect(second.oauth.startOAuth("new-api")).resolves.toEqual(started);
    await second.oauth.cancelPending("new-api");
    expect(browser.call).toHaveBeenCalledExactlyOnceWith("restore", undefined);
    expect(secondBrowser.call.mock.calls).toEqual([
      ["restore", undefined],
      ["oauth", { method: "startOAuth", args: ["new-api"] }],
      ["oauth", { method: "cancelPending", args: ["new-api"] }],
    ]);
    first.dispose();
    secondBrowser.events.fire({ owner });
    await vi.waitFor(() => expect(authority.isCurrent(owner)).toBe(true));
    expect(browser.call).toHaveBeenCalledExactlyOnceWith("restore", undefined);
  });

  it("does not change owner revision or invalidate either tab for same-owner token refresh events", async () => {
    const hook = vi.fn();
    const { bridge, authority, browser } = fixture({ onOwnerChanged: hook });
    const first = bridge.attach(browser.client);
    const secondBrowser = peer();
    const second = bridge.attach(secondBrowser.client);
    await Promise.all([first.ready, second.ready]);
    const acceptedOwner = authority.getOwner();
    const invalidated = vi.fn();
    first.onDidInvalidate(invalidated);
    second.onDidInvalidate(invalidated);
    const changed = vi.fn();
    authority.oauth.onDidChangeSession(changed);
    secondBrowser.call.mockImplementationOnce(async (command, arg) => {
      expect(command).toBe("oauth");
      expect(arg).toEqual({ method: "refreshToken", args: ["new-api"] });
      secondBrowser.events.fire({ owner: { ...owner } });
    });
    await second.oauth.refreshToken("new-api");
    browser.events.fire({ owner: { ...owner } });
    expect(authority.getOwner()).toBe(acceptedOwner);
    expect(hook).toHaveBeenCalledExactlyOnceWith(owner);
    expect(invalidated).not.toHaveBeenCalled();
    expect(changed).not.toHaveBeenCalled();
    expect(browser.call).toHaveBeenCalledExactlyOnceWith("restore", undefined);
    await expect(authority.getRelayCredential(owner)).resolves.toHaveProperty("token");
  });

  it("routes B's cached identity, metadata, callback and refresh through B with public projections", async () => {
    const { bridge, authority, browser } = fixture();
    await bridge.attach(browser.client).ready;
    const secondBrowser = peer();
    const second = bridge.attach(secondBrowser.client);
    await second.ready;
    const acceptedOwner = authority.getOwner();
    const userInfo = { id: owner.userId, username: "only-b", displayName: "Only B" };
    secondBrowser.call.mockResolvedValueOnce({
      ...restoreResult(),
      session: {
        status: "authenticated",
        userInfo: { ...userInfo, refreshToken: "secret" },
        refreshToken: "secret",
      },
      refreshToken: "secret",
    });
    await expect(second.oauth.restoreCachedSessionState()).resolves.toEqual({
      status: "authenticated",
      userInfo,
    });
    secondBrowser.call.mockResolvedValueOnce({
      owner,
      session: { status: "authenticated", userInfo },
    });
    await expect(second.oauth.restoreCachedSession()).resolves.toEqual(userInfo);
    const metadata = [{ id: "new-api", displayName: "Aiscoo", enabled: true, order: 0 }];
    secondBrowser.call.mockResolvedValueOnce([{ ...metadata[0], refreshToken: "secret" }]);
    await expect(second.oauth.getProviders()).resolves.toEqual(metadata);
    secondBrowser.call.mockResolvedValueOnce("new-api");
    await expect(second.oauth.getActiveProvider()).resolves.toBe("new-api");
    secondBrowser.call.mockResolvedValueOnce({ ...userInfo, refreshToken: "secret" });
    await expect(second.oauth.restoreSession()).resolves.toEqual(userInfo);
    secondBrowser.call.mockResolvedValueOnce({
      kind: "session",
      provider: "new-api",
      userInfo: { ...userInfo, refreshToken: "secret" },
      refreshToken: "secret",
    });
    await expect(
      second.oauth.handleCallback("http://127.0.0.1:5173/oauth/callback?code=synthetic&state=b"),
    ).resolves.toEqual({
      kind: "session",
      provider: "new-api",
      userInfo,
    });
    secondBrowser.call.mockResolvedValueOnce({ refreshToken: "secret" });
    await expect(second.oauth.refreshToken("new-api")).resolves.toBeUndefined();
    expect(authority.getOwner()).toBe(acceptedOwner);
    expect(browser.call).toHaveBeenCalledExactlyOnceWith("restore", undefined);
    expect(secondBrowser.call.mock.calls).toEqual([
      ["restore", undefined],
      ["restore", undefined],
      ["restore", undefined],
      ["oauth", { method: "getProviders", args: [] }],
      ["oauth", { method: "getActiveProvider", args: [] }],
      ["oauth", { method: "restoreSession", args: [] }],
      [
        "oauth",
        {
          method: "handleCallback",
          args: ["http://127.0.0.1:5173/oauth/callback?code=synthetic&state=b"],
        },
      ],
      ["oauth", { method: "refreshToken", args: ["new-api"] }],
    ]);
  });

  it("keeps B's pending OAuth alive when A closes and does not transfer A's cancellation", async () => {
    const { bridge, browser } = fixture({}, null);
    const secondBrowser = peer(null);
    const first = bridge.attach(browser.client);
    const second = bridge.attach(secondBrowser.client);
    await Promise.all([first.ready, second.ready]);
    const response = Promise.withResolvers<unknown>();
    const entered = Promise.withResolvers<void>();
    secondBrowser.call.mockImplementationOnce(() => {
      entered.resolve();
      return response.promise;
    });
    const login = second.oauth.startOAuth("new-api");
    await entered.promise;
    first.dispose();
    await expect(first.oauth.cancelPending("new-api")).rejects.toThrow("XCODE_STALE_OWNER");
    const started = {
      provider: "new-api",
      purpose: "primary-account",
      authorizeUrl: `${origin}/oauth/authorize?state=pending-b`,
      state: "pending-b",
    };
    response.resolve(started);
    await expect(login).resolves.toEqual(started);
    expect(browser.call).toHaveBeenCalledExactlyOnceWith("restore", undefined);
    expect(secondBrowser.call.mock.calls).toEqual([
      ["restore", undefined],
      ["oauth", { method: "startOAuth", args: ["new-api"] }],
    ]);
  });

  it("rejects A's late OAuth after A closes while leaving B's facade usable", async () => {
    const { bridge, browser } = fixture();
    const first = bridge.attach(browser.client);
    await first.ready;
    const response = Promise.withResolvers<unknown>();
    const entered = Promise.withResolvers<void>();
    browser.call.mockImplementationOnce(() => {
      entered.resolve();
      return response.promise;
    });
    const login = first.oauth.startOAuth("new-api");
    const rejected = expect(login).rejects.toThrow("XCODE_STALE_OWNER");
    await entered.promise;
    const secondBrowser = peer();
    const second = bridge.attach(secondBrowser.client);
    await second.ready;
    first.dispose();
    response.resolve({
      provider: "new-api",
      purpose: "primary-account",
      authorizeUrl: `${origin}/oauth/authorize?state=closed-a`,
      state: "closed-a",
    });
    await rejected;
    await expect(first.oauth.cancelPending("new-api")).rejects.toThrow("XCODE_STALE_OWNER");
    await second.oauth.cancelPending("new-api");
    expect(secondBrowser.call.mock.calls).toEqual([
      ["restore", undefined],
      ["oauth", { method: "cancelPending", args: ["new-api"] }],
    ]);
  });

  it.each([
    { label: "logout", account: null },
    { label: "account switch", account: nextOwner },
    { label: "SID switch for the same user", account: { ...owner, sid: "session-replaced" } },
    {
      label: "generation switch for the same user and SID",
      account: { ...owner, authGeneration: 2 },
    },
  ])(
    "revokes other old members on $label and ignores their late session events",
    async ({ account }) => {
      const hook = vi.fn();
      const { bridge, authority, browser } = fixture({ onOwnerChanged: hook });
      const first = bridge.attach(browser.client);
      const secondBrowser = peer();
      const second = bridge.attach(secondBrowser.client);
      await Promise.all([first.ready, second.ready]);
      const invalidated: string[] = [];
      second.onDidInvalidate((reason) => invalidated.push(reason));
      const changes: OAuthSessionState[] = [];
      authority.oauth.onDidChangeSession((state) => changes.push(state));
      browser.events.fire({ owner: account });
      expect(authority.isCurrent(owner)).toBe(false);
      expect(authority.getOwner()).toEqual(account);
      expect(hook.mock.calls).toEqual([[owner], [account]]);
      expect(invalidated).toEqual(["owner-changed"]);
      secondBrowser.events.fire({ owner });
      await expect(second.oauth.refreshToken("new-api")).rejects.toThrow("XCODE_STALE_OWNER");
      second.dispose();
      await vi.waitFor(() => expect(changes).toEqual([account ? "signed-in" : "signed-out"]));
      expect(authority.getOwner()).toEqual(account);
      expect(hook.mock.calls).toEqual([[owner], [account]]);
      expect(secondBrowser.call).toHaveBeenCalledExactlyOnceWith("restore", undefined);
      if (account) {
        await expect(authority.getRelayCredential(account)).resolves.toHaveProperty("token");
      }
    },
  );

  it("fails closed when an admitted source's replacement owner hook rejects", async () => {
    const hook = vi.fn((account: NewApiOwner | null) => {
      if (account?.sid === nextOwner.sid)
        throw Object.assign(new Error("hook secret"), { code: "XCODE_BACKEND_UNAVAILABLE" });
    });
    const { bridge, authority, browser } = fixture({ onOwnerChanged: hook });
    const first = bridge.attach(browser.client);
    const secondBrowser = peer();
    const second = bridge.attach(secondBrowser.client);
    await Promise.all([first.ready, second.ready]);
    const invalidated: string[] = [];
    first.onDidInvalidate((reason) => invalidated.push(reason));
    browser.events.fire({ owner: nextOwner });
    await vi.waitFor(() => expect(invalidated).toEqual(["unavailable"]));
    expect(authority.getOwner()).toBeNull();
    expect(authority.isCurrent(owner)).toBe(false);
    expect(authority.isCurrent(nextOwner)).toBe(false);
    secondBrowser.events.fire({ owner });
    browser.events.fire({ owner: nextOwner });
    expect(authority.getOwner()).toBeNull();
    await expect(second.oauth.getActiveProvider()).rejects.toThrow("XCODE_STALE_OWNER");
  });

  // 旧注销 hook 的迟到结算只能失效其捕获修订，不能关闭同一连接后来已接受的 O2。
  it.each(["resolve", "reject"] as const)(
    "preserves accepted O2 on the same source when its superseded null owner hook settles by %s",
    async (settlement) => {
      const nullHook = Promise.withResolvers<void>();
      const nullEntered = Promise.withResolvers<void>();
      const nextHook = Promise.withResolvers<void>();
      const nextEntered = Promise.withResolvers<void>();
      const hook = vi.fn((account: NewApiOwner | null) => {
        if (account === null) {
          nullEntered.resolve();
          return nullHook.promise;
        }
        if (account.sid === nextOwner.sid) {
          nextEntered.resolve();
          return nextHook.promise;
        }
      });
      const { bridge, authority, browser } = fixture({ onOwnerChanged: hook });
      const attachment = bridge.attach(browser.client);
      await attachment.ready;
      const invalidated: string[] = [];
      attachment.onDidInvalidate((reason) => invalidated.push(reason));
      const changes: OAuthSessionState[] = [];
      const nextAccepted = Promise.withResolvers<OAuthSessionState>();
      authority.oauth.onDidChangeSession((state) => {
        changes.push(state);
        nextAccepted.resolve(state);
      });
      browser.events.fire({ owner: null });
      await nullEntered.promise;
      expect(authority.getOwner()).toBeNull();
      expect(changes).toEqual([]);
      browser.events.fire({ owner: nextOwner });
      await nextEntered.promise;
      expect(authority.getOwner()).toEqual(nextOwner);
      expect(changes).toEqual([]);
      nextHook.resolve();
      expect(await nextAccepted.promise).toBe("signed-in");
      const acceptedOwner = authority.getOwner();
      expect(hook.mock.calls).toEqual([[owner], [null], [nextOwner]]);
      expect(invalidated).toEqual([]);
      if (settlement === "resolve") nullHook.resolve();
      else
        nullHook.reject(
          Object.assign(new Error("old cleanup failed"), { code: "XCODE_BACKEND_UNAVAILABLE" }),
        );
      // 排空旧 hook 的 Promise 结算链，检查迟到清理完成后的连接和账号事实。
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(authority.getOwner()).toBe(acceptedOwner);
      expect(authority.isCurrent(nextOwner)).toBe(true);
      expect(authority.isCurrent(owner)).toBe(false);
      expect(invalidated).toEqual([]);
      expect(changes).toEqual(["signed-in"]);
      expect(hook.mock.calls).toEqual([[owner], [null], [nextOwner]]);
      browser.call.mockImplementation(async (command, arg) => {
        if (command === "oauth") {
          expect(arg).toEqual({ method: "getActiveProvider", args: [] });
          return "new-api";
        }
        expect(command).toBe("control");
        expect(arg).toEqual({ owner: nextOwner });
        return { owner: nextOwner, accessToken: "accepted-o2-control" };
      });
      await expect(attachment.oauth.getActiveProvider()).resolves.toBe("new-api");
      const action = vi.fn(async (token: string, captured: NewApiOwner) => {
        expect(captured).toEqual(nextOwner);
        return token;
      });
      await expect(authority.withControlSession(action)).resolves.toBe("accepted-o2-control");
      expect(action).toHaveBeenCalledTimes(1);
      expect(browser.call.mock.calls.map(([command]) => command)).toEqual([
        "restore",
        "oauth",
        "control",
      ]);
      expect(authority.getOwner()).toBe(acceptedOwner);
      expect(invalidated).toEqual([]);
      expect(hook.mock.calls).toEqual([[owner], [null], [nextOwner]]);
    },
  );

  it("invalidates an old read before the async owner hook completes", async () => {
    const accepted = Promise.withResolvers<void>();
    const hook = vi.fn((account: NewApiOwner | null) =>
      account?.sid === nextOwner.sid ? accepted.promise : undefined,
    );
    const { bridge, authority, browser } = fixture({ onOwnerChanged: hook });
    await bridge.attach(browser.client).ready;
    const changes: OAuthSessionState[] = [];
    authority.oauth.onDidChangeSession((state) => changes.push(state));
    const response = Promise.withResolvers<unknown>();
    browser.call.mockImplementationOnce(() => response.promise);
    const reading = authority.getRelayCredential(owner);
    const rejected = expect(reading).rejects.toThrow("XCODE_STALE_OWNER");
    browser.events.fire({ owner: nextOwner });
    expect(authority.isCurrent(owner)).toBe(false);
    expect(hook).toHaveBeenLastCalledWith(nextOwner);
    expect(changes).toEqual([]);
    response.resolve({ token: "sk-old-relay", expiresAt: Date.now() + 60_000 });
    await rejected;
    accepted.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(changes).toEqual(["signed-in"]);
  });

  it("fences the control action result after the action awaits", async () => {
    const { bridge, authority, browser } = fixture();
    await bridge.attach(browser.client).ready;
    const started = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<string>();
    const reading = authority.withControlSession(async (token, captured) => {
      expect(token).toBe("test-control");
      expect(captured).toEqual(owner);
      started.resolve();
      return finished.promise;
    });
    const rejected = expect(reading).rejects.toThrow("XCODE_STALE_OWNER");
    await started.promise;
    browser.events.fire({ owner: nextOwner });
    finished.resolve("late result");
    await rejected;
  });

  it("invalidates synchronously before the detach hook and delays signed-out until acceptance", async () => {
    const accepted = Promise.withResolvers<void>();
    const { bridge, authority, browser } = fixture({
      onOwnerChanged: (account) => {
        if (!account) {
          expect(authority.getOwner()).toBeNull();
          return accepted.promise;
        }
      },
    });
    const attached = bridge.attach(browser.client);
    await attached.ready;
    const changes: OAuthSessionState[] = [];
    authority.oauth.onDidChangeSession((state) => changes.push(state));
    attached.dispose();
    expect(authority.getOwner()).toBeNull();
    expect(changes).toEqual([]);
    accepted.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(changes).toEqual(["signed-out"]);
  });

  it("restores again for cached reads and projects away credential fields", async () => {
    const { bridge, authority, browser } = fixture();
    await bridge.attach(browser.client).ready;
    browser.call.mockResolvedValueOnce({
      ...restoreResult(),
      session: {
        status: "authenticated",
        userInfo: { id: "1", username: "user", displayName: "User", refreshToken: "never-return" },
        refreshToken: "never-return",
      },
      refreshToken: "never-return",
    });
    expect(await authority.oauth.restoreCachedSessionState()).toEqual(restoreResult().session);
    browser.call.mockResolvedValueOnce({
      token: "sk-test-relay",
      expiresAt: Date.now() + 60_000,
      refreshToken: "never-return",
    });
    expect(Object.keys(await authority.getRelayCredential(owner)).sort()).toEqual([
      "expiresAt",
      "token",
    ]);
    browser.call.mockResolvedValueOnce({ refreshToken: "never-return" });
    expect(await authority.oauth.refreshToken()).toBeUndefined();
    expect(browser.call).toHaveBeenLastCalledWith("oauth", { method: "refreshToken", args: [] });
  });

  it.each([
    { ...owner, origin: `${origin}/` },
    { ...owner, origin: "https://another.example.test" },
    { ...owner, userId: "0" },
    { ...owner, sid: " " },
    { ...owner, authGeneration: 0 },
    { ...owner, authGeneration: Number.MAX_SAFE_INTEGER + 1 },
    { ...owner, refreshToken: "must-not-retain" },
  ])("rejects invalid owner projection %#", async (invalidOwner) => {
    const { bridge, authority, browser } = fixture();
    browser.call.mockResolvedValueOnce({ ...restoreResult(), owner: invalidOwner });
    await expect(bridge.attach(browser.client).ready).rejects.toThrow("XCODE_PROTOCOL_INVALID");
    expect(authority.getOwner()).toBeNull();
  });

  it("rejects a control response for another owner and expired relay credentials", async () => {
    const { bridge, authority, browser } = fixture();
    await bridge.attach(browser.client).ready;
    browser.call.mockResolvedValueOnce({ owner: nextOwner, accessToken: "never-release" });
    const action = vi.fn();
    await expect(authority.withControlSession(action)).rejects.toThrow("XCODE_STALE_OWNER");
    expect(action).not.toHaveBeenCalled();
    browser.call.mockResolvedValueOnce({ token: "sk-expired", expiresAt: 1 });
    await expect(authority.getRelayCredential(owner)).rejects.toThrow("XCODE_SESSION_INVALID");
  });

  it("delegates one confirmed control-expiry refresh to the browser before retrying", async () => {
    const { bridge, authority, browser } = fixture();
    await bridge.attach(browser.client).ready;
    const expired = Object.assign(new Error("remote secret"), { code: "XCODE_ACCESS_EXPIRED" });
    const action = vi.fn().mockRejectedValueOnce(expired).mockResolvedValueOnce("retried");
    await expect(authority.withControlSession(action)).resolves.toBe("retried");
    expect(browser.call.mock.calls.map(([command]) => command)).toEqual([
      "restore",
      "control",
      "oauth",
      "control",
    ]);
    expect(browser.call.mock.calls[2]).toEqual([
      "oauth",
      { method: "refreshToken", args: ["new-api"] },
    ]);
    expect(action).toHaveBeenCalledTimes(2);
    browser.call.mockClear();
    await expect(authority.withControlSession(vi.fn().mockRejectedValue(expired))).rejects.toThrow(
      "XCODE_ACCESS_EXPIRED",
    );
    expect(browser.call.mock.calls.map(([command]) => command)).toEqual([
      "control",
      "oauth",
      "control",
    ]);
  });

  it("does not retry a control action if its browser refresh completes after owner change", async () => {
    const { bridge, authority, browser } = fixture();
    await bridge.attach(browser.client).ready;
    const refresh = Promise.withResolvers<unknown>();
    const started = Promise.withResolvers<void>();
    browser.call.mockImplementation(async (command) => {
      if (command === "control") return { owner, accessToken: "test-control" };
      if (command === "oauth") {
        started.resolve();
        return refresh.promise;
      }
      throw new Error("unexpected command");
    });
    const action = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("expired"), { code: "XCODE_ACCESS_EXPIRED" }));
    const reading = authority.withControlSession(action);
    const rejected = expect(reading).rejects.toThrow("XCODE_STALE_OWNER");
    await started.promise;
    browser.events.fire({ owner: nextOwner });
    refresh.resolve(undefined);
    await rejected;
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("does not retry on B when A closes during A's control-expiry refresh", async () => {
    const { bridge, authority, browser } = fixture();
    const first = bridge.attach(browser.client);
    await first.ready;
    const refresh = Promise.withResolvers<unknown>();
    const entered = Promise.withResolvers<void>();
    browser.call.mockImplementation(async (command) => {
      if (command === "control") return { owner, accessToken: "test-control" };
      if (command === "oauth") {
        entered.resolve();
        return refresh.promise;
      }
      throw new Error("unexpected command");
    });
    const action = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("expired"), { code: "XCODE_ACCESS_EXPIRED" }));
    const reading = authority.withControlSession(action);
    const rejected = expect(reading).rejects.toThrow("XCODE_STALE_OWNER");
    await entered.promise;
    const secondBrowser = peer();
    await bridge.attach(secondBrowser.client).ready;
    first.dispose();
    refresh.resolve(undefined);
    await rejected;
    expect(action).toHaveBeenCalledTimes(1);
    expect(secondBrowser.call).toHaveBeenCalledExactlyOnceWith("restore", undefined);
    expect(authority.isCurrent(owner)).toBe(true);
    await expect(authority.getRelayCredential(owner)).resolves.toHaveProperty("token");
  });

  it.each(["XCODE_SESSION_INVALID", "XCODE_CREDENTIAL_SCOPE_DENIED"])(
    "revokes matching B on Native-confirmed %s while notifying only captured A",
    async (code) => {
      const accepted = Promise.withResolvers<void>();
      const notified = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const hook = vi.fn((account: NewApiOwner | null) =>
        account === null ? accepted.promise : undefined,
      );
      const { bridge, authority, browser } = fixture({ onOwnerChanged: hook });
      await bridge.attach(browser.client).ready;
      browser.call.mockImplementation(async (command, arg) => {
        if (command === "control") return { owner, accessToken: "test-control" };
        if (command === "invalidateCredential") {
          expect(authority.getOwner()).toBeNull();
          expect(arg).toEqual({ owner });
          entered.resolve();
          return notified.promise;
        }
        throw new Error("unexpected command");
      });
      const nativeStarted = Promise.withResolvers<void>();
      const failure = Promise.withResolvers<never>();
      const reading = authority.withControlSession(async () => {
        nativeStarted.resolve();
        return failure.promise;
      });
      const outcome = reading.catch((error: unknown) => error);
      await nativeStarted.promise;
      const secondBrowser = peer();
      const second = bridge.attach(secondBrowser.client);
      await second.ready;
      const invalidated: string[] = [];
      second.onDidInvalidate((reason) => invalidated.push(reason));
      failure.reject(Object.assign(new Error("native secret"), { code }));
      await entered.promise;
      expect(hook.mock.calls).toEqual([[owner], [null]]);
      expect(invalidated).toEqual(["owner-changed"]);
      secondBrowser.events.fire({ owner });
      expect(authority.getOwner()).toBeNull();
      await expect(second.oauth.restoreCachedSessionState()).rejects.toThrow("XCODE_STALE_OWNER");
      await expect(authority.getRelayCredential(owner)).rejects.toThrow("XCODE_STALE_OWNER");
      expect(secondBrowser.call).toHaveBeenCalledExactlyOnceWith("restore", undefined);
      accepted.resolve();
      notified.resolve();
      expect(await outcome).toMatchObject({ code, message: code });
      expect(browser.call.mock.calls.map(([command]) => command)).toEqual([
        "restore",
        "control",
        "invalidateCredential",
      ]);
    },
  );

  it.each(["XCODE_SESSION_INVALID", "XCODE_CREDENTIAL_SCOPE_DENIED"])(
    "invalidates confirmed %s before awaiting the hook or browser and blocks relay",
    async (code) => {
      const accepted = Promise.withResolvers<void>();
      const notified = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const { bridge, authority, browser } = fixture({
        onOwnerChanged: (next) => (next === null ? accepted.promise : undefined),
      });
      await bridge.attach(browser.client).ready;
      browser.call.mockImplementation(async (command, arg) => {
        if (command === "control") return { owner, accessToken: "test-control" };
        if (command === "invalidateCredential") {
          expect(authority.getOwner()).toBeNull();
          expect(authority.isCurrent(owner)).toBe(false);
          expect(arg).toEqual({ owner });
          browser.events.fire({ owner: null });
          entered.resolve();
          return notified.promise;
        }
        throw new Error("unexpected command");
      });
      const reading = authority.withControlSession(async () => {
        throw Object.assign(new Error("untrusted native details"), { code });
      });
      const outcome = reading.catch((error: unknown) => error);
      await vi.waitFor(() => expect(authority.getOwner()).toBeNull());
      await entered.promise;
      await expect(authority.getRelayCredential(owner)).rejects.toThrow("XCODE_STALE_OWNER");
      accepted.resolve();
      notified.resolve();
      expect(await outcome).toMatchObject({ code, message: code });
      expect(browser.call.mock.calls.map(([command]) => command)).toEqual([
        "restore",
        "control",
        "invalidateCredential",
      ]);
    },
  );

  it.each(["XCODE_SESSION_INVALID", "XCODE_CREDENTIAL_SCOPE_DENIED"])(
    "does not invalidate a replacement owner for a late confirmed %s",
    async (code) => {
      const { bridge, authority, browser } = fixture();
      await bridge.attach(browser.client).ready;
      const entered = Promise.withResolvers<void>();
      const result = Promise.withResolvers<never>();
      const reading = authority.withControlSession(async () => {
        entered.resolve();
        return result.promise;
      });
      const rejected = expect(reading).rejects.toThrow("XCODE_STALE_OWNER");
      await entered.promise;
      browser.events.fire({ owner: nextOwner });
      result.reject(Object.assign(new Error(code), { code }));
      await rejected;
      expect(authority.isCurrent(nextOwner)).toBe(true);
      expect(browser.call.mock.calls.map(([command]) => command)).toEqual(["restore", "control"]);
    },
  );

  it("keeps replacement ownership when browser invalidation completes late", async () => {
    const { bridge, authority, browser } = fixture();
    const attached = bridge.attach(browser.client);
    await attached.ready;
    const entered = Promise.withResolvers<void>();
    const completed = Promise.withResolvers<void>();
    browser.call.mockImplementation(async (command) => {
      if (command === "control") return { owner, accessToken: "test-control" };
      if (command === "invalidateCredential") {
        entered.resolve();
        return completed.promise;
      }
      throw new Error("unexpected command");
    });
    const reading = authority.withControlSession(async () => {
      throw Object.assign(new Error("revoked"), { code: "XCODE_SESSION_INVALID" });
    });
    const rejected = expect(reading).rejects.toThrow("XCODE_STALE_OWNER");
    await entered.promise;
    attached.dispose();
    await bridge.attach(peer().client).ready;
    completed.resolve();
    await rejected;
    expect(authority.isCurrent(owner)).toBe(true);
  });

  it("notifies the captured browser and remains invalid when owner cleanup rejects", async () => {
    const { bridge, authority, browser } = fixture({
      onOwnerChanged: (next) => {
        if (next === null)
          throw Object.assign(new Error("cleanup rejected"), { code: "XCODE_BACKEND_UNAVAILABLE" });
      },
    });
    const attachment = bridge.attach(browser.client);
    await attachment.ready;
    const invalidated: string[] = [];
    attachment.onDidInvalidate((reason) => invalidated.push(reason));
    browser.call.mockImplementation(async (command, arg) => {
      if (command === "control") return { owner, accessToken: "test-control" };
      if (command === "invalidateCredential") {
        expect(arg).toEqual({ owner });
        return;
      }
      throw new Error("unexpected command");
    });
    await expect(
      authority.withControlSession(async () => {
        throw Object.assign(new Error("revoked"), { code: "XCODE_SESSION_INVALID" });
      }),
    ).rejects.toThrow("XCODE_BACKEND_UNAVAILABLE");
    expect(authority.isCurrent(owner)).toBe(false);
    expect(invalidated).toEqual(["unavailable"]);
    await expect(attachment.oauth.getActiveProvider()).rejects.toThrow("XCODE_STALE_OWNER");
    // 失败 hook 已撤销包括 null owner 在内的已验证连接，后续新读取没有凭据来源。
    await expect(authority.getRelayCredential(owner)).rejects.toThrow(
      "XCODE_BROWSER_ACCOUNT_UNAVAILABLE",
    );
    expect(browser.call.mock.calls.map(([command]) => command)).toEqual([
      "restore",
      "control",
      "invalidateCredential",
    ]);
  });

  it.each(["XCODE_BACKEND_UNAVAILABLE", "XCODE_PROTOCOL_INVALID", "NETWORK_ERROR"])(
    "preserves the owner and relay after unconfirmed %s",
    async (code) => {
      const { bridge, authority, browser } = fixture();
      await bridge.attach(browser.client).ready;
      await expect(
        authority.withControlSession(async () => {
          throw Object.assign(new Error(code), { code });
        }),
      ).rejects.toThrow();
      expect(authority.isCurrent(owner)).toBe(true);
      await expect(authority.getRelayCredential(owner)).resolves.toHaveProperty("token");
      expect(browser.call.mock.calls.map(([command]) => command)).toEqual([
        "restore",
        "control",
        "relay",
      ]);
    },
  );

  it("sanitizes remote errors without retaining messages, stacks, or token data", async () => {
    const { bridge, authority, browser } = fixture();
    await bridge.attach(browser.client).ready;
    browser.call.mockRejectedValueOnce(
      Object.assign(new Error("secret-control secret-refresh"), {
        code: "UNRECOGNIZED-secret",
        data: { refreshToken: "secret-refresh" },
      }),
    );
    const error = await authority.getRelayCredential(owner).catch((error: unknown) => error);
    expect(error).toMatchObject({
      message: "XCODE_BROWSER_ACCOUNT_UNAVAILABLE",
      code: "XCODE_BROWSER_ACCOUNT_UNAVAILABLE",
    });
    expect(String((error as Error).stack)).not.toContain("secret");
    expect(error).not.toHaveProperty("data");
  });
});
