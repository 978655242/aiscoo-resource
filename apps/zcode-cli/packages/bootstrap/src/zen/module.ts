/**
 * cli-zen-account 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const cliZenAccountModule = {
  id: "cli-zen-account",
  requires: ["shared", "cli-zen-auth", "provider", "zcode-cli", "aiscoo-brand"],
  provides: ["cli-zen-account"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
