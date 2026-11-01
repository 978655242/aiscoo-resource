import type { ServiceCollection } from "@zcode/services";

/** undefined 保留原服务；C 由 Main 传入，不在 Host 重新推导默认目录。 */
export type RegisterAiscooDataDirectoryServices = (
  services: ServiceCollection,
  defaultDataBaseDir: string | undefined,
) => void;
