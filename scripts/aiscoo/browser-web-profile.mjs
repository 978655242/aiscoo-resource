// 本机代理曾整体替换上游表，导致远控/分享 OAuth 被 /api 通配送到本机。
// 保留既有专用目标，再追加本机条目；关闭时返回原表，不修改共享配置对象。
export function composeBrowserWebProxy(profile, existing) {
  if (!profile) return existing;
  const specific = Object.fromEntries(
    Object.entries(existing).filter(([path]) => path !== "/ws" && path !== "/api"),
  );
  return { ...specific, ...profile.proxy };
}

// 产品入口不提供旧官方 token 代理，避免直接 HTTP 绕过页面门禁。
export function aiscooAccountLoginBoundaryPlugin() {
  const configure = (server) => {
    // Vite 把返回函数当 post hook；Connect use 返回 app，必须在此显式返回 void。
    server.middlewares.use((req, res, next) => {
      if (/^\/api\/v1\/oauth(?:\/|$)/.test(req.url?.split("?")[0] ?? "")) {
        res.statusCode = 403;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ code: "AISCOO_ACCOUNT_LOGIN_UNSUPPORTED" }));
        return;
      }
      next();
    });
  };
  return {
    name: "aiscoo-account-login-policy",
    enforce: "pre",
    configureServer: configure,
    configurePreviewServer: configure,
  };
}

// 本机 Web 只增加公开配置、同源代理与开发服务器入口限制，不持有登录凭据。
export function browserWebProfile(env) {
  if (env.AISCOO_BROWSER_NEW_API !== "1") return null;
  const origin = new URL(env.AISCOO_ADMIN_BASE_URL || "");
  const browser = new URL(env.AISCOO_BROWSER_ORIGIN || "http://127.0.0.1:5173");
  const serverPort = Number(env.PORT || 3030);
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/" ||
    !["https:", "http:"].includes(origin.protocol) ||
    (origin.protocol === "http:" &&
      !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname)) ||
    !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(browser.origin) ||
    browser.href !== `${browser.origin}/` ||
    Number(browser.port) > 65535 ||
    !Number.isInteger(serverPort) ||
    serverPort < 1 ||
    serverPort > 65535
  )
    throw new Error("AISCOO_BROWSER_CONFIG_INVALID");
  return {
    origin: origin.origin,
    browserOrigin: browser.origin,
    server: {
      host: "127.0.0.1",
      port: Number(browser.port),
      strictPort: true,
      cors: false,
      allowedHosts: ["127.0.0.1"],
    },
    proxy: {
      "/api/xcode/v1": { target: origin.origin, changeOrigin: true, secure: true },
      "/ws": { target: `ws://127.0.0.1:${serverPort}`, ws: true },
      "/api": { target: `http://127.0.0.1:${serverPort}` },
    },
    plugin: {
      name: "aiscoo-browser-account-boundary",
      enforce: "pre",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const requestOrigin = req.headers.origin;
          // Aiscoo 只接受既有精确 loopback callback；远控/分享旧官方回跳不再开放。
          const callbackPaths = new Set(["/oauth/callback"]);
          const callbackNavigation =
            req.method === "GET" &&
            callbackPaths.has(req.url?.split("?")[0]) &&
            req.headers["sec-fetch-mode"] === "navigate";
          if (
            req.headers.host !== browser.host ||
            (requestOrigin && requestOrigin !== browser.origin) ||
            (req.headers["sec-fetch-site"] === "cross-site" && !callbackNavigation) ||
            req.url?.split("?")[0] === "/__open-in-editor"
          ) {
            res.statusCode = 403;
            res.end("Forbidden");
            return;
          }
          next();
        });
      },
    },
  };
}
