import { afterEach, describe, expect, it, vi } from "vitest";
import { Emitter } from "@zcode/rpc";
import {
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  type ZCodeProtocolMessage,
  type ZCodeProtocolRequest,
} from "@zcode/shared";
import {
  ZCodeProtocolClient,
  type ZCodeProtocolRequestTimeoutEvent,
} from "../src/zcode-agent/zcodeProtocolClient.js";
import type { ZCodeProtocolTransportClosedEvent } from "../src/zcode-agent/zcodeProtocolTransport.js";
import { createPluginGuideAgentExtension } from "../src/aiscoo-plugin-guides/adapters/agent.js";

const selection = { providerId: "test-provider", modelId: "guide-model" };
function fixture() {
  const messages = new Emitter<ZCodeProtocolMessage>();
  const closed = new Emitter<ZCodeProtocolTransportClosedEvent>();
  const requests: ZCodeProtocolRequest[] = [];
  const client = new ZCodeProtocolClient({
    kind: "memory",
    onMessage: messages.event,
    onClose: closed.event,
    async send(message) {
      if (!("id" in message) || !("method" in message)) return;
      requests.push(message);
      if (message.method === zcodeProtocolMethods.workspaceCancelGenerateText)
        messages.fire({ id: message.id, result: { cancelled: true } });
    },
    dispose() {
      messages.dispose();
      closed.dispose();
    },
  });
  const bridge = createPluginGuideAgentExtension({
    getClient: async () => client,
    getPluginManagementClient: async () => client,
    buildWorkspaceRef: (target) => ({
      workspacePath: target.workspacePath,
      workspaceKey: target.workspacePath,
    }),
    syncAccount: async () => {},
  });
  const subscription = client.onNotification((message) => bridge.accept(client, message));
  const timeouts: ZCodeProtocolRequestTimeoutEvent[] = [];
  client.onRequestTimeout((event) => timeouts.push(event));
  const deltas: string[] = [];
  return {
    client,
    messages,
    requests,
    timeouts,
    deltas,
    bridge,
    stream: (signal = new AbortController().signal) =>
      bridge.methods.streamWorkspaceModelText({
        workspacePath: "/workspace",
        selection,
        messages: [{ role: "user", content: "Write a guide" }],
        querySource: "plugin_usage_guide",
        maxOutputTokens: 8192,
        operationId: "guide-stream",
        signal,
        onDelta: (text) => deltas.push(text),
      }),
    dispose() {
      subscription.dispose();
      bridge.dispose();
      client.dispose();
    },
  };
}
afterEach(() => vi.useRealTimers());

describe("guide requests do not recycle the workspace agent", () => {
  it("continues a genuine stream beyond the protocol default deadline", async () => {
    vi.useFakeTimers();
    const state = fixture();
    try {
      const result = state.stream();
      const outcome = result.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await vi.waitFor(() =>
        expect(
          state.requests.some(
            (request) => request.method === zcodeProtocolMethods.xworkWorkspaceStreamText,
          ),
        ).toBe(true),
      );
      await vi.advanceTimersByTimeAsync(181_000);
      expect(state.timeouts).toEqual([]);
      state.messages.fire({
        method: zcodeProtocolNotifications.xworkWorkspaceTextDelta,
        params: { operationId: "guide-stream", sequence: 1, text: "A real late delta" },
      });
      const request = state.requests.find(
        (item) => item.method === zcodeProtocolMethods.xworkWorkspaceStreamText,
      )!;
      state.messages.fire({
        id: request.id,
        result: { text: "A real late delta", selection, finishReason: "stop" },
      });
      expect(await outcome).toEqual({
        value: { text: "A real late delta", selection, finishReason: "stop" },
      });
      expect(state.deltas).toEqual(["A real late delta"]);
      expect(state.client.pendingRequestCount).toBe(0);
    } finally {
      state.dispose();
    }
  });

  it("uses its own cancellation deadline instead of reporting a stale workspace", async () => {
    vi.useFakeTimers();
    const state = fixture();
    try {
      const result = state.stream().then(
        () => null,
        (error: unknown) => error,
      );
      await vi.waitFor(() =>
        expect(
          state.requests.some(
            (request) => request.method === zcodeProtocolMethods.xworkWorkspaceStreamText,
          ),
        ).toBe(true),
      );
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(await result).toMatchObject({ name: "TimeoutError" });
      expect(state.timeouts).toEqual([]);
      expect(
        state.requests.some(
          (request) => request.method === zcodeProtocolMethods.workspaceCancelGenerateText,
        ),
      ).toBe(true);
      expect(state.client.pendingRequestCount).toBe(0);
    } finally {
      state.dispose();
    }
  });

  it("aborts a source request without leaving a watchdog that can recycle the client", async () => {
    vi.useFakeTimers();
    const state = fixture();
    const controller = new AbortController();
    try {
      const result = state.bridge.methods
        .readPluginGuideSource({
          workspacePath: "/workspace",
          pluginName: "tables",
          marketplace: "example",
          mode: "documents",
          signal: controller.signal,
        })
        .then(
          () => null,
          (error: unknown) => error,
        );
      await vi.waitFor(() =>
        expect(
          state.requests.some(
            (request) => request.method === zcodeProtocolMethods.xworkPluginGuideSource,
          ),
        ).toBe(true),
      );
      controller.abort(new DOMException("Stopped reading", "AbortError"));
      expect(await result).toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(31 * 60_000);
      expect(state.timeouts).toEqual([]);
      expect(state.client.pendingRequestCount).toBe(0);
    } finally {
      state.dispose();
    }
  });
});
