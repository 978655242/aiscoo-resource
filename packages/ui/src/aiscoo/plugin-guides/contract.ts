import type { ComponentProps } from "react";
import type { IPluginGuideService } from "@zcode/services/aiscoo-plugin-guides";
import type { IModelSelectionService } from "@zcode/services";
import type { PluginGuideSnapshot } from "@zcode/shared/aiscoo-plugin-guides";
import type { ModelSelection } from "@zcode/shared";
import type { PluginStoreDetailView } from "@/settings/PluginStoreDetailView.js";

export type { IPluginGuideService };
export type { ModelSelectionView } from "@zcode/services";

export type AiscooPluginStoreDetailViewProps = ComponentProps<typeof PluginStoreDetailView> & {
  workspacePath?: string | null;
  workspaceIdentity?: string;
  remoteSessionId?: string | null;
  /** Explicit null means this target Host does not expose guides; never use another Host. */
  guideService?: IPluginGuideService | null;
  /** The guide Host's model catalog; must come from the same resolution as `guideService`. */
  modelSelectionService?: IModelSelectionService | null;
  /** False while the guide Host's connection is pending; pauses its model catalog reads. */
  guideHostReady?: boolean;
};
/** Model catalog owner for a guide reader: always the Host that owns the guide service. */
export interface PluginGuideModelHost {
  modelSelectionService: IModelSelectionService | null | undefined;
  ready: boolean;
}
export interface PluginGuideProjection {
  snapshot: PluginGuideSnapshot | null;
  loading: boolean;
  error: string | null;
  generate(question?: string, regenerate?: boolean, selection?: ModelSelection): Promise<boolean>;
  stop(): Promise<void>;
  retrySave(): Promise<void>;
  retryRead(): Promise<void>;
}
