import { resolveAiscooDesktopIdentity } from "@zcode/shared/aiscoo-desktop-identity";
import {
  NATIVE_RESOURCE_DIRECTORY_ENV,
  resolveNativeResourceDirectoryPolicy,
  type NativeResourceDirectoryPolicy,
} from "@zcode/shared/native-resource-directories";

let startupPolicy: NativeResourceDirectoryPolicy | undefined;

/** Main 启动入口唯一解析；dotenv 先合并，已定义的进程变量（包括空白）后覆盖。 */
export function initializeDesktopNativeResourceDirectories(
  localEnv: Readonly<Record<string, string | undefined>>,
  processEnv: Record<string, string | undefined>,
): NativeResourceDirectoryPolicy {
  if (startupPolicy) return startupPolicy;
  const inheritedEnv = Object.fromEntries(
    Object.entries(processEnv).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const policy = resolveNativeResourceDirectoryPolicy({
    env: { ...localEnv, ...inheritedEnv },
    productDirectoryName: resolveAiscooDesktopIdentity()?.nativeResourceDirectoryName,
  });
  startupPolicy = policy;
  // Main 的 MCP 与后续 Host/Agent 只消费同一规范值；不改变 HOME、设置或运行时库存根。
  processEnv[NATIVE_RESOURCE_DIRECTORY_ENV] = policy.directoryName;
  return policy;
}

/** 资源 IO 必须晚于入口校验；运行中不重读 env，完整重启后才更换策略。 */
export function getDesktopNativeResourceDirectories(): NativeResourceDirectoryPolicy {
  if (!startupPolicy) throw new Error("Desktop native resource directories are not initialized");
  return startupPolicy;
}
