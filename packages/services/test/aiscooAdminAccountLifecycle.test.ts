import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AiscooAdminOwner, AiscooAdminSessionBundle, OAuthSessionState } from "@zcode/shared";
import { withFileLock } from "@zcode/shared/node";
import { createCredentialCipherProvider } from "../src/credential/providers/credentialCipherProvider.js";
import { AiscooAdminAccountService } from "../src/aiscoo-admin/aiscooAdminAccountService.js";
import { AiscooAdminClient } from "../src/aiscoo-admin/aiscooAdminClient.js";
import {
  AiscooAdminSessionRepo,
  type AiscooAdminStoredSession,
} from "../src/aiscoo-admin/aiscooAdminSessionRepo.js";
import { AiscooAdminProviderAdapter } from "../src/oauth/providers/aiscooAdminProviderAdapter.js";

const origin = "https://native.example";
const initialTime = 1_800_000_000_000;
function barrier<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function bundle(
  id = "1",
  sid = "sid-1",
  refresh = "refresh-1",
  expires = initialTime + 60_000,
): AiscooAdminSessionBundle {
  const payload = Buffer.from(
    JSON.stringify({
      iss: "new-api",
      aud: ["new-api-xcode"],
      token_use: "xcode_access",
      sub: id,
      sid,
      exp: expires / 1000,
      uv: 1,
      sv: 1,
      nbf: initialTime / 1000 - 5,
      iat: initialTime / 1000,
      scopes: ["profile:read", "wallet:read", "usage:read"],
      jti: randomUUID(),
    }),
  ).toString("base64url");
  return {
    schema_version: 1,
    server_time: initialTime,
    access_token: `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${payload}.${Buffer.alloc(32, 1).toString("base64url")}`,
    access_expires_at: expires,
    refresh_token: refresh,
    refresh_expires_at: initialTime + 600_000,
    token_type: "Bearer",
    session_id: sid,
    user: {
      id,
      username: `user-${id}`,
      display_name: `User ${id}`,
      avatar_url: null,
    },
    relay_credential: {
      token: `sk-relay-${sid}`,
      expires_at: initialTime + 600_000,
    },
  };
}
const success = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    headers: { "content-type": "application/json" },
  });
const failure = (code: string, status: number) =>
  new Response(
    JSON.stringify({
      success: false,
      code,
      message: "Safe server failure",
      request_id: "test-request",
    }),
    { status, headers: { "content-type": "application/json" } },
  );

