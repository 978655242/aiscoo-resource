/** XCODE: 下游品牌展示通过独立模块叠加，资源和文本保持单一事实源。 */
export const aiscooBrandUiModule = {
  id: "aiscoo-brand-ui",
  requires: ["ui", "shared", "aiscoo-brand"],
  provides: ["aiscoo-brand-ui"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
