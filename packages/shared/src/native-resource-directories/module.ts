export const nativeResourceDirectoriesModule = {
  id: "native-resource-directories",
  requires: [],
  provides: ["native-resource-directory-policy"],
  publicEntrypoints: ["index.ts", "node.ts", "contract.ts"],
} as const;
