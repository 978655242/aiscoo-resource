import type { IPlatformService, OAuthProviderId } from "@zcode/shared";

// XCODE: 产品账号准入为可选只读策略；未注入时保留上游渠道与状态机。
// 登录命令、回调与恢复由产品服务包装拒绝，这里只供设置页隐藏不被接受的账号套餐入口。
export interface OAuthAccountPolicy {
  readonly acceptsProvider: (provider: OAuthProviderId) => boolean;
}

export type OAuthLifecyclePlatform = IPlatformService & {
  oauthAccountPolicy?: OAuthAccountPolicy;
};
