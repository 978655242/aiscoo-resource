import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Host 资源发现沿用 Agent 的显式运行时库存根，不能从新的资源配置祖父目录反推。 */
export function resolveDesktopPluginStorageRoot(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const storageDir = env.ZCODE_STORAGE_DIR?.trim();
  if (!storageDir) return undefined;
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  const storageRoot = storageDir.startsWith("~/")
    ? join(home, storageDir.slice(2))
    : resolve(storageDir);
  const cliRoot = basename(storageRoot) === "cli" ? storageRoot : join(storageRoot, "cli");
  return join(cliRoot, "plugins");
}
