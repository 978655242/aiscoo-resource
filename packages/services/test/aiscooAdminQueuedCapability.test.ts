import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { z } from "zod";
import {
  createRootTraceContext,
  SessionEventType,
  type SessionEvent,
  type TurnErrorPayload,
} from "@zcode/contracts";
import {
  ModelConfigRules,
  ProviderConfigMap,
  ProviderConfigResolver,
  ProviderRegistry,
} from "@zcode/provider";
import { createAiscooAdminProviderAnchors } from "@zcode/provider-node";
import { AISCOO_MODEL_PROVIDER_IDS } from "@zcode/shared";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { createZCodeApp } from "../../../apps/zcode-cli/packages/bootstrap/src/app/create-app.js";
import type { ZCodeApp } from "../../../apps/zcode-cli/packages/bootstrap/src/app/types.js";
import { V4CommandExecutor } from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/executor.js";
import type { V4SessionRecordView } from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/commands/types.js";
import { ProductProjection } from "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/product-projection.js";
import { resolveAiscooAdminAccountProviders } from "../src/aiscoo-admin/aiscooAdminAccountProviderResolution.js";
import {
  catalog,
  entitlements,
  modelConfig,
  builtinModelRules,
  owner,
} from "./aiscooAdminRegistryFixtures.js";

const lowSelection = {
  providerId: AISCOO_MODEL_PROVIDER_IDS["openai-chat-completions"],
  modelId: "real-model",
  options: { reasoningLevel: "low" },
};
const requestSchema = z.object({
  model: z.literal("real-model"),
  reasoning_effort: z.string(),
  thinking: z.object({ type: z.literal("enabled") }),
  stream: z.literal(true),
});

