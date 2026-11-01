// XCODE: TUI 与模型 Registry 共享同一 Zen runtime；业务全部在此，上游 tui-prompt-handler 只做装配。
import { PRODUCT_NAME } from "@zcode/i18n";
import type { TuiSubmitPrompt } from "@zcode/tui";
import { loadBootstrapModule } from "../bootstrap-loader.js";
import type { CommandCenterDeps } from "../command-center.js";
import type { RunDependencies } from "../cli-types.js";
import { createAiscooCommandCenter } from "./command-center.js";
import type { AiscooZenCommandDeps } from "./contract.js";

type ZenRegistryRuntime = Awaited<
  ReturnType<NonNullable<RunDependencies["startProcessProviderRegistryRuntime"]>>
>;

// env（含 .env）在 runtime 启动时才确定，故不在装配时判断；未配置 AISCOO_ADMIN_BASE_URL 时 zenAccount 为 undefined。
export function createTuiZenCommandDeps(
  readRuntime: () => Promise<ZenRegistryRuntime | undefined>,
): AiscooZenCommandDeps {
  const zenRuntime = async () => {
    const runtime = await readRuntime();
    if (!runtime?.zenAccount)
      throw new Error(`Configure AISCOO_ADMIN_BASE_URL to use ${PRODUCT_NAME} Zen Plan.`);
    return { runtime, zenAccount: runtime.zenAccount };
  };
  return {
    async refreshAccountModels() {
      const runtime = await readRuntime();
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

/**
 * 包装 Provider Registry 启动函数，记下 TUI 进程级 runtime，并返回注入上游 TUI 的命令中心工厂。
 * 上游 tui-prompt-handler 只读取可选的 createTuiCommandCenter，不感知 Zen。
 */
export function withAiscooTuiCommandCenter(deps: RunDependencies): RunDependencies {
  let runtimePromise: Promise<ZenRegistryRuntime> | undefined;
  const startRuntime: NonNullable<RunDependencies["startProcessProviderRegistryRuntime"]> = (
    ...args
  ) => {
    const start = deps.startProcessProviderRegistryRuntime;
    const started = start
      ? start(...args)
      : loadBootstrapModule().then((module) => module.startProcessProviderRegistryRuntime(...args));
    runtimePromise ??= started;
    return started;
  };
  const zen = createTuiZenCommandDeps(async () => runtimePromise);
  return {
    ...deps,
    startProcessProviderRegistryRuntime: startRuntime,
    createTuiCommandCenter: (commandDeps: CommandCenterDeps): TuiSubmitPrompt =>
      createAiscooCommandCenter(commandDeps, zen),
  };
}
