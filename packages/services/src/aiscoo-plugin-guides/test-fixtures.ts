import { afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ModelSelectionView } from "@zcode/provider";
import {
  PLUGIN_GUIDE_SECTIONS,
  type PluginGuideSource,
  type PluginGuideTarget,
} from "@zcode/shared/aiscoo-plugin-guides";
import type { PluginGuideAgentPort, PluginGuideServiceDependencies } from "./contract.js";
import { createPluginGuideService } from "./app/service.js";
import { createPluginGuideFileRepository } from "./adapters/repository.js";
export { createPluginGuideService };

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
export const target: PluginGuideTarget = {
  workspacePath: "/workspace",
  pluginName: "tables",
  marketplace: "example",
  locale: "en-US",
  version: "1.0.0",
};
export const selection = { providerId: "test-provider", modelId: "guide-model" };
export const source: PluginGuideSource = {
  pluginId: "tables@example",
  sourceIdentity: "source-a",
  sourceRevision: "source-v1",
  fingerprint: "content-v1",
  fingerprintKind: "content",
  version: "1.0.0",
  documents: [
    {
      path: "skills/tables/SKILL.md",
      text: "Create spreadsheet summaries from a CSV and verify totals.",
    },
  ],
  diagnostics: [],
};
function documentText(detail = "Summarize monthly sales and verify totals.") {
  return `# Tables\n\n${PLUGIN_GUIDE_SECTIONS.map((section) => `## ${section.title["en-US"]}\n\n${detail}`).join("\n\n")}`;
}
export function response(detail?: string) {
  return `<reply>Updated the requested explanation.</reply>\n<guide>\n${documentText(detail)}\n</guide>`;
}
export const modelSelectionView: ModelSelectionView = {
  revision: 1,
  preferredSelection: { ...selection, options: { reasoningLevel: "max" } },
  providers: [selection, { providerId: "alternate-provider", modelId: "alternate-model" }].map(
    (identity) => ({
      providerId: identity.providerId,
      config: {},
      models: [
        {
          modelId: identity.modelId,
          config: {
            enabled: true,
            properties: {
              requiresMfjsToolSchema: false,
              contextWindow: 200_000,
              inputFormat: {
                supportsText: true,
                supportsImage: false,
                supportsVideo: false,
                supportsAudio: false,
                supportsPdf: false,
              },
              outputFormat: { supportsText: true },
              supportsToolCall: false,
              supportsJsonSchemaOutput: false,
              supportsNativeWebSearch: false,
              supportsMidConversationSystem: false,
            },
            optionSpecs: {
              reasoningLevel: { values: ["low", "high", "max"], map: "{}" },
              maxOutputTokens: { max: 4096, map: '{"max_tokens":maxOutputTokens}' },
            },
          },
        },
      ],
    }),
  ),
};
export async function setup(stream?: PluginGuideAgentPort["streamWorkspaceModelText"]) {
  const root = await mkdtemp(join(tmpdir(), "aiscoo-plugin-guides-"));
  roots.push(root);
  const repository = createPluginGuideFileRepository(root);
  const requests: Parameters<PluginGuideAgentPort["streamWorkspaceModelText"]>[0][] = [];
  const dependencies: PluginGuideServiceDependencies = {
    repository,
    readSource: async () => source,
    readModelSelectionView: async (_target, chosen) => {
      if (!chosen) return modelSelectionView;
      const provider = modelSelectionView.providers.find(
        (candidate) => candidate.providerId === chosen.providerId,
      );
      const model = provider?.models.find((candidate) => candidate.modelId === chosen.modelId);
      const reasoning = chosen.options?.reasoningLevel;
      return {
        ...modelSelectionView,
        effectiveSelection: provider && model ? chosen : null,
        ...(!provider
          ? { selectionIssue: "provider-not-found" as const }
          : !model
            ? { selectionIssue: "model-not-found" as const }
            : reasoning === undefined
              ? { selectionIssue: "reasoning-level-missing" as const }
              : !model.config.optionSpecs.reasoningLevel.values.includes(reasoning)
                ? { selectionIssue: "reasoning-level-not-supported" as const }
                : {}),
      };
    },
    streamText: async (request) => {
      requests.push(request);
      if (stream) return stream(request);
      const text = response();
      request.onDelta(text.slice(0, 100));
      request.onDelta(text.slice(100));
      return { text, selection: request.selection, finishReason: "stop" };
    },
  };
  return {
    root,
    repository,
    dependencies,
    requests,
    service: createPluginGuideService(dependencies),
  };
}
