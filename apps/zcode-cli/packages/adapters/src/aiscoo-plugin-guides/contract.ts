import type { PluginGuideSource } from "@zcode/shared/aiscoo-plugin-guides";

export interface ReadPluginGuideSourceInput {
  storageRoot: string;
  marketplace: string;
  name: string;
  mode: "identity" | "documents";
  withWriteLock?: <T>(write: () => Promise<T>) => Promise<T>;
}
export type ReadPluginGuideSource = (
  input: ReadPluginGuideSourceInput,
) => Promise<PluginGuideSource>;
