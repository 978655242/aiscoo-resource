import type { AccountProviderResolver } from "@zcode/provider";
import type { NewApiAccountService } from "../new-api/newApiAccountService.js";
import type { IOAuthService } from "../oauth/oauth.js";
import type { OfficialCloudConnectionHost } from "../official-mcp/officialCloudConnectionService.js";
import type { AccountRequestAuthResolver } from "../model-provider/accountProviderRequestAuthService.js";
import type { ICodingPlanSubscriptionService } from "../coding-plan-subscription/codingPlanSubscription.js";
import type { IUsageStatsService } from "../usage-stats/usageStats.js";
import type { LocalCredentialService } from "../credential/credentialService.js";

export type PolicyAccountAuthority = Pick<
  NewApiAccountService,
  "oauth" | "getOwner" | "isCurrent" | "withControlSession" | "getRelayCredential"
>;

/** Optional composition port. An omitted policy preserves the generic Host behavior. */
export interface HostAccountPolicy {
  readonly newApiOrigin: string | null;
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
