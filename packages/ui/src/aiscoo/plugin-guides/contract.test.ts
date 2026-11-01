// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IPluginGuideService } from "./contract.js";
import {
  pluginGuideTargetKey,
  type PluginGuideChange,
  type PluginGuideSnapshot,
  type PluginGuideTarget,
} from "@zcode/shared/aiscoo-plugin-guides";
import { usePluginGuide } from "./usePluginGuide.js";

const target: PluginGuideTarget = {
  workspacePath: "/project",
  marketplace: "official",
  pluginName: "pdf",
  locale: "en-US",
};
const savedDocument: NonNullable<PluginGuideSnapshot["document"]> = {
  schemaVersion: 1,
  templateVersion: 1,
  pluginId: "pdf@official",
  sourceIdentity: "official",
  sourceRevision: "1",
  fingerprint: "fingerprint",
  version: "1",
  locale: "en-US",
  markdown: "## Meet the plugin\nSaved instructions",
  messages: [],
  updatedAt: "2026-10-27T00:00:00.000Z",
  revision: "saved-1",
  sourcePaths: ["README.md"],
  diagnostics: [],
};
function snapshot(overrides: Partial<PluginGuideSnapshot> = {}): PluginGuideSnapshot {
  const selected = overrides.target ?? target;
  return {
    key: pluginGuideTargetKey(selected),
    target: selected,
    sequence: 1,
    phase: "idle",
    document: null,
    messages: [],
    previewMarkdown: "",
    previewReply: "",
    stale: false,
    ...overrides,
  };
}
function port(initial = snapshot()) {
  const listeners = new Set<(value: PluginGuideChange) => void>();
  const service: IPluginGuideService = {
    read: vi.fn(async () => initial),
    generate: vi.fn(async () =>
      snapshot({ sequence: 2, phase: "generating", operationId: "operation" }),
    ),
    cancel: vi.fn(async () => {}),
    retrySave: vi.fn(async () => snapshot({ sequence: 4, phase: "ready" })),
    onDidChange: (listener) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
  };
  return {
    service,
    emit: (value: PluginGuideChange) => {
      for (const listener of listeners) listener(value);
    },
  };
}
afterEach(cleanup);

