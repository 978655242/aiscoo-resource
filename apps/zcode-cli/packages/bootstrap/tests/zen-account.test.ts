import { describe, expect, it } from "vitest";
import { ZenAccountRuntime } from "../src/zen/index.js";
import type { AiscooAdminSessionBundle } from "@zcode/shared";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { ZenClient, createZenAuthorization } from "@zcode/adapters/auth";

function fixture() {
  const user = { id: "1", username: "test", display_name: "Test", avatar_url: null };
  const bundle: AiscooAdminSessionBundle = {
    schema_version: 1,
    server_time: 1000,
    access_token: "control",
    access_expires_at: 100000,
    refresh_token: "refresh",
    refresh_expires_at: 200000,
    token_type: "Bearer",
    session_id: "sid-a",
    user,
    relay_credential: { token: "sk-test", expires_at: 200000 },
  };
  let saved: { revision: string; value: AiscooAdminSessionBundle } | null = null;
  let revoked = 0;
  const store = {
    assertAvailable: async () => {},
    read: async () => saved,
    compareAndSwap: async (
      _origin: string,
      revision: string | null,
      next: AiscooAdminSessionBundle | null,
    ) => {
      if ((saved?.revision ?? null) !== revision) return false;
      saved = next ? { revision: "next", value: next } : null;
      return true;
    },
    withLease: async <T>(_origin: string, action: () => Promise<T>) => action(),
  };
  const client = {
    origin: "https://zen.example.com",
    exchange: async () => bundle,
    me: async () => ({ user, session_id: "sid-a" }),
    logout: async () => {
      revoked++;
    },
  };
  const listener = {
    redirectUri: "http://127.0.0.1:49152/oauth/callback",
    wait: async () => ({ code: "code", state: "state" }),
    close: async () => {},
  };
  return {
    bundle,
    store,
    client,
    revoked: () => revoked,
    dependencies: {
      client,
      store,
      createAuthorization: async () => ({
        listener,
        verifier: "verifier",
        authorizeUrl: "https://zen.example.com/authorize",
      }),
      openBrowser: async () => {},
      now: () => 2000,
    },
  };
}

