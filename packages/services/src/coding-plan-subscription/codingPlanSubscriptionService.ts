import {
  applyDynamicWorkflowUserMode,
  type ApiClient,
  type SelfServiceReadResult,
} from "@zcode/shared";
import type { ICredentialService } from "../credential/credential.js";
import type { ICodingPlanSubscriptionService } from "./codingPlanSubscription.js";
import { BigModelCodingPlanSubscriptionProvider } from "./bigmodelCodingPlanSubscriptionProvider.js";
import type { ModelSelectionView } from "@zcode/provider";
import { ZaiCodingPlanSubscriptionProvider } from "./zaiCodingPlanSubscriptionProvider.js";
import {
  createAiscooAdminSubscriptionReadAdapter,
  rejectAiscooAdminSelfService,
  type AiscooAdminSubscriptionDependencies,
} from "../aiscoo-admin/aiscooAdminSubscriptionReadAdapter.js";
import type { OfficialCloudConnectionHost } from "../official-mcp/officialCloudConnectionService.js";

export interface CodingPlanSubscriptionServiceDependencies {
  apiClient: ApiClient;
  credentialService: Pick<ICredentialService, "load">;
  resolveOffPeakModelSelectionView?: () => Promise<ModelSelectionView>;
  native?: AiscooAdminSubscriptionDependencies;
  officialCloudHost?: Pick<
    OfficialCloudConnectionHost,
    "withCredentials" | "getModelSelectionView"
  >;
  /**
   * 用户在设置里选的动态工作流模式（launch.md「The user's choice」）。只有拥有设置权威的装配
   * （desktop 本地 Host、web/standalone server）注入；缺省时快照只含服务端的「提供」。
   */
  resolveDynamicWorkflowUserMode?: () => Promise<unknown>;
}

