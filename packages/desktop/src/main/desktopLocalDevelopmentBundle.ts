import { normalize } from "node:path";

// XCODE: 新 Dev bundle 展示名来自品牌配置，同时继续识别历史生成副本。
import { PRODUCT_BRAND } from "@zcode/shared/aiscoo-brand";

const LOCAL_DEV_BUNDLE_PATH = "/.zcode-runtime/desktop-dev/";
const LOCAL_DEV_BUNDLE_EXECUTABLE_SUFFIX = `/${PRODUCT_BRAND.developmentName}.app/Contents/MacOS/Electron`;
const LEGACY_XWORK_LOCAL_DEV_BUNDLE_EXECUTABLE_SUFFIX = "/XWork Dev.app/Contents/MacOS/Electron";
const LEGACY_LOCAL_DEV_BUNDLE_EXECUTABLE_SUFFIX = "/XCode Dev.app/Contents/MacOS/Electron";

export function isLocalDevelopmentBundleLaunch(
  options: {
    env?: NodeJS.ProcessEnv;
    execPath?: string;
    platform?: NodeJS.Platform;
  } = {},
): boolean {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  if ((options.env ?? process.env).ZCODE_LOCAL_DEV_BUNDLE !== "1") return false;

  const executablePath = normalize(options.execPath ?? process.execPath).replaceAll("\\", "/");
  return (
    executablePath.includes(LOCAL_DEV_BUNDLE_PATH) &&
    (executablePath.endsWith(LOCAL_DEV_BUNDLE_EXECUTABLE_SUFFIX) ||
      executablePath.endsWith(LEGACY_XWORK_LOCAL_DEV_BUNDLE_EXECUTABLE_SUFFIX) ||
      executablePath.endsWith(LEGACY_LOCAL_DEV_BUNDLE_EXECUTABLE_SUFFIX))
  );
}
