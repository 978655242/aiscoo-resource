/** 本地 Host 默认数据目录包装；路径与设置仍归现有 services。 */
export const hostAiscooDataDirectoryModule = {
  id: "host-aiscoo-data-directory",
  requires: ["services"],
  provides: ["host-aiscoo-data-directory"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
