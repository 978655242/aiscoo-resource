import type { AiscooPluginStoreDetailViewProps } from "./contract.js";

/** A management scope passes its resolved Host port, including an explicit unavailable value. */
export const unavailableGuideHostExample: Pick<
  AiscooPluginStoreDetailViewProps,
  "workspacePath" | "workspaceIdentity" | "remoteSessionId" | "guideService"
> = {
  workspacePath: "/project",
  workspaceIdentity: "example-workspace",
  remoteSessionId: "example-remote-session",
  guideService: null,
};
