// XCODE: TUI 与模型 Registry 共享同一 Zen runtime；业务全部在此，上游 tui-prompt-handler 只做装配。
import { PRODUCT_NAME } from "@zcode/i18n";
import type { AiscooZenCommandDeps } from "./contract.js";
import type { createTuiProcessRuntimeState } from "../tui-prompt-handler-runtime.js";

type TuiProcessRuntimeState = ReturnType<typeof createTuiProcessRuntimeState>;

// env（含 .env）在 runtime 启动时才确定，故不在装配时判断；未配置 AISCOO_ADMIN_BASE_URL 时 zenAccount 为 undefined。
export function createTuiZenCommandDeps(processRuntime: TuiProcessRuntimeState): AiscooZenCommandDeps {
  const zenRuntime = async () => {
    const runtime = await processRuntime.providerRegistryRuntimePromise;
    if (!runtime?.zenAccount) throw new Error(`Configure AISCOO_ADMIN_BASE_URL to use ${PRODUCT_NAME} Zen Plan.`);
    return { runtime, zenAccount: runtime.zenAccount };
  };
  return {
    async refreshAccountModels() {
      const runtime = await processRuntime.providerRegistryRuntimePromise;
      if (runtime?.zenAccount) await runtime.refreshStandaloneAccount("model-list");
    },
    async loginZen(options) {
      const { runtime, zenAccount } = await zenRuntime();
      const result = await zenAccount.login(options);
      await runtime.refreshStandaloneAccount("zen-login");
      return { ...result, modelStatus: await runtime.readZenModelStatus() };
    },
    async logoutZen() {
      const { runtime, zenAccount } = await zenRuntime();
      const result = await zenAccount.logout();
      await runtime.refreshStandaloneAccount("zen-logout");
      return result;
    },
  };
}
