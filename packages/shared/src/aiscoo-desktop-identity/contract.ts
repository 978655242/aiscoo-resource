export type AiscooDesktopChannel = "production" | "development" | "preview";

/** 不含账号或运行中状态；各渠道使用固定身份，历史加密名称不随品牌改变。 */
export interface AiscooDesktopIdentity {
  readonly channel: AiscooDesktopChannel;
  readonly appId: string;
  readonly productName: string;
  readonly dataName: string;
  readonly nativeResourceDirectoryName: string;
  readonly scheme: string;
  readonly oauthRedirectUri: string;
  readonly macKeychainName: string;
  readonly windowsExecutableName: string;
  readonly linuxExecutableName: string;
  readonly linuxPackageName: string;
  readonly desktopFileName: string;
}
