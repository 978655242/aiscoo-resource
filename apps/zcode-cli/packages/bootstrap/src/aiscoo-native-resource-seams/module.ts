export const cliNativeResourceSeamsModule = {
  id: "cli-native-resource-seams",
  requires: ["zcode-cli", "shared", "native-resource-directories"],
  provides: ["native-workflow-resource-policy-seams"],
  publicEntrypoints: [
    "contract.ts",
    "../zcode-protocol/saved-workflows-run.ts",
    "../../../core/src/tool/executor/permission-input-adjustments.ts",
    "../../../cli/src/plugins-command-shared.ts",
  ],
} as const;
