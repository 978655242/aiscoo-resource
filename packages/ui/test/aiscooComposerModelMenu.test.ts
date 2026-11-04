// XCODE: 保留退役 App 文件中的 Aiscoo 模型分组、图标及恢复时序回归。
import { createElement, type ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelSelectionView, ProviderSettingsView } from "@zcode/services";
import { ZCodeAboutLogo } from "@/components/ui/ZCodeAboutLogo.js";
import { V4ComposerModelControls } from "@/v4/composer/V4ComposerToolbar.js";
import type { ModelConfigSelect } from "@/ModelConfigSelect.js";

type MenuProps = ComponentProps<typeof ModelConfigSelect>;
const captured = vi.hoisted(() => ({ menu: null as MenuProps | null }));
const modelConfig = {
  optionSpecs: {
    reasoningLevel: { values: ["disabled"], map: "{}" },
    maxOutputTokens: { max: 32_000, map: "{}" },
  },
};
const catalog: ModelSelectionView = {
  revision: 1,
  providers: [
    {
      providerId: "custom-openai",
      providerName: "Custom OpenAI",
      config: {
        access: { type: "api-key", apiKey: "test-key" },
        api: {
          type: "openai-chat-completions",
          baseUrl: "https://api.example.com/v1",
        },
      },
      models: [{ modelId: "gpt-4o", config: modelConfig }],
    },
    {
      providerId: "custom-deepseek",
      providerName: "DeepSeek",
      config: {
        access: { type: "api-key", apiKey: "test-key" },
        api: {
          type: "openai-chat-completions",
          baseUrl: "https://api.deepseek.example/v1",
        },
      },
      models: [{ modelId: "deepseek-v4-pro", config: modelConfig }],
    },
    {
      providerId: "account:aiscoo-openai-chat-completions",
      providerName: "XWork",
      config: {
        access: {
          type: "new-api-account",
          accountType: "new-api",
          mode: "private-subscription",
          entitled: true,
        },
        api: {
          type: "openai-chat-completions",
          baseUrl: "https://aiscoo-admin.example.com/v1",
        },
      },
      models: [
        {
          modelId: "claude-sonnet-5.5",
          icon: "Claude.Color",
          config: modelConfig,
        },
      ],
    },
  ],
};

vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStoreWithDefault: (selector: (state: unknown) => unknown) =>
    selector({ user: { id: "account-a" }, authSessionSeq: 1 }),
}));
vi.mock("@/hooks/useWorkspaceServices.js", () => ({
  useBaseWorkspaceServices: () => ({}),
}));
vi.mock("@/hooks/useComposerConnectionSwitch.js", () => ({
  useComposerConnectionSwitch: () => ({
    pending: false,
    error: null,
    select: vi.fn(),
  }),
}));
vi.mock("@/ModelConfigSelect.js", () => ({
  ModelConfigSelect: (props: MenuProps) => {
    captured.menu = props;
    return createElement("button", {
      "data-testid": "model-select",
      disabled: props.disabled,
    });
  },
}));
vi.mock("@/chat-input-toolbar/display.js", () => ({
  ChatContextUsage: () => null,
}));
vi.mock("@/v4/composer/toolbarShortcuts.js", () => ({
  useToolbarShortcutBindings: vi.fn(),
}));
vi.mock("@/chat-input-toolbar/modelSelection.js", () => ({
  resolveModelSelectTriggerDisplay: (value: string) => ({ value }),
  shouldShowManageModelsAction: () => false,
}));
vi.mock("@/store/TabStoreProvider.js", () => ({ useTabStore: () => vi.fn() }));
vi.mock("@/hooks/useProviderSettingsView.js", () => ({
  useProviderSettingsView: () => ({
    state: {
      status: "ready",
      view: {
        revision: 1,
        addableProviders: [],
        providerOrder: [],
        providers: [],
      } as ProviderSettingsView,
    },
    reload: vi.fn(),
  }),
}));
vi.mock("@/hooks/useSettingService.js", () => ({
  useSettings: () => ({
    settings: {
      providerFamilyConnectionSelections: {},
      providerFamilyDomain: {},
    },
  }),
}));
vi.mock("@/hooks/useUsageEntitlement.js", () => ({
  useUsageEntitlement: () => ({
    snapshot: null,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/hooks/useZCodeConfig.js", () => ({
  useToolbarConfigOptions: () => ({
    configOptions: [],
    loading: false,
    error: true,
  }),
}));
vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({
    intl: { formatMessage: ({ id }: { id: string }) => id },
    locale: "zh-CN",
  }),
}));
vi.mock("@/settings/CodingPlanUpgradeDialogProvider.js", () => ({
  useCodingPlanUpgradeDialog: () => ({ openCodingPlanUpgrade: vi.fn() }),
}));
vi.mock("@/settings/model-provider-section/useCodingPlanEntitlements.js", () => ({
  useCodingPlanEntitlements: () => ({
    entitlements: {},
    enabledStartPlanProviderIds: [],
    refresh: vi.fn(),
  }),
}));
vi.mock("@/settings/model-provider-section/useEnterpriseCodingPlanProducts.js", () => ({
  useEnterpriseCodingPlanProducts: () => ({
    snapshot: { productList: [] },
    loading: false,
    error: null,
  }),
}));

