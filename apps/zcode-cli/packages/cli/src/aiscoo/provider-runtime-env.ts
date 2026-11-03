import { normalizeNewApiOrigin } from "@zcode/shared";
import { prepareCliProviderRuntimeEnv } from "../provider-runtime-env.js";
import { parseGlobalArgs, isProtocolServerInvocation } from "../arguments.js";
import { resolveCliCwd } from "../cwd.js";
import { loadCliDotenv, shouldLoadCliDotenvForProtocolServer } from "../env.js";

/** 缓存与下载必须选择同一管理端；无配置时只用 bundle，不复用官方或其他站点的缓存。 */
export function prepareAiscooProviderRuntimeEnv(
  options: Parameters<typeof prepareCliProviderRuntimeEnv>[0],
): Promise<Record<string, string>> {
  return prepareCliProviderRuntimeEnv({
    ...options,
    resolveBuiltinEndpointOrigin: () => {
      // 原入口在缓存装配后才加载 dotenv，会让下载源与缓存 key 不一致；此处复用相同优先级和 --cwd。
      // 该端口仅在真正使用本地配置资源时调用，Host 已注入完整路径或 help 等命令不会额外读取。
      if (
        !isProtocolServerInvocation([...options.argv]) ||
        shouldLoadCliDotenvForProtocolServer(options.env)
      ) {
        const { values } = parseGlobalArgs([...options.argv]);
        const cwd = resolveCliCwd({
          cwd: process.cwd,
          requestedCwd: values.cwd as string | undefined,
        });
        const dotenv = loadCliDotenv({ cwd, env: options.env });
        if (dotenv.error) {
          throw new Error(`Failed to load environment file: ${dotenv.path}`, {
            cause: dotenv.error,
          });
        }
      }
      try {
        return normalizeNewApiOrigin(options.env.AISCOO_ADMIN_BASE_URL?.trim() ?? "");
      } catch {
        return null;
      }
    },
  });
}
