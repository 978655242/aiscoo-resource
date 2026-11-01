import { useRef, useState } from "react";
import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { PluginStoreDetailView } from "@/settings/PluginStoreDetailView.js";
import { resolveItemDisplayName } from "@/settings/pluginStoreListing.js";
import { PluginGuideReader } from "./PluginGuideReader.js";
import type { AiscooPluginStoreDetailViewProps } from "./contract.js";

export function AiscooPluginStoreDetailView({
  workspacePath,
  workspaceIdentity,
  remoteSessionId,
  guideService,
  modelSelectionService,
  guideHostReady = true,
  ...detail
}: AiscooPluginStoreDetailViewProps) {
  const { intl, locale } = useZCodeIntl();
  const services = useOptionalServices();
  const [openTarget, setOpenTarget] = useState<string | null>(null);
  const entry = useRef<HTMLButtonElement>(null);
  const targetIdentity = JSON.stringify([
    workspaceIdentity?.trim() || workspacePath,
    remoteSessionId,
    detail.item.id,
    locale,
  ]);
  const open = openTarget === targetIdentity;
  // 说明服务与模型目录必须来自同一来源：显式传入时都用调用方解析出的 Host，否则都用上下文。
  const explicit = guideService !== undefined;
  const service = explicit ? guideService : services?.pluginGuideService;
  const modelHost = {
    modelSelectionService: explicit ? modelSelectionService : services?.modelSelectionService,
    ready: explicit ? guideHostReady : true,
  };
  const version =
    detail.item.info?.version ??
    detail.item.installedMeta?.version ??
    detail.item.summary?.version ??
    (detail.describeEntry?.status === "loaded"
      ? detail.describeEntry.data?.metadata?.version
      : undefined);
  return (
    <>
      <div hidden={open}>
        <PluginStoreDetailView
          {...detail}
          headerActions={
            <>
              {detail.headerActions}
              <Button
                ref={entry}
                type="button"
                variant="outline"
                size="lg"
                data-testid="plugin-guide-open"
                onClick={() => setOpenTarget(targetIdentity)}
              >
                <BookOpen className="size-3.5" aria-hidden="true" />
                {intl.formatMessage({ id: "settings.plugins.guide.open" })}
              </Button>
            </>
          }
        />
      </div>
      {open ? (
        <PluginGuideReader
          key={targetIdentity}
          service={service}
          modelHost={modelHost}
          target={
            workspacePath
              ? {
                  workspacePath,
                  ...(workspaceIdentity?.trim()
                    ? { workspaceIdentity: workspaceIdentity.trim() }
                    : {}),
                  ...(remoteSessionId ? { remoteSessionId } : {}),
                  pluginName: detail.item.name,
                  marketplace: detail.item.marketplace,
                  locale,
                  ...(version ? { version } : {}),
                }
              : null
          }
          displayName={resolveItemDisplayName(detail.item, locale)}
          onBack={() => {
            setOpenTarget(null);
            requestAnimationFrame(() => entry.current?.focus());
          }}
        />
      ) : null}
    </>
  );
}
