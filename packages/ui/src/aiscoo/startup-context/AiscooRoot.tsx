import type { ComponentType } from "react";
import type { RootProps } from "@/root/types.js";
import { restoreDraftContext } from "./restoreDraftContext.js";

export function createAiscooRoot(Root: ComponentType<RootProps>) {
  return function AiscooRoot(props: RootProps) {
    return <Root {...props} restoreDraftContext={restoreDraftContext} />;
  };
}
