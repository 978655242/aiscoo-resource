import { readFile } from "node:fs/promises";
import { generateText } from "ai";
import { describe, expect, it } from "vitest";
import {
  createRegistryModelConfig,
  createRegistryProviderConfig,
  parseProviderConfig,
  parseZCodeBuiltinModelConfigRules,
} from "@zcode/provider";
import { modelSelectionSchema } from "@zcode/shared/model-selection";
import { AiSdkModelExecution } from "../src/model/model-execution.js";
import { createGenerateTextOptions } from "../src/model/runner-options.js";
import { createStatusContext } from "../src/model/runner-status.js";

// XCODE: 身份迁移不能把网关 model_id 改成产品 Provider ID；截获正式 SDK 请求，不发外网。
describe("Aiscoo migrated Provider SDK request", () => {
  it("keeps hy3, reasoning options and /v1/chat/completions on the wire", async () => {
    const selection = modelSelectionSchema.parse({
      providerId: "account:new-api-openai-chat-completions",
      modelId: "hy3",
      options: { reasoningLevel: "high" },
    });
    const release = JSON.parse(
      await readFile(
        new URL("../../../../../config/provider/zcode-builtin.json", import.meta.url),
        "utf8",
      ),
    );
    const rules = parseZCodeBuiltinModelConfigRules(release.config.modelConfigRules);
    const baseUrl = "https://zen.example.com/v1";
    const config = rules.resolve({
      providerId: selection.providerId,
      modelId: selection.modelId,
      apiType: "openai-chat-completions",
      baseUrl,
    });
    const model = createRegistryModelConfig(config);
    const provider = createRegistryProviderConfig(
      parseProviderConfig({
        group: "standard-personal",
        access: { type: "api-key", apiKey: "AISCOO_FAKE_RELAY_KEY" },
        api: { type: "openai-chat-completions", baseUrl },
      }),
    );
    if (!model.ok || !provider.ok) throw new Error("Invalid SDK fixture");
    const requests: Request[] = [];
    const execution = new AiSdkModelExecution(
      { env: {} },
      {
        transport: async (input, init) => {
          requests.push(new Request(input, init));
          return Response.json(
            { error: { message: "AISCOO_CAPTURED", type: "invalid_request_error" } },
            { status: 400 },
          );
        },
      },
    );
    const bound = execution.bindModel({
      providerId: selection.providerId,
      modelId: selection.modelId,
      providerConfig: provider.config,
      supportsJsonSchemaOutput: false,
      optionSpecs: model.config.optionSpecs,
    });
    const resolved = {
      ...bound.resolveRequest({
        options: { reasoningLevel: selection.options!.reasoningLevel, maxOutputTokens: 4096 },
      }),
      properties: model.config.properties,
    };
    const request = { messages: [{ role: "user" as const, content: "capture" }] };
    await expect(
      generateText(
        createGenerateTextOptions({
          includeModelIO: false,
          resolved,
          request,
          statusContext: createStatusContext({
            maxAttempts: 1,
            request,
            resolved,
            transport: "http",
          }),
        }),
      ),
    ).rejects.toThrow("AISCOO_CAPTURED");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`${baseUrl}/chat/completions`);
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer AISCOO_FAKE_RELAY_KEY");
    expect(await requests[0]!.json()).toMatchObject({ model: "hy3", reasoning_effort: "high" });
  });
});
