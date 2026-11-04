import { normalizeAiscooAdminOrigin } from "@zcode/shared";

/** 本机浏览器入口只接受配置中的两个精确 loopback Host，不接受 localhost 别名。 */
export function resolveBrowserAccountProfile(env: Record<string, string | undefined>) {
  if (env.AISCOO_BROWSER_NEW_API !== "1") return null;
  const origin = normalizeAiscooAdminOrigin(env.AISCOO_ADMIN_BASE_URL ?? "");
  const browser = new URL(env.AISCOO_BROWSER_ORIGIN || "http://127.0.0.1:5173");
  const port = Number(env.PORT || 3030);
  if (
    !/^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})$/.test(browser.origin) ||
    browser.href !== `${browser.origin}/` ||
    Number(browser.port) > 65535 ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error("AISCOO_BROWSER_ORIGIN_INVALID");
  const hosts = new Set([`127.0.0.1:${port}`, browser.host]);
  return {
    origin,
    browserOrigin: browser.origin,
    port,
    acceptRequest(request: Request): boolean {
      const host = request.headers.get("host") ?? new URL(request.url).host;
      const requestOrigin = request.headers.get("origin");
      return (
        hosts.has(host) &&
        request.headers.get("sec-fetch-site") !== "cross-site" &&
        (!requestOrigin || requestOrigin === browser.origin)
      );
    },
  };
}
