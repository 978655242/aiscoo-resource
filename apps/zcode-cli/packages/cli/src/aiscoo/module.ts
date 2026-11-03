/**
 * cli-aiscoo 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.xwork.yaml（检查器会校验两者一致）。
 */
export const cliAiscooModule = {
  id: "cli-aiscoo",
  // XCODE: 保留管理端源依赖，并追加产品身份与原生资源目录策略。
  requires: [
    "cli-arguments",
    "cli-sea-keyring",
    "zcode-cli",
    "cli-aiscoo-brand",
    "shared",
    "aiscoo-desktop-identity",
    "native-resource-directories",
  ],
  provides: ["cli-aiscoo"],
  publicEntrypoints: ["index.ts", "contract.ts", "provider-runtime-env.ts"],
} as const;
