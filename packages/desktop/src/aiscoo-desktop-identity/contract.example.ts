import {
  buildAiscooDesktopStorageEnv,
  initializeAiscooDesktopStorage,
  initializeDesktopNativeResourceDirectories,
} from "./index.js";

/** 早期 bootstrap 已装配默认根 C，原设置 owner 已恢复当前根 D。 */
export async function exampleAiscooDesktopRuntime(settingsFile: string, dataBaseDir: string) {
  const processEnv: Record<string, string | undefined> = {};
  const nativeDirectories = initializeDesktopNativeResourceDirectories({}, processEnv);
  const cliBaseDir = await initializeAiscooDesktopStorage({ settingsFile, dataBaseDir });
  const runtimeEnv = buildAiscooDesktopStorageEnv(dataBaseDir, processEnv, cliBaseDir);
  return { nativeDirectories, runtimeEnv };
}
