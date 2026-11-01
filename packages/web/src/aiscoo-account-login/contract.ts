import type { ComponentProps } from "react";
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