async function fixture(onOwnerChanged?: (owner: AiscooAdminOwner | null) => void | Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "xcode-native-lifecycle-"));
  const credentialsFile = join(dir, "credentials.json");
  const cipherProvider = createCredentialCipherProvider({
    env: { ZCODE_CREDENTIAL_SECRET: randomBytes(32).toString("hex") },
  });
  const legacy = cipherProvider.encrypt("unowned-official-secret");
  await writeFile(
    credentialsFile,
    JSON.stringify({ "official-cloud:unowned": legacy, zcodeJwtToken: legacy }),
  );
  let now = initialTime;
  let tokenSession = bundle();
  let exchange: (code: string) => Promise<AiscooAdminSessionBundle> = async () => tokenSession;
  let refresh: () => Promise<AiscooAdminSessionBundle> = async () =>
    bundle("1", "sid-1", "refresh-2", now + 60_000);
  let meError: Response | null = null;
  let refreshCalls = 0;
  const revoked: string[] = [];
  const sessions = new Map<string, AiscooAdminSessionBundle>();
  const client = new AiscooAdminClient(origin, {
    now: () => now,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      if (url.pathname.endsWith("/auth/token")) {
        tokenSession = await exchange(body.code);
        sessions.set(tokenSession.session_id, tokenSession);
        return success(tokenSession);
      }
      if (url.pathname.endsWith("/auth/refresh")) {
        refreshCalls++;
        tokenSession = await refresh();
        sessions.set(tokenSession.session_id, tokenSession);
        return success(tokenSession);
      }
      if (url.pathname.endsWith("/auth/logout")) {
        if (sessions.get(body.session_id)?.refresh_token !== body.refresh_token)
          return failure("XCODE_SESSION_INVALID", 401);
        sessions.delete(body.session_id);
        revoked.push(body.session_id);
        return success({ schema_version: 1, server_time: now, revoked: true });
      }
      if (url.pathname.endsWith("/me")) {
        if (meError) return meError.clone();
        const authorization = new Headers(init?.headers).get("authorization")!;
        const claims = JSON.parse(
          Buffer.from(authorization.split(".")[1]!, "base64url").toString(),
        );
        return success({
          schema_version: 1,
          server_time: now,
          session_id: claims.sid,
          user: {
            id: claims.sub,
            username: `user-${claims.sub}`,
            display_name: `User ${claims.sub}`,
            avatar_url: null,
          },
          authorization_revision: "0",
        });
      }
      throw new Error("Unexpected lifecycle endpoint");
    },
  });
  const repo = new AiscooAdminSessionRepo(origin, {
    credentialsFile,
    cipherProvider,
  });
  const owners: unknown[] = [];
  const service = new AiscooAdminAccountService({
    adapter: new AiscooAdminProviderAdapter(client),
    repo,
    now: () => now,
    onOwnerChanged: (owner) => {
      owners.push(owner);
      return onOwnerChanged?.(owner);
    },
  });
  const sessionEvents: OAuthSessionState[] = [];
  service.oauth.onDidChangeSession((state) => sessionEvents.push(state));
  const callback = (state: string) =>
    `zcode://oauth/callback?provider=new-api&state=${state}&code=${state}`;
  return {
    service,
    repo,
    owners,
    sessionEvents,
    revoked,
    callback,
    credentialsFile,
    cipherProvider,
    dir,
    legacy,
    newService: () =>
      new AiscooAdminAccountService({
        adapter: new AiscooAdminProviderAdapter(client),
        repo,
        now: () => now,
      }),
    setExchange: (action: typeof exchange) => {
      exchange = action;
    },
    setRefresh: (action: typeof refresh) => {
      refresh = action;
    },
    setMeError: (response: Response | null) => {
      meError = response;
    },
    advance: () => {
      now = initialTime + 61_000;
    },
    refreshCalls: () => refreshCalls,
    login: async () => {
      const start = await service.oauth.startOAuth("new-api");
      return service.oauth.handleCallback(callback(start.state));
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

test("Native session events follow accepted owners without treating token rotation as a new login", async () => {
  const f = await fixture();
  try {
    await f.login();
    assert.deepEqual(f.sessionEvents, ["signed-out", "signed-in"]);
    await f.service.oauth.refreshToken();
    assert.deepEqual(f.sessionEvents, ["signed-out", "signed-in"]);
    f.setExchange(async () => bundle("2", "sid-2", "refresh-b"));
    const next = await f.service.oauth.startOAuth("new-api");
    assert.equal(f.service.getOwner(), null);
    assert.deepEqual(f.sessionEvents, ["signed-out", "signed-in", "signed-out"]);
    await f.service.oauth.handleCallback(f.callback(next.state));
    assert.equal(f.service.getOwner()?.userId, "2");
    assert.deepEqual(f.sessionEvents, ["signed-out", "signed-in", "signed-out", "signed-in"]);
    await f.service.oauth.logout();
    assert.deepEqual(f.sessionEvents, [
      "signed-out",
      "signed-in",
      "signed-out",
      "signed-in",
      "signed-out",
    ]);
  } finally {
    await f.dispose();
  }
});

test("owner invalidation notifies before cleanup and canceled owner activation never emits signed-in", async () => {
  const entered = barrier<void>();
  const release = barrier<void>();
  const f = await fixture(async (owner) => {
    if (owner) {
      entered.resolve();
      await release.promise;
    } else {
      assert.equal(f.sessionEvents.at(-1), "signed-out");
    }
  });
  try {
    const start = await f.service.oauth.startOAuth("new-api");
    const callback = f.service.oauth.handleCallback(f.callback(start.state));
    await entered.promise;
    assert.equal(f.sessionEvents.includes("signed-in"), false);
    await f.service.oauth.cancelPending();
    release.resolve();
    assert.equal(await callback, null);
    assert.equal(f.service.getOwner(), null);
    assert.equal(await f.repo.loadActive(), null);
    assert.equal(f.sessionEvents.includes("signed-in"), false);
  } finally {
    release.resolve();
    await f.dispose();
  }
});

test("late A exchange cannot publish or persist over B, and revokes the actual late SID", async () => {
  const f = await fixture();
  try {
    const arrived = barrier<void>();
    const late = barrier<AiscooAdminSessionBundle>();
    const a = await f.service.oauth.startOAuth("new-api");
    f.setExchange(async (code) => {
      if (code === a.state) {
        arrived.resolve();
        return late.promise;
      }
      return bundle("2", "sid-2", "refresh-b");
    });
    const pendingA = f.service.oauth.handleCallback(f.callback(a.state));
    await arrived.promise;
    const b = await f.service.oauth.startOAuth("new-api");
    await f.service.oauth.handleCallback(f.callback(b.state));
    late.resolve(bundle());
    assert.equal(await pendingA, null);
    assert.equal(f.service.getOwner()?.userId, "2");
    assert.equal((await f.repo.loadActive())?.bundle.session_id, "sid-2");
    assert.deepEqual(f.revoked, ["sid-1"]);
    assert.equal(f.sessionEvents.filter((state) => state === "signed-in").length, 1);
    assert.equal(f.sessionEvents.at(-1), "signed-in");
  } finally {
    await f.dispose();
  }
});

test("cancel after exchange and during atomic commit compensates persistence", async () => {
  const f = await fixture();
  try {
    const entered = barrier<void>();
    const release = barrier<void>();
    const commit = f.repo.commitVerifiedLogin.bind(f.repo);
    f.repo.commitVerifiedLogin = async (session, assertCurrent) => {
      const previous = await commit(session, assertCurrent);
      entered.resolve();
      await release.promise;
      return previous;
    };
    const start = await f.service.oauth.startOAuth("new-api");
    const callback = f.service.oauth.handleCallback(f.callback(start.state));
    await entered.promise;
    const cancel = f.service.oauth.cancelPending();
    release.resolve();
    assert.equal(await callback, null);
    await cancel;
    assert.equal(f.service.getOwner(), null);
    assert.equal(await f.repo.loadActive(), null);
    assert.deepEqual(f.revoked, ["sid-1"]);
    assert.equal(f.sessionEvents.includes("signed-in"), false);
  } finally {
    await f.dispose();
  }
});

test("cancel before exchange completes revokes without writing credentials", async () => {
  const f = await fixture();
  try {
    const entered = barrier<void>();
    const release = barrier<AiscooAdminSessionBundle>();
    f.setExchange(async () => {
      entered.resolve();
      return release.promise;
    });
    const start = await f.service.oauth.startOAuth("new-api");
    const pending = f.service.oauth.handleCallback(f.callback(start.state));
    await entered.promise;
    await f.service.oauth.cancelPending();
    release.resolve(bundle());
    assert.equal(await pending, null);
    assert.equal(await f.repo.loadActive(), null);
    assert.deepEqual(f.revoked, ["sid-1"]);
  } finally {
    await f.dispose();
  }
});

test("concurrent refresh is single-flight, rotates encrypted secret and retains owner generation", async () => {
  const f = await fixture();
  try {
    await f.login();
    const owner = f.service.getOwner()!;
    const entered = barrier<void>();
    const release = barrier<AiscooAdminSessionBundle>();
    f.setRefresh(async () => {
      entered.resolve();
      return release.promise;
    });
    f.advance();
    const a = f.service.withControlSession(async (_, current) => current);
    await entered.promise;
    const b = f.service.withControlSession(async (_, current) => current);
    release.resolve(bundle("1", "sid-1", "refresh-rotated", initialTime + 120_000));
    assert.deepEqual(await a, owner);
    assert.deepEqual(await b, owner);
    assert.equal(f.refreshCalls(), 1);
    assert.equal((await f.repo.loadActive())?.bundle.refresh_token, "refresh-rotated");
    assert.equal((await readFile(f.credentialsFile, "utf8")).includes("refresh-rotated"), false);
  } finally {
    await f.dispose();
  }
});

for (const mutation of ["user", "sid", "key"] as const) {
  test(`refresh rejects changed ${mutation} and closes current execution`, async () => {
    const f = await fixture();
    try {
      await f.login();
      const changed = bundle(
        mutation === "user" ? "2" : "1",
        mutation === "sid" ? "sid-2" : "sid-1",
        "refresh-2",
      );
      if (mutation === "key") changed.relay_credential.token = "sk-unexpected";
      f.setRefresh(async () => changed);
      await assert.rejects(f.service.oauth.refreshToken());
      assert.equal(f.service.getOwner(), null);
      assert.equal(await f.repo.loadActive(), null);
      assert.equal(f.owners.at(-1), null);
    } finally {
      await f.dispose();
    }
  });
}

test("503 restore preserves recoverable record, explicit session revocation removes only private owner", async () => {
  const f = await fixture();
  try {
    await f.login();
    const before = await f.repo.loadActive();
    f.setMeError(failure("XCODE_BACKEND_UNAVAILABLE", 503));
    const unavailable = await f.service.oauth.restoreCachedSessionState();
    assert.deepEqual(f.sessionEvents, ["signed-out", "signed-in"]);
    assert.equal(unavailable.status, "unavailable");
    assert.deepEqual(await f.repo.loadActive(), before);
    f.setMeError(failure("XCODE_SESSION_INVALID", 401));
    assert.equal((await f.service.oauth.restoreCachedSessionState()).status, "signed-out");
    assert.equal(f.service.getOwner(), null);
    assert.equal(await f.repo.loadActive(), null);
    assert.equal(f.sessionEvents.at(-1), "signed-out");
    const store = JSON.parse(await readFile(f.credentialsFile, "utf8"));
    assert.equal(store["official-cloud:unowned"], f.legacy);
    assert.equal(store.zcodeJwtToken, f.legacy);
  } finally {
    await f.dispose();
  }
});

test("control expiry retries once, permission denial preserves owner, logout never clears official credentials", async () => {
  const f = await fixture();
  try {
    await f.login();
    let calls = 0;
    const error = Object.assign(new Error("safe"), {
      code: "XCODE_ACCESS_EXPIRED",
      status: 401,
    });
    await assert.rejects(
      f.service.withControlSession(async () => {
        calls++;
        throw error;
      }),
    );
    assert.equal(calls, 2);
    assert.equal(f.refreshCalls(), 1);
    const owner = f.service.getOwner();
    await assert.rejects(
      f.service.withControlSession(async () => {
        throw Object.assign(new Error("safe"), {
          code: "XCODE_PLAN_UNASSIGNED",
          status: 403,
        });
      }),
    );
    assert.deepEqual(f.service.getOwner(), owner);
    await f.service.oauth.logoutAll();
    const store = JSON.parse(await readFile(f.credentialsFile, "utf8"));
    assert.equal(store["official-cloud:unowned"], f.legacy);
    assert.equal(store.zcodeJwtToken, f.legacy);
  } finally {
    await f.dispose();
  }
});

test("Renderer OAuth projection exposes no Host session or private implementation functions", async () => {
  const f = await fixture();
  try {
    await f.login();
    const approved = [
      "onDidChangeSession",
      "getProviders",
      "getActiveProvider",
      "restoreCachedSession",
      "restoreCachedSessionState",
      "restoreSession",
      "startOAuth",
      "startOAuthWithPolling",
      "pollPendingOAuth",
      "handleCallback",
      "refreshToken",
      "logout",
      "logoutAll",
      "cancelPending",
    ];
    assert.deepEqual(Object.keys(f.service.oauth).sort(), approved.sort());
    assert.deepEqual(Object.keys(f.service), ["oauth"]);
    assert.equal(JSON.stringify(await f.service.oauth.restoreSession()).includes("sk-"), false);
    assert.equal(JSON.stringify(f.service).includes("refresh-1"), false);
    await assert.rejects(f.service.oauth.pollPendingOAuth(), {
      code: "XCODE_PRIVATE_POLLING_UNSUPPORTED",
    });
    await assert.rejects(f.service.oauth.startOAuthWithPolling("new-api"), {
      code: "XCODE_PRIVATE_POLLING_UNSUPPORTED",
    });
  } finally {
    await f.dispose();
  }
});

test("B started during A commit fences A and publishes only B after compensation", async () => {
  const f = await fixture();
  try {
    const entered = barrier<void>();
    const release = barrier<void>();
    const commit = f.repo.commitVerifiedLogin.bind(f.repo);
    f.repo.commitVerifiedLogin = async (record, assertCurrent) => {
      const previous = await commit(record, assertCurrent);
      if (record.bundle.session_id === "sid-1") {
        entered.resolve();
        await release.promise;
      }
      return previous;
    };
    const a = await f.service.oauth.startOAuth("new-api");
    const pendingA = f.service.oauth.handleCallback(f.callback(a.state));
    await entered.promise;
    const pendingB = f.service.oauth.startOAuth("new-api");
    release.resolve();
    assert.equal(await pendingA, null);
    const b = await pendingB;
    f.setExchange(async () => bundle("2", "sid-2", "refresh-b"));
    await f.service.oauth.handleCallback(f.callback(b.state));
    assert.equal(f.service.getOwner()?.userId, "2");
    assert.equal((await f.repo.loadActive())?.bundle.session_id, "sid-2");
    assert.deepEqual(f.revoked, ["sid-1"]);
  } finally {
    await f.dispose();
  }
});

test("cold restore never publishes cached profile during 503, then refreshes an expired control token", async () => {
  const f = await fixture();
  try {
    await f.login();
    const cold = f.newService();
    const restoredEvents: OAuthSessionState[] = [];
    cold.oauth.onDidChangeSession((state) => restoredEvents.push(state));
    f.setMeError(failure("XCODE_BACKEND_UNAVAILABLE", 503));
    assert.equal((await cold.oauth.restoreCachedSessionState()).status, "unavailable");
    assert.equal(cold.getOwner(), null);
    assert.deepEqual(restoredEvents, []);
    assert.equal(await cold.oauth.getActiveProvider(), null);
    assert.ok(await f.repo.loadActive());
    f.setMeError(null);
    f.advance();
    assert.equal((await cold.oauth.restoreCachedSessionState()).status, "authenticated");
    assert.equal(cold.getOwner()?.userId, "1");
    assert.equal(f.refreshCalls(), 1);
    assert.equal((await f.repo.loadActive())?.bundle.refresh_token, "refresh-2");
    assert.deepEqual(restoredEvents, ["signed-in"]);
    await cold.oauth.restoreCachedSessionState();
    assert.deepEqual(restoredEvents, ["signed-in"]);
  } finally {
    await f.dispose();
  }
});

test("two Host runtimes refresh one shared SID once and both adopt its encrypted successor", async () => {
  const f = await fixture();
  try {
    await f.login();
    const second = f.newService();
    await second.oauth.restoreSession();
    const ownerA = f.service.getOwner();
    const ownerB = second.getOwner();
    const entered = barrier<void>();
    const release = barrier<AiscooAdminSessionBundle>();
    f.setRefresh(async () => {
      entered.resolve();
      return release.promise;
    });
    const a = f.service.oauth.refreshToken();
    await entered.promise;
    const b = second.oauth.refreshToken();
    release.resolve(bundle("1", "sid-1", "cross-window-successor"));
    await Promise.all([a, b]);
    assert.equal(f.refreshCalls(), 1);
    assert.deepEqual(f.service.getOwner(), ownerA);
    assert.deepEqual(second.getOwner(), ownerB);
    assert.equal((await f.repo.loadActive())?.bundle.refresh_token, "cross-window-successor");
  } finally {
    await f.dispose();
  }
});

test("late control result cannot cross account switch and accepted B revokes only this Host's A", async () => {
  const f = await fixture();
  try {
    await f.login();
    const oldOwner = f.service.getOwner()!;
    const entered = barrier<void>();
    const release = barrier<void>();
    const stale = f.service.withControlSession(async () => {
      entered.resolve();
      await release.promise;
      return "A data";
    });
    await entered.promise;
    f.setExchange(async () => bundle("2", "sid-2", "refresh-b"));
    await f.login();
    release.resolve();
    await assert.rejects(stale, { code: "XCODE_STALE_OWNER" });
    assert.equal(f.service.isCurrent(oldOwner), false);
    await assert.rejects(f.service.getRelayCredential(oldOwner), {
      code: "XCODE_STALE_OWNER",
    });
    assert.deepEqual(f.revoked, ["sid-1"]);
    assert.equal((await f.repo.loadActive())?.bundle.session_id, "sid-2");
  } finally {
    await f.dispose();
  }
});

test("logout during refresh removes the actual rotated successor instead of resurrecting a predecessor", async () => {
  const f = await fixture();
  try {
    await f.login();
    const entered = barrier<void>();
    const release = barrier<AiscooAdminSessionBundle>();
    f.setRefresh(async () => {
      entered.resolve();
      return release.promise;
    });
    const pendingRefresh = f.service.oauth.refreshToken();
    const rejected = assert.rejects(pendingRefresh, {
      code: "XCODE_STALE_OWNER",
    });
    await entered.promise;
    const logout = f.service.oauth.logout();
    release.resolve(bundle("1", "sid-1", "logout-successor"));
    await Promise.all([rejected, logout]);
    assert.equal(f.service.getOwner(), null);
    assert.equal(await f.repo.loadActive(), null);
    assert.ok(f.revoked.includes("sid-1"));
  } finally {
    await f.dispose();
  }
});

test("opaque cached control token requires manual recovery without erasing encrypted or official data", async () => {
  const f = await fixture();
  try {
    const stored: AiscooAdminStoredSession = {
      schemaVersion: 1,
      origin,
      bundle: { ...bundle(), access_token: "opaque" },
    };
    await f.repo.commit(stored);
    const before = await readFile(f.credentialsFile, "utf8");
    const cold = f.newService();
    assert.deepEqual(await cold.oauth.restoreCachedSessionState(), {
      status: "unavailable",
      reason: "credential-recovery-required",
    });
    assert.equal(cold.getOwner(), null);
    assert.equal(await cold.oauth.getActiveProvider(), null);
    assert.equal(await readFile(f.credentialsFile, "utf8"), before);
  } finally {
    await f.dispose();
  }
});

test("refresh followed by Me 503 retains the rotated secret for recovery", async () => {
  const f = await fixture();
  try {
    await f.login();
    const owner = f.service.getOwner();
    f.setMeError(failure("XCODE_BACKEND_UNAVAILABLE", 503));
    await assert.rejects(f.service.oauth.refreshToken(), {
      code: "XCODE_BACKEND_UNAVAILABLE",
    });
    assert.deepEqual(f.service.getOwner(), owner);
    assert.equal((await f.repo.loadActive())?.bundle.refresh_token, "refresh-2");
    f.setMeError(null);
    assert.equal((await f.service.oauth.restoreCachedSessionState()).status, "authenticated");
    assert.equal(f.refreshCalls(), 1);
  } finally {
    await f.dispose();
  }
});

test("accepted switch never deletes or revokes another window's active owner", async () => {
  const f = await fixture();
  try {
    await f.login();
    const other = f.newService();
    f.setExchange(async () => bundle("3", "sid-3", "refresh-c"));
    const c = await other.oauth.startOAuth("new-api");
    await other.oauth.handleCallback(f.callback(c.state));
    f.setExchange(async () => bundle("2", "sid-2", "refresh-b"));
    await f.login();
    assert.deepEqual(f.revoked, ["sid-1"]);
    assert.equal(other.getOwner()?.userId, "3");
    assert.equal((await other.getRelayCredential(other.getOwner()!)).token, "sk-relay-sid-3");
    const records = JSON.parse(await readFile(f.credentialsFile, "utf8"));
    assert.ok(Object.keys(records).some((key) => key.endsWith(":3:sid-3")));
    assert.equal((await f.repo.loadActive())?.bundle.session_id, "sid-2");
  } finally {
    await f.dispose();
  }
});

test("server Me identity is mandatory before callback credentials can be published", async () => {
  const f = await fixture();
  try {
    f.setMeError(
      success({
        schema_version: 1,
        server_time: initialTime,
        session_id: "sid-1",
        user: {
          id: "2",
          username: "other",
          display_name: "Other",
          avatar_url: null,
        },
        authorization_revision: "0",
      }),
    );
    await assert.rejects(f.login(), { code: "XCODE_SESSION_INVALID" });
    assert.equal(f.service.getOwner(), null);
    assert.equal(await f.repo.loadActive(), null);
    assert.deepEqual(f.revoked, ["sid-1"]);
  } finally {
    await f.dispose();
  }
});

test("logout after another Host rotation revokes with the actual removed successor secret", async () => {
  const f = await fixture();
  try {
    await f.login();
    const other = f.newService();
    await other.oauth.restoreSession();
    await other.oauth.refreshToken();
    assert.equal((await f.repo.loadActive())?.bundle.refresh_token, "refresh-2");
    await f.service.oauth.logout();
    assert.equal(await f.repo.loadActive(), null);
    assert.deepEqual(f.revoked, ["sid-1"]);
  } finally {
    await f.dispose();
  }
});

test("ciphertext corruption requires manual recovery without deleting private or official credentials", async () => {
  const f = await fixture();
  try {
    await f.login();
    const records: Record<string, string> = JSON.parse(await readFile(f.credentialsFile, "utf8"));
    const active = Object.keys(records).find(
      (key) => key.startsWith("new-api:") && key.endsWith(":active"),
    )!;
    records[active] = "enc:v1:invalid";
    await writeFile(f.credentialsFile, JSON.stringify(records));
    const cold = f.newService();
    assert.deepEqual(await cold.oauth.restoreCachedSessionState(), {
      status: "unavailable",
      reason: "credential-recovery-required",
    });
    assert.equal(await readFile(f.credentialsFile, "utf8"), JSON.stringify(records));
    assert.equal(cold.getOwner(), null);
    assert.equal(await cold.oauth.getActiveProvider(), null);
    assert.deepEqual(f.revoked, []);
  } finally {
    await f.dispose();
  }
});

for (const fault of ["active", "session", "foreign-key", "plaintext", "invalid-owner"] as const) {
  test(`verified login recovers ${fault} while retaining backup and unrelated credentials`, async () => {
    const f = await fixture();
    try {
      await f.login();
      const records: Record<string, string> = JSON.parse(await readFile(f.credentialsFile, "utf8"));
      const active = Object.keys(records).find(
        (key) => key.startsWith("new-api:") && key.endsWith(":active"),
      )!;
      const ownerKey = Object.keys(records).find(
        (key) => key.startsWith("new-api:") && key !== active,
      )!;
      if (fault === "session") records[ownerKey] = "enc:v1:invalid";
      else if (fault === "foreign-key") {
        records[active] = createCredentialCipherProvider({
          env: { ZCODE_CREDENTIAL_SECRET: "old-synthetic-key" },
        }).encrypt("{}");
      } else if (fault === "plaintext") records[active] = "{}";
      else if (fault === "invalid-owner")
        records[active] = f.cipherProvider.encrypt('{"userId":"invalid"}');
      else records[active] = "enc:v1:invalid";
      const unrelatedKey = "new-api:unrelated-origin:active";
      records[unrelatedKey] = "enc:v1:unreadable-but-untouched";
      const before = JSON.stringify(records);
      await writeFile(f.credentialsFile, before);
      const cold = f.newService();
      assert.equal((await cold.oauth.restoreCachedSessionState()).status, "unavailable");
      f.setExchange(async () => bundle("2", "sid-recovered", "refresh-recovered"));
      const start = await cold.oauth.startOAuth("new-api");
      const result = await cold.oauth.handleCallback(f.callback(start.state));
      assert.equal(result?.kind, "session");
      assert.equal(cold.getOwner()?.userId, "2");
      assert.equal((await f.repo.loadActive())?.bundle.session_id, "sid-recovered");
      const after: Record<string, string> = JSON.parse(await readFile(f.credentialsFile, "utf8"));
      for (const [key, value] of Object.entries(records)) {
        if (key !== active) assert.equal(after[key], value, `unrelated ciphertext changed: ${key}`);
      }
      const backups = (await readdir(f.dir)).filter(
        (name) => name.includes(".corrupt-") && name.endsWith(".bak"),
      );
      assert.equal(backups.length, 1);
      const backup = join(f.dir, backups[0]!);
      assert.equal(await readFile(backup, "utf8"), before);
      if (process.platform !== "win32") assert.equal((await stat(backup)).mode & 0o777, 0o600);
      assert.equal(
        (await f.newService().oauth.restoreCachedSessionState()).status,
        "authenticated",
      );
    } finally {
      await f.dispose();
    }
  });
}

for (const fault of ["ciphertext", "schema"] as const) {
  test(`warm verified login survives displaced ${fault} cleanup and revokes the old SID`, async () => {
    const f = await fixture();
    try {
      await f.login();
      const records: Record<string, string> = JSON.parse(await readFile(f.credentialsFile, "utf8"));
      const ownerKey = Object.keys(records).find((key) => key.endsWith("1:sid-1"))!;
      records[ownerKey] =
        fault === "ciphertext" ? "enc:v1:invalid" : f.cipherProvider.encrypt("{}");
      const before = JSON.stringify(records);
      await writeFile(f.credentialsFile, before);
      f.setExchange(async () => bundle("2", "sid-warm-recovered", "refresh-warm"));
      const result = await f.login();
      assert.equal(result?.kind, "session");
      assert.equal(f.service.getOwner()?.userId, "2");
      assert.equal((await f.repo.loadActive())?.bundle.session_id, "sid-warm-recovered");
      const after = JSON.parse(await readFile(f.credentialsFile, "utf8"));
      assert.equal(after[ownerKey], records[ownerKey]);
      assert.ok(f.revoked.includes("sid-1"));
      assert.equal(f.revoked.includes("sid-warm-recovered"), false);
      const backups = (await readdir(f.dir)).filter((name) => name.endsWith(".bak"));
      assert.equal(backups.length, 1);
      assert.equal(await readFile(join(f.dir, backups[0]!), "utf8"), before);
      assert.equal(
        (await f.newService().oauth.restoreCachedSessionState()).status,
        "authenticated",
      );
    } finally {
      await f.dispose();
    }
  });
}

test("recovery can retry after an interrupted partial backup", async () => {
  const f = await fixture();
  try {
    await f.login();
    const records: Record<string, string> = JSON.parse(await readFile(f.credentialsFile, "utf8"));
    const active = Object.keys(records).find((key) => key.endsWith(":active"))!;
    records[active] = "enc:v1:invalid";
    const before = JSON.stringify(records);
    await writeFile(f.credentialsFile, before);
    const id = createHash("sha256").update(before).digest("hex").slice(0, 24);
    await writeFile(`${f.credentialsFile}.corrupt-${id}.bak`, "partial", { mode: 0o600 });
    const cold = f.newService();
    f.setExchange(async () => bundle("2", "sid-new", "refresh-new"));
    const start = await cold.oauth.startOAuth("new-api");
    assert.equal((await cold.oauth.handleCallback(f.callback(start.state)))?.kind, "session");
    const backups = (await readdir(f.dir)).filter((name) => name.endsWith(".bak"));
    const contents = await Promise.all(backups.map((name) => readFile(join(f.dir, name), "utf8")));
    assert.ok(contents.includes(before));
  } finally {
    await f.dispose();
  }
});

test("verified login recovers unreadable records at the exact new SID without clearing other sessions", async () => {
  const f = await fixture();
  try {
    const records: Record<string, string> = JSON.parse(await readFile(f.credentialsFile, "utf8"));
    const prefix = `new-api:${createHash("sha256").update(origin).digest("hex")}:`;
    const key = `${prefix}1:sid-1`;
    records[key] = "enc:v1:invalid";
    const before = JSON.stringify(records);
    await writeFile(f.credentialsFile, before);
    assert.equal((await f.login())?.kind, "session");
    assert.equal((await f.repo.loadActive())?.bundle.session_id, "sid-1");
    const backups = (await readdir(f.dir)).filter((name) => name.endsWith(".bak"));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(f.dir, backups[0]!), "utf8"), before);
  } finally {
    await f.dispose();
  }
});

