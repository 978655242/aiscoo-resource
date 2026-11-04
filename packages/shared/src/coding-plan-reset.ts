import type { AiscooAdminEntitlements } from "./aiscoo-admin.js";
export type CodingPlanResetType = "FIVE_HOUR" | "WEEK";

export interface CodingPlanResetScopeRequest {
  preferredProviderId: string;
  /** Registry 静态访问类别，或调用边界已解析的 Team scope。 */
  accountAccess: ZCodeProviderAccountAccess | ZCodeAccountAccess;
}

export interface CodingPlanResetOpportunitySnapshot {
  expireAt: number;
}

export interface CodingPlanResetHistorySnapshot {
  usedAt: number;
}

export interface OfficialWindowsResetStatus {
  mode: "official-windows";
  availableFiveHourResets: CodingPlanResetOpportunitySnapshot[];
  availableWeekResets: CodingPlanResetOpportunitySnapshot[];
  latestFiveHourResetHistory: CodingPlanResetHistorySnapshot | null;
  latestWeekResetHistory: CodingPlanResetHistorySnapshot | null;
  hasUnreadHistory: boolean;
}

export interface NativeSinglePeriodResetStatus {
  mode: "native-single-period";
  source: "new-api";
  selfServiceEnabled: false;
  authorizationStatus: AiscooAdminEntitlements["status"];
  authorizationRevision: string;
  period: "never" | "daily" | "weekly" | "monthly" | "custom" | null;
  lastResetTime: number | null;
  nextResetTime: number | null;
  resetTimeZone: string | null;
  history: { availability: "not-supported"; reason: "native-history-not-provided" };
}

export type CodingPlanResetStatusSnapshot =
  | OfficialWindowsResetStatus
  | NativeSinglePeriodResetStatus;
export type CodingPlanResetHistoryReadResult =
  | { availability: "available" }
  | { availability: "not-supported"; reason: "native-history-not-provided" };

export interface CodingPlanResetOpportunityRequest extends CodingPlanResetScopeRequest {
  idempotencyKey: string;
}

export interface CodingPlanResetOpportunityResult {
  granted: boolean;
  nextTryAt: number | null;
}

export interface CodingPlanResetUseRequest extends CodingPlanResetScopeRequest {
  idempotencyKey: string;
  resetType: CodingPlanResetType;
}

export interface CodingPlanResetUseResult {
  used: true;
}
import type { ZCodeAccountAccess, ZCodeProviderAccountAccess } from "./zcode-protocol/index.js";
