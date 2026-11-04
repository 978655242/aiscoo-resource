// 浏览器驱动：只操作原生 Aiscoo 页面（登录、2FA、Passkey、授权页），不绕过任何认证步骤。
import { chromium } from "playwright-core";
import { freshTotp } from "./totp.mjs";

// XCODE: 授权页已使用 aiscoo 文案；客户端协议标识仍按既有契约校验。
const AUTHORIZE_BUTTON = /^(Authorize and open aiscoo|授权并打开 aiscoo)$/;
const VIRTUAL_AUTHENTICATOR = { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true };

export async function launchBrowser() {
  return chromium.launch({ channel: "chrome", headless: true });
}

export async function newSession(browser, { passkeyCredentials } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  let cdp;
  let authenticatorId;
  if (passkeyCredentials !== undefined) {
    cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: VIRTUAL_AUTHENTICATOR }));
    for (const credential of passkeyCredentials) await cdp.send("WebAuthn.addCredential", { authenticatorId, credential });
  }
  return {
    context, page,
    async credentials() {
      return (await cdp.send("WebAuthn.getCredentials", { authenticatorId })).credentials;
    },
    close: () => context.close(),
  };
}

const isSignInPath = (url) => /^\/(login|sign-in)(\/|$)/.test(new URL(url).pathname);

async function submitPassword(page, account) {
  await page.locator('input[name="username"]').fill(account.username);
  await page.locator('input[name="password"]').fill(account.password);
  await page.locator('form button[type="submit"]').click();
}

async function completeTotpIfPrompted(page, account) {
  await page.waitForURL((url) => !isSignInPath(url.href), { timeout: 15_000 });
  if (!new URL(page.url()).pathname.startsWith("/otp")) return false;
  if (!account.totpSecret) throw new Error("2FA prompt shown for an account without TOTP");
  const input = page.locator('input[autocomplete="one-time-code"]');
  await input.waitFor();
  await input.fill(await freshTotp(account.totpSecret));
  await page.getByRole("button", { name: /^(Verify|验证)$/ }).last().click();
  await page.waitForURL((url) => !url.pathname.startsWith("/otp"), { timeout: 15_000 });
  return true;
}

/** 原生密码登录（含 2FA）。返回是否真的经过了 TOTP 步骤。 */
export async function nativeLogin(page, origin, account) {
  await page.goto(`${origin}/login`);
  await submitPassword(page, account);
  return completeTotpIfPrompted(page, account);
}

export async function openSecurity(page) {
  await page.getByRole("link", { name: /安全与访问|Security/ }).first().click();
  await page.waitForLoadState("networkidle");
}

async function confirmPassword(page, password) {
  const dialog = page.locator('[role="dialog"]').last();
  await dialog.locator('input[type="password"]').fill(password);
  await dialog.getByRole("button", { name: /^(Verify|验证)$/ }).click();
}

/** 经原生安全验证启用 TOTP，并把密钥只保存在内存中的合成账号对象上。 */
export async function enableTotp(page, account) {
  await openSecurity(page);
  await page.getByRole("button", { name: /^(Enable|启用)$/ }).first().click();
  await confirmPassword(page, account.password);
  const dialog = page.locator('[role="dialog"]').last();
  await dialog.getByText(/[A-Z2-7]{16,}/).first().waitFor();
  account.totpSecret = (await dialog.innerText()).match(/\b[A-Z2-7]{16,}\b/)[0];
  for (let step = 0; step < 2; step += 1) await page.getByRole("button", { name: /^(Next|下一步)$/ }).click();
  await dialog.locator("input").last().fill(await freshTotp(account.totpSecret));
  await page.getByRole("button", { name: /^(Enable 2FA|启用 2FA)$/ }).click();
  await page.getByText(/剩余备份代码|Backup codes remaining/).waitFor({ timeout: 15_000 });
}

export async function registerPasskey(session, account) {
  await openSecurity(session.page);
  await session.page.getByRole("button", { name: /启用 Passkey|Enable Passkey/ }).click();
  await confirmPassword(session.page, account.password);
  await session.page.getByRole("button", { name: /解绑 Passkey|Remove Passkey/ }).waitFor({ timeout: 15_000 });
  return session.credentials();
}

/**
 * 打开 CLI 给出的授权 URL，按需完成原生登录（密码/2FA/Passkey），然后主动授权。
 * method: "password" | "passkey" | "existing"
 */
export async function authorizeInBrowser(session, url, { account, method = "password" } = {}) {
  const { page } = session;
  await page.goto(url);
  await page.waitForLoadState("networkidle");
  const loginRequired = isSignInPath(page.url());
  if (method === "existing" && loginRequired) throw new Error("expected an existing browser session");
  let usedTotp = false;
  if (loginRequired && method === "passkey") {
    await page.getByRole("button", { name: /使用 Passkey 登录|Sign in with Passkey/ }).click();
  } else if (loginRequired) {
    await submitPassword(page, account);
    usedTotp = await completeTotpIfPrompted(page, account);
  }
  const button = page.getByRole("button", { name: AUTHORIZE_BUTTON });
  try {
    await button.waitFor({ timeout: 20_000 });
  } catch (error) {
    throw new Error(`authorize button missing at ${new URL(page.url()).pathname}: ${(await page.locator("body").innerText()).slice(0, 600)}`, { cause: error });
  }
  const pageText = await page.locator("body").innerText();
  const callback = page.waitForRequest((request) => /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback\?/.test(request.url()), { timeout: 15_000 }).catch(() => undefined);
  await button.click();
  const callbackRequest = await callback;
  const callbackStatus = callbackRequest ? (await callbackRequest.response())?.status() : undefined;
  return { loginRequired, usedTotp, pageText, callbackStatus };
}

/** 在授权页选择“使用其他账户”，退出浏览器会话后用另一账号重新登录并授权同一请求。 */
export async function switchAccountAndAuthorize(session, url, account) {
  const { page } = session;
  await page.goto(url);
  await page.getByRole("button", { name: /^(Use another account|使用其他账户)$/ }).click();
  await page.getByRole("button", { name: /^(Sign out and switch|退出并切换)$/ }).click();
  await page.locator('input[name="username"]').waitFor({ timeout: 15_000 });
  await submitPassword(page, account);
  await completeTotpIfPrompted(page, account);
  await page.getByRole("button", { name: AUTHORIZE_BUTTON }).waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: AUTHORIZE_BUTTON }).click();
}
