// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  pluginGuideTargetKey,
  type PluginGuideDocument,
  type PluginGuideSnapshot,
  type PluginGuideTarget,
} from "@zcode/shared/aiscoo-plugin-guides";
import { usePluginGuideModel } from "@/aiscoo/plugin-guides/usePluginGuideModel.js";
import type { IPluginGuideService } from "@/aiscoo/plugin-guides/contract.js";
import type { IModelSelectionService } from "@zcode/services";
import { usePluginGuide } from "@/aiscoo/plugin-guides/usePluginGuide.js";

const catalog = vi.hoisted(() => ({
  state: {} as Record<string, unknown>,
  read: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock("@/hooks/useModelSelectionView.js", () => ({
  useModelSelectionServiceView: (...args: unknown[]) => {
    catalog.read(...args);
    return { state: catalog.state, reload: vi.fn() };
  },
  // 回归：说明阅读器不得再按路径独立解析模型目录（见 PR #33 评审）。
  useModelSelectionView: (...args: unknown[]) => {
    catalog.resolve(...args);
    throw new Error("guide model must use the guide Host's model selection service");
  },
}));
const hostModels = { name: "guide-host-models" } as unknown as IModelSelectionService;
const host = { modelSelectionService: hostModels, ready: true };
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
const target: PluginGuideTarget = {
  workspacePath: "/remote/project",
  workspaceIdentity: "remote:project",
  remoteSessionId: "remote-host",
  marketplace: "official",
  pluginName: "pdf",
  locale: "en-US",
};
const preferred = { providerId: "p", modelId: "m", options: { reasoningLevel: "max" } };
function view() {
  return {
    revision: 1,
    preferredSelection: preferred,
    providers: [
      {
        providerId: "p",
        providerName: "Provider",
        config: { api: { type: "openai-chat-completions" } },
        models: [
          {
            modelId: "m",
            config: { optionSpecs: { reasoningLevel: { values: ["low", "high", "max"] } } },
          },
          { modelId: "other", config: { optionSpecs: {} } },
        ],
      },
      { providerId: "empty", config: { api: { type: "openai-chat-completions" } }, models: [] },
    ],
  };
}
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe("reader-local guide model", () => {
  it("uses the target Host and lowest public effort without writing preferred selection", () => {
    catalog.state = { status: "ready", view: view() };
    const { result } = renderHook(() => usePluginGuideModel(host, target, undefined, true));
    expect(catalog.read).toHaveBeenCalledWith(hostModels, true, "remote-waiting");
    expect(catalog.resolve).not.toHaveBeenCalled();
    expect(result.current.selection).toEqual({ ...preferred, options: { reasoningLevel: "low" } });
    expect(result.current.groups.map((group) => group.key)).toEqual(["registry-provider:p"]);
    expect(preferred.options.reasoningLevel).toBe("max");
  });
  it("restores a supported saved choice and preserves explicit effort through catalog refresh", () => {
    const selected = { ...preferred, options: { reasoningLevel: "high" } };
    catalog.state = { status: "ready", view: view() };
    const saved = { selection: selected } as PluginGuideDocument;
    const { result, rerender } = renderHook(() => usePluginGuideModel(host, target, saved, true));
    expect(result.current.selection).toEqual(selected);
    act(() => result.current.setSelection({ ...preferred, options: { reasoningLevel: "max" } }));
    const changed = view();
    catalog.state = {
      status: "ready",
      view: {
        ...changed,
        providers: changed.providers.map((provider) => ({
          ...provider,
          models: provider.models.map((model) => ({
            ...model,
            config: { optionSpecs: { reasoningLevel: { values: ["low"] } } },
          })),
        })),
      },
    };
    rerender();
    expect(result.current.selection?.options?.reasoningLevel).toBe("max");
    expect(result.current.issue).toBeTruthy();
    expect(result.current.canGenerate).toBe(false);
  });
  it("falls back from unsupported cached choices but never silently switches an initialized choice", () => {
    catalog.state = { status: "ready", view: view() };
    const { result, rerender } = renderHook(() =>
      usePluginGuideModel(
        host,
        target,
        { selection: { providerId: "gone", modelId: "m" } } as PluginGuideDocument,
        true,
      ),
    );
    expect(result.current.selection?.providerId).toBe("p");
    catalog.state = { status: "ready", view: { ...view(), providers: [] } };
    rerender();
    expect(result.current.selection?.providerId).toBe("p");
    expect(result.current.canGenerate).toBe(false);
  });
  it("waits for the saved document before pinning the default and cannot use a waiting remote", () => {
    catalog.state = { status: "ready", view: view() };
    const { result, rerender } = renderHook(
      ({ ready }) => usePluginGuideModel(host, target, undefined, ready),
      { initialProps: { ready: false } },
    );
    expect(result.current.selection).toBeUndefined();
    catalog.state = { status: "unavailable", reason: "remote-waiting" };
    rerender({ ready: true });
    expect(result.current.canGenerate).toBe(false);
    expect(result.current.groups).toEqual([]);
  });
  it("reads the guide Host's catalog even when the target has no attached remote session", () => {
    // 远程配置工作区没有已附加标签页：target 只有 identity，没有 remoteSessionId。
    // 说明服务已绑定该 Host，模型目录必须来自同一 Host，不能进入 remote-waiting。
    catalog.state = { status: "ready", view: view() };
    const detached = { ...target, remoteSessionId: undefined };
    const { result } = renderHook(() => usePluginGuideModel(host, detached, undefined, true));
    expect(catalog.read).toHaveBeenCalledWith(hostModels, true, "remote-waiting");
    expect(catalog.resolve).not.toHaveBeenCalled();
    expect(result.current.canGenerate).toBe(true);
  });
  it("pauses the catalog while the guide Host's RPC is not ready", () => {
    catalog.state = { status: "unavailable", reason: "remote-waiting" };
    const { result } = renderHook(() =>
      usePluginGuideModel(
        { modelSelectionService: hostModels, ready: false },
        target,
        undefined,
        true,
      ),
    );
    expect(catalog.read).toHaveBeenCalledWith(hostModels, false, "remote-waiting");
    expect(result.current.canGenerate).toBe(false);
  });
});

function guidePort(phase: PluginGuideSnapshot["phase"]) {
  const snapshot: PluginGuideSnapshot = {
    key: pluginGuideTargetKey(target),
    target,
    sequence: 1,
    phase: "ready",
    document: null,
    messages: [],
    previewMarkdown: "",
    previewReply: "",
    stale: false,
  };
  const service: IPluginGuideService = {
    read: vi.fn(async () => snapshot),
    generate: vi.fn(async () => ({ ...snapshot, sequence: 2, phase })),
    cancel: vi.fn(async () => {}),
    retrySave: vi.fn(async () => snapshot),
    onDidChange: vi.fn(() => ({ dispose: vi.fn() })),
  };
  return service;
}

describe("guide generation acceptance", () => {
  it.each(["error", "cancelled", "generating"] as const)(
    "does not accept a %s generation as a reason to clear input",
    async (phase) => {
      const service = guidePort(phase);
      const { result } = renderHook(() => usePluginGuide(service, target));
      await waitFor(() => expect(result.current.snapshot?.phase).toBe("ready"));
      await act(async () => expect(await result.current.generate("Keep this draft")).toBe(false));
    },
  );

  it.each(["ready", "unsaved"] as const)(
    "accepts a completed %s result with its local choice without resubscribing",
    async (phase) => {
      const service = guidePort(phase);
      const { result, rerender } = renderHook(() => usePluginGuide(service, { ...target }));
      await waitFor(() => expect(result.current.snapshot?.phase).toBe("ready"));
      const selection = {
        providerId: "reader-only",
        modelId: "model",
        options: { reasoningLevel: "high" },
      };
      rerender();
      await act(async () =>
        expect(await result.current.generate("Explain", false, selection)).toBe(true),
      );
      expect(service.generate).toHaveBeenCalledWith(expect.objectContaining({ selection }));
      expect(service.read).toHaveBeenCalledTimes(1);
      expect(service.onDidChange).toHaveBeenCalledTimes(1);
    },
  );
});
