import { useEffect, useRef, useState } from "react";
import { Button } from "@zcode/ui";
import { PRODUCT_NAME } from "@zcode/shared/aiscoo-brand";
import {
  createBrowserAccountWebConnection,
  type BrowserAccountWebConnection,
} from "../aiscoo-browser-account/index.js";
import type { AiscooBrowserWebStartupOptions, AiscooWebConnectionPageProps } from "./contract.js";

export function AiscooWebConnectionPage({
  failure,
  onRetry,
  onLogin,
  locale,
}: AiscooWebConnectionPageProps) {
  const zh = (locale ?? navigator.language).startsWith("zh");
  const state = failure?.reason ?? "connecting";
  const canLogin = state === "account-mismatch" && !!onLogin;
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginFailed, setLoginFailed] = useState(false);
  const loginPending = useRef(false);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const startLogin = async () => {
    if (!onLogin || loginPending.current) return;
    loginPending.current = true;
    setLoginBusy(true);
    setLoginFailed(false);
    try {
      await onLogin();
      // 导航已发起时保持忙态，防止离页前再次点击覆盖本页 PKCE proof。
    } catch {
      loginPending.current = false;
      if (active.current) {
        setLoginBusy(false);
        setLoginFailed(true);
      }
    }
  };
  const title = canLogin
    ? zh
      ? "登录 Aiscoo"
      : "Sign in to Aiscoo"
    : state === "connecting"
      ? zh
        ? "正在连接 Aiscoo"
        : "Connecting to Aiscoo"
      : state === "account-in-use"
        ? zh
          ? "账号连接已被其他页面占用"
          : "Account connection in use"
        : state === "account-mismatch"
          ? zh
            ? "账号连接不匹配"
            : "Account connection mismatch"
          : zh
            ? "与 Aiscoo 的连接已断开"
            : "Connection lost";
  const description = canLogin
    ? zh
      ? "请在此页面登录 Aiscoo。登录完成后将重新验证账号连接。"
      : "Sign in to Aiscoo on this page. Your account connection will be checked again after sign-in."
    : state === "connecting"
      ? zh
        ? "正在恢复账号和应用，请稍候。"
        : "Restoring your account and application. Please wait."
      : state === "account-in-use"
        ? zh
          ? "请关闭正在使用此用户端的其他标签页，再点击重试。"
          : "Close other tabs using this app, then retry."
        : state === "account-mismatch"
          ? zh
            ? "此页面的登录会话与本机服务当前使用的会话不同。请关闭使用其他会话的页面，再点击重试。登录信息会保留。"
            : "This page's sign-in session does not match the session currently used by the local service. Close pages using a different session, then retry. Your sign-in is preserved."
          : zh
            ? "请确认本机服务正在运行，然后重试。登录信息会保留。"
            : "Check that the local service is running, then retry. Your sign-in is preserved.";
  return (
    <main
      className="flex h-full min-h-0 items-center justify-center bg-background px-4 py-8 text-foreground"
      data-testid="aiscoo-web-connection-page"
      data-state={state}
    >
      <section
        className="w-full max-w-md rounded-xl border border-card-border bg-card p-6"
        role={failure ? "alert" : "status"}
      >
        <div className="mb-4 text-ui-sm font-medium text-brand">{PRODUCT_NAME}</div>
        <h1 className="text-ui-xl font-semibold">{title}</h1>
        <p className="mt-3 text-ui-base leading-6 text-foreground-subtle">{description}</p>
        {failure ? (
          <div className="mt-5 flex flex-wrap gap-3">
            {canLogin ? (
              <Button
                type="button"
                data-testid="oauth-login-button-new-api"
                disabled={loginBusy}
                aria-busy={loginBusy}
                onClick={() => {
                  void startLogin();
                }}
              >
                {loginBusy ? (zh ? "正在登录..." : "Signing in...") : zh ? "登录" : "Sign in"}
              </Button>
            ) : null}
            <Button
              type="button"
              variant={canLogin ? "outline" : undefined}
              disabled={loginBusy}
              onClick={onRetry}
            >
              {zh ? "重试" : "Retry"}
            </Button>
          </div>
        ) : null}
        {canLogin && loginFailed ? (
          <p role="alert" className="mt-3 text-ui-base text-destructive">
            {zh ? "无法发起登录，请重试。" : "Unable to start sign-in. Please try again."}
          </p>
        ) : null}
      </section>
    </main>
  );
}

/** 普通 Web 独占本次启动的状态页；旧连接结束后不能再挂载旧 Root。 */
export function createAiscooBrowserWebStartup({
  account,
  render,
  isPageUnloading,
  locale,
}: AiscooBrowserWebStartupOptions): BrowserAccountWebConnection {
  let disposed = false;
  let loginFlight: Promise<void> | undefined;
  const onRetry = () => {
    if (disposed || isPageUnloading()) return;
    dispose();
    window.location.reload();
  };
  const onLogin = () => {
    if (disposed || isPageUnloading()) return Promise.resolve();
    if (loginFlight) return loginFlight;
    if (account.getOwner() !== null) return Promise.resolve();
    const attempt = (async () => {
      const flow = await account.oauth.startOAuth("new-api");
      if (!disposed && !isPageUnloading()) window.location.assign(flow.authorizeUrl);
    })();
    loginFlight = attempt;
    void attempt.catch(() => {
      if (loginFlight === attempt) loginFlight = undefined;
    });
    return attempt;
  };
  const connection = createBrowserAccountWebConnection({
    account,
    onFailure: (failure) => {
      if (!disposed && !isPageUnloading()) {
        // 控制器先终止旧连接再通知；只对已准入后的换号重载一次，冲突账号保留显式重试。
        if (failure.reason === "account-changed") onRetry();
        else
          render(
            <AiscooWebConnectionPage
              failure={failure}
              onRetry={onRetry}
              locale={locale}
              onLogin={
                failure.reason === "account-mismatch" && account.getOwner() === null
                  ? onLogin
                  : undefined
              }
            />,
          );
      }
    },
  });
  function dispose() {
    if (disposed) return;
    // 连接关闭后故障页仍可显式登录；离页/重试才终止页面命令，迟到授权结果不能导航。
    disposed = true;
    window.removeEventListener("beforeunload", dispose);
    connection.dispose();
  }
  window.addEventListener("beforeunload", dispose, { once: true });
  return {
    get closed() {
      return connection.closed;
    },
    connect(wsUrl) {
      if (!connection.closed) {
        render(<AiscooWebConnectionPage onRetry={onRetry} locale={locale} />);
      }
      return connection.connect(wsUrl);
    },
    dispose,
  };
}
