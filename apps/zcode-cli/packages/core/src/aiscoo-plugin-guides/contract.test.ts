import { afterEach, describe, expect, it, vi } from "vitest";
import { createSessionId, type ModelEvent, type ModelRequest } from "@zcode/contracts";
import { createTestAgentRuntime } from "../../tests/test-agent-runtime.js";
import { createTestModelFactory } from "../../tests/test-runtime-model.js";
import { createTestSessionEventStore } from "../../tests/test-event-store.js";
import * as usage from "../runtime/methods/usage-observability.js";
import { streamWorkspaceModelText } from "./index.js";
import { OUTPUT_TOKEN_CONTINUE_PROMPT } from "../runtime/methods/turn-output-token-continuation.js";

const selection = { providerId: "test", modelId: "guide" };
const input = { selection, prompt: "Write a guide", querySource: "plugin_guide" };
const actualUsage = { inputTokens: 7, outputTokens: 3, totalTokens: 10 };
afterEach(() => vi.restoreAllMocks());
function fixture(events: ModelEvent[], continuations: ModelEvent[][] = []) {
  const eventStore = createTestSessionEventStore();
  const generateText = vi.fn(async () => {
    throw new Error("Nonstream fallback forbidden");
  });
  const requests: ModelRequest[] = [];
  const modelFactory = createTestModelFactory({
    generateText,
    streamText: async function* (request) {
      const round = requests.length;
      requests.push({ ...request, messages: request.messages.map((message) => ({ ...message })) });
      yield* round === 0 ? events : (continuations[round - 1] ?? events);
    },
  });
  const runtime = createTestAgentRuntime(
    createSessionId("plugin-guide-stream"),
    {},
    { eventStore, modelFactory },
  );
  return { runtime, generateText, eventStore, requests };
}