export function createCodingPlanSubscriptionService(
  dependencies: CodingPlanSubscriptionServiceDependencies,
): ICodingPlanSubscriptionService {
  const bigmodel = new BigModelCodingPlanSubscriptionProvider(dependencies);
  const zai = new ZaiCodingPlanSubscriptionProvider(dependencies);
  const native =
    dependencies.native && createAiscooAdminSubscriptionReadAdapter(dependencies.native);
  const available = async <T>(operation: () => Promise<T>): Promise<SelfServiceReadResult<T>> =>
    native
      ? dependencies.native!.account.withControlSession(
          async (): Promise<SelfServiceReadResult<T>> => ({
            availability: "not-supported",
            reason: "manual_admin",
            data: null,
          }),
        )
      : { availability: "available", data: await operation() };
  const officialFeature = async <T>(
    operation: (provider: BigModelCodingPlanSubscriptionProvider) => Promise<T>,
  ): Promise<T> => {
    const host = dependencies.officialCloudHost;
    if (!host) {
      if (native) throw new Error("official_cloud_connection_required");
      return operation(bigmodel);
    }
    return host.withCredentials(async (credentials) =>
      operation(
        new BigModelCodingPlanSubscriptionProvider({
          apiClient: dependencies.apiClient,
          credentialService: {
            load: async (key) =>
              key === "zcodejwttoken"
                ? credentials.jwt
                : key === `oauth:${credentials.family}:access_token`
                  ? credentials.accessToken
                  : key === "oauth:active_provider"
                    ? credentials.family
                    : null,
          },
          resolveOffPeakModelSelectionView: () => host.getModelSelectionView(),
        }),
      ),
    );
  };
  return {
    batchPreview: (request) => (native ? native.read() : bigmodel.batchPreview(request)),
    getStaticProducts: () => (native ? native.read() : bigmodel.getStaticProducts()),
    getStaticTeamProducts: () => (native ? native.read() : bigmodel.getStaticTeamProducts()),
    getStartPlanPreview: () => (native ? native.read() : bigmodel.getStartPlanPreview()),
    // XCODE: 主套餐仅允许 Native 管理员授予，官方 Start 领取不能充当私有赠送。
    getManualClaimPlanPreviews: () =>
      native ? rejectAiscooAdminSelfService() : bigmodel.getManualClaimPlanPreviews(),
    claimManualPlan: (request) =>
      native ? rejectAiscooAdminSelfService() : bigmodel.claimManualPlan(request),
    createPlanWebHandoff: () =>
      native
        ? native.createPlanWebHandoff()
        : Promise.reject(new Error("XCODE_NATIVE_ACCOUNT_REQUIRED")),
    getOffPeakClientConfig: (options) =>
      officialFeature((provider) => provider.getOffPeakClientConfig(options)),
    getDynamicWorkflowClientConfig: (options) =>
      officialFeature(async (provider) => {
        const offer = await provider.getDynamicWorkflowClientConfig(options);
        const resolveUserMode = dependencies.resolveDynamicWorkflowUserMode;
        return resolveUserMode
          ? applyDynamicWorkflowUserMode(offer, await resolveUserMode())
          : offer;
      }),
    getModelContextBudgetStrategy: () => bigmodel.getModelContextBudgetStrategy(),
    getBillingDiscount: () =>
      native ? rejectAiscooAdminSelfService() : bigmodel.getBillingDiscount(),
    getRequestVerificationConfig: () => bigmodel.getRequestVerificationConfig(),
    getForceUpdateConfig: () => bigmodel.getForceUpdateConfig(),
    productInfo: (request) => (native ? native.read() : bigmodel.productInfo(request)),
    preview: (request) => (native ? native.read() : bigmodel.preview(request)),
    createSign: (request) =>
      native ? rejectAiscooAdminSelfService() : bigmodel.createSign(request),
    updateSign: (request) =>
      native ? rejectAiscooAdminSelfService() : bigmodel.updateSign(request),
    checkPayment: (request) => available(() => bigmodel.checkPayment(request)),
    checkPendingOrders: (request) => available(() => bigmodel.checkPendingOrders(request)),
    queryStripeCards: (request) => available(() => bigmodel.queryStripeCards(request)),
    bindStripeCard: (request) =>
      native ? rejectAiscooAdminSelfService() : bigmodel.bindStripeCard(request),
    unbindStripeCard: (request) =>
      native ? rejectAiscooAdminSelfService() : bigmodel.unbindStripeCard(request),
    payStripe: (request) => (native ? rejectAiscooAdminSelfService() : bigmodel.payStripe(request)),
    checkPaypalSupport: (request) => available(() => bigmodel.checkPaypalSupport(request)),
    createPaypalSetupToken: (request) =>
      native ? rejectAiscooAdminSelfService() : bigmodel.createPaypalSetupToken(request),
    subscribePaypal: (request) =>
      native ? rejectAiscooAdminSelfService() : bigmodel.subscribePaypal(request),
    getEnterprisePricing: (request) =>
      native
        ? native.read()
        : (request?.family === "zai" ? zai : bigmodel).getEnterprisePricing(request),
    getEnterpriseBalance: () => (native ? native.read() : bigmodel.getEnterpriseBalance()),
    calculateEnterpriseOrder: (request) =>
      native ? rejectAiscooAdminSelfService() : bigmodel.calculateEnterpriseOrder(request),
    createEnterpriseOrder: (request) =>
      native ? rejectAiscooAdminSelfService() : bigmodel.createEnterpriseOrder(request),
    getEnterprisePendingOrders: () => available(() => bigmodel.getEnterprisePendingOrders()),
    cancelEnterpriseOrder: (request) =>
      native ? rejectAiscooAdminSelfService() : bigmodel.cancelEnterpriseOrder(request),
    continueEnterpriseOrderPayment: (request) =>
      native ? rejectAiscooAdminSelfService() : bigmodel.continueEnterpriseOrderPayment(request),
    checkEnterpriseOrderStatus: (request) =>
      available(() => bigmodel.checkEnterpriseOrderStatus(request)),
  };
}
