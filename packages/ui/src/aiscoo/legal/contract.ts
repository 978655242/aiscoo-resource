import type { OAuthProviderMeta } from "@zcode/shared";

/** 公开法律链接的只读投影；不发起登录、不读取或保存会话。 */
export interface AiscooLegalLinksProps {
  providers: readonly OAuthProviderMeta[];
  placement: "login" | "settings";
}

export type AiscooAdminLegalLinks = NonNullable<OAuthProviderMeta["legalLinks"]>;
