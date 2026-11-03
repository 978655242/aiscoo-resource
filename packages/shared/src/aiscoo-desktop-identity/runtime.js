// XCODE: 身份配置供未构建的 Node 工具与三端 bundle 复用，不能读取包外相对路径。
const identities = Object.freeze({
  production: Object.freeze({
    channel: "production",
    appId: "dev.aiscoo.app",
    productName: "Aiscoo",
    dataName: "Aiscoo",
    nativeResourceDirectoryName: ".aiscoo",
    scheme: "aiscoo",
    oauthRedirectUri: "aiscoo://oauth/callback",
    macKeychainName: "XWork",
    windowsExecutableName: "Aiscoo",
    linuxExecutableName: "aiscoo",
    linuxPackageName: "aiscoo",
    desktopFileName: "aiscoo.desktop",
  }),
  development: Object.freeze({
    channel: "development",
    appId: "dev.aiscoo.app.dev",
    productName: "Aiscoo Dev",
    dataName: "Aiscoo Dev",
    nativeResourceDirectoryName: ".aiscoo",
    scheme: "aiscoo-dev",
    oauthRedirectUri: "aiscoo-dev://oauth/callback",
    macKeychainName: "XWork Dev",
    windowsExecutableName: "Aiscoo Dev",
    linuxExecutableName: "aiscoo-dev",
    linuxPackageName: "aiscoo-dev",
    desktopFileName: "aiscoo-dev.desktop",
  }),
  preview: Object.freeze({
    channel: "preview",
    appId: "dev.aiscoo.app.preview",
    productName: "Aiscoo Preview",
    dataName: "Aiscoo Preview",
    nativeResourceDirectoryName: ".aiscoo",
    scheme: "aiscoo-preview",
    oauthRedirectUri: "aiscoo-preview://oauth/callback",
    macKeychainName: "XWork Preview",
    windowsExecutableName: "Aiscoo Preview",
    linuxExecutableName: "aiscoo-preview",
    linuxPackageName: "aiscoo-preview",
    desktopFileName: "aiscoo-preview.desktop",
  }),
});

/** Main 下发给本地 Host 的渠道默认 App 根，Host 据此解释“恢复默认目录”。 */
export const AISCOO_DESKTOP_DEFAULT_DATA_BASE_DIR_ENV = "AISCOO_DESKTOP_DEFAULT_DATA_BASE_DIR";

/** @param {import("./contract.js").AiscooDesktopChannel} channel */
export function getAiscooDesktopIdentity(channel) {
  if (!Object.hasOwn(identities, channel)) {
    throw new TypeError("Invalid Aiscoo desktop channel");
  }
  return identities[channel];
}

/** 未注入时维持通用上游默认行为，打包后不接受外部环境改写渠道。 */
export function resolveAiscooDesktopIdentity() {
  return typeof __AISCOO_DESKTOP_CHANNEL__ === "undefined"
    ? null
    : getAiscooDesktopIdentity(__AISCOO_DESKTOP_CHANNEL__);
}
