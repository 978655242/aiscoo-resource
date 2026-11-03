import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  SESSION_ENTRY_MODEL_SELECTION,
  createProjectId,
  createSessionId,
  type MessageInfo,
  type MessagePart,
  type ModelCatalogEntry,
  type ModelSelection,
} from "@zcode/contracts";
import { AISCOO_MODEL_PROVIDER_IDS, modelSelectionSchema } from "@zcode/shared";
import { parseCommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { InMemoryJournalStore } from "@zcode/dynamic-workflow";
import { createSqliteSessionStore } from "../../adapters/src/storage/session-store/sqlite-session-store.js";
import { cloneModelSelection } from "../../core/src/runtime/model-selection.js";
import { forkStableConversationAtMessage } from "../../core/src/runtime/methods/session-fork.js";
import { resolveModelReference } from "../../core/src/tool/handlers/model-reference.js";
import { resolveTuiModelSelection } from "../../cli/src/command-center/handlers/model.js";
import { parseProviderQualifiedModelSelection } from "../src/app/provider-registry-selection.js";
import { ApiProviderModelRuntime } from "../src/app/provider-registry-model-runtime.js";
import { readSessionModelSelection } from "../src/app/session-store.js";
import { workflowActorModelPolicy } from "../src/app/workflow-actor-model.js";
import {
  readRunModelBindings,
  readRunSubagentModel,
} from "../src/app/dynamic-workflow-run-launch-anchor.js";
import { createTestProviderRegistry } from "./helpers/registry-backed-test-app.js";

const aliases = [
  ["account:new-api-anthropic-messages", AISCOO_MODEL_PROVIDER_IDS["anthropic-messages"]],
  ["account:new-api-openai-chat-completions", AISCOO_MODEL_PROVIDER_IDS["openai-chat-completions"]],
  ["account:new-api-openai-responses", AISCOO_MODEL_PROVIDER_IDS["openai-responses"]],
] as const;
const selection = (providerId: string): ModelSelection => ({
  providerId,
  modelId: "hy3",
  options: { reasoningLevel: "high" },
});

// XCODE: 直接输入与历史引用共用身份迁移，不能只靠结构化 schema 掩盖 typed 旁路。
describe("Aiscoo CLI Provider identity compatibility", () => {
  it.each(aliases)("normalizes typed selections and qualified actor pins: %s", (oldId, newId) => {
    const original = selection(oldId);
    const cloned = cloneModelSelection(original);
    expect(cloned).toEqual(selection(newId));
    expect(original.providerId).toBe(oldId);
    expect(cloned.options).not.toBe(original.options);
    expect(parseProviderQualifiedModelSelection(`${oldId}/vendor/hy3$literal`)).toEqual({
      providerId: newId,
      modelId: "vendor/hy3$literal",
    });
    expect(workflowActorModelPolicy({ parentSelection: selection(newId) }, `${oldId}/hy3`)).toEqual(
      { configOverrides: {} },
    );
  });

  it.each(aliases)(
    "resolves old picker refs and inherited workflow references: %s",
    (oldId, newId) => {
      const entry: ModelCatalogEntry = {
        providerId: newId,
        modelId: "hy3",
        reasoningLevels: ["high"],
        defaultReasoningLevel: "high",
        current: true,
      };
      const resolved = resolveModelReference(`${oldId}/hy3$high`, [entry]);
      expect(resolved).toMatchObject({
        ok: true,
        selection: selection(newId),
        canonical: `${newId}/hy3$high`,
      });
      expect(
        resolveTuiModelSelection(
          "old picker",
          [
            {
              ref: { providerId: newId, modelId: "hy3" },
              label: "hy3",
              reasoning: { levels: [{ value: "high", label: "High" }], defaultLevel: "high" },
            },
          ],
          selection(oldId),
        ),
      ).toEqual(selection(newId));
    },
  );

  it.each([...aliases, ["account:new-api-custom", "account:new-api-custom"]] as const)(
    "the actual flat command parser agrees with structured selection: %s",
    (oldId, newId) => {
      const parsed = parseCommandEnvelope({
        clientId: "cli-compat",
        issuedAt: 1,
        commandId: "cmd-provider-id",
        sessionId: "session-provider-id",
        baseRevision: 0,
        type: "switchModelConfig",
        payload: { provider: oldId, model: "hy3", thought: "high" },
      });
      if (!parsed.ok) throw parsed.error;
      expect(parsed.envelope.payload).toEqual({ provider: newId, model: "hy3", thought: "high" });
      expect(modelSelectionSchema.parse(selection(oldId))).toEqual(selection(newId));
    },
  );

  it("keeps unknown and official providers unchanged", () => {
    for (const providerId of [
      "account:new-api-custom",
      "account:new-api-openai-responses-extra",
      "custom",
      "account:zai-start-plan",
    ]) {
      expect(cloneModelSelection(selection(providerId))).toEqual(selection(providerId));
      expect(parseProviderQualifiedModelSelection(`${providerId}/hy3`)).toEqual({
        providerId,
        modelId: "hy3",
      });
    }
  });

  it.each(aliases)(
    "canonicalizes the typed model factory input before exact registry lookup: %s",
    (oldId, newId) => {
      const registry = createTestProviderRegistry([{ providerId: newId, modelId: "hy3" }]);
      const createModel = vi.fn((input) => input);
      const runtime = new ApiProviderModelRuntime({
        registry,
        modelAdapter: { createModel } as never,
      });
      runtime.start();
      try {
        runtime.modelFactory({ selection: selection(oldId) });
        expect(createModel).toHaveBeenCalledWith(
          expect.objectContaining({
            providerId: newId,
            modelId: "hy3",
            options: { reasoningLevel: "high" },
          }),
        );
        expect(registry.getView().providers.some(({ providerId }) => providerId === oldId)).toBe(
          false,
        );
      } finally {
        runtime.dispose();
      }
    },
  );

  it("reads canonical run metadata without rewriting the old journal or binding keys", () => {
    const journal = new InMemoryJournalStore();
    const oldModel = `${aliases[1][0]}/vendor/hy3$high`;
    journal.createRun({
      runId: "old-run",
      caps: { maxConcurrency: 1 },
      spentTokens: 0,
      status: "running",
    });
    journal.appendEvent("old-run", {
      type: "run-launched",
      inputId: "input",
      subagentModel: oldModel,
      modelBindings: { [oldModel]: oldModel },
    });
    expect(readRunSubagentModel(journal, "old-run")).toBe(`${aliases[1][1]}/vendor/hy3$high`);
    expect(readRunModelBindings(journal, "old-run")).toEqual({
      [oldModel]: `${aliases[1][1]}/vendor/hy3$high`,
    });
    expect(
      journal.listEvents("old-run", { types: ["run-launched"], reportItems: "all" })[0]?.event,
    ).toMatchObject({ subagentModel: oldModel, modelBindings: { [oldModel]: oldModel } });
  });
});

// XCODE: 直接插入已发布旧记录，再走真实 SQLite Reader、原子 fork 与 Writer，不能由新 Writer 伪造旧历史。
describe("Aiscoo persisted session identity", () => {
  it.each(aliases)(
    "restores and forks old assistant/subtask history, then saves canonical references: %s",
    async (oldId, newId) => {
      const root = await mkdtemp(join(tmpdir(), "aiscoo-cli-provider-id-"));
      const dbPath = join(root, "sessions.sqlite");
      const store = await createSqliteSessionStore({ dbPath });
      const db = new DatabaseSync(dbPath);
      const sessionID = createSessionId("old-session");
      const childID = createSessionId("fork-session");
      try {
        await store.createSession({
          id: sessionID,
          projectID: createProjectId("provider-id"),
          directory: root,
          slug: "old",
          title: "Old",
          version: "old",
        });
        const oldSelection = selection(oldId);
        const user = {
          role: "user",
          agent: "zcode-agent",
          time: { created: 1 },
          modelSelection: oldSelection,
        };
        const assistant = {
          role: "assistant",
          agent: "zcode-agent",
          parentID: "user",
          time: { created: 2, completed: 3 },
          providerId: oldId,
          modelId: "hy3",
          reasoningLevel: "high",
          mode: "build",
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          path: { cwd: root, root },
        };
        for (const [id, sequence, data] of [
          ["user", 0, user],
          ["assistant", 1, assistant],
        ] as const) {
          db.prepare(
            "INSERT INTO message(id,session_id,time_created,time_updated,data,sequence) VALUES(?,?,?,?,?,?)",
          ).run(id, sessionID, sequence + 1, sequence + 1, JSON.stringify(data), sequence);
        }
        const subtask = {
          type: "subtask",
          prompt: "continue",
          description: "worker",
          agent: "general-purpose",
          modelSelection: oldSelection,
        };
        const timeline = {
          type: "timeline",
          timelineType: "model_change",
          display: "separator",
          toModelSelection: { ...oldSelection, label: "Original model" },
        };
        for (const [id, sequence, data] of [
          ["subtask", 0, subtask],
          ["timeline", 1, timeline],
        ] as const) {
          db.prepare(
            "INSERT INTO part(id,message_id,session_id,time_created,time_updated,data,sequence) VALUES(?,?,?,?,?,?,?)",
          ).run(id, "assistant", sessionID, 2, 2, JSON.stringify(data), sequence);
        }
        db.prepare(
          "INSERT INTO session_entry(id,session_id,type,time_created,time_updated,data) VALUES(?,?,?,?,?,?)",
        ).run(
          "selection",
          sessionID,
          SESSION_ENTRY_MODEL_SELECTION,
          1,
          1,
          JSON.stringify({ modelSelection: oldSelection }),
        );
        const originalRows = db.prepare("SELECT data FROM message ORDER BY sequence").all();
        expect(await readSessionModelSelection(store, sessionID)).toEqual(selection(newId));
        const history = await store.messages({ sessionID });
        expect(history[0]?.info).toMatchObject({ modelSelection: selection(newId) });
        expect(history[1]?.info).toMatchObject({
          providerId: newId,
          modelId: "hy3",
          reasoningLevel: "high",
        });
        expect(history[1]?.parts[0]).toMatchObject({ model: selection(newId) });
        expect(history[1]?.parts[1]).toMatchObject({
          toModel: { ...selection(newId), label: "Original model" },
        });
        expect(db.prepare("SELECT data FROM message ORDER BY sequence").all()).toEqual(
          originalRows,
        );
        const runtime = {
          sessionId: sessionID,
          sessionStore: store,
          config: { agentName: "zcode-agent", mode: "build" },
          workingDirectory: root,
          workspaceRoot: root,
          rootTraceContext: { traceId: "trace-provider-id" },
          getSessionModelSelection: () => selection(newId),
          createEvent: (_type: unknown, payload: unknown) => ({ payload }),
          appendEvent: async () => undefined,
        };
        await forkStableConversationAtMessage.call(runtime as never, {
          forkedSessionId: childID,
          sourceCommandId: "cmd-fork-provider-id",
          goalBoundary: { kind: "none" },
          target: {
            productTurnId: "product",
            transcriptTurnId: "turn",
            orderedMessageIds: ["user", "assistant"],
            boundaryMessageId: "assistant",
          },
        });
        expect(await readSessionModelSelection(store, childID)).toEqual(selection(newId));
        const childRows = db.prepare("SELECT data FROM message WHERE session_id = ?").all(childID);
        expect(childRows.length).toBeGreaterThan(2);
        for (const row of childRows) {
          const saved = JSON.parse(String(row.data));
          expect(saved.modelSelection?.providerId ?? saved.providerId).toBe(newId);
        }
        // typed Writer 不能依赖调用者先读过历史或调用 schema；输入对象仍然保持原样。
        await store.saveMessage({
          ...history[0]!.info,
          modelSelection: oldSelection,
        } as MessageInfo);
        await store.saveMessage({ ...history[1]!.info, providerId: oldId } as MessageInfo);
        await store.savePart({ ...history[1]!.parts[0]!, model: oldSelection } as MessagePart);
        await store.savePart({
          ...history[1]!.parts[1]!,
          toModel: { ...oldSelection, label: "Original model" },
        } as MessagePart);
        await store.saveSessionEntry({
          id: "selection",
          sessionID,
          type: SESSION_ENTRY_MODEL_SELECTION,
          time: { created: 1, updated: 4 },
          data: oldSelection,
        });
        expect(
          JSON.parse(String(db.prepare("SELECT data FROM message WHERE id='user'").get()?.data))
            .modelSelection,
        ).toEqual(selection(newId));
        expect(
          JSON.parse(
            String(db.prepare("SELECT data FROM message WHERE id='assistant'").get()?.data),
          ).providerId,
        ).toBe(newId);
        expect(
          JSON.parse(String(db.prepare("SELECT data FROM part WHERE id='subtask'").get()?.data))
            .modelSelection,
        ).toEqual(selection(newId));
        expect(
          JSON.parse(String(db.prepare("SELECT data FROM part WHERE id='timeline'").get()?.data))
            .toModelSelection,
        ).toEqual({ ...selection(newId), label: "Original model" });
        expect(
          JSON.parse(
            String(db.prepare("SELECT data FROM session_entry WHERE id='selection'").get()?.data),
          ).modelSelection,
        ).toEqual(selection(newId));
        expect(oldSelection).toEqual(selection(oldId));
      } finally {
        db.close();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
