export const aiscooDesktopRuntimeModule = {
  id: "aiscoo-desktop-runtime",
  requires: ["aiscoo-desktop-identity", "shared"],
  provides: ["aiscoo-desktop-runtime"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