test("failed Me validation cannot recover an unreadable active pointer", async () => {
  const f = await fixture();
  try {
    await f.login();
    const records: Record<string, string> = JSON.parse(await readFile(f.credentialsFile, "utf8"));
    const active = Object.keys(records).find((key) => key.endsWith(":active"))!;
    records[active] = "enc:v1:invalid";
    const before = JSON.stringify(records);
    await writeFile(f.credentialsFile, before);
    const cold = f.newService();
    f.setExchange(async () => bundle("2", "sid-rejected", "refresh-rejected"));
    f.setMeError(failure("XCODE_SESSION_INVALID", 401));
    const start = await cold.oauth.startOAuth("new-api");
    await assert.rejects(cold.oauth.handleCallback(f.callback(start.state)));
    assert.equal(await readFile(f.credentialsFile, "utf8"), before);
    assert.equal(
      (await readdir(f.dir)).some((name) => name.endsWith(".bak")),
      false,
    );
    assert.equal(cold.getOwner(), null);
  } finally {
    await f.dispose();
  }
});

test("failed recovery backup keeps unreadable ciphertext and rejects the new login", async () => {
  const f = await fixture();
  try {
    await f.login();
    const records: Record<string, string> = JSON.parse(await readFile(f.credentialsFile, "utf8"));
    const active = Object.keys(records).find((key) => key.endsWith(":active"))!;
    records[active] = "enc:v1:invalid";
    const before = JSON.stringify(records);
    await writeFile(f.credentialsFile, before);
    const id = createHash("sha256").update(before).digest("hex").slice(0, 24);
    await mkdir(`${f.credentialsFile}.corrupt-${id}.bak`);
    const cold = f.newService();
    const start = await cold.oauth.startOAuth("new-api");
    await assert.rejects(cold.oauth.handleCallback(f.callback(start.state)));
    assert.equal(await readFile(f.credentialsFile, "utf8"), before);
    assert.equal(cold.getOwner(), null);
  } finally {
    await f.dispose();
  }
});

