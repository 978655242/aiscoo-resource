/**
 * cli-aiscoo 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.xwork.yaml（检查器会校验两者一致）。
 */
export const cliAiscooModule = {
  id: "cli-aiscoo",
  requires: ["cli-arguments", "cli-sea-keyring", "zcode-cli", "cli-aiscoo-brand", "shared"],
  provides: ["cli-aiscoo"],
  publicEntrypoints: ["index.ts", "contract.ts", "provider-runtime-env.ts"],
} as const;
