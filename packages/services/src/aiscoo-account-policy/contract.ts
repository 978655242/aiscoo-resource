import type { AccountProviderResolver } from "@zcode/provider";
import type { AiscooAdminAccountService } from "../aiscoo-admin/aiscooAdminAccountService.js";
import type { IOAuthService } from "../oauth/oauth.js";
import type { OfficialCloudConnectionHost } from "../official-mcp/officialCloudConnectionService.js";
import type { AccountRequestAuthResolver } from "../model-provider/accountProviderRequestAuthService.js";
import type { ICodingPlanSubscriptionService } from "../coding-plan-subscription/codingPlanSubscription.js";
import type { IUsageStatsService } from "../usage-stats/usageStats.js";
import type { LocalCredentialService } from "../credential/credentialService.js";

export type PolicyAccountAuthority = Pick<
  AiscooAdminAccountService,
  "oauth" | "getOwner" | "isCurrent" | "withControlSession" | "getRelayCredential"
>;

/** Optional composition port. An omitted policy preserves the generic Host behavior. */
export interface HostAccountPolicy {
  readonly aiscooAdminOrigin: string | null;
  /** Built-in 使用已验证 origin；缺配置失败，不触发官方远端读取。 */
  readonly resolveBuiltinEndpointOrigin: () => string;
  readonly allowOfficialCloud: boolean;
  createUnavailableAccount(): PolicyAccountAuthority;
  wrapOAuth(oauth: IOAuthService): IOAuthService;
  wrapCredentials(credentials: LocalCredentialService): LocalCredentialService;
  readonly unavailableProviders: AccountProviderResolver;
  readonly unavailableRequestAuth: AccountRequestAuthResolver;
  /** Stateless unavailable capability, never a credential/session owner. */
  readonly unavailableOfficialCloud: OfficialCloudConnectionHost;
  wrapSubscription(service: ICodingPlanSubscriptionService): ICodingPlanSubscriptionService;
  wrapUsage(service: IUsageStatsService): IUsageStatsService;
}
