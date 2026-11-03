export type {
  AccountAccessIdentityInput,
  AccountRequestAuthResolver,
} from "../model-provider/accountProviderRequestAuthService.js";
export type { ZCodeProviderRuntimeHeadersRequestParams } from "@zcode/shared";

/** runtime headers 请求校验器：返回拒绝文案即拒绝请求，返回 undefined 表示放行。 */
export type RuntimeHeadersRequestValidator = (
  request: import("@zcode/shared").ZCodeProviderRuntimeHeadersRequestParams,
) => string | undefined;
