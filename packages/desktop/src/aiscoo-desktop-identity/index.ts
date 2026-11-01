import { join } from "node:path";
import { resolveAiscooDesktopIdentity } from "@zcode/shared/aiscoo-desktop-identity";
import type { AiscooDesktopDataBootstrapOptions, DesktopDataBootstrap } from "./contract.js";

let defaultDataBaseDir: string | undefined;

/** XCODE: 应用 ID 不隔离服务设置；先选本渠道根，再让原 owner 读取该根的设置。 */
export function bootstrapAiscooDesktopData(
  bootstrap: DesktopDataBootstrap,
  options: AiscooDesktopDataBootstrapOptions,
): string | null {
  const identity = resolveAiscooDesktopIdentity();
  if (!identity) return bootstrap();
  const root =
    options.env.ZCODE_DATA_BASE_DIR?.trim() || join(options.appDataPath, identity.dataName);
  // XCODE: C 在恢复自定义 D 之前确定，清空设置时仍回到此默认根。
  defaultDataBaseDir = root;
  options.setDataBaseDir(root);
  const settingsFile =
    options.env.ZCODE_SETTINGS_FILE_PATH?.trim() || join(root, ".zcode", "v2", "setting.json");
  // XCODE: 设置文件归属固定在安装渠道；后续业务数据迁移不改变 Main/Host 的设置写入 owner。
  options.env.ZCODE_SETTINGS_FILE_PATH = settingsFile;
  return bootstrap(settingsFile);
}

/** XCODE: App 仅迁移 v2，CLI 三条路径必须从固定 B 派生，且尊重最终合并的显式覆盖。 */
export function buildAiscooDesktopStorageEnv(
  dataBaseDir: string,
  env: Record<string, string | undefined>,
  cliBaseDir: string | undefined,
): Record<string, string> {
  if (!resolveAiscooDesktopIdentity()) return {};
  if (!cliBaseDir || !defaultDataBaseDir) {
    throw new Error("Aiscoo desktop storage is not initialized");
  }
  const root = join(cliBaseDir, ".zcode");
  return {
    // XCODE: D 即使等于 HOME 也须覆盖继承值，否则 Host 会恢复成旧环境中的根。
    ZCODE_DATA_BASE_DIR: dataBaseDir,
    AISCOO_DESKTOP_DEFAULT_DATA_BASE_DIR: defaultDataBaseDir,
    ZCODE_STORAGE_DIR: env.ZCODE_STORAGE_DIR?.trim() || root,
    ZCODE_SESSION_DB_PATH:
      env.ZCODE_SESSION_DB_PATH?.trim() || join(root, "cli", "db", "db.sqlite"),
    ZCODE_LOG_DIR: env.ZCODE_LOG_DIR?.trim() || join(root, "cli", "log"),
  };
}

export {
  initializeAiscooDesktopStorage,
  getAiscooDesktopCliBaseDir,
  isAiscooDesktopStorageReady,
} from "./cliStorageRoot.js";

// XCODE: 打包账号源解析与应用。
export * from "./packagedAccountOrigin.js";
// XCODE: 应用内更新 manifest 改用 Aiscoo 账号服务同一 origin。
export * from "./updateEndpoint.js";
