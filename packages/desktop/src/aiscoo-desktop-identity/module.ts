export const aiscooDesktopRuntimeModule = {
  id: "aiscoo-desktop-runtime",
  requires: ["aiscoo-desktop-identity", "shared", "native-resource-directories"],
  provides: ["aiscoo-desktop-runtime"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
