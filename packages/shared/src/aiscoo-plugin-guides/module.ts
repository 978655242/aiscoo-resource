export const aiscooPluginGuidesProtocolModule = {
  id: "aiscoo-plugin-guides-protocol",
  requires: ["shared"],
  provides: ["aiscoo-plugin-guides-protocol"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
