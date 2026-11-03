import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import {
  ProviderConfigResolver,
  ProviderConfigMap,
  ModelConfigRules,
  ProviderRegistry,
} from "@zcode/provider";
import { createNewApiProviderAnchors } from "@zcode/provider-node";
import { AISCOO_MODEL_PROVIDER_IDS } from "@zcode/shared";
import {
  runWithModelInvocationContext,
  type ModelInputMessage,
  type ModelRequest,
  type ModelToolCall,
} from "@zcode/contracts";
import { ApiProviderModelRuntime } from "../../../apps/zcode-cli/packages/bootstrap/src/app/provider-registry-model-runtime.js";
import { AiSdkModelAdapter } from "../../../apps/zcode-cli/packages/adapters/src/model/runner.js";
import { resolveNewApiAccountProviders } from "../src/new-api/newApiAccountProviderResolution.js";
import {
  owner,
  catalog,
  entitlements,
  modelConfig,
  builtinModelRules,
} from "./newApiRegistryFixtures.js";

const reasoningMap =
  'reasoningLevel == "disabled" ? {"thinking":{"type":"disabled"},"reasoning_effort":null} : {"thinking":{"type":"enabled"},"reasoning_effort":reasoningLevel}';
const defaultEnabledMap =
  'reasoningLevel == "disabled" ? {"thinking":{"type":"disabled"},"reasoning_effort":null} : {"thinking":null,"reasoning_effort":reasoningLevel}';

const bodySchema = z.object({
  model: z.literal("real-model"),
  thinking: z.object({ type: z.enum(["enabled", "disabled"]) }).optional(),
  reasoning_effort: z.string().optional(),
  max_tokens: z.number().int().positive(),
  tools: z
    .array(
      z.object({
        type: z.literal("function"),
        function: z.object({ name: z.string(), parameters: z.record(z.string(), z.unknown()) }),
      }),
    )
    .optional(),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.unknown().optional(),
      reasoning_content: z.string().optional(),
      tool_calls: z
        .array(
          z.object({
            id: z.string(),
            type: z.literal("function"),
            function: z.object({ name: z.string(), arguments: z.string() }),
          }),
        )
        .optional(),
      tool_call_id: z.string().optional(),
    }),
  ),
});

