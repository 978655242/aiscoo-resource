import { createElement } from "react";
import { AiscooAccountAvatar } from "./index.js";

export function exampleAiscooAccountAvatar() {
  return createElement(AiscooAccountAvatar, { userId: "42", label: "Ada" });
}
