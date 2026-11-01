import assert from "node:assert/strict";
import test from "node:test";
import { preview } from "vite";
import { fileURLToPath } from "node:url";
import {
  browserWebProfile,
  composeBrowserWebProxy,
  aiscooAccountLoginBoundaryPlugin,
} from "./browser-web-profile.mjs";

const env = { AISCOO_BROWSER_NEW_API: "1", AISCOO_ADMIN_BASE_URL: "https://account.example" };
test("disabled profile leaves existing Web configuration unchanged", () => {
  assert.equal(browserWebProfile({}), null);
});
test("retired backend key neither enables nor overrides the Admin profile", () => {
  assert.equal(browserWebProfile({ NEW_API_BASE_URL: "https://retired.example" }), null);
  assert.throws(() =>
    browserWebProfile({
      AISCOO_BROWSER_NEW_API: "1",
      NEW_API_BASE_URL: env.AISCOO_ADMIN_BASE_URL,
    }),
  );
  assert.equal(
    browserWebProfile({ ...env, NEW_API_BASE_URL: "https://retired.example" }).origin,
    env.AISCOO_ADMIN_BASE_URL,
  );
  assert.throws(() =>
    browserWebProfile({
      ...env,
      AISCOO_ADMIN_BASE_URL: "",
      NEW_API_BASE_URL: "https://retired.example",
    }),
  );
});
test("profile only adds public origin, fixed loopback and same-origin proxies", () => {
  const profile = browserWebProfile(env);
  assert.equal(profile.origin, env.AISCOO_ADMIN_BASE_URL);
  assert.deepEqual(profile.server, {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    cors: false,
    allowedHosts: ["127.0.0.1"],
  });
  assert.equal(Object.keys(profile.proxy)[0], "/api/xcode/v1");
  assert.equal(profile.proxy["/api/xcode/v1"].target, env.AISCOO_ADMIN_BASE_URL);
  assert.equal(profile.proxy["/ws"].target, "ws://127.0.0.1:3030");
});
test("entry boundary runs before Vite and rejects cross-site and editor actions", () => {
  let middleware;
  browserWebProfile(env).plugin.configureServer({
    middlewares: {
      use(fn) {
        middleware = fn;
      },
    },
  });
  for (const [headers, url, accepted] of [
    [{ host: "127.0.0.1:5173" }, "/", true],
    [{ host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" }, "/ws", true],
    [{ host: "evil.localhost:5173" }, "/", false],
    [{ host: "127.0.0.1:5173", origin: "https://evil.example" }, "/@fs/file", false],
    [{ host: "127.0.0.1:5173", "sec-fetch-site": "cross-site" }, "/", false],
    [{ host: "127.0.0.1:5173" }, "/__open-in-editor?file=private", false],
  ]) {
    let reached = false;
    const res = { end() {} };
    middleware({ headers, url }, res, () => {
      reached = true;
    });
    assert.equal(reached, accepted);
    if (!accepted) assert.equal(res.statusCode, 403);
  }
});
test("authorization callback permits only a cross-site top-level navigation", () => {
  let middleware;
  browserWebProfile(env).plugin.configureServer({
    middlewares: {
      use(fn) {
        middleware = fn;
      },
    },
  });
  for (const path of [
    "/oauth/callback",
    "/remote/v4",
    "/remote/v4/",
    "/share/callback",
    "/cn/share/callback",
  ]) {
    for (const mode of ["navigate", "no-cors"]) {
      let reached = false;
      middleware(
        {
          method: "GET",
          url: `${path}?provider=synthetic&code=synthetic&state=synthetic`,
          headers: {
            host: "127.0.0.1:5173",
            "sec-fetch-site": "cross-site",
            "sec-fetch-mode": mode,
          },
        },
        { end() {} },
        () => {
          reached = true;
        },
      );
      assert.equal(reached, path === "/oauth/callback" && mode === "navigate", `${path} ${mode}`);
    }
  }
});
test("local account proxies preserve existing OAuth and remote routes ahead of the API fallback", () => {
  const oauth = { target: "https://official.example", changeOrigin: true, secure: true };
  const remote = { ...oauth, ws: true };
  const existing = {
    "/api/v1/oauth/token": oauth,
    "/api/v1/remote": remote,
    "/ws": { target: "ws://localhost:3030", ws: true },
    "/api": { target: "http://localhost:3030" },
  };
  assert.equal(composeBrowserWebProxy(null, existing), existing);
  const proxy = composeBrowserWebProxy(browserWebProfile(env), existing);
  assert.equal(proxy["/api/v1/oauth/token"], oauth);
  assert.equal(proxy["/api/v1/remote"], remote);
  const target = (path) => proxy[Object.keys(proxy).find((prefix) => path.startsWith(prefix))];
  assert.equal(target("/api/v1/oauth/token"), oauth);
  assert.equal(target("/api/v1/remote/devices"), remote);
  assert.equal(target("/api/xcode/v1/auth/token").target, env.AISCOO_ADMIN_BASE_URL);
  assert.equal(target("/api/info").target, "http://127.0.0.1:3030");
  assert.equal(target("/ws").target, "ws://127.0.0.1:3030");
  assert.equal(existing["/api"].target, "http://localhost:3030");
});

test("product boundary rejects the official token proxy before it can forward cookies", () => {
  let middleware;
  const plugin = aiscooAccountLoginBoundaryPlugin();
  for (const register of [plugin.configureServer, plugin.configurePreviewServer]) {
    assert.equal(
      register({
        middlewares: {
          use(fn) {
            middleware = fn;
            return () => {
              throw new Error("connect instance must not become a Vite post hook");
            };
          },
        },
      }),
      undefined,
    );
    let forwarded = false;
    let result;
    const res = {
      setHeader() {},
      end(body) {
        result = body;
      },
    };
    middleware({ url: "/api/v1/oauth/token?secret=never-forward", method: "POST" }, res, () => {
      forwarded = true;
    });
    assert.equal(res.statusCode, 403);
    assert.equal(forwarded, false);
    assert.match(result, /AISCOO_ACCOUNT_LOGIN_UNSUPPORTED/);
    assert.doesNotMatch(result, /secret/);
  }
});

test("actual Vite preview starts with the product boundary and rejects old OAuth HTTP", async () => {
  const server = await preview({
    root: fileURLToPath(new URL("../../packages/web", import.meta.url)),
    configFile: false,
    plugins: [aiscooAccountLoginBoundaryPlugin()],
    preview: { host: "127.0.0.1", port: 0, open: false },
  });
  try {
    const address = server.httpServer.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/oauth/token`, {
      method: "POST",
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { code: "AISCOO_ACCOUNT_LOGIN_UNSUPPORTED" });
  } finally {
    await server.close();
  }
});

test("invalid origins never turn into a proxy target", () => {
  for (const origin of [
    "http://evil.example",
    "https://user:pass@account.example",
    "https://account.example/path",
  ]) {
    assert.throws(() => browserWebProfile({ ...env, AISCOO_ADMIN_BASE_URL: origin }));
  }
  for (const browserOrigin of [
    "http://localhost:5173",
    "http://127.0.0.1:80",
    "https://127.0.0.1:5173",
  ]) {
    assert.throws(() => browserWebProfile({ ...env, AISCOO_BROWSER_ORIGIN: browserOrigin }));
  }
});
