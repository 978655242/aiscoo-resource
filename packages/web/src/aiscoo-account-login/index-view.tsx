import { useMemo, useState } from "react";
import { normalizeNewApiOrigin } from "@zcode/shared";
import { PRODUCT_NAME } from "@zcode/shared/aiscoo-brand";
import { ConversationShareLandingLoader as UpstreamShareLoader } from "#src/share/ConversationShareLandingPage.js";
import type {
  AiscooPublicShareProps,
  AiscooWebAuth,
  AiscooWebEntry,
  AiscooWebEntryOptions,
} from "./contract.js";

const unsupported = () => new Error("AISCOO_ACCOUNT_LOGIN_UNSUPPORTED");

/** 官方实现保持可复用；产品实例不接触旧 JWT、cookie、pending 或 token。 */
export function createAiscooWebAuth(): AiscooWebAuth {
  return {
    getZCodeJwtToken: () => null,
    getActiveAccount: () => null,
    startLogin: () => {
      throw unsupported();
    },
    handleCallback: async () => {
      throw unsupported();
    },
    logout: async () => {},
  };
}

export function resolveAiscooWebEntry(options: AiscooWebEntryOptions): AiscooWebEntry {
  const url = new URL(options.href);
  if (
    options.remoteRoute ||
    url.pathname.startsWith("/remote") ||
    url.searchParams.has("remote") ||
    ["/share/callback", "/cn/share/callback"].includes(url.pathname)
  )
    return "unsupported";
  if (/^\/(?:cn\/)?share\/[^/]+\/?$/.test(url.pathname)) return "public-share";
  if (!options.browserAccountOrigin) return "unconfigured";
  try {
    normalizeNewApiOrigin(options.browserAccountOrigin);
  } catch {
    return "unconfigured";
  }
  // 浏览器 New API 回调只支持既有精确 loopback grammar；不扩展 origin/CORS。
  if (
    !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(url.origin) ||
    !url.port ||
    Number(url.port) > 65535
  )
    return "unsupported";
  if (url.pathname === "/oauth/callback" && url.searchParams.get("provider") !== "new-api")
    return "unsupported";
  return ["/", "/oauth/callback"].includes(url.pathname) ? "local" : "unsupported";
}

export function AiscooWebLoginPage({
  reason = "unsupported",
  locale,
}: {
  reason?: "unsupported" | "unconfigured";
  locale?: string;
}) {
  const zh = (locale ?? navigator.language).startsWith("zh");
  return (
    <main className="flex h-full min-h-0 items-center justify-center bg-background px-4 py-8 text-foreground">
      <section className="w-full max-w-md rounded-lg border border-card-border bg-card p-6">
        <div className="mb-4 text-ui-sm font-medium text-brand">{PRODUCT_NAME}</div>
        <h1 className="text-ui-xl font-semibold">
          {zh ? "Aiscoo 登录不可用" : "Aiscoo sign-in unavailable"}
        </h1>
        <p className="mt-3 text-ui-base leading-6 text-foreground-subtle">
          {reason === "unconfigured"
            ? zh
              ? "尚未配置 Aiscoo 账号服务，请联系管理员。"
              : "The Aiscoo account service is not configured. Contact your administrator."
            : zh
              ? "此页面暂不支持 Aiscoo 账号登录。公开只读分享仍可查看。"
              : "Aiscoo sign-in is not supported on this page. Public read-only shares remain available."}
        </p>
        <a className="mt-5 inline-block text-ui-base text-brand underline" href="/">
          {zh ? "返回首页" : "Back to home"}
        </a>
      </section>
    </main>
  );
}

/** 公开分享只做匿名读取；受保护响应不能转入旧 provider 登录提示。 */
export function AiscooPublicShareLoader(props: AiscooPublicShareProps) {
  const [unavailable, setUnavailable] = useState(false);
  const client = useMemo(
    () => ({
      async getPreview(code: string) {
        try {
          const preview = await props.client.getPreview(code);
          if (preview.share.access_mode !== "public_readonly") {
            setUnavailable(true);
            throw unsupported();
          }
          return preview;
        } catch (error) {
          const kind =
            error && typeof error === "object" && "kind" in error ? error.kind : undefined;
          if (kind === "authentication_required" || kind === "not_found") setUnavailable(true);
          throw error;
        }
      },
    }),
    [props.client],
  );
  return unavailable ? (
    <AiscooWebLoginPage locale={props.locale} />
  ) : (
    <UpstreamShareLoader
      shareCode={props.shareCode}
      client={client}
      locale={props.locale}
      theme={props.theme}
    />
  );
}

export function anonymousAiscooShareFetch(input: RequestInfo | URL, init?: RequestInit) {
  return globalThis.fetch(input, { ...init, credentials: "omit", redirect: "error" });
}
