import { createAiscooAccountPolicy } from "./index.js";

export const unavailableAccountExample = createAiscooAccountPolicy({});
export const configuredAccountExample = createAiscooAccountPolicy({
  adminBaseUrl: "https://account.example.com",
});
