import type { AiscooDesktopChannel, AiscooDesktopIdentity } from "./contract.js";
export type { AiscooDesktopChannel, AiscooDesktopIdentity } from "./contract.js";

export const AISCOO_DESKTOP_DEFAULT_DATA_BASE_DIR_ENV: "AISCOO_DESKTOP_DEFAULT_DATA_BASE_DIR";
export function getAiscooDesktopIdentity(channel: AiscooDesktopChannel): AiscooDesktopIdentity;
export function resolveAiscooDesktopIdentity(): AiscooDesktopIdentity | null;
