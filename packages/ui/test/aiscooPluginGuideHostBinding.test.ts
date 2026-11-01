// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IModelSelectionService } from "@zcode/services";
import type { IPluginGuideService, PluginGuideModelHost } from "@/aiscoo/plugin-guides/contract.js";

const seen = vi.hoisted(() => ({
  reader: [] as Array<{ service: unknown; modelHost: PluginGuideModelHost }>,
}));
const contextServices = vi.hoisted(() => ({
  pluginGuideService: { name: "context-guide" },
  modelSelectionService: { name: "context-models" },
}));
vi.mock("@/hooks/useServices.js", () => ({ useOptionalServices: () => contextServices }));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "en-US",
  }),
}));
vi.mock("@/settings/PluginStoreDetailView.js", () => ({
  PluginStoreDetailView: ({ headerActions }: { headerActions: unknown }) =>
    createElement("div", null, headerActions),
}));
vi.mock("@/settings/pluginStoreListing.js", () => ({
  resolveItemDisplayName: (item: { name: string }) => item.name,
}));
// XCODE: 旧路径仅转发，替身必须挂到唯一实现；保留同 Host 与空来源隔离断言。
vi.mock("@/aiscoo/plugin-guides/PluginGuideReader.js", () => ({
  PluginGuideReader: (props: { service: unknown; modelHost: PluginGuideModelHost }) => {
    seen.reader.push({ service: props.service, modelHost: props.modelHost });
    return createElement("div", { "data-testid": "reader" });
  },
}));

const item = { id: "official/pdf", name: "pdf", marketplace: "official" };

async function openGuide(props: Record<string, unknown>) {
  const { AiscooPluginStoreDetailView } =
    await import("@/aiscoo/plugin-guides/AiscooPluginStoreDetailView.js");
  render(
    createElement(AiscooPluginStoreDetailView, {
      workspacePath: "/remote/project",
      item,
      actions: {},
      onRetryDescribe: () => {},
      ...props,
    } as never),
  );
  fireEvent.click(screen.getByTestId("plugin-guide-open"));
  return seen.reader.at(-1)!;
}

afterEach(() => {
  cleanup();
  seen.reader.length = 0;
});

describe("guide reader Host binding", () => {
  it("takes the model catalog from the same resolved Host as an explicit guide service", async () => {
    // 回归（PR #33 评审）：管理页传入已解析 Host 的说明服务时，模型目录不能另行按路径解析。
    const guide = { name: "source-guide" } as unknown as IPluginGuideService;
    const models = { name: "source-models" } as unknown as IModelSelectionService;
    const reader = await openGuide({
      guideService: guide,
      modelSelectionService: models,
      guideHostReady: false,
    });
    expect(reader.service).toBe(guide);
    expect(reader.modelHost).toEqual({ modelSelectionService: models, ready: false });
  });

  it("never mixes an explicit guide Host with the context model catalog", async () => {
    const reader = await openGuide({ guideService: null });
    expect(reader.service).toBeNull();
    expect(reader.modelHost.modelSelectionService).toBeUndefined();
  });

  it("uses the context Host for both services when no guide service is supplied", async () => {
    const reader = await openGuide({});
    expect(reader.service).toBe(contextServices.pluginGuideService);
    expect(reader.modelHost).toEqual({
      modelSelectionService: contextServices.modelSelectionService,
      ready: true,
    });
  });
});
