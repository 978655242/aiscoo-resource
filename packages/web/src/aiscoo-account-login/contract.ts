import type { ComponentProps, ReactNode } from "react";
import type {
  BrowserAiscooAdminAccount,
  BrowserAccountConnectionFailure,
} from "../aiscoo-browser-account/index.js";
import type { WebAuthService } from "#src/auth/webAuthService.js";
import type { ConversationShareLandingLoader } from "#src/share/ConversationShareLandingPage.js";

/** 产品前置页只投影不可用状态，不读取或修改官方存储。 */
export type AiscooWebAuth = Pick<
  WebAuthService,
  "getZCodeJwtToken" | "getActiveAccount" | "startLogin" | "logout" | "handleCallback"
>;
export type AiscooPublicShareProps = ComponentProps<typeof ConversationShareLandingLoader>;
export interface AiscooWebEntryOptions {
  href: string;
  browserAccountOrigin?: string;
  remoteRoute: boolean;
}
export type AiscooWebEntry = "public-share" | "local" | "unsupported" | "unconfigured";

export interface AiscooWebConnectionPageProps {
  failure?: BrowserAccountConnectionFailure;
  onRetry(): void;
  /** Only an unconfirmed local page may begin its own existing browser OAuth flow. */
  onLogin?(): Promise<void>;
  locale?: string;
}

/** 组合连接状态与本页登录命令，不持有或清除账号凭据。 */
export interface AiscooBrowserWebStartupOptions {
  account: BrowserAiscooAdminAccount;
  render(node: ReactNode): void;
  isPageUnloading(): boolean;
  locale?: string;
}
