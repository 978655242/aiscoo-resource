export const cliAiscooBrandModule = {
  id: "cli-aiscoo-brand",
  requires: ["zcode-cli", "aiscoo-brand"],
  provides: ["cli-aiscoo-brand"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
