import type { AiscooWebAuth, AiscooBrowserWebStartupOptions } from "./contract.js";
import { createAiscooBrowserWebStartup } from "./index.js";

export function prepareBrowserWebStartup(options: AiscooBrowserWebStartupOptions) {
  return createAiscooBrowserWebStartup(options);
}

export function readAiscooWebAccount(auth: AiscooWebAuth) {
  return { token: auth.getZCodeJwtToken(), account: auth.getActiveAccount() };
}
