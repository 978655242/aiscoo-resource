import {
  isAiscooAdminModelProviderId,
  type ZCodeProviderRuntimeHeadersRequestParams,
} from "@zcode/shared";

/**
 * Aiscoo 托管 Provider 的 runtime headers 请求必须同时满足：
 * - 外层鉴权 Provider 与模型选择的 Provider 相同（两者在 schema 层已各自迁移到规范 ID）；
 * - 携带 `new-api-account` 访问凭据。
 *
 * 账号鉴权解析器只处理带 `accountAccess` 的请求；缺少访问凭据的托管请求会走界面交互路径，
 * 所以这条规则必须在 handler 入口拦截，返回拒绝文案；返回 undefined 表示放行。
 */
export function validateAiscooAdminRuntimeHeadersRequest(
  request: ZCodeProviderRuntimeHeadersRequestParams,
): string | undefined {
  const managed =
    request.accountAccess?.type === "new-api-account" ||
    isAiscooAdminModelProviderId(request.providerId) ||
    isAiscooAdminModelProviderId(request.modelSelection.providerId);
  if (!managed) return undefined;
  if (
    request.providerId !== request.modelSelection.providerId ||
    request.accountAccess?.type !== "new-api-account"
  ) {
    return "Invalid Native provider runtime headers identity";
  }
  return undefined;
}
