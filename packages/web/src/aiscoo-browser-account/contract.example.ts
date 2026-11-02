import type { BrowserNewApiAccount, BrowserAccountWebConnection } from "./contract.js";

/** Socket open 之后仍需等待既有 RPC 准入，关闭后的结果不能挂载页面。 */
export async function connectBrowserAccountPage(
  connection: BrowserAccountWebConnection,
  wsUrl: string,
) {
  const services = await connection.connect(wsUrl);
  return connection.closed ? null : services;
}

/** Attach only after server-confirmed restore; getOwner is a synchronous projection. */
export async function restoreBrowserAccount(account: BrowserNewApiAccount) {
  const session = await account.oauth.restoreCachedSessionState();
  return { owner: account.getOwner(), session };
}

/** Existing WebCallbackPage adapter; the account never accepts arbitrary return targets. */
export async function completeBrowserAccount(account: BrowserNewApiAccount, callbackUrl: string) {
  const result = await account.oauth.handleCallback(callbackUrl);
  return result?.kind === "session" ? { userInfo: result.userInfo, appReturnTo: "/" } : null;
}
