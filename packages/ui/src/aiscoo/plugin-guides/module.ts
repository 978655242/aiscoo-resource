export const aiscooPluginGuidesModule = {
  id: "aiscoo-plugin-guides-ui",
  requires: [
    "ui",
    "services",
    "shared",
    "aiscoo-plugin-guides-protocol",
    "aiscoo-plugin-guides-service",
  ],
  provides: ["aiscoo-plugin-guides-ui"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
