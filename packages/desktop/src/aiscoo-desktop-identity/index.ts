import { join } from "node:path";
import {
  AISCOO_DESKTOP_DEFAULT_DATA_BASE_DIR_ENV,
  resolveAiscooDesktopIdentity,
} from "@zcode/shared/aiscoo-desktop-identity";
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
  // 默认根须在恢复自定义目录之前记下，用户清空目录设置时回到这里。
  defaultDataBaseDir = root;
  options.setDataBaseDir(root);
  const settingsFile =
    options.env.ZCODE_SETTINGS_FILE_PATH?.trim() || join(root, ".zcode", "v2", "setting.json");
  // XCODE: 设置文件归属固定在安装渠道；后续业务数据迁移不改变 Main/Host 的设置写入 owner。
  options.env.ZCODE_SETTINGS_FILE_PATH = settingsFile;
  return bootstrap(settingsFile);
}

/** App 目录迁移只复制 v2；CLI 三条路径从固定根派生，逐键尊重最终合并的显式覆盖。 */
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
    // 当前根等于 HOME 时也要显式下发，否则 Host 会沿用继承环境里的旧根。
    ZCODE_DATA_BASE_DIR: dataBaseDir,
    [AISCOO_DESKTOP_DEFAULT_DATA_BASE_DIR_ENV]: defaultDataBaseDir,
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
// XCODE: 原生资源策略与 App/CLI 运行时库存独立，Main 校验一次后供 MCP 与 Host 装配使用。
export {
  initializeDesktopNativeResourceDirectories,
  getDesktopNativeResourceDirectories,
} from "./nativeResourceDirectories.js";
