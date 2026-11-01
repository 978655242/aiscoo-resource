/**
 * aiscoo-startup-context 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.xwork.yaml。
 */
export const aiscooStartupContextModule = {
  id: "aiscoo-startup-context",
  requires: ["ui"],
  provides: ["aiscoo-startup-context"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
