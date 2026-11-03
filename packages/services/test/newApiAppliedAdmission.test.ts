import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate } from "node:timers/promises";
import {
  createAccountProviderConfigSnapshot,
  ModelConfigRules,
  ProviderConfigMap,
  ProviderConfigResolver,
  projectModelSelectionProviderView,
} from "@zcode/provider";
import { createNewApiProviderAnchors } from "@zcode/provider-node";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";
import { createZCodeAgentConnectionScope } from "../src/zcode-agent/zcodeAgentConnectionScope.js";
import { setDataBaseDir } from "../src/paths.js";
import { resolveNewApiAccountProviders } from "../src/new-api/newApiAccountProviderResolution.js";
import { owner, catalog, entitlements, modelConfig } from "./newApiRegistryFixtures.js";

test(
  "Host normalizes legacy runtime auth IDs and rejects contradictory Native request identities before credential IO",
  { timeout: 20_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "aiscoo-runtime-auth-identity-"));
    setDataBaseDir(dir);
    const workerPath = join(dir, "worker.mjs");
    const canonicalId = "account:aiscoo-openai-responses";
    const legacyId = "account:new-api-openai-responses";
    const selection = { providerId: canonicalId, modelId: "real-model" };
    const accountAccess = {
      type: "new-api-account",
      accountType: "new-api",
      mode: "private-subscription",
      entitled: true,
      owner,
      authorizationRevision: "7",
    };
    const cases = [
      { providerId: legacyId, modelSelection: selection, accountAccess },
      {
        providerId: canonicalId,
        modelSelection: { ...selection, providerId: legacyId },
        accountAccess,
      },
      {
        providerId: canonicalId,
        modelSelection: { ...selection, providerId: "account:aiscoo-openai-chat-completions" },
        accountAccess,
      },
      { providerId: "custom", modelSelection: selection, accountAccess },
      {
        providerId: canonicalId,
        modelSelection: selection,
        accountAccess: {
          type: "zhipu-account",
          accountType: "zai",
          mode: "individual-coding-plan",
          entitled: true,
        },
      },
      { providerId: canonicalId, modelSelection: selection },
    ];
    const transportUrl = new URL(
      "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.ts",
      import.meta.url,
    ).href;
    const sharedUrl = new URL("../../shared/src/index.ts", import.meta.url).href;
    await writeFile(
      workerPath,
      `
import { ZCodeProtocolNdjsonConnection } from ${JSON.stringify(transportUrl)};
import { zcodeProtocolMethods } from ${JSON.stringify(sharedUrl)};
const cases = ${JSON.stringify(cases)};
let generation, index = 0;
const replies = [];
const next = () => {
  if (index === cases.length) {
    connection.send({ id: generation.id, result: { text: JSON.stringify(replies), selection: generation.params.selection } });
    return;
  }
  connection.send({ id: "native-auth-" + index, method: zcodeProtocolMethods.interactionRequestProviderRuntimeHeaders, params: {
    requestId: "native-auth-" + index, sessionId: "auth-fixture", workspace: { workspacePath: ${JSON.stringify(dir)}, workspaceKey: ${JSON.stringify(dir)} }, reason: "model-request", ...cases[index],
  } });
};
const connection = new ZCodeProtocolNdjsonConnection({ input: process.stdin, output: process.stdout, handleMessage: async message => {
  if (!("method" in message)) { replies.push(message); index++; next(); return; }
  if (message.method === zcodeProtocolMethods.runtimeCapabilities) return { id: message.id, result: {} };
  if (message.method === zcodeProtocolMethods.providerRefreshRegistry) return { id: message.id, result: { refreshed: true } };
  if (message.method === zcodeProtocolMethods.workspaceGenerateText) { generation = message; next(); return; }
  throw new Error("Unexpected method: " + message.method);
} });
connection.start();
await connection.waitForClose();
`,
    );
    const seenProviderIds: string[] = [];
    const native = resolveNewApiAccountProviders({
      owner,
      entitlements,
      catalog: {
        ...catalog,
        models: [{ ...catalog.models[0]!, api_type: "openai-chat-completions" }],
      },
    });
    const resolution = new ProviderConfigResolver().resolve({
      zcodeBuiltinProviders: createNewApiProviderAnchors(owner.origin),
      personalProviders: ProviderConfigMap.empty(),
      personalModels: ModelConfigRules.empty(),
      zcodeBuiltinModelRules: ModelConfigRules.empty(),
      accountProviders: native.providers,
      accountModelConfigs: native.modelConfigs,
      accountStates: native.states,
    });
    const agent = createZCodeAgentService({
      modelSelectionReadinessSource: {
        getView: async () => ({
          revision: 1,
          providers: resolution.registryProviders.map(projectModelSelectionProviderView),
        }),
      },
      commandResolver: () => ({
        command: process.execPath,
        args: ["--import", import.meta.resolve("tsx"), workerPath],
        cwd: dir,
        env: { TSX_TSCONFIG_PATH: fileURLToPath(new URL("./tsconfig.json", import.meta.url)) },
      }),
      requestTimeoutMs: 5_000,
      readRequestVerificationConfig: async () => null,
      accountRequestAuthService: {
        resolveAccessCurrent: async () => {
          throw new Error("unexpected access lookup");
        },
        assertCurrent: async () => {
          throw new Error("unexpected identity lookup");
        },
        resolveCurrent: async (input) => {
          seenProviderIds.push(input.providerId);
          assert.deepEqual(input.accountAccess, accountAccess);
          return { apiKey: "sk-isolated-auth-fixture" };
        },
      },
    });
    try {
      const result = await agent.generateWorkspaceText({
        workspacePath: dir,
        selection,
        prompt: "isolated runtime auth",
        querySource: "test",
      });
      const replies = JSON.parse(result.text);
      assert.equal(replies.length, cases.length);
      for (const reply of replies.slice(0, 2)) assert.equal(reply.result?.headersApplied, true);
      for (const reply of replies.slice(2)) assert.equal(reply.error?.code, -32602);
      assert.deepEqual(seenProviderIds, [canonicalId, canonicalId]);
    } finally {
      await agent.disposeAllAndWait();
      setDataBaseDir(null);
      await rm(dir, { recursive: true, force: true });
    }
  },
);