function renderMenu(overrides: Partial<ComponentProps<typeof V4ComposerModelControls>> = {}) {
  renderToStaticMarkup(
    createElement(V4ComposerModelControls, {
      workspacePath: "/workspace",
      modelSelectionView: catalog,
      sessionId: null,
      phase: null,
      usage: null,
      disabled: false,
      activeConfigPicker: null,
      onConfigPickerOpenChange: vi.fn(),
      onSelectModel: vi.fn(),
      onSelectThought: vi.fn(),
      onSwitchMode: vi.fn(),
      draftConfig: {
        mode: "build",
        modelSelection: {
          providerId: "custom-openai",
          modelId: "gpt-4o",
          options: { reasoningLevel: "disabled" },
        },
      },
      ...overrides,
    }),
  );
  return captured.menu!;
}

afterEach(() => {
  captured.menu = null;
});

describe("Aiscoo composer model menu", () => {
  it("官方模型合为一组，自配模型按供应商分组，按钮只显示模型名", () => {
    const props = renderMenu();
    expect(props.triggerLabel).toBe("gpt-4o");
    expect(props.tooltipTitle).toBe("gpt-4o");
    expect(props.triggerLabelPrefix).toBeUndefined();
    expect(props.modelGroups.map((group) => group.labelBadge)).toEqual([
      undefined,
      "settings.modelProvider.connectionMode.apiKeyBadge",
      "settings.modelProvider.connectionMode.apiKeyBadge",
    ]);
    expect(props.modelGroups.slice(1).map((group) => group.label)).toEqual([
      "Custom OpenAI",
      "DeepSeek",
    ]);
    expect(props.modelGroups.map((group) => group.items.map((item) => item.name))).toEqual([
      ["claude-sonnet-5.5"],
      ["gpt-4o"],
      ["deepseek-v4-pro"],
    ]);
    const officialIcon = props.modelGroups[0]!.items[0]!.icon as {
      props: { name?: string };
    };
    expect(officialIcon.props.name).toBe("Claude.Color");
    expect(props.modelGroups[1]!.items[0]!.icon).toBeTruthy();
    expect(props.triggerIcon).toBe(props.modelGroups[1]!.items[0]!.icon);
    expect(props.modelGroups[0]!.icon).toEqual(expect.objectContaining({ type: ZCodeAboutLogo }));
    expect(props.modelGroups[2]!.icon).toBeTruthy();
    expect(props.modelGroups[2]!.icon).toEqual(props.modelGroups[2]!.items[0]!.icon);
    expect(props.triggerClassName).toContain("shrink-0");
    expect(props.composerOptions?.levels).toEqual(
      expect.arrayContaining([expect.objectContaining({ value: "disabled" })]),
    );
  });

  it("已有会话配置未恢复时保留新版空标签，恢复后重新显示 Aiscoo 模型图标", () => {
    expect(renderMenu({ sessionId: "session-a", draftConfig: {} }).triggerLabel).toBe("");
    const restored = renderMenu({ sessionId: "session-a" });
    expect(restored.triggerLabel).toBe("gpt-4o");
    expect(restored.triggerIcon).toBe(restored.modelGroups[1]!.items[0]!.icon);
  });
});
