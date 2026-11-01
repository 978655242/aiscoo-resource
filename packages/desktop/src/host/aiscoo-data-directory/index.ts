import { ISettingService, ISystemService } from "@zcode/services";
import type { RegisterAiscooDataDirectoryServices } from "./contract.js";

export const registerAiscooDataDirectoryServices: RegisterAiscooDataDirectoryServices = (
  services,
  defaultDataBaseDir,
) => {
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
      // XCODE: 空值应回到渠道 C；必须以已注册 base 为 this，让原 update 的提交后通知保留。
      return setting.updateDataBaseDir(newDir?.trim() ? newDir : defaultDataBaseDir);
    },
  });
};
