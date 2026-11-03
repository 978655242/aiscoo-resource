import type { RuntimeHeadersRequestValidator } from "./contract.js";
import { validateAiscooAdminRuntimeHeadersRequest } from "./index.js";

export const runtimeHeadersValidatorsExample: readonly RuntimeHeadersRequestValidator[] = [
  validateAiscooAdminRuntimeHeadersRequest,
];