for (const promotion of ["manual", "auto"] as const) {
  test(
    `${promotion} Core queue promotion preserves removed low and exposes model_creation failure without another HTTP request`,
    { timeout: 30_000 },
    async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "xwork-native-queued-capability-"));
      const workspace = join(directory, "workspace");
      const storage = join(directory, "storage");
      const userConfigPath = join(directory, "config.json");
      const firstStarted = Promise.withResolvers<void>();
      const releaseFirst = Promise.withResolvers<void>();
      const backgroundFinished = Promise.withResolvers<void>();
      const requests: z.infer<typeof requestSchema>[] = [];
      const paths: string[] = [];
      const peerErrors: unknown[] = [];
      const events: SessionEvent[] = [];
      let app: ZCodeApp | undefined;
      let initialCompletion: Promise<unknown> | undefined;
      const initialAbort = new AbortController();
      let projection: ProductProjection | undefined;
      const peer = createServer(async (request, response) => {
        try {
          let raw = "";
          for await (const chunk of request) raw += chunk.toString();
          requests.push(requestSchema.parse(JSON.parse(raw)));
          paths.push(request.url!);
          if (requests.length === 1) {
            firstStarted.resolve();
            await releaseFirst.promise;
          }
          response.writeHead(200, { "content-type": "text/event-stream" });
          const chunk = (delta: object, finish_reason: string | null = null) =>
            response.write(
              `data: ${JSON.stringify({
                id: "queued-capability-fixture",
                object: "chat.completion.chunk",
                created: 1,
                model: "real-model",
                choices: [{ index: 0, delta, finish_reason }],
              })}\n\n`,
            );
          chunk({ role: "assistant", content: "Controlled turn complete" });
          chunk({}, "stop");
          response.end("data: [DONE]\n\n");
        } catch (error) {
          peerErrors.push(error);
          firstStarted.reject(error);
          response.writeHead(500);
          response.end();
        }
      });
      try {
        await mkdir(workspace);
        await writeFile(
          userConfigPath,
          JSON.stringify({
            storage: { dir: storage, sessionDbPath: join(storage, "session.db") },
            plugins: { enabled: false },
            skills: { enabled: false },
            mcp: { enabled: false, servers: {} },
          }),
        );
        peer.listen(0, "127.0.0.1");
        await once(peer, "listening");
        const address = peer.address();
        assert.ok(address && typeof address !== "string");
        const currentOwner = { ...owner, origin: `http://127.0.0.1:${address.port}` };
        const resolveProviders = (removeLow: boolean) => {
          const native = resolveAiscooAdminAccountProviders({
            owner: currentOwner,
            entitlements,
            configRevision: removeLow ? "builtin-2" : "builtin-1",
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
            zcodeBuiltinProviders: createAiscooAdminProviderAnchors(currentOwner.origin),
            personalProviders: ProviderConfigMap.empty(),
            personalModels: ModelConfigRules.empty(),
            zcodeBuiltinModelRules: builtinModelRules({
              ...modelConfig,
              properties: {
                ...modelConfig.properties,
                contextWindow: 65536,
                supportsToolCall: true,
              },
              optionSpecs: {
                ...modelConfig.optionSpecs,
                reasoningLevel: {
                  values: removeLow
                    ? ["disabled", "high", "max"]
                    : ["disabled", "low", "high", "max"],
                  map: 'reasoningLevel == "disabled" ? {"thinking":{"type":"disabled"},"reasoning_effort":null} : {"thinking":{"type":"enabled"},"reasoning_effort":reasoningLevel}',
                },
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
        const registry = new ProviderRegistry(resolveProviders(false).registryProviders);
        assert.equal(registry.validateSelection(lowSelection).ok, true);
        const traceContext = createRootTraceContext();
        app = await createZCodeApp({
          providerRegistry: registry,
          traceContext,
          skipUserConfig: false,
          userConfigPath,
          projectConfigPath: join(workspace, "absent-project-config.json"),
          pluginStorageRoot: join(storage, "cli", "plugins"),
          officialPluginRoots: [],
          env: {
            ZCODE_STORAGE_DIR: storage,
            HOME: directory,
            ZCODE_SESSION_DB_PATH: join(storage, "session.db"),
            ZCODE_LOG_DIR: join(storage, "cli", "log"),
          },
          runtimeConfig: {
            workingDirectory: workspace,
            modelStreaming: "on",
            modelSelection: lowSelection,
            mode: "build",
            toolAllowlist: ["Read"],
            titleGeneration: { enabled: false },
            memory: { enabled: false, extractionEnabled: false },
            dynamicWorkflowEnabled: false,
            mcp: { enabled: false, servers: {} },
          },
          providerRuntimeHeadersPort: {
            refreshBeforeModelRequest: async () => ({
              headersApplied: true,
              requestAuth: { apiKey: "sk-isolated-queued-fixture" },
            }),
          },
          eventSink: {
            onSessionEvent(event) {
              projection ??= new ProductProjection(
                String(event.sessionId),
                "queued-capability-test",
              );
              projection.applyEvent(event);
              events.push(event);
            },
          },
        });
        const record: V4SessionRecordView = {
          app,
          traceContext,
          workspace: { workspacePath: workspace },
          persistence: "immediate",
        };
        const executor = new V4CommandExecutor({
          getRecord: (sessionId) => (sessionId === app!.sessionId ? record : undefined),
          getQueueItem: (_sessionId, queueItemId) =>
            projection!
              .getSnapshot()
              .queue.items.find((item) => item.queueItemId === queueItemId) ?? null,
          getInputRoutingMode: () => projection!.getSnapshot().inputRouting.mode,
          afterLegacyStateMutation: async (_record, reason) => {
            if (reason === "prompt_failed" || reason === "prompt_completed")
              backgroundFinished.resolve();
          },
        });
        await app.setQueueAutoDrain(false);
        const initial = await app.sendInput("Run the controlled first turn", {
          inputId: "initial-turn",
          abortSignal: AbortSignal.any([initialAbort.signal, t.signal]),
        });
        assert.equal(initial.kind, "started_turn");
        if (initial.kind !== "started_turn") throw new Error("Expected real Core turn admission");
        initialCompletion = initial.completion;
        await firstStarted.promise;
        const queuedCommand: CommandEnvelope = {
          commandId: "original-queued-low",
          clientId: "queued-capability-test",
          sessionId: app.sessionId,
          type: "sendText",
          issuedAt: Date.now(),
          payload: {
            text: "Keep this original low selection",
            modelSelection: lowSelection,
            requestedDelivery: "queue",
          },
        };
        assert.deepEqual(await executor.execute(queuedCommand), {
          type: "inputAccepted",
          delivery: "queue",
          inputId: "original-queued-low",
        });
        const queued = projection!.getSnapshot().queue.items[0]!;
        assert.ok(queued);
        assert.equal(queued.sourceCommandId, "original-queued-low");
        assert.deepEqual(queued.modelSelection, lowSelection);
        assert.equal(queued.dispatch.state, "queued");
        const coreQueued = (await app.runtime.getProjection()).pendingSteerInputs;
        assert.equal(coreQueued.length, 1);
        assert.equal(coreQueued[0]!.pendingInputId, queued.queueItemId);
        assert.deepEqual(coreQueued[0]!.intent?.modelSelection, lowSelection);
        const oldProvider = registry.getProvider(lowSelection.providerId)!;
        registry.replace(resolveProviders(true).registryProviders, "capability-only-refresh");
        const newProvider = registry.getProvider(lowSelection.providerId)!;
        assert.deepEqual(newProvider.accountOwner, oldProvider.accountOwner);
        assert.equal(
          newProvider.accountAuthorizationRevision,
          oldProvider.accountAuthorizationRevision,
        );
        assert.equal(registry.validateSelection(lowSelection).ok, false);
        assert.deepEqual(projection!.getSnapshot().queue.items[0]!.modelSelection, lowSelection);
        releaseFirst.resolve();
        assert.equal((await initial.completion).response, "Controlled turn complete");
        assert.equal((await app.runtime.getProjection()).pendingSteerInputs.length, 1);
        assert.equal(app.runtime.hasActiveOrQueuedTurnWork(), false);
        assert.equal(projection!.getSnapshot().queue.autoDrain, false);
        assert.deepEqual(projection!.getSnapshot().queue.items[0]!.modelSelection, lowSelection);
        assert.equal(requests.length, 1);
        assert.equal(requests[0]!.reasoning_effort, "low");
        const requestCountBeforePromotion = requests.length;
        if (promotion === "auto") await app.setQueueAutoDrain(true);
        await executor.execute(
          {
            commandId: `${promotion}-promote`,
            clientId: "queued-capability-test",
            sessionId: app.sessionId,
            type: "sendQueuedNow",
            issuedAt: Date.now(),
            payload: { queueItemId: queued.queueItemId },
          },
          undefined,
          promotion === "auto" ? { autoDrainPromotion: true } : undefined,
        );
        await backgroundFinished.promise;
        const terminalErrors = events.filter((event) => event.type === SessionEventType.TurnError);
        assert.equal(terminalErrors.length, 1);
        const terminal = terminalErrors[0]!;
        const failure = terminal.payload as TurnErrorPayload;
        assert.equal(failure.inputId, "original-queued-low");
        assert.equal(failure.turnPhase, "model_creation");
        const snapshot = projection!.getSnapshot();
        assert.equal(snapshot.control.phase, "error");
        assert.ok(snapshot.control.lastError?.message);
        assert.deepEqual(app.runtime.getSessionModelSelection(), lowSelection);
        assert.deepEqual(queued.modelSelection, lowSelection);
        assert.equal(snapshot.queue.items.length, 0);
        assert.equal((await app.runtime.getProjection()).pendingSteerInputs.length, 0);
        assert.equal(requests.length, requestCountBeforePromotion);
        assert.deepEqual(paths, ["/v1/chat/completions"]);
        assert.deepEqual(peerErrors, []);
      } finally {
        releaseFirst.resolve();
        initialAbort.abort();
        await Promise.allSettled(initialCompletion ? [initialCompletion] : []);
        await app?.close?.();
        peer.closeAllConnections();
        if (peer.listening)
          await new Promise<void>((resolve, reject) =>
            peer.close((error) => (error ? reject(error) : resolve())),
          );
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
}
