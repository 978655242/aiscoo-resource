import { join } from "node:path";
import { resolveAiscooDesktopIdentity } from "@zcode/shared/aiscoo-desktop-identity";
import type { AiscooDesktopDataBootstrapOptions, DesktopDataBootstrap } from "./contract.js";

/** XCODE: 应用 ID 不隔离服务设置；先选本渠道根，再让原 owner 读取该根的设置。 */
export function bootstrapAiscooDesktopData(
  bootstrap: DesktopDataBootstrap,
  options: AiscooDesktopDataBootstrapOptions,
): string | null {
  const identity = resolveAiscooDesktopIdentity();
  if (!identity) return bootstrap();
  const root =
    options.env.ZCODE_DATA_BASE_DIR?.trim() || join(options.appDataPath, identity.dataName);
  options.setDataBaseDir(root);
  const settingsFile =
    options.env.ZCODE_SETTINGS_FILE_PATH?.trim() || join(root, ".zcode", "v2", "setting.json");
  // XCODE: 设置文件归属固定在安装渠道；后续业务数据迁移不改变 Main/Host 的设置写入 owner。
  options.env.ZCODE_SETTINGS_FILE_PATH = settingsFile;
  return bootstrap(settingsFile);
}

/** XCODE: CLI 默认仍使用系统 HOME；明确补齐存储、会话库与日志路径，避免两个产品写同一库。 */
export function buildAiscooDesktopStorageEnv(
  dataBaseDir: string,
  env: Record<string, string | undefined>,
): Record<string, string> {
  if (!resolveAiscooDesktopIdentity()) return {};
  const root = join(dataBaseDir, ".zcode");
  return {
    ZCODE_STORAGE_DIR: env.ZCODE_STORAGE_DIR?.trim() || root,
    ZCODE_SESSION_DB_PATH:
      env.ZCODE_SESSION_DB_PATH?.trim() || join(root, "cli", "db", "db.sqlite"),
    ZCODE_LOG_DIR: env.ZCODE_LOG_DIR?.trim() || join(root, "cli", "log"),
  };
}

// XCODE: 打包账号源解析与应用。
export * from "./packagedAccountOrigin.js";
// XCODE: 应用内更新 manifest 改用 Aiscoo 账号服务同一 origin。
export * from "./updateEndpoint.js";
