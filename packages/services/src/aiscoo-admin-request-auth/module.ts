export const aiscooAdminRequestAuthModule = {
  id: "aiscoo-admin-request-auth",
  requires: ["provider", "services", "shared"],
  provides: ["aiscoo-admin-request-auth"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