describe("Zen standalone account", () => {
  it("retains the independent session when a transient restore failure is retried", async () => {
    const f = fixture();
    const initial = new ZenAccountRuntime(f.dependencies as never);
    await initial.login();
    let failed = true;
    const client = {
      ...f.client,
      me: async () => {
        if (failed)
          throw Object.assign(new Error("unavailable"), { code: "XCODE_BACKEND_UNAVAILABLE" });
        return { user: f.bundle.user, session_id: f.bundle.session_id };
      },
    };
    const cold = new ZenAccountRuntime({ ...f.dependencies, client } as never);
    await expect(cold.restore()).rejects.toThrow();
    expect((await f.store.read())?.value.session_id).toBe("sid-a");
    failed = false;
    expect((await cold.restore())?.user.id).toBe("1");
  });
  it("completes real HTTP authorization callback, token exchange, restore and logout", async () => {
    const f = fixture();
    let tokenRequests = 0;
    const server = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/api/xcode/v1/auth/token") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const input = JSON.parse(body);
        expect(input.client_id).toBe("xwork-cli");
        expect(input.redirect_uri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
        expect(input.code_verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
        tokenRequests++;
        response.end(JSON.stringify({ success: true, data: f.bundle }));
      } else if (request.url === "/api/xcode/v1/me") {
        expect(request.headers.authorization).toBe("Bearer control");
        response.end(
          JSON.stringify({
            success: true,
            data: {
              schema_version: 1,
              server_time: 2000,
              user: f.bundle.user,
              session_id: f.bundle.session_id,
              authorization_revision: "1",
            },
          }),
        );
      } else if (request.url === "/api/xcode/v1/auth/logout") {
        response.end(JSON.stringify({ success: true, data: { revoked: true } }));
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const dependencies = {
      ...f.dependencies,
      client: new ZenClient(origin),
      createAuthorization: () => createZenAuthorization(origin),
    };
    const account = new ZenAccountRuntime(dependencies);
    try {
      const result = await account.login({
        noBrowser: true,
        onAuthorizeUrl: async (raw) => {
          const url = new URL(raw);
          const callback = new URL(url.searchParams.get("redirect_uri")!);
          callback.search = new URLSearchParams({
            provider: "new-api",
            state: url.searchParams.get("state")!,
            code: "a".repeat(43),
          }).toString();
          expect((await fetch(callback)).status).toBe(200);
        },
      });
      expect(result.user.id).toBe("1");
      expect(tokenRequests).toBe(1);
      const cold = new ZenAccountRuntime(dependencies);
      expect((await cold.restore())?.user.id).toBe("1");
      expect(await cold.logout()).toEqual({ localCleared: true, serverRevoked: true });
      cold.dispose();
    } finally {
      account.dispose();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("does not emit a new account change when restoring an absent session", async () => {
    const f = fixture();
    const account = new ZenAccountRuntime(f.dependencies as never);
    let events = 0;
    account.onDidChange(() => {
      events++;
    });
    expect(await account.restore()).toBeNull();
    expect(await account.restore()).toBeNull();
    expect(events).toBe(0);
  });
  it("revokes a rotated session when successor persistence fails", async () => {
    const f = fixture();
    const next = { ...f.bundle, access_token: "next", refresh_token: "refresh-next" };
    const account = new ZenAccountRuntime({
      ...f.dependencies,
      client: { ...f.client, refresh: async () => next },
    } as never);
    await account.login();
    f.bundle.access_expires_at = 1;
    f.store.compareAndSwap = async () => {
      throw new Error("disk unavailable");
    };
    await expect(account.withControlSession(async () => "never")).rejects.toThrow();
    expect(f.revoked()).toBe(1);
    expect(account.getOwner()).toBeNull();
  });
  it("persists a rotated successor before a transient Me verification failure", async () => {
    const f = fixture();
    const next = { ...f.bundle, access_token: "control-next", refresh_token: "refresh-next" };
    const dependencies = { ...f.dependencies, client: { ...f.client, refresh: async () => next } };
    const account = new ZenAccountRuntime(dependencies as never);
    await account.login();
    f.bundle.access_expires_at = 1;
    dependencies.client.me = async () => {
      throw Object.assign(new Error("unavailable"), { code: "XCODE_BACKEND_UNAVAILABLE" });
    };
    await expect(account.withControlSession(async () => "never")).rejects.toThrow();
    expect((await f.store.read())?.value.refresh_token).toBe("refresh-next");
  });
  it("commits a verified CLI session and restores it in another runtime", async () => {
    const f = fixture();
    const account = new ZenAccountRuntime(f.dependencies as never);
    expect((await account.login()).providerId).toBe("zen");
    expect(account.getOwner()?.sid).toBe("sid-a");
    const second = new ZenAccountRuntime(f.dependencies as never);
    expect((await second.restore())?.user.id).toBe("1");
    expect(await account.logout()).toEqual({ localCleared: true, serverRevoked: true });
    expect(await second.restore()).toBeNull();
    expect(f.revoked()).toBe(1);
  });
  it("revokes the issued SID if secure commit fails and never publishes owner", async () => {
    const f = fixture();
    f.store.compareAndSwap = async () => false;
    const account = new ZenAccountRuntime(f.dependencies as never);
    await expect(account.login()).rejects.toThrow();
    expect(account.getOwner()).toBeNull();
    expect(f.revoked()).toBe(1);
  });
  it("rejects an equivalent owner after another process logs out", async () => {
    const f = fixture();
    const account = new ZenAccountRuntime(f.dependencies as never);
    await account.login();
    const owner = { ...account.getOwner()! };
    expect((await account.getRelayCredential(owner)).token).toBe("sk-test");
    const second = new ZenAccountRuntime(f.dependencies as never);
    await second.logout();
    await expect(account.getRelayCredential(owner)).rejects.toThrow();
    expect(account.getOwner()).toBeNull();
  });
  it("does not open authorization or exchange a code after already canceled input", async () => {
    const f = fixture();
    let opened = false;
    f.dependencies.createAuthorization = async () => {
      opened = true;
      throw new Error("should not open");
    };
    const account = new ZenAccountRuntime(f.dependencies as never);
    await expect(account.login({ signal: AbortSignal.abort() })).rejects.toThrow();
    expect(opened).toBe(false);
  });
  it("clears owner when relay credentials have expired", async () => {
    const f = fixture();
    const account = new ZenAccountRuntime(f.dependencies as never);
    await account.login();
    f.bundle.relay_credential.expires_at = 1;
    await expect(account.getRelayCredential(account.getOwner()!)).rejects.toThrow();
    expect(account.getOwner()).toBeNull();
  });
  it("reports local cleanup when remote logout is unavailable", async () => {
    const f = fixture();
    const account = new ZenAccountRuntime(f.dependencies as never);
    await account.login();
    f.client.logout = async () => {
      throw Object.assign(new Error("unavailable"), { code: "XCODE_BACKEND_UNAVAILABLE" });
    };
    expect(await account.logout()).toEqual({ localCleared: true, serverRevoked: false });
    expect(account.getOwner()).toBeNull();
  });
  it("treats an already revoked server session as revoked during logout", async () => {
    const f = fixture();
    const account = new ZenAccountRuntime(f.dependencies as never);
    await account.login();
    f.client.logout = async () => {
      throw Object.assign(new Error("gone"), { code: "XCODE_SESSION_INVALID" });
    };
    expect(await account.logout()).toEqual({ localCleared: true, serverRevoked: true });
    f.client.logout = async () => {
      throw Object.assign(new Error("bad"), { code: "XCODE_PROTOCOL_INVALID" });
    };
    await account.login();
    expect(await account.logout()).toEqual({ localCleared: true, serverRevoked: false });
  });
  it("revokes a rotated successor when the account changes while refresh is in flight", async () => {
    const f = fixture();
    const next = { ...f.bundle, access_token: "next", refresh_token: "refresh-next" };
    const revokedRefresh: string[] = [];
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const account = new ZenAccountRuntime({
      ...f.dependencies,
      client: {
        ...f.client,
        refresh: async () => {
          started.resolve();
          await release.promise;
          return next;
        },
        logout: async (_sid: string, refresh: string) => {
          revokedRefresh.push(refresh);
        },
      },
    } as never);
    await account.login();
    f.bundle.access_expires_at = 1;
    const inFlight = account.withControlSession(async () => "never");
    await started.promise;
    const logout = account.logout();
    release.resolve();
    await expect(inFlight).rejects.toThrow();
    await logout;
    expect(revokedRefresh).toContain("refresh-next");
  });
  it("revokes the replaced SID after switching accounts", async () => {
    const f = fixture();
    const revokedSids: string[] = [];
    f.client.logout = async (sid: string) => {
      revokedSids.push(sid);
    };
    const account = new ZenAccountRuntime(f.dependencies as never);
    await account.login();
    const switched = { ...f.bundle, session_id: "sid-b" };
    f.client.exchange = async () => switched;
    f.client.me = async () => ({ user: f.bundle.user, session_id: "sid-b" });
    await account.login();
    expect(account.getOwner()?.sid).toBe("sid-b");
    expect(revokedSids).toEqual(["sid-a"]);
  });
  it("does not let a late failure clear a newer account owner", async () => {
    const f = fixture();
    const account = new ZenAccountRuntime(f.dependencies as never);
    await account.login();
    let reject!: (reason: unknown) => void;
    const failed = account.withControlSession(
      async () =>
        new Promise((_resolve, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    await account.restore();
    const owner = account.getOwner();
    reject(Object.assign(new Error("revoked"), { code: "XCODE_SESSION_INVALID" }));
    await expect(failed).rejects.toThrow();
    expect(account.getOwner()).toEqual(owner);
  });
  it("refreshes once when the server rejects locally unexpired control credentials", async () => {
    const f = fixture();
    let refreshes = 0;
    const refreshed = { ...f.bundle, access_token: "control-next" };
    const dependencies = {
      ...f.dependencies,
      client: {
        ...f.client,
        refresh: async () => {
          refreshes++;
          return refreshed;
        },
      },
    };
    const account = new ZenAccountRuntime(dependencies as never);
    await account.login();
    const result = await account.withControlSession(async (token) => {
      if (token === "control")
        throw Object.assign(new Error("expired"), { code: "XCODE_ACCESS_EXPIRED" });
      return token;
    });
    expect(result).toBe("control-next");
    expect(refreshes).toBe(1);
  });
  it("revokes an exchanged session even when credential persistence becomes unreadable", async () => {
    const f = fixture();
    let reads = 0;
    f.store.read = async () => {
      if (++reads > 1) throw new Error("storage failed");
      return null;
    };
    const account = new ZenAccountRuntime(f.dependencies as never);
    await expect(account.login()).rejects.toThrow();
    expect(f.revoked()).toBe(1);
  });
  // 回归：取消曾中断进行中的 code 兑换，服务端已签发的 SID 因拿不到 bundle 而无法撤销。
  it("revokes the issued SID when canceled while the code exchange is in flight", async () => {
    const f = fixture();
    const controller = new AbortController();
    let exchangeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      exchangeStarted = resolve;
    });
    f.client.exchange = (async (
      _code: string,
      _verifier: string,
      _redirect: string,
      signal?: AbortSignal,
    ) => {
      exchangeStarted();
      // 与 fetch 一致：收到 abort 时请求被中断，即使服务端已经完成签发。
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 30);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(signal.reason);
          },
          { once: true },
        );
      });
      return f.bundle;
    }) as never;
    const account = new ZenAccountRuntime(f.dependencies as never);
    const pending = account.login({ signal: controller.signal });
    await started;
    controller.abort(new Error("canceled"));
    await expect(pending).rejects.toThrow();
    expect(f.revoked()).toBe(1);
    expect(account.getOwner()).toBeNull();
  });
  it("aborts an outstanding callback when the account is disposed", async () => {
    const f = fixture();
    let listening!: () => void;
    const ready = new Promise<void>((resolve) => {
      listening = resolve;
    });
    let closed = false;
    f.dependencies.createAuthorization = async () => ({
      verifier: "verifier",
      authorizeUrl: "https://zen.example.com/authorize",
      listener: {
        redirectUri: "http://127.0.0.1:49152/oauth/callback",
        wait: async (signal?: AbortSignal) => {
          listening();
          return new Promise<never>((_resolve, reject) =>
            signal?.addEventListener("abort", () => reject(signal.reason), { once: true }),
          );
        },
        close: async () => {
          closed = true;
        },
      },
    });
    const account = new ZenAccountRuntime(f.dependencies as never);
    const pending = account.login();
    await ready;
    account.dispose();
    const result = await Promise.race([
      pending.then(
        () => "accepted",
        () => "canceled",
      ),
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50)),
    ]);
    expect(result).toBe("canceled");
    expect(closed).toBe(true);
  });
  it("does not publish a session replaced while cold-restore verification is in flight", async () => {
    const f = fixture();
    const account = new ZenAccountRuntime(f.dependencies as never);
    await account.login();
    f.client.me = async () => {
      const current = await f.store.read();
      await f.store.compareAndSwap(f.client.origin, current!.revision, null);
      return { user: f.bundle.user, session_id: f.bundle.session_id };
    };
    const restoring = new ZenAccountRuntime(f.dependencies as never);
    await expect(restoring.restore()).rejects.toThrow();
    expect(restoring.getOwner()).toBeNull();
  });
});
