export const aiscooPluginGuidesServiceModule = {
  id: "aiscoo-plugin-guides-service",
  requires: [
    "services",
    "shared",
    "rpc",
    "provider",
    "aiscoo-plugin-guides-protocol",
    "aiscoo-brand",
  ],
  provides: ["aiscoo-plugin-guides-service"],
  publicEntrypoints: ["index.ts", "contract.ts", "node.ts"],
} as const;
