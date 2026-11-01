export const hostAiscooDataDirectoryModule = {
  id: "host-aiscoo-data-directory",
  requires: ["services"],
  provides: ["host-aiscoo-data-directory"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
