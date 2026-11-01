import type { RestoredDraftContext } from "./contract.js";
import { restoreDraftContext } from "./restoreDraftContext.js";

export function restoreProjectContextExample(context: RestoredDraftContext): void {
  restoreDraftContext(context);
}
