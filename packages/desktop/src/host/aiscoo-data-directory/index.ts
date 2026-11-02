import { ISettingService, ISystemService, type ServiceCollection } from "@zcode/services";

/** 在本地 Host 暴露服务前包装 system/setting；defaultDataBaseDir 为 undefined 时保持上游服务。 */
export function registerAiscooDataDirectoryServices(
  services: ServiceCollection,
  defaultDataBaseDir: string | undefined,
): void {
  if (defaultDataBaseDir === undefined) return;
  const system = services.get(ISystemService);
  const setting = services.get(ISettingService);
  services.register(ISystemService, {
    ...system,
    async info() {
      return { ...(await system.info()), defaultDataBaseDir };
    },
  });
  services.register(ISettingService, {
    ...setting,
    updateDataBaseDir(newDir) {
      // 空值回到渠道默认根；经 base 调用，原 update 的提交后通知不变。
      return setting.updateDataBaseDir(newDir?.trim() ? newDir : defaultDataBaseDir);
    },
  });
}
