export const aiscooAccountAvatarModule = {
  id: "aiscoo-account-avatar",
  requires: ["profile-avatar", "shared"],
  provides: ["aiscoo-account-avatar"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
