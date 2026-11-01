import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ZCodeProtocolAgentServerContext } from "../zcode-protocol/server-types.js";
import {
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  type ZCodeProtocolMessage,
  type ZCodeProtocolNotification,
} from "@zcode/shared";
import { ZCodeProtocolNdjsonConnection } from "../zcode-protocol/transport.js";
import type { streamWorkspaceModelText as StreamText } from "@zcode/core";

const mocks = vi.hoisted(() => ({ stream: vi.fn<typeof StreamText>(), createApp: vi.fn() }));
vi.mock("@zcode/core", () => ({ streamWorkspaceModelText: mocks.stream }));
vi.mock("../zcode-protocol/workspace-model-runtime.js", () => ({
  createWorkspaceZCodeApp: mocks.createApp,
}));
import { streamWorkspaceText } from "./index.js";

const workspace = {
  workspaceKey: "/workspace",
  workspacePath: "/workspace",
  workspaceIdentity: "remote:test",
  remoteSessionId: "attachment",
};
const params = {
  workspace,
  operationId: "guide-operation",
  selection: { providerId: "test", modelId: "model" },
  prompt: "Guide",
  querySource: "plugin_guide",
};
afterEach(() => vi.clearAllMocks());
function fixture(active: boolean) {
  const close = vi.fn(async () => {});
  const app = { runtime: {}, close };
  const notify = vi.fn();
  const context = {
    sessions: new Map(active ? [["active", { workspace, app }]] : []),
    notify,
    deps: {
      env: {},
      createSessionEventStore: vi.fn(() => ({})),
      sessionStore: {},
      version: "test",
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  mocks.createApp.mockResolvedValue(app);
  return { context, close, notify, app };
}

describe("plugin guide stream protocol", () => {
  it("correlates and sequences actual deltas and closes its temporary app", async () => {
    const { context, close, notify, app } = fixture(false);
    mocks.stream.mockImplementation(async (runtime, input, options) => {
      expect(runtime).toBe(app.runtime);
      expect(input.selection).toEqual(params.selection);
      await options.onDelta("One");
      await options.onDelta("Two");
      return { text: "OneTwo", selection: params.selection, finishReason: "stop" };
    });
    const result = await streamWorkspaceText(context, params);
    expect(result.text).toBe("OneTwo");
    expect(notify.mock.calls.map(([notification]) => notification)).toEqual([
      {
        method: zcodeProtocolNotifications.xworkWorkspaceTextDelta,
        params: { operationId: "guide-operation", sequence: 1, text: "One" },
      },
      {
        method: zcodeProtocolNotifications.xworkWorkspaceTextDelta,
        params: { operationId: "guide-operation", sequence: 2, text: "Two" },
      },
    ]);
    expect(close).toHaveBeenCalledOnce();
  });

  it("passes cancellation through and closes a temporary app on failure", async () => {
    const { context, close } = fixture(false);
    const controller = new AbortController();
    mocks.stream.mockImplementation(async (_runtime, _input, options) => {
      expect(options.abortSignal).toBe(controller.signal);
      throw new DOMException("cancelled", "AbortError");
    });
    await expect(streamWorkspaceText(context, params, controller.signal)).rejects.toThrow(
      "cancelled",
    );
    expect(close).toHaveBeenCalledOnce();
  });

  it("borrows the active app without closing or changing it", async () => {
    const { context, close } = fixture(true);
    mocks.stream.mockResolvedValue({
      text: "Done",
      selection: params.selection,
      finishReason: "stop",
    });
    await streamWorkspaceText(context, params);
    expect(close).not.toHaveBeenCalled();
    expect(mocks.createApp).not.toHaveBeenCalled();
  });
});

describe("plugin guide transport admission", () => {
  it("accepts both public spellings on the existing wire methods", async () => {
    const { isPluginGuideConcurrentMethod } = await import("./dispatch-policy.js");
    for (const method of [
      zcodeProtocolMethods.xworkPluginGuideSource,
      zcodeProtocolMethods.aiscooPluginGuideSource,
      zcodeProtocolMethods.xworkWorkspaceStreamText,
      zcodeProtocolMethods.aiscooWorkspaceStreamText,
    ]) expect(isPluginGuideConcurrentMethod(method)).toBe(true);
    expect(zcodeProtocolMethods.aiscooPluginGuideSource).toBe("xwork/plugins/guideSource");
    expect(zcodeProtocolMethods.aiscooWorkspaceStreamText).toBe("xwork/workspace/streamText");
    expect(zcodeProtocolNotifications.aiscooWorkspaceTextDelta).toBe("xwork/workspace/textDelta");
  });
  it.each([
    zcodeProtocolMethods.xworkWorkspaceStreamText,
    zcodeProtocolMethods.xworkPluginGuideSource,
  ])("lets ordinary requests respond while %s is held", async (method) => {
    const input = new PassThrough();
    const output = new PassThrough();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const ordinaryEntered = Promise.withResolvers<void>();
    const releaseOrdinary = Promise.withResolvers<void>();
    const handled: string[] = [];
    const messages: ZCodeProtocolMessage[] = [];
    output.on("data", (chunk: Buffer) => {
      messages.push(JSON.parse(chunk.toString("utf8")));
    });
    const notification: ZCodeProtocolNotification = {
      method: zcodeProtocolNotifications.xworkWorkspaceTextDelta,
      params: { operationId: params.operationId, sequence: 1, text: "Guide" },
    };
    const transport = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      signal: controller.signal,
      async handleMessage(message) {
        if (!("method" in message) || !("id" in message)) return;
        handled.push(message.method);
        if (message.method === method) {
          entered.resolve();
          await release.promise;
        }
        if (message.method === zcodeProtocolMethods.sessionSend) {
          ordinaryEntered.resolve();
          await releaseOrdinary.promise;
        }
        return { id: message.id, result: {} };
      },
      takePostResponseMessages: (requestId) => (requestId === 1 ? [notification] : []),
    });
    transport.start();
    try {
      input.write(`${JSON.stringify({ id: 1, method, params })}\n`);
      await entered.promise;
      input.write(
        `${JSON.stringify({ id: 2, method: zcodeProtocolMethods.sessionSend, params: { sessionId: "active", text: "Hello" } })}\n`,
      );
      await vi.waitFor(() => expect(handled).toContain(zcodeProtocolMethods.sessionSend));
      await ordinaryEntered.promise;
      input.write(
        `${JSON.stringify({ id: 3, method: zcodeProtocolMethods.sessionRead, params: { sessionId: "active" } })}\n`,
      );
      await nextTurn();
      expect(handled).toEqual([method, zcodeProtocolMethods.sessionSend]);
      releaseOrdinary.resolve();
      await vi.waitFor(() =>
        expect(messages).toEqual([
          { id: 2, result: {} },
          { id: 3, result: {} },
        ]),
      );
      expect(handled).toEqual([
        method,
        zcodeProtocolMethods.sessionSend,
        zcodeProtocolMethods.sessionRead,
      ]);
      release.resolve();
      await vi.waitFor(() =>
        expect(messages).toEqual([
          { id: 2, result: {} },
          { id: 3, result: {} },
          { id: 1, result: {} },
          notification,
        ]),
      );
    } finally {
      releaseOrdinary.resolve();
      release.resolve();
      controller.abort();
      await transport.waitForClose();
      input.destroy();
      output.destroy();
    }
  });

  it("admits operation cancellation before a held guide stream completes", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const controller = new AbortController();
    const operation = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const messages: ZCodeProtocolMessage[] = [];
    output.on("data", (chunk: Buffer) => messages.push(JSON.parse(chunk.toString("utf8"))));
    const transport = new ZCodeProtocolNdjsonConnection({
      input,
      output,
      signal: controller.signal,
      async handleMessage(message) {
        if (!("method" in message) || !("id" in message)) return;
        if (message.method === zcodeProtocolMethods.xworkWorkspaceStreamText) {
          entered.resolve();
          await release.promise;
          return {
            id: message.id,
            result: { operationId: params.operationId, cancelled: operation.signal.aborted },
          };
        }
        if (message.method === zcodeProtocolMethods.workspaceCancelGenerateText) {
          expect(message.params).toEqual({ operationId: params.operationId });
          operation.abort();
          return { id: message.id, result: { operationId: params.operationId, cancelled: true } };
        }
      },
    });
    transport.start();
    try {
      input.write(
        `${JSON.stringify({ id: 1, method: zcodeProtocolMethods.xworkWorkspaceStreamText, params })}\n`,
      );
      await entered.promise;
      input.write(
        `${JSON.stringify({ id: 2, method: zcodeProtocolMethods.workspaceCancelGenerateText, params: { operationId: params.operationId } })}\n`,
      );
      await vi.waitFor(() =>
        expect(messages).toEqual([
          { id: 2, result: { operationId: params.operationId, cancelled: true } },
        ]),
      );
      expect(operation.signal.aborted).toBe(true);
      release.resolve();
      await vi.waitFor(() =>
        expect(messages).toEqual([
          { id: 2, result: { operationId: params.operationId, cancelled: true } },
          { id: 1, result: { operationId: params.operationId, cancelled: true } },
        ]),
      );
    } finally {
      release.resolve();
      controller.abort();
      await transport.waitForClose();
      input.destroy();
      output.destroy();
    }
  });
});
