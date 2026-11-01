import { describe, expect, it } from "vitest";
import {
  previewPluginGuideResponse,
  PLUGIN_GUIDE_MAX_DOCUMENT_BYTES,
  pluginGuideChangeSchema,
  type PluginGuideChange,
  type PluginGuidePreview,
} from "@zcode/shared/aiscoo-plugin-guides";
import {
  response,
  selection,
  setup,
  source,
  target,
} from "../src/aiscoo-plugin-guides/test-fixtures.js";

describe("plugin guide streaming boundaries", () => {
  it("sends linear-sized preview changes while preserving the full saved guide", async () => {
    async function measure(size: number) {
      const text = response("Documented input, output and verification. ".repeat(size));
      const fixture = await setup(async (request) => {
        for (let offset = 0; offset < text.length; offset += 64)
          request.onDelta(text.slice(offset, offset + 64));
        return { text, selection, finishReason: "stop" };
      });
      const changes: PluginGuideChange[] = [];
      fixture.service.onDidChange((change) => changes.push(change));
      const saved = await fixture.service.generate({ target, operationId: "stream" });
      const previews = changes.filter((change): change is PluginGuidePreview => "type" in change);
      expect(previews.map((change) => change.markdownDelta).join("")).toBe(
        saved.document?.markdown,
      );
      expect(previews.map((change) => change.replyDelta).join("")).toBe(
        previewPluginGuideResponse(text).reply,
      );
      return changes.reduce(
        (bytes, change) => bytes + Buffer.byteLength(JSON.stringify(change)),
        0,
      );
    }
    const small = await measure(80);
    const large = await measure(160);
    expect(large).toBeLessThan(small * 2.6);
  });

  it("cancels a material read before any new model call and keeps the pending question", async () => {
    const fixture = await setup();
    await fixture.service.generate({ target, operationId: "first" });
    const { promise: admitted, resolve: started } = Promise.withResolvers<void>();
    fixture.dependencies.readSource = async (_target, mode, signal) => {
      if (mode === "identity") return source;
      if (!signal) throw new Error("Material generation requires its operation signal");
      signal.throwIfAborted();
      const pending = Promise.withResolvers<void>();
      signal.addEventListener("abort", () => pending.reject(signal.reason), { once: true });
      started();
      await pending.promise;
      return source;
    };
    const generation = fixture.service.generate({
      target,
      operationId: "cancel-reading",
      question: "Explain the prerequisites.",
    });
    await admitted;
    const reading = await fixture.service.read(target);
    expect(reading.phase).toBe("reading");
    expect(reading.operationId).toBe("cancel-reading");
    await fixture.service.cancel({ target, operationId: "cancel-reading" });
    const cancelled = await generation;
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.messages.at(-1)).toMatchObject({
      role: "user",
      content: "Explain the prerequisites.",
    });
    expect(cancelled.document?.revision).toBe("first");
    expect(fixture.requests).toHaveLength(1);
  });

  it("rejects oversized partial output before publishing an invalid state", async () => {
    const fixture = await setup();
    await fixture.service.generate({ target, operationId: "first" });
    const changes: PluginGuideChange[] = [];
    fixture.service.onDidChange((change) => changes.push(change));
    fixture.dependencies.streamText = async (request) => {
      const text = `<reply>Answer</reply><guide>${"x".repeat(PLUGIN_GUIDE_MAX_DOCUMENT_BYTES + 1)}`;
      request.onDelta(text);
      return { text, selection, finishReason: "stop" };
    };
    const failed = await fixture.service.generate({
      target,
      operationId: "oversized",
      question: "Expand the guide.",
    });
    expect(failed.phase).toBe("error");
    expect(failed.error).toContain("preview limit");
    expect(failed.document?.revision).toBe("first");
    expect(changes.every((change) => pluginGuideChangeSchema.safeParse(change).success)).toBe(true);
  });
});