describe("plugin guide UI service projection", () => {
  it("reads before first generation and keeps the Host operation alive after leaving", async () => {
    const { service } = port();
    const { result, unmount } = renderHook(() => usePluginGuide(service, target));
    await waitFor(() => expect(result.current.snapshot?.phase).toBe("generating"));
    expect(service.read).toHaveBeenCalledWith(target);
    expect(service.generate).toHaveBeenCalledWith(expect.objectContaining({ target }));
    unmount();
    expect(service.cancel).not.toHaveBeenCalled();
  });

  it.each(["ready", "error", "cancelled", "unsaved"] as const)(
    "does not automatically regenerate a %s snapshot",
    async (phase) => {
      const { service } = port(snapshot({ phase }));
      const { result } = renderHook(() => usePluginGuide(service, target));
      await waitFor(() => expect(result.current.snapshot?.phase).toBe(phase));
      expect(service.generate).not.toHaveBeenCalled();
    },
  );

  it("subscribes before reading and does not replace newer progress with a late empty read", async () => {
    const { service, emit } = port();
    const { promise, resolve: resolveRead } = Promise.withResolvers<PluginGuideSnapshot>();
    service.read = vi.fn(() => promise);
    const { result } = renderHook(() => usePluginGuide(service, target));
    act(() => emit(snapshot({ sequence: 3, phase: "generating", previewReply: "Real progress" })));
    await act(async () => resolveRead(snapshot()));
    expect(result.current.snapshot?.previewReply).toBe("Real progress");
    expect(service.generate).not.toHaveBeenCalled();
  });

  it("rejects old target, old transport route, old version and lower sequence events", async () => {
    const { service, emit } = port(snapshot({ phase: "ready" }));
    const { result, rerender } = renderHook(({ selected }) => usePluginGuide(service, selected), {
      initialProps: { selected: target },
    });
    await waitFor(() => expect(result.current.snapshot?.phase).toBe("ready"));
    act(() => emit(snapshot({ sequence: 0, previewReply: "old" })));
    expect(result.current.snapshot?.previewReply).toBe("");
    const next = { ...target, remoteSessionId: "remote-b", version: "2" };
    rerender({ selected: next });
    act(() => emit(snapshot({ sequence: 99, previewReply: "wrong route" })));
    expect(result.current.snapshot).toBeNull();
    act(() =>
      emit(snapshot({ target: next, sequence: 2, phase: "ready", previewReply: "current" })),
    );
    expect(result.current.snapshot?.previewReply).toBe("current");
  });

  it("forwards questions, explicit regeneration, stop and save retry through the service", async () => {
    const { service, emit } = port(snapshot({ phase: "ready" }));
    const { result } = renderHook(() => usePluginGuide(service, target));
    await waitFor(() => expect(result.current.snapshot?.phase).toBe("ready"));
    await act(async () => {
      await result.current.generate("Explain the first step");
    });
    expect(service.generate).toHaveBeenLastCalledWith(
      expect.objectContaining({ question: "Explain the first step", target }),
    );
    await act(async () => {
      await result.current.stop();
    });
    expect(service.cancel).toHaveBeenCalledWith({ target, operationId: "operation" });
    act(() => emit(snapshot({ sequence: 3, phase: "unsaved", error: "Disk full" })));
    await act(async () => {
      await result.current.retrySave();
    });
    expect(result.current.snapshot?.phase).toBe("ready");
    expect(service.generate).toHaveBeenCalledTimes(1);
    await act(async () => {
      await result.current.generate(undefined, true);
    });
    expect(service.generate).toHaveBeenLastCalledWith(
      expect.objectContaining({ regenerate: true }),
    );
  });

  it("reuses the saved guide and preserves it while real question progress or failure is projected", async () => {
    const { service, emit } = port(snapshot({ phase: "ready", document: savedDocument }));
    const { result } = renderHook(() => usePluginGuide(service, target));
    await waitFor(() => expect(result.current.snapshot?.document?.revision).toBe("saved-1"));
    expect(service.generate).not.toHaveBeenCalled();
    const messages: PluginGuideSnapshot["messages"] = [
      { id: "q1", role: "user", content: "Add a practical example" },
    ];
    act(() =>
      emit(
        snapshot({
          sequence: 2,
          phase: "generating",
          document: savedDocument,
          messages,
          previewMarkdown: "## Meet the plugin\nNew instructions",
          previewReply: "I am adding an example.",
        }),
      ),
    );
    expect(result.current.snapshot?.document?.markdown).toBe(savedDocument.markdown);
    expect(result.current.snapshot?.messages).toEqual(messages);
    expect(result.current.snapshot?.previewReply).toBe("I am adding an example.");
    act(() =>
      emit(
        snapshot({
          sequence: 3,
          phase: "error",
          document: savedDocument,
          messages,
          error: "Provider refused",
        }),
      ),
    );
    expect(result.current.snapshot?.document?.revision).toBe("saved-1");
    expect(result.current.snapshot?.error).toBe("Provider refused");
  });

  it("admits only one repeated generation click and exposes command errors without losing the guide", async () => {
    const { service } = port(snapshot({ phase: "ready", document: savedDocument }));
    const { promise, reject } = Promise.withResolvers<PluginGuideSnapshot>();
    service.generate = vi.fn(() => promise);
    const { result } = renderHook(() => usePluginGuide(service, target));
    await waitFor(() => expect(result.current.snapshot?.phase).toBe("ready"));
    let first!: Promise<boolean>;
    act(() => {
      first = result.current.generate(undefined, true);
    });
    await act(async () => {
      expect(await result.current.generate(undefined, true)).toBe(false);
    });
    await act(async () => {
      reject(new Error("Disconnected"));
      await first;
    });
    expect(service.generate).toHaveBeenCalledTimes(1);
    expect(result.current.error).toBe("Disconnected");
    expect(result.current.snapshot?.document?.revision).toBe("saved-1");
  });

  it("does not request a guide from an unavailable Host", async () => {
    const { result } = renderHook(() => usePluginGuide(null, target));
    expect(await result.current.generate("A question")).toBe(false);
    expect(result.current.snapshot).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("ignores an old service's delayed response after switching Hosts", async () => {
    const first = port();
    const { promise, resolve: resolveRead } = Promise.withResolvers<PluginGuideSnapshot>();
    first.service.read = vi.fn(() => promise);
    const second = port(snapshot({ phase: "ready", previewReply: "new Host" }));
    const { result, rerender } = renderHook(({ service }) => usePluginGuide(service, target), {
      initialProps: { service: first.service },
    });
    rerender({ service: second.service });
    await waitFor(() => expect(result.current.snapshot?.previewReply).toBe("new Host"));
    await act(async () => resolveRead(snapshot()));
    expect(result.current.snapshot?.previewReply).toBe("new Host");
    expect(first.service.generate).not.toHaveBeenCalled();
  });

  it("appends real preview increments once while keeping the saved article", async () => {
    const { service, emit } = port(
      snapshot({ phase: "generating", operationId: "operation", document: savedDocument }),
    );
    const { result } = renderHook(() => usePluginGuide(service, target));
    await waitFor(() => expect(result.current.snapshot?.phase).toBe("generating"));
    const progress = {
      type: "preview" as const,
      key: pluginGuideTargetKey(target),
      target,
      sequence: 2,
      operationId: "operation",
      markdownDelta: "A real paragraph",
      replyDelta: "Answer",
    };
    act(() => emit(progress));
    act(() => emit(progress));
    expect(result.current.snapshot?.previewMarkdown).toBe("A real paragraph");
    expect(result.current.snapshot?.previewReply).toBe("Answer");
    expect(result.current.snapshot?.document?.markdown).toBe(savedDocument.markdown);
    expect(service.generate).not.toHaveBeenCalled();
  });

  it("repairs a missed preview from the Host snapshot without another model request", async () => {
    const { service, emit } = port(
      snapshot({ phase: "generating", operationId: "operation", document: savedDocument }),
    );
    const { result } = renderHook(() => usePluginGuide(service, target));
    await waitFor(() => expect(result.current.snapshot?.sequence).toBe(1));
    service.read = vi.fn(async () =>
      snapshot({
        sequence: 5,
        phase: "generating",
        operationId: "operation",
        document: savedDocument,
        previewMarkdown: "Complete preview from the Host",
      }),
    );
    act(() =>
      emit({
        type: "preview",
        key: pluginGuideTargetKey(target),
        target,
        sequence: 4,
        operationId: "operation",
        markdownDelta: "a tail without its beginning",
        replyDelta: "",
      }),
    );
    await waitFor(() => expect(result.current.snapshot?.sequence).toBe(5));
    expect(result.current.snapshot?.previewMarkdown).toBe("Complete preview from the Host");
    expect(result.current.snapshot?.document?.markdown).toBe(savedDocument.markdown);
    expect(service.generate).not.toHaveBeenCalled();
  });
});