for (const mode of ["desktop-continuous", "web-remote-replayable"] as const) {
  for (const type of ["sendText", "createSession"] as const) {
    test(
      `${mode} ${type} waits for applied config and retries without consuming command identity`,
      { timeout: 20_000 },
      async () => {
        const dir = await mkdtemp(join(tmpdir(), "xwork-applied-admission-"));
        setDataBaseDir(dir);
        const transcriptPath = join(dir, "transcript.jsonl");
        const workerPath = join(dir, "worker.mjs");
        const transportUrl = new URL(
          "../../../apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.ts",
          import.meta.url,
        ).href;
        const sharedUrl = new URL("../../shared/src/index.ts", import.meta.url).href;
        await writeFile(
          workerPath,
          `
import { appendFile } from "node:fs/promises";
import { ZCodeProtocolNdjsonConnection } from ${JSON.stringify(transportUrl)};
import { zcodeProtocolMethods, zcodeProviderUpdateAccountConfigParamsSchema } from ${JSON.stringify(sharedUrl)};
let updates = 0;
const connection = new ZCodeProtocolNdjsonConnection({
  input: process.stdin, output: process.stdout,
  handleMessage: async (message) => {
    if (!("id" in message) || !("method" in message)) throw new Error("Unexpected notification");
    // XCODE: 新版 Host 启动先协商目录来源能力；探针不参与账号配置准入的业务顺序断言。
    if (message.method === zcodeProtocolMethods.runtimeCapabilities) {
      return { id: message.id, result: {} };
    }
    await appendFile(${JSON.stringify(transcriptPath)}, JSON.stringify(message) + "\\n");
    if (message.method === zcodeProtocolMethods.providerUpdateAccountConfig) {
      const snapshot = zcodeProviderUpdateAccountConfigParamsSchema.parse(message.params);
      updates++;
      return { id: message.id, result: {
        receivedRevision: snapshot.revision,
        appliedRevision: updates === 1 ? "old-applied-revision" : snapshot.revision,
        providerCount: Object.keys(snapshot.providers).length,
        status: updates === 1 ? "received" : "unchanged",
      }};
    }
    if (message.method === zcodeProtocolMethods.providerRefreshRegistry) {
      return { id: message.id, result: { refreshed: true } };
    }
    if (message.method === "v4/command") {
      return { id: message.id, result: {
        commandId: message.params.commandId,
        status: "accepted", revisionAtDecision: 1,
      }};
    }
    throw new Error("Unexpected method: " + message.method);
  },
});
connection.start();
await connection.waitForClose();
`,
        );
        const native = resolveNewApiAccountProviders({
          owner,
          catalog: {
            ...catalog,
            models: [{ ...catalog.models[0]!, api_type: "openai-chat-completions" }],
          },
          entitlements,
          configRevision: "builtin-1",
        });
        const snapshot = createAccountProviderConfigSnapshot(
          "builtin-1",
          native.providers,
          native.states,
          native,
        );
        let currentSnapshot = snapshot;
        let heldRead: (() => Promise<void>) | undefined;
        let releaseHeldRead: (() => void) | undefined;
        let reads = 0;
        const pendingAdmissions: Promise<unknown>[] = [];
        const resolution = new ProviderConfigResolver().resolve({
          zcodeBuiltinProviders: createNewApiProviderAnchors(owner.origin),
          personalProviders: ProviderConfigMap.empty(),
          personalModels: ModelConfigRules.empty(),
          zcodeBuiltinModelRules: ModelConfigRules.empty(),
          accountProviders: native.providers,
          accountModelConfigs: native.modelConfigs,
          accountStates: native.states,
        });
        const agent = createZCodeAgentService({
          commandResolver: () => ({
            command: process.execPath,
            args: ["--import", import.meta.resolve("tsx"), workerPath],
            cwd: dir,
            env: { TSX_TSCONFIG_PATH: fileURLToPath(new URL("./tsconfig.json", import.meta.url)) },
          }),
          requestTimeoutMs: 5_000,
          accountProviderConfigSource: {
            read: async () => {
              reads++;
              const accepted = currentSnapshot;
              const hold = heldRead;
              heldRead = undefined;
              if (hold) await hold();
              return accepted;
            },
            onDidChange: () => () => {},
          },
          modelSelectionReadinessSource: {
            getView: async () => ({
              revision: 1,
              providers: resolution.registryProviders
                .filter((provider) => provider.config.visibility !== "hidden")
                .map(projectModelSelectionProviderView),
            }),
          },
        });
        const scope = createZCodeAgentConnectionScope(agent, {
          connectionId: `${mode}-${type}`,
          clientMode: mode,
        });
        const envelope = {
          commandId: "retry-same-command",
          clientId: "isolated-consumer",
          sessionId: type === "createSession" ? null : "isolated-session",
          type,
          payload:
            type === "createSession"
              ? { workspaceId: "isolated-workspace" }
              : { text: "isolated input" },
          issuedAt: Date.now(),
        };
        const params = { workspacePath: dir, envelope };
        const transcript = async () =>
          (await readFile(transcriptPath, "utf8"))
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
        try {
          await assert.rejects(
            scope.service.sendConversationCommandV4(params),
            /helloRequired|handshakeRequired/,
          );
          const hello = await scope.service.helloConversationV4();
          await scope.service.initializeConversationV4({
            kind: "clientHello",
            protocolVersion: hello.protocolVersion,
            clientId: envelope.clientId,
            appVersion: "isolated-test",
          });
          await assert.rejects(
            scope.service.sendConversationCommandV4({
              ...params,
              envelope: { ...envelope, clientId: "wrong-consumer" },
            }),
            /clientMismatch/,
          );
          await assert.rejects(
            scope.service.sendConversationCommandV4(params),
            /Account Config 尚未在 Worker Registry 应用或回执版本不一致/,
          );
          assert.deepEqual(
            (await transcript()).map((entry) => entry.method),
            ["provider/updateAccountConfig"],
          );
          const accepted = await scope.service.sendConversationCommandV4(params);
          assert.equal(accepted.status, "accepted");
          assert.equal(accepted.commandId, envelope.commandId);
          const admitted = await transcript();
          assert.deepEqual(
            admitted.map((entry) => entry.method),
            [
              "provider/updateAccountConfig",
              "provider/updateAccountConfig",
              "provider/refreshRegistry",
              "v4/command",
            ],
          );
          const forwarded = admitted[3].params;
          assert.equal(forwarded.commandId, envelope.commandId);
          assert.equal(forwarded.clientId, envelope.clientId);
          assert.equal(forwarded.sessionId, envelope.sessionId);
          if (type === "sendText") assert.equal(forwarded.payload.text, "isolated input");
          else assert.equal(forwarded.payload.workspaceId, "isolated-workspace");
          await scope.service.sendConversationCommandV4({
            ...params,
            envelope: { ...envelope, commandId: "next-command" },
          });
          assert.deepEqual(
            (await transcript()).map((entry) => entry.method),
            [
              "provider/updateAccountConfig",
              "provider/updateAccountConfig",
              "provider/refreshRegistry",
              "v4/command",
              "provider/refreshRegistry",
              "v4/command",
            ],
          );

          const revisions = [9000, 10000].map((contextWindow) => {
            const next = resolveNewApiAccountProviders({
              owner,
              entitlements,
              configRevision: "builtin-1",
              catalog: {
                ...catalog,
                catalog_revision: `catalog-context-${contextWindow}`,
                models: [
                  {
                    ...catalog.models[0]!,
                    api_type: "openai-chat-completions",
                    model_config: {
                      ...modelConfig,
                      properties: { ...modelConfig.properties, contextWindow },
                    },
                  },
                ],
              },
            });
            return createAccountProviderConfigSnapshot(
              "builtin-1",
              next.providers,
              next.states,
              next,
            );
          });
          const readEntered = Promise.withResolvers<void>();
          const releaseRead = Promise.withResolvers<void>();
          releaseHeldRead = () => releaseRead.resolve();
          const beforeHeldRead = reads;
          currentSnapshot = revisions[0]!;
          heldRead = async () => {
            readEntered.resolve();
            await releaseRead.promise;
          };
          pendingAdmissions.push(
            scope.service.sendConversationCommandV4({
              ...params,
              envelope: { ...envelope, commandId: "held-first" },
            }),
          );
          await readEntered.promise;
          currentSnapshot = revisions[1]!;
          pendingAdmissions.push(
            scope.service.sendConversationCommandV4({
              ...params,
              envelope: { ...envelope, commandId: "held-second" },
            }),
          );
          await setImmediate();
          assert.equal(
            reads,
            beforeHeldRead + 1,
            "second read cannot overtake the first queued read",
          );
          releaseRead.resolve();
          await Promise.all(pendingAdmissions);
          const accountUpdates = (await transcript()).filter(
            (entry) => entry.method === "provider/updateAccountConfig",
          );
          assert.deepEqual(
            accountUpdates.slice(-2).map((entry) => entry.params.revision),
            revisions.map((revision) => revision.revision),
          );
        } finally {
          releaseHeldRead?.();
          await Promise.allSettled(pendingAdmissions);
          await scope.dispose();
          await agent.disposeAllAndWait();
          setDataBaseDir(null);
          await rm(dir, { recursive: true, force: true });
        }
      },
    );
  }
}
