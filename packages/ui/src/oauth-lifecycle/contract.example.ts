import type { OAuthAccountPolicy, OAuthLifecyclePlatform } from "./contract.js";

/** 产品装配时显式注入；缺省不干预现有行为。 */
export function withOAuthAccountPolicy(
  platform: OAuthLifecyclePlatform,
  policy: OAuthAccountPolicy,
): OAuthLifecyclePlatform {
  return Object.assign(platform, { oauthAccountPolicy: policy });
}