test("verified login does not treat a non-decrypt storage failure as recoverable", async () => {
  const f = await fixture();
  try {
    await f.login();
    const before = await readFile(f.credentialsFile, "utf8");
    const cold = f.newService();
    // 解密抛出的不是“密文损坏”而是安全库/IO 故障：必须原样失败，不能备份、覆盖或登录。
    const decrypt = f.cipherProvider.decrypt.bind(f.cipherProvider);
    f.cipherProvider.decrypt = () => {
      throw Object.assign(new Error("keystore unavailable"), {
        code: "XCODE_SECURE_STORAGE_UNAVAILABLE",
      });
    };
    f.setExchange(async () => bundle("2", "sid-storage-fault", "refresh-fault"));
    const start = await cold.oauth.startOAuth("new-api");
    await assert.rejects(cold.oauth.handleCallback(f.callback(start.state)), {
      code: "XCODE_SECURE_STORAGE_UNAVAILABLE",
    });
    f.cipherProvider.decrypt = decrypt;
    assert.equal(await readFile(f.credentialsFile, "utf8"), before);
    assert.equal(
      (await readdir(f.dir)).some((name) => name.endsWith(".bak") || name.endsWith(".tmp")),
      false,
    );
    assert.equal(cold.getOwner(), null);
  } finally {
    await f.dispose();
  }
});

