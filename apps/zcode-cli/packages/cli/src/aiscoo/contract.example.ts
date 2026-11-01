import type { AiscooZenCommandDeps } from "./contract.js";

/** 标准调用：/model 打开前先刷新 Zen 目录；登录结果只展示用户与模型可用性，不接触凭据。 */
export async function loginThenRefresh(zen: AiscooZenCommandDeps, signal?: AbortSignal) {
  const result = await zen.loginZen({ signal });
  await zen.refreshAccountModels();
  return { account: result.user.display_name || result.user.username, ready: result.modelStatus.available };
}
