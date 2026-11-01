export interface AiscooDesktopDataBootstrapOptions {
  readonly env: Record<string, string | undefined>;
  readonly appDataPath: string;
  readonly setDataBaseDir: (path: string) => void;
}

export type DesktopDataBootstrap = (settingsFile?: string) => string | null;

export interface AiscooDesktopStorageInitialization {
  /** 固定设置文件；绑定记录与它同目录，不随 App 数据迁移。 */
  readonly settingsFile: string;
  /** 原 paths owner 已恢复的当前 App 根 D，首次绑定使用它。 */
  readonly dataBaseDir: string;
}

export interface PackagedAiscooAccountOriginRuntime {
  /** 构建期编译常量；上游通用构建与未注入时为 undefined。 */
  readonly compiledOrigin: string | undefined;
  /** 仅 Aiscoo 渠道才会携带账号源；未注入渠道时不得生效。 */
  readonly hasAiscooChannel: boolean;
  readonly isPackaged: boolean;
  readonly env: Record<string, string | undefined>;
}

export interface AiscooUpdateEndpointRuntime {
  /** 仅 Aiscoo 渠道才把更新源改到账号服务；未注入渠道时保持上游官方更新源。 */
  readonly hasAiscooChannel: boolean;
  /** 当前账号源（打包态已被编译值覆盖），可缺失或非法。 */
  readonly accountOrigin: string | undefined;
}
