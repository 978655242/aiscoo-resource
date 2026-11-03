/**
 * cli-aiscoo 对外契约：Aiscoo 对独立 CLI 的组合层。上游 run / createCommandCenter 原样委托，
 * 本模块只处理 Aiscoo 专属命令（目前为 Aiscoo Zen Plan）并在上游输出后追加内容，不改写上游文案。
 */

export { prepareAiscooProviderRuntimeEnv } from "./provider-runtime-env.js";

/** TUI 命令中心需要的 Zen 账号能力；业务 owner 是 bootstrap 的 ZenAccountRuntime，本层不保存账号状态。 */
export interface AiscooZenCommandDeps {
  loginZen(options: {
    signal?: AbortSignal;
    onAuthorizeUrl?: (url: string) => Promise<void>;
  }): Promise<{
    user: { display_name: string; username: string };
    modelStatus: { available: boolean; reason: string | null };
  }>;
  logoutZen(): Promise<{ localCleared: boolean; serverRevoked: boolean }>;
  /** 打开 /model 前恢复短暂断网的 Zen 身份；不在目录 resolver 内递归恢复。 */
  refreshAccountModels(): Promise<void>;
}