test(
  "real Native SDK freezes maps through streamed tools and retry; the next Model uses new capabilities",
  { timeout: 20_000 },
  async () => {
    const bodies: z.infer<typeof bodySchema>[] = [];
    const paths: string[] = [];
    const firstStarted = Promise.withResolvers<void>();
    const releaseFirst = Promise.withResolvers<void>();
    const peerErrors: unknown[] = [];
    const peer = createServer(async (request, response) => {
      try {
        let raw = "";
        for await (const chunk of request) raw += chunk.toString();
        bodies.push(bodySchema.parse(JSON.parse(raw)));
        paths.push(request.url!);
        const index = bodies.length;
        if (index === 1) {
          firstStarted.resolve();
          await releaseFirst.promise;
          response.writeHead(200, { "content-type": "text/event-stream" });
          const chunk = (delta: object, finish_reason: string | null = null) =>
            response.write(
              `data: ${JSON.stringify({ id: "fixture-tool-completion", object: "chat.completion.chunk", created: 1, model: "real-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
            );
          chunk({ role: "assistant", reasoning_content: "inspect " });
          chunk({ reasoning_content: "the fixture" });
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "lookup-1",
                type: "function",
                function: { name: "lookup", arguments: '{"query":' },
              },
            ],
          });
          chunk({ tool_calls: [{ index: 0, function: { arguments: '"fixture"}' } }] });
          chunk({}, "tool_calls");
          response.write(
            `data: ${JSON.stringify({ id: "fixture-tool-completion", object: "chat.completion.chunk", created: 1, model: "real-model", choices: [], usage: { prompt_tokens: 20, completion_tokens: 8, total_tokens: 28 } })}\n\n`,
          );
          response.end("data: [DONE]\n\n");
          return;
        }
        if (index === 2) {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: { message: "isolated transient peer error", type: "server_error" },
            }),
          );
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: `fixture-${index}`,
            object: "chat.completion",
            created: 1,
            model: "real-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "fixture complete" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 30, completion_tokens: 4, total_tokens: 34 },
          }),
        );
      } catch (error) {
        peerErrors.push(error);
        firstStarted.reject(error);
        response.writeHead(500);
        response.end();
      }
    });
    peer.listen(0, "127.0.0.1");
    await once(peer, "listening");
    const address = peer.address();
    assert.ok(address && typeof address !== "string");
    const currentOwner = { ...owner, origin: `http://127.0.0.1:${address.port}` };
    const nativeId = AISCOO_MODEL_PROVIDER_IDS["openai-chat-completions"];
    const resolve = (next: boolean, map = next ? defaultEnabledMap : reasoningMap) => {
      const native = resolveNewApiAccountProviders({
        owner: currentOwner,
        entitlements,
        configRevision: next ? "builtin-2" : "builtin-1",
        catalog: {
          ...catalog,
          models: [
            {
              ...catalog.models[0]!,
              api_type: "openai-chat-completions",
            },
          ],
        },
      });
      return new ProviderConfigResolver().resolve({
        zcodeBuiltinProviders: createNewApiProviderAnchors(currentOwner.origin),
        personalProviders: ProviderConfigMap.empty(),
        personalModels: ModelConfigRules.empty(),
        zcodeBuiltinModelRules: builtinModelRules({
          ...modelConfig,
          properties: {
            ...modelConfig.properties,
            contextWindow: next ? 4096 : 8192,
            supportsToolCall: true,
          },
          optionSpecs: {
            reasoningLevel: {
              values: next ? ["disabled", "high", "max"] : ["disabled", "low", "high", "max"],
              map,
            },
            maxOutputTokens: { max: next ? 32 : 64, map: '{"max_tokens":maxOutputTokens}' },
          },
        }),
        accountProviders: native.providers,
        accountStates: native.states,
        accountModelPresentation: native.modelPresentation,
        accountOwner: currentOwner,
        accountRevision: native.revision,
        accountAuthorizationRevision: native.authorizationRevision,
      });
    };
    const initial = resolve(false);
    const registry = new ProviderRegistry(initial.registryProviders);
    const runtime = new ApiProviderModelRuntime({
      registry,
      modelAdapter: new AiSdkModelAdapter({ env: {}, retry: { maxAttempts: 2 } }),
    });
    const credential = {
      refreshRuntimeHeadersBeforeAttempt: async () => ({
        headersApplied: true,
        requestAuth: { apiKey: "sk-isolated-fixture" },
      }),
    };
    const selection = {
      providerId: nativeId,
      modelId: "real-model",
      options: { reasoningLevel: "high" },
    };
    const messages: ModelInputMessage[] = [
      { role: "user", content: "lookup the synthetic fixture" },
    ];
    let toolDirectory: string | undefined;
    const lookupInput = z.object({ query: z.literal("fixture") });
    const tools = [
      {
        name: "lookup",
        description: "Read synthetic fixture",
        inputSchema: {
          type: "object",
          properties: { query: { type: "string" } },
          required: ["query"],
          additionalProperties: false,
        },
        execute: async (input: unknown) => {
          lookupInput.parse(input);
          assert.ok(toolDirectory);
          return readFile(join(toolDirectory, "fixture.txt"), "utf8");
        },
      },
    ];
    const request: ModelRequest = { messages, tools, options: { maxOutputTokens: 48 } };
    const calls: ModelToolCall[] = [];
    let reasoning = "";
    let finish = "";
    let streaming: Promise<void> | undefined;
    runtime.start();
    try {
      toolDirectory = await mkdtemp(join(tmpdir(), "xwork-native-sdk-tool-"));
      await writeFile(join(toolDirectory, "fixture.txt"), "synthetic lookup result");
      const legacySelection = {
        ...selection,
        providerId: "account:new-api-openai-chat-completions",
      };
      const oldModel = runtime.modelFactory({ selection: legacySelection });
      assert.equal(oldModel.providerId, nativeId);
      assert.equal(legacySelection.providerId, "account:new-api-openai-chat-completions");
      streaming = runWithModelInvocationContext(credential, async () => {
        for await (const event of oldModel.streamText(request)) {
          if (event.type === "error") throw event.error;
          if (event.type === "reasoning_delta") reasoning += event.text;
          if (event.type === "tool_call") calls.push(event.toolCall);
          if (event.type === "finish") finish = event.finishReason;
        }
      });
      await firstStarted.promise;
      registry.replace(resolve(true).registryProviders, "capabilities-B-during-stream");
      releaseFirst.resolve();
      await streaming;
      assert.equal(reasoning, "inspect the fixture");
      assert.equal(finish, "tool-calls");
      assert.deepEqual(
        calls.map(({ id, name, input }) => ({ id, name, input })),
        [{ id: "lookup-1", name: "lookup", input: { query: "fixture" } }],
      );
      const toolResult = await tools[0]!.execute(calls[0]!.input);
      const continuation: ModelRequest = {
        ...request,
        messages: [
          ...messages,
          {
            role: "assistant",
            content: [{ type: "reasoning", text: reasoning }],
            toolCalls: calls,
            providerId: oldModel.providerId,
            modelId: oldModel.modelId,
          },
          { role: "tool", content: toolResult, toolCallId: calls[0]!.id, toolName: calls[0]!.name },
        ],
      };
      const continued = await runWithModelInvocationContext(credential, () =>
        oldModel.generateText(continuation),
      );
      assert.equal(continued.text, "fixture complete");
      assert.equal(continued.finishReason, "stop");
      const nextModel = runtime.modelFactory({ selection });
      assert.equal(oldModel.properties.contextWindow, 8192);
      assert.equal(oldModel.optionSpecs.maxOutputTokens.max, 64);
      assert.equal(nextModel.properties.contextWindow, 4096);
      assert.equal(nextModel.optionSpecs.maxOutputTokens.max, 32);
      await assert.rejects(
        runWithModelInvocationContext(credential, () => nextModel.generateText(request)),
        /maxOutputTokens/,
      );
      const beforeRejectedSelection = bodies.length;
      assert.throws(
        () =>
          runtime.modelFactory({ selection: { ...selection, options: { reasoningLevel: "low" } } }),
        /reasoning|selection/i,
      );
      assert.equal(bodies.length, beforeRejectedSelection);
      await runWithModelInvocationContext(credential, () =>
        nextModel.generateText({ messages, tools, options: { maxOutputTokens: 24 } }),
      );
      const disabledModel = runtime.modelFactory({
        selection: { ...selection, options: { reasoningLevel: "disabled" } },
      });
      await runWithModelInvocationContext(credential, () =>
        disabledModel.generateText({ messages, options: { maxOutputTokens: 1 } }),
      );
      assert.deepEqual(peerErrors, []);
      assert.deepEqual(paths, Array(5).fill("/v1/chat/completions"));
      for (const body of bodies.slice(0, 3)) {
        assert.deepEqual(body.thinking, { type: "enabled" });
        assert.equal(body.reasoning_effort, "high");
        assert.equal(body.max_tokens, 48);
        assert.deepEqual(body.tools?.[0]?.function.parameters, tools[0]!.inputSchema);
      }
      for (const body of bodies.slice(1, 3)) {
        const assistant = body.messages.find((message) => message.role === "assistant");
        assert.ok(assistant);
        assert.equal(assistant.reasoning_content, reasoning);
        assert.deepEqual(assistant.tool_calls, [
          {
            id: "lookup-1",
            type: "function",
            function: { name: "lookup", arguments: '{"query":"fixture"}' },
          },
        ]);
        const tool = body.messages.find((message) => message.role === "tool");
        assert.ok(tool);
        assert.equal(tool.tool_call_id, "lookup-1");
        assert.equal(tool.content, "synthetic lookup result");
      }
      assert.equal(Object.hasOwn(bodies[3]!, "thinking"), false);
      assert.equal(bodies[3]!.reasoning_effort, "high");
      assert.equal(bodies[3]!.max_tokens, 24);
      assert.deepEqual(bodies[4]!.thinking, { type: "disabled" });
      assert.equal(Object.hasOwn(bodies[4]!, "reasoning_effort"), false);
      assert.equal(bodies[4]!.max_tokens, 1);
      registry.replace(resolve(false).registryProviders, "all-authorized-levels");
      for (const level of ["disabled", "low", "high", "max"]) {
        const model = runtime.modelFactory({
          selection: { ...selection, options: { reasoningLevel: level } },
        });
        await runWithModelInvocationContext(credential, () =>
          model.generateText({ messages, options: { maxOutputTokens: 64 } }),
        );
        const body = bodies.at(-1)!;
        assert.equal(body.max_tokens, 64);
        assert.deepEqual(body.thinking, { type: level === "disabled" ? "disabled" : "enabled" });
        assert.equal(body.reasoning_effort, level === "disabled" ? undefined : level);
      }
      for (const map of ['reasoningLevel == "high" ? [1] : {}', '{"max_tokens":999}']) {
        registry.replace(resolve(false, map).registryProviders, "invalid-option-map");
        const beforeInvalidMap = bodies.length;
        await assert.rejects(async () => {
          const model = runtime.modelFactory({ selection });
          await runWithModelInvocationContext(credential, () =>
            model.generateText({ messages, options: { maxOutputTokens: 64 } }),
          );
        });
        assert.equal(bodies.length, beforeInvalidMap);
      }
      assert.deepEqual(peerErrors, []);
    } finally {
      releaseFirst.resolve();
      runtime.dispose();
      await Promise.allSettled(streaming ? [streaming] : []);
      peer.closeAllConnections();
      await new Promise<void>((resolveClose, reject) =>
        peer.close((error) => (error ? reject(error) : resolveClose())),
      );
      if (toolDirectory) await rm(toolDirectory, { recursive: true, force: true });
    }
  },
);
