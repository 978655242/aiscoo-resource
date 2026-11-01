// 依赖与 architecture-policy.yaml 同步；新增文件必须属于此 managed 边界。
export const mobileUiModule = {
  id: "mobile-ui",
  // XCODE: 应用标志通过下游品牌契约接入，供应商图标保持独立。
  requires: ["ui", "aiscoo-brand-ui"],
  provides: ["mobile-ui"],
  publicEntrypoints: [
    "index.ts",
    "contract.ts",
    "DevicePlatformIcon.tsx",
    "ZCodeAppLogo.tsx",
    "bottom-sheet.tsx",
  ],
} as const;
