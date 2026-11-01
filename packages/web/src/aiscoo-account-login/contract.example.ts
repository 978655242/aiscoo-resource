import type { AiscooWebAuth } from "./contract.js";

export function readAiscooWebAccount(auth: AiscooWebAuth) {
  return { token: auth.getZCodeJwtToken(), account: auth.getActiveAccount() };
}
