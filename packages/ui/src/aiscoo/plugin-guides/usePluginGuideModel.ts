import { useMemo, useState } from "react";
import { ZCODE_AGENT_PROVIDER, type ModelSelection } from "@zcode/shared";
import type { ModelSelectionView, PluginGuideModelHost } from "./contract.js";
import type { ZCodeConfigOption } from "@zcode/shared";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import type { PluginGuideDocument, PluginGuideTarget } from "@zcode/shared/aiscoo-plugin-guides";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildRegistryModelSelectGroups } from "@/lib/modelSelectionGroups.js";
import { resolveModelThoughtOption } from "@/lib/modelThoughtOption.js";

export interface PluginGuideModel {
  selection: ModelSelection | undefined;
  setSelection(selection: ModelSelection): void;
  groups: ModelSelectGroup[];
  thoughtOption: ZCodeConfigOption | null;
  issue: string | null;
  canGenerate: boolean;
  loading: boolean;
  reload(): void;
  pickModel(providerId: string, modelId: string): void;
}

function supported(view: ModelSelectionView, selection: ModelSelection): boolean {
  const model = view.providers
    .find((provider) => provider.providerId === selection.providerId)
    ?.models.find((candidate) => candidate.modelId === selection.modelId);
  if (!model) return false;
  const levels = model.config.optionSpecs.reasoningLevel?.values ?? [];
  return levels.length > 0
    ? levels.includes(selection.options?.reasoningLevel ?? "")
    : !selection.options?.reasoningLevel;
}

function lowestSelection(view: ModelSelectionView, selection: ModelSelection): ModelSelection {
  const option = resolveModelThoughtOption({ modelSelectionView: view, ...selection });
  const level = option?.options?.[0]?.value;
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(level ? { options: { reasoningLevel: level } } : {}),
  };
}

/** Only the mounted reader owns this intent; the Host catalog remains read-only. */
export function usePluginGuideModel(
  host: PluginGuideModelHost,
  target: PluginGuideTarget | null,
  document: PluginGuideDocument | null | undefined,
  documentRead: boolean,
): PluginGuideModel {
  const { intl } = useZCodeIntl();
  // Bug 原因：按 target 路径独立解析模型目录，会和说明服务落在不同 Host——远程 Source 的
  // 路径型 target 回退到 Base Host 的模型却提交给远程 Host；无附加标签页的远程配置工作区
  // 则停在 remote-waiting，禁用手动生成。改为读取说明服务所在 Host 的模型服务（PR #33 评审）。
  const read = useModelSelectionServiceView(
    host.modelSelectionService,
    Boolean(target) && host.ready,
    target ? "remote-waiting" : "missing-target",
  );
  const view = read.state.status === "ready" ? read.state.view : null;
  const [selection, setSelection] = useState<ModelSelection>();
  const [initialized, setInitialized] = useState(false);
  let current = selection;
  if (!initialized && documentRead && view) {
    const preferred = view.preferredSelection;
    current =
      document?.selection && supported(view, document.selection)
        ? document.selection
        : preferred
          ? lowestSelection(view, preferred)
          : undefined;
    setSelection(current);
    setInitialized(true);
  }
  const groups = useMemo(
    () =>
      view
        ? buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, view, {
            apiKeyBadgeLabel: intl.formatMessage({
              id: "settings.modelProvider.connectionMode.apiKeyBadge",
            }),
            codingPlanBadgeLabel: intl.formatMessage({
              id: "settings.modelProvider.connectionMode.codingPlanBadge",
            }),
            startPlanBadgeLabel: intl.formatMessage({
              id: "settings.modelProvider.connectionMode.startPlanBadge",
            }),
            teamPlanBadgeLabel: intl.formatMessage({
              id: "settings.modelProvider.connectionMode.teamPlanBadge",
            }),
          })
        : [],
    [intl, view],
  );
  const valid = Boolean(view && current && supported(view, current));
  const issue =
    read.state.status === "error"
      ? read.state.error.message
      : read.state.status === "unavailable"
        ? intl.formatMessage({
            id:
              read.state.reason === "remote-waiting"
                ? "chat.toolbar.model.remoteWaiting"
                : "chat.toolbar.model.targetMissing",
          })
        : read.state.status === "ready" && read.state.refreshError
          ? read.state.refreshError.error.message
          : view && !valid
            ? intl.formatMessage({ id: "chat.toolbar.combined.selectModel" })
            : null;
  const thoughtOption =
    view && current
      ? resolveModelThoughtOption({
          modelSelectionView: view,
          ...current,
          currentValue: current.options?.reasoningLevel,
        })
      : null;
  return {
    selection: current,
    setSelection,
    groups,
    thoughtOption,
    issue,
    canGenerate: initialized && valid && !issue,
    loading: read.state.status === "loading",
    reload: read.reload,
    pickModel: (providerId: string, modelId: string) => {
      if (!view) return;
      if (current?.providerId === providerId && current.modelId === modelId) return;
      setSelection(lowestSelection(view, { providerId, modelId }));
    },
  };
}