test("cancel while verified recovery waits for the file lock keeps the original bytes", async () => {
  const f = await fixture();
  const locked = barrier<void>();
  const release = barrier<void>();
  try {
    await f.login();
    const records: Record<string, string> = JSON.parse(await readFile(f.credentialsFile, "utf8"));
    const active = Object.keys(records).find((key) => key.endsWith(":active"))!;
    records[active] = "enc:v1:invalid";
    const before = JSON.stringify(records);
    await writeFile(f.credentialsFile, before);
    const held = withFileLock(f.credentialsFile, async () => {
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const committing = barrier<void>();
    const commit = f.repo.commitVerifiedLogin.bind(f.repo);
    f.repo.commitVerifiedLogin = (record, assertCurrent) => {
      committing.resolve();
      return commit(record, assertCurrent);
    };
    const cold = f.newService();
    f.setExchange(async () => bundle("2", "sid-canceled", "refresh-canceled"));
    const start = await cold.oauth.startOAuth("new-api");
    const callback = cold.oauth.handleCallback(f.callback(start.state));
    await committing.promise;
    await cold.oauth.cancelPending();
    release.resolve();
    await held;
    assert.equal(await callback, null);
    assert.equal(await readFile(f.credentialsFile, "utf8"), before);
    assert.equal(
      (await readdir(f.dir)).some((name) => name.endsWith(".bak")),
      false,
    );
    assert.equal(cold.getOwner(), null);
    assert.ok(f.revoked.includes("sid-canceled"));
  } finally {
    release.resolve();
    await f.dispose();
  }
});

test("canceled recovered login cannot remove another window's newly committed owner", async () => {
  const f = await fixture();
  const entered = barrier<void>();
  const release = barrier<void>();
  try {
    await f.login();
    const records: Record<string, string> = JSON.parse(await readFile(f.credentialsFile, "utf8"));
    const active = Object.keys(records).find((key) => key.endsWith(":active"))!;
    records[active] = "enc:v1:invalid";
    await writeFile(f.credentialsFile, JSON.stringify(records));
    const commit = f.repo.commitVerifiedLogin.bind(f.repo);
    f.repo.commitVerifiedLogin = async (record, assertCurrent) => {
      const previous = await commit(record, assertCurrent);
      entered.resolve();
      await release.promise;
      return previous;
    };
    const cold = f.newService();
    f.setExchange(async () => bundle("2", "sid-recovered-a", "refresh-a"));
    const start = await cold.oauth.startOAuth("new-api");
    const callback = cold.oauth.handleCallback(f.callback(start.state));
    await entered.promise;
    await f.repo.commit({
      schemaVersion: 1,
      origin,
      bundle: bundle("3", "sid-other-window", "refresh-b"),
    });
    await cold.oauth.cancelPending();
    release.resolve();
    assert.equal(await callback, null);
    assert.equal((await f.repo.loadActive())?.bundle.session_id, "sid-other-window");
    assert.equal(cold.getOwner(), null);
    assert.ok(f.revoked.includes("sid-recovered-a"));
    assert.equal(f.revoked.includes("sid-other-window"), false);
  } finally {
    release.resolve();
    await f.dispose();
  }
});

test("cancel after a same-user same-SID re-authorization restores the previous owner", async () => {
  const f = await fixture();
  const entered = barrier<void>();
  const release = barrier<void>();
  try {
    await f.login();
    assert.equal((await f.repo.loadActive())?.bundle.refresh_token, "refresh-1");
    const commit = f.repo.commitVerifiedLogin.bind(f.repo);
    f.repo.commitVerifiedLogin = async (record, assertCurrent) => {
      const previous = await commit(record, assertCurrent);
      entered.resolve();
      await release.promise;
      return previous;
    };
    f.setExchange(async () => bundle("1", "sid-1", "refresh-new"));
    const start = await f.service.oauth.startOAuth("new-api");
    const callback = f.service.oauth.handleCallback(f.callback(start.state));
    await entered.promise;
    await f.service.oauth.cancelPending();
    release.resolve();
    assert.equal(await callback, null);
    // 同键补偿不能删除记录后让 active 指向空记录；取消的授权不得留下它的 refresh secret。
    const restored = await f.repo.loadActive();
    assert.equal(restored?.bundle.session_id, "sid-1");
    assert.equal(restored?.bundle.refresh_token, "refresh-1");
  } finally {
    release.resolve();
    await f.dispose();
  }
});

test("verified login cannot overwrite a malformed credential file", async () => {
  const f = await fixture();
  try {
    await writeFile(f.credentialsFile, "{");
    await assert.rejects(f.login());
    assert.equal(await readFile(f.credentialsFile, "utf8"), "{");
    assert.equal(f.service.getOwner(), null);
  } finally {
    await f.dispose();
  }
});

test("healthy verified login does not create a recovery backup", async () => {
  const f = await fixture();
  try {
    await f.login();
    f.setExchange(async () => bundle("2", "sid-healthy", "refresh-healthy"));
    await f.login();
    assert.equal(
      (await readdir(f.dir)).some((name) => name.endsWith(".bak")),
      false,
    );
    assert.equal((await f.repo.loadActive())?.bundle.session_id, "sid-healthy");
  } finally {
    await f.dispose();
  }
});

test("malformed refresh responses retain confirmed owner and encrypted session for manual recovery", async () => {
  const f = await fixture();
  try {
    await f.login();
    const owner = f.service.getOwner();
    const before = await readFile(f.credentialsFile, "utf8");
    f.setRefresh(async () => ({ ...bundle(), access_token: "opaque" }));
    await assert.rejects(f.service.oauth.refreshToken(), {
      code: "XCODE_PROTOCOL_INVALID",
    });
    assert.deepEqual(f.service.getOwner(), owner);
    assert.equal(await readFile(f.credentialsFile, "utf8"), before);
    assert.deepEqual(f.revoked, []);
  } finally {
    await f.dispose();
  }
});

test("malformed credential files require manual recovery without replacing the stored bytes", async () => {
  const f = await fixture();
  try {
    await f.login();
    await writeFile(f.credentialsFile, "{");
    const cold = f.newService();
    assert.deepEqual(await cold.oauth.restoreCachedSessionState(), {
      status: "unavailable",
      reason: "credential-recovery-required",
    });
    assert.equal(cold.getOwner(), null);
    assert.equal(await readFile(f.credentialsFile, "utf8"), "{");
    assert.deepEqual(f.revoked, []);
  } finally {
    await f.dispose();
  }
});
