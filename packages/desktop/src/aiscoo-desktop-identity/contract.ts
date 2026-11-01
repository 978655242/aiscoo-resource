export interface AiscooDesktopDataBootstrapOptions {
  readonly env: Record<string, string | undefined>;
  readonly appDataPath: string;
  readonly setDataBaseDir: (path: string) => void;
}

export type DesktopDataBootstrap = (settingsFile?: string) => string | null;

export interface PackagedAiscooAccountOriginRuntime {
  /** 构建期编译常量；上游通用构建与未注入时为 undefined。 */
  readonly compiledOrigin: string | undefined;
  /** 仅 Aiscoo 渠道才会携带账号源；未注入渠道时不得生效。 */
  readonly hasAiscooChannel: boolean;
  readonly isPackaged: boolean;
  readonly env: Record<string, string | undefined>;
}
