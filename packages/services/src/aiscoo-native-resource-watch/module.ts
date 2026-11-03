export const hostNativeResourceWatchModule = {
  id: "host-native-resource-watch",
  requires: ["services", "shared", "native-resource-directories"],
  provides: ["native-subagent-resource-watch"],
  publicEntrypoints: ["contract.ts", "../subagents/subagentRuntimeConfig.ts"],
} as const;
