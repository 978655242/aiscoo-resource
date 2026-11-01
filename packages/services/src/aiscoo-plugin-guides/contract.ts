import type { Event } from "@zcode/rpc";
import type { ModelSelectionView } from "@zcode/provider";
import type {
  ZCodeWorkspaceGenerateTextParams,
  ZCodeWorkspaceGenerateTextResult,
} from "@zcode/shared";
import type {
  PluginGuideChange,
  PluginGuideDocument,
  PluginGuideSource,
  PluginGuideGenerateParams,
  PluginGuideSnapshot,
  PluginGuideTarget,
} from "@zcode/shared/aiscoo-plugin-guides";
import { createServiceDescriptor } from "../descriptors.js";

/** The target Host owns all accepted guide operations and complete saved revisions. */
export interface IPluginGuideService {
  read(target: PluginGuideTarget): Promise<PluginGuideSnapshot>;
  generate(input: PluginGuideGenerateParams): Promise<PluginGuideSnapshot>;
  cancel(input: { target: PluginGuideTarget; operationId: string }): Promise<void>;
  retrySave(target: PluginGuideTarget): Promise<PluginGuideSnapshot>;
  onDidChange: Event<PluginGuideChange>;
}
export const IPluginGuideService =
  createServiceDescriptor<IPluginGuideService>("xwork-plugin-guides");
export type {
  PluginGuideDocument,
  PluginGuideGenerateParams,
  PluginGuideMessage,
  PluginGuideSnapshot,
  PluginGuideTarget,
} from "@zcode/shared/aiscoo-plugin-guides";

export interface PluginGuideAgentPort {
  readPluginGuideSource(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    pluginName: string;
    marketplace: string;
    mode: "identity" | "documents";
    signal?: AbortSignal;
  }): Promise<PluginGuideSource>;
  streamWorkspaceModelText(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    remoteSessionId?: string;
    selection: ZCodeWorkspaceGenerateTextParams["selection"];
    messages: NonNullable<ZCodeWorkspaceGenerateTextParams["messages"]>;
    querySource: string;
    maxOutputTokens: number;
    operationId: string;
    signal: AbortSignal;
    onDelta: (text: string) => void;
  }): Promise<ZCodeWorkspaceGenerateTextResult>;
}
export interface PluginGuideRepository {
  read(
    source: Pick<PluginGuideSource, "sourceIdentity" | "pluginId">,
    locale: PluginGuideTarget["locale"],
  ): Promise<PluginGuideDocument | null>;
  readFallback(target: PluginGuideTarget): Promise<PluginGuideDocument | null>;
  save(target: PluginGuideTarget, document: PluginGuideDocument): Promise<void>;
  withLock<T>(
    source: Pick<PluginGuideSource, "sourceIdentity" | "pluginId">,
    locale: PluginGuideTarget["locale"],
    run: () => Promise<T>,
  ): Promise<T>;
}
export interface PluginGuideServiceDependencies {
  repository: PluginGuideRepository;
  readSource(
    target: PluginGuideTarget,
    mode: "identity" | "documents",
    signal?: AbortSignal,
  ): Promise<PluginGuideSource>;
  readModelSelectionView(
    target: PluginGuideTarget,
    selection?: ZCodeWorkspaceGenerateTextParams["selection"],
  ): Promise<ModelSelectionView>;
  streamText: PluginGuideAgentPort["streamWorkspaceModelText"];
  now?: () => Date;
}
