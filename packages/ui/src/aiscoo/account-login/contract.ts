import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import type { OAuthLifecyclePlatform } from "@/oauth-lifecycle/contract.js";

/** 只归当前 Desktop Root 的展示状态，身份与退出副作用仍由原 owner/动作持有。 */
export interface AiscooLogoutPresentation {
  run(action: () => Promise<void>): Promise<void>;
  confirmed(): void;
  isExiting(): boolean;
}

/** 只读产品装配，不拥有账号、凭据、pending flow 或第二份身份状态。 */
export interface AiscooAccountLoginAssembly {
  services(services: IServiceAccessor): IServiceAccessor;
  platform(platform: IPlatformService): OAuthLifecyclePlatform;
}
