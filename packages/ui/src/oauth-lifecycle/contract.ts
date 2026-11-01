import type { IPlatformService, OAuthProviderId } from "@zcode/shared";

// XCODE: 产品账号准入为可选只读策略；未注入时保留上游渠道与状态机。
export interface OAuthAccountPolicy {
  readonly acceptsProvider: (provider: OAuthProviderId) => boolean;
  readonly allowOfficialCloudConnection: boolean;
  readonly unavailableMessageId: string;
  readonly unsupportedMessageId: string;
  readonly errorMessageId: (error: unknown) => string | undefined;
}

export type OAuthLifecyclePlatform = IPlatformService & {
  oauthAccountPolicy?: OAuthAccountPolicy;
};
