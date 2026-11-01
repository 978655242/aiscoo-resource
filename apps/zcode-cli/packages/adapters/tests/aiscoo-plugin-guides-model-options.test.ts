import { describe, expect, it } from "vitest";
import {
  createModelId,
  createModelProviderId,
  createSessionId,
  type ModelOptions,
} from "@zcode/contracts";
import { createTestAgentRuntime } from "../../core/tests/test-agent-runtime.js";
import { createTestSessionEventStore } from "../../core/tests/test-event-store.js";
import { streamWorkspaceModelText } from "../../core/src/aiscoo-plugin-guides/index.js";
import { createModel } from "../src/model/model.js";
import { createTestModelProperties } from "./test-model-format.js";

describe("guide stream model output limits and isolated selection", () => {
  it.each([
    { limit: 4096, requested: 8192, expected: 4096, reasoning: undefined, actual: "low" },
    { limit: 32000, requested: 8192, expected: 8192, reasoning: undefined, actual: "low" },
    { limit: 4096, requested: 2048, expected: 2048, reasoning: undefined, actual: "low" },
    { limit: 4096, requested: undefined, expected: 4096, reasoning: undefined, actual: "low" },
    { limit: 4096, requested: 8192, expected: 4096, reasoning: "high", actual: "high" },
    { limit: 4096, requested: 8192, expected: 4096, reasoning: "max", actual: "max" },
  ])(
    "completes with model limit $limit, budget $requested and reasoning $reasoning",
    async ({ limit, requested, expected, reasoning, actual }) => {
      const requests: Required<ModelOptions>[] = [];
      const ordinarySelection = {
        providerId: "ordinary-provider",
        modelId: "ordinary-model",
        options: { reasoningLevel: "max" },
      };
      const selection = {
        providerId: "budget-fixture",
        modelId: "guide",
        ...(reasoning === undefined ? {} : { options: { reasoningLevel: reasoning } }),
      };
      const executedIdentities: { providerId: string; modelId: string }[] = [];
      const runtime = createTestAgentRuntime(
        createSessionId("guide-budget"),
        { modelSelection: ordinarySelection },
        {
          eventStore: createTestSessionEventStore(),
          modelFactory: ({ selection: boundSelection }) =>
            createModel({
              providerId: createModelProviderId(boundSelection.providerId),
              modelId: createModelId(boundSelection.modelId),
              properties: createTestModelProperties(),
              optionSpecs: {
                maxOutputTokens: { max: limit, map: '{"max_tokens":maxOutputTokens}' },
                reasoningLevel: {
                  values: ["low", "high", "max"],
                  map: '{"reasoning_effort":reasoningLevel}',
                },
              },
              options: boundSelection.options,
              executor: {
                async generateText() {
                  throw new Error("Unexpected nonstream request");
                },
                async *streamText(request) {
                  requests.push(request.options);
                  executedIdentities.push({
                    providerId: boundSelection.providerId,
                    modelId: boundSelection.modelId,
                  });
                  yield { type: "text_delta", id: "guide", text: "A completed guide" };
                  yield {
                    type: "finish",
                    finishReason: "stop",
                    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                  };
                },
              },
            }),
        },
      );
      const result = await streamWorkspaceModelText(
        runtime,
        {
          selection,
          prompt: "Write the guide",
          querySource: "plugin_usage_guide",
          ...(requested === undefined ? {} : { maxOutputTokens: requested }),
        },
        { onDelta() {} },
      );
      expect(result).toMatchObject({
        text: "A completed guide",
        finishReason: "stop",
        selection: {
          providerId: "budget-fixture",
          modelId: "guide",
          options: { reasoningLevel: actual },
        },
      });
      expect(requests).toEqual([{ maxOutputTokens: expected, reasoningLevel: actual }]);
      expect(executedIdentities).toEqual([{ providerId: "budget-fixture", modelId: "guide" }]);
      expect(runtime.getSessionModelSelection()).toEqual(ordinarySelection);
      expect(selection.options?.reasoningLevel).toBe(reasoning);
    },
  );
});
