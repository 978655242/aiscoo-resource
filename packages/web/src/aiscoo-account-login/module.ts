export const aiscooAccountLoginWebModule = {
  id: "aiscoo-account-login-web",
  owner: "account",
  requires: ["shared", "web", "aiscoo-brand", "aiscoo-browser-account-web", "ui"],
  provides: ["aiscoo-web-account-entry"],
} as const;
