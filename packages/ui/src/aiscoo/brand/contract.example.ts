import { createElement } from "react";
import { AiscooMark, AiscooWordmark } from "./index.js";
import type { AiscooBrandComponents } from "./contract.js";

export const aiscooBrandComponents: AiscooBrandComponents = {
  Mark: AiscooMark,
  Wordmark: AiscooWordmark,
};

export function aiscooBrandExample() {
  return createElement(AiscooWordmark, { className: "h-auto w-24" });
}
