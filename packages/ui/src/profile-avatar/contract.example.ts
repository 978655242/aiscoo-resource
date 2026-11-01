import { createElement, type ReactNode } from "react";
import { AccountMenuVisibilityProvider, ProfileAvatarFallbackProvider } from "./index.js";

export function exampleProfileAvatar(children: ReactNode) {
  return createElement(ProfileAvatarFallbackProvider, {
    renderFallback: (user) => createElement("span", null, user.id),
    children,
  });
}

export function exampleAccountMenuVisibility(children: ReactNode) {
  return createElement(AccountMenuVisibilityProvider, { showRewards: false, children });
}