describe("workspace model streaming", () => {
  it("forwards genuine deltas, returns actual usage, and leaves model and conversation unchanged", async () => {
    const { runtime, generateText, eventStore } = fixture([
      { type: "text_delta", text: "Hello " },
      { type: "text_delta", text: "world" },
      { type: "finish", finishReason: "stop", usage: actualUsage },
    ]);
    const record = vi.spyOn(usage, "recordModelUsageFact").mockResolvedValue(undefined);
    const selected = runtime.getSessionModelSelection();
    const conversationEvents = await eventStore.getEvents(runtime.sessionId);
    const deltas: string[] = [];
    const result = await streamWorkspaceModelText(runtime, input, {
      onDelta: async (text) => {
        deltas.push(text);
      },
    });
    expect(deltas).toEqual(["Hello ", "world"]);
    expect(result).toMatchObject({
      text: "Hello world",
      finishReason: "stop",
      usage: actualUsage,
      selection,
    });
    expect(runtime.getSessionModelSelection()).toEqual(selected);
    expect(await eventStore.getEvents(runtime.sessionId)).toEqual(conversationEvents);
    expect(generateText).not.toHaveBeenCalled();
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        status: "completed",
        result: expect.objectContaining({ usage: actualUsage }),
      }),
    );
  });

  it.each(["tool-calls", "content-filter", "unknown", "error"])(
    "rejects unsupported completion %s and records its real usage",
    async (finishReason) => {
      const { runtime } = fixture([{ type: "finish", finishReason, usage: actualUsage }]);
      const record = vi.spyOn(usage, "recordModelUsageFact").mockResolvedValue(undefined);
      await expect(streamWorkspaceModelText(runtime, input, { onDelta: () => {} })).rejects.toThrow(
        /completion/i,
      );
      expect(record).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          status: "error",
          result: expect.objectContaining({ usage: actualUsage }),
        }),
      );
    },
  );

  it("rejects streams that close without finish", async () => {
    const { runtime } = fixture([{ type: "text_delta", text: "incomplete" }]);
    await expect(streamWorkspaceModelText(runtime, input, { onDelta: () => {} })).rejects.toThrow(
      /finish/i,
    );
  });

  it("normalizes provider stream errors without a nonstream retry", async () => {
    const { runtime, generateText } = fixture([
      { type: "error", error: new Error("provider failed") },
    ]);
    await expect(streamWorkspaceModelText(runtime, input, { onDelta: () => {} })).rejects.toThrow(
      "provider failed",
    );
    expect(generateText).not.toHaveBeenCalled();
  });

  it("stops at cancellation and records cancellation rather than committing a later finish", async () => {
    const controller = new AbortController();
    const { runtime } = fixture([
      { type: "text_delta", text: "partial" },
      { type: "finish", finishReason: "stop", usage: actualUsage },
    ]);
    const record = vi.spyOn(usage, "recordModelUsageFact").mockResolvedValue(undefined);
    await expect(
      streamWorkspaceModelText(runtime, input, {
        abortSignal: controller.signal,
        onDelta: () => controller.abort(new DOMException("Cancelled", "AbortError")),
      }),
    ).rejects.toThrow("Cancelled");
    expect(record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: "cancelled" }),
    );
  });

  it("continues a truncated answer with its assistant context, preserving ordinary history and real usage", async () => {
    const { runtime, eventStore, requests } = fixture(
      [
        { type: "text_delta", text: "<guide>First " },
        { type: "finish", finishReason: "length", usage: actualUsage },
      ],
      [
        [
          { type: "text_delta", text: "second</guide>" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
          },
        ],
      ],
    );
    const record = vi.spyOn(usage, "recordModelUsageFact").mockResolvedValue(undefined);
    const before = await eventStore.getEvents(runtime.sessionId);
    const selected = runtime.getSessionModelSelection();
    const deltas: string[] = [];
    const result = await streamWorkspaceModelText(runtime, input, {
      onDelta: (delta) => {
        deltas.push(delta);
      },
    });
    expect(result.text).toBe("<guide>First second</guide>");
    expect(deltas).toEqual(["<guide>First ", "second</guide>"]);
    expect(requests[1]?.messages).toMatchObject([
      { role: "user", content: "Write a guide" },
      { role: "assistant", content: "<guide>First " },
      { role: "user", content: OUTPUT_TOKEN_CONTINUE_PROMPT },
    ]);
    expect(result.usage).toEqual({ inputTokens: 18, outputTokens: 8, totalTokens: 26 });
    expect(record.mock.calls.map(([, fact]) => fact.result?.usage)).toEqual([
      actualUsage,
      { inputTokens: 11, outputTokens: 5, totalTokens: 16 },
    ]);
    expect(await eventStore.getEvents(runtime.sessionId)).toEqual(before);
    expect(runtime.getSessionModelSelection()).toEqual(selected);
  });

  it.each(["stop", "length"])(
    "allows exactly three continuations when the fourth request ends with %s",
    async (lastFinish) => {
      const round = (text: string, finishReason: string): ModelEvent[] => [
        { type: "text_delta", text },
        { type: "finish", finishReason, usage: actualUsage },
      ];
      const { runtime, requests } = fixture(round("one", "length"), [
        round("two", "length"),
        round("three", "length"),
        round("four", lastFinish),
      ]);
      const record = vi.spyOn(usage, "recordModelUsageFact").mockResolvedValue(undefined);
      const generated = streamWorkspaceModelText(runtime, input, { onDelta: () => {} });
      if (lastFinish === "stop") {
        await expect(generated).resolves.toMatchObject({
          text: "onetwothreefour",
          usage: { inputTokens: 28, outputTokens: 12, totalTokens: 40 },
        });
      } else {
        await expect(generated).rejects.toThrow("exceeded the output token maximum");
      }
      expect(requests).toHaveLength(4);
      expect(
        requests[3]?.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.content),
      ).toEqual(["one", "two", "three"]);
      expect(record.mock.calls.map(([, fact]) => fact.status)).toEqual([
        "completed",
        "completed",
        "completed",
        lastFinish === "stop" ? "completed" : "error",
      ]);
    },
  );

  it("retains reasoning signatures and follows the harness raw output-limit marker even with empty text", async () => {
    const { runtime, requests } = fixture(
      [
        { type: "reasoning_start", id: "thinking" },
        { type: "reasoning_delta", id: "thinking", text: "Consider the instructions." },
        {
          type: "reasoning_end",
          id: "thinking",
          providerMetadata: { signature: "signed-thinking" },
        },
        {
          type: "finish",
          finishReason: "other",
          providerMetadata: { rawFinishReason: "max_output_tokens" },
          usage: actualUsage,
        },
      ],
      [
        [
          { type: "text_delta", text: "Complete guide" },
          { type: "finish", finishReason: "stop", usage: actualUsage },
        ],
      ],
    );
    vi.spyOn(usage, "recordModelUsageFact").mockResolvedValue(undefined);
    const result = await streamWorkspaceModelText(runtime, input, { onDelta: () => {} });
    expect(result.text).toBe("Complete guide");
    expect(requests[1]?.messages[1]).toMatchObject({
      role: "assistant",
      content: [
        {
          type: "reasoning",
          text: "Consider the instructions.",
          providerOptions: { signature: "signed-thinking" },
        },
      ],
    });
  });

  it("stops during a continuation without issuing another request or returning a partial success", async () => {
    const controller = new AbortController();
    const { runtime, requests } = fixture(
      [
        { type: "text_delta", text: "first" },
        { type: "finish", finishReason: "length", usage: actualUsage },
      ],
      [
        [
          { type: "text_delta", text: "second" },
          { type: "finish", finishReason: "length", usage: actualUsage },
        ],
      ],
    );
    const record = vi.spyOn(usage, "recordModelUsageFact").mockResolvedValue(undefined);
    await expect(
      streamWorkspaceModelText(runtime, input, {
        abortSignal: controller.signal,
        onDelta(text) {
          if (text === "second") controller.abort(new DOMException("Stopped", "AbortError"));
        },
      }),
    ).rejects.toThrow("Stopped");
    expect(requests).toHaveLength(2);
    expect(record.mock.calls.map(([, fact]) => fact.status)).toEqual(["completed", "cancelled"]);
  });

  it("continues an empty length response without sending an invalid empty assistant message", async () => {
    const { runtime, requests } = fixture(
      [{ type: "finish", finishReason: "length", usage: actualUsage }],
      [
        [
          { type: "text_delta", text: "finished" },
          { type: "finish", finishReason: "stop", usage: { outputTokens: 2 } },
        ],
      ],
    );
    vi.spyOn(usage, "recordModelUsageFact").mockResolvedValue(undefined);
    const result = await streamWorkspaceModelText(runtime, input, { onDelta: () => {} });
    expect(result.text).toBe("finished");
    expect(requests[1]?.messages.map((message) => message.role)).toEqual(["user", "user"]);
    expect(result.usage).toEqual({ outputTokens: 5 });
  });
});
