import type { IServiceAccessor } from "@zcode/services";
import type { IPlatformService } from "@zcode/shared";
import { createAiscooAccountLoginPlatform, createAiscooAccountLoginServices } from "./index.js";

export function aiscooAccountLoginExample(services: IServiceAccessor, platform: IPlatformService) {
  return {
    services: createAiscooAccountLoginServices(services),
    platform: createAiscooAccountLoginPlatform(platform),
  };
}
