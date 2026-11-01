import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Loader2, RefreshCw, Save } from "lucide-react";
import type { IPluginGuideService, PluginGuideModelHost } from "./contract.js";
import { PLUGIN_GUIDE_SECTIONS, type PluginGuideTarget } from "@zcode/shared/aiscoo-plugin-guides";
import { Button } from "@/components/ui/button.js";
import { MessageResponse } from "@/components/ai-elements/message.js";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { PluginGuideQuestions } from "./PluginGuideQuestions.js";
import { usePluginGuide } from "./usePluginGuide.js";
import { usePluginGuideModel } from "./usePluginGuideModel.js";

interface PluginGuideReaderProps {
  service: IPluginGuideService | null | undefined;
  modelHost: PluginGuideModelHost;
  target: PluginGuideTarget | null;
  displayName: string;
  onBack: () => void;
}

export function PluginGuideReader(props: PluginGuideReaderProps) {
  const route = JSON.stringify(props.target);
  const [owner, setOwner] = useState({ service: props.service, route, revision: 0 });
  let currentOwner = owner;
  if (owner.service !== props.service || owner.route !== route) {
    currentOwner = { service: props.service, route, revision: owner.revision + 1 };
    setOwner(currentOwner);
  }
  // 原因：相同文本也可能属于不同 Host/插件；所有者切换必须废弃编辑器和本地选择。
  return <PluginGuideReaderContent key={currentOwner.revision} {...props} />;
}

function PluginGuideReaderContent({
  service,
  modelHost,
  target,
  displayName,
  onBack,
}: PluginGuideReaderProps) {
  const { intl } = useZCodeIntl();
  const format = (key: string, values?: Record<string, string>) =>
    intl.formatMessage({ id: `settings.plugins.guide.${key}` }, values);
  const theme = useZCodeStoreWithDefault((state) => state.theme, "system");
  const codePreviewSettings = useZCodeStoreWithDefault(
    (state) => state.codePreviewSettings,
    DEFAULT_CODE_PREVIEW_SETTINGS,
  );
  const projection = usePluginGuide(service, target);
  const { snapshot } = projection;
  const document = snapshot?.document;
  const model = usePluginGuideModel(
    modelHost,
    target,
    document,
    Boolean(snapshot && (document || snapshot.phase !== "reading")),
  );
  const busy =
    snapshot?.phase === "generating" ||
    snapshot?.phase === "saving" ||
    (snapshot?.phase === "reading" && Boolean(snapshot.operationId));
  const unsaved = snapshot?.phase === "unsaved";
  const error = projection.error ?? snapshot?.error;
  const article = useRef<HTMLElement>(null);
  const title = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    title.current?.focus();
  }, []);
  const markdownProps = { theme, codePreviewSettings };
  const unavailable = !service || !target;
  const trailingMessage = snapshot?.messages.at(-1);
  const lastQuestion = trailingMessage?.role === "user" ? trailingMessage.content : undefined;
  return (
    <section
      className="@container/plugin-guide min-w-0 space-y-5"
      data-testid="plugin-guide-reader"
    >
      <header className="space-y-3">
        <Button type="button" variant="ghost" onClick={onBack} data-testid="plugin-guide-back">
          <ArrowLeft className="size-4" aria-hidden="true" />
          {format("back")}
        </Button>
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1
              ref={title}
              tabIndex={-1}
              className="break-words text-ui-xl font-semibold outline-none"
            >
              {format("title", { name: displayName })}
            </h1>
            <p
              role="status"
              className="text-ui-caption text-foreground-subtle"
              data-testid="plugin-guide-status"
            >
              {unavailable
                ? format("unavailable")
                : projection.loading && !snapshot
                  ? format("phase.reading")
                  : format(`phase.${snapshot?.phase ?? "idle"}`)}
              {document
                ? ` · ${format("savedAt", { time: new Date(document.updatedAt).toLocaleString(target?.locale, { dateStyle: "medium", timeStyle: "short" }) })}`
                : ""}
            </p>
            {target ? (
              <p className="break-words text-ui-caption text-foreground-subtle">
                {format("sourceVersion", {
                  source: target.marketplace,
                  version: document?.version ?? target.version ?? format("versionUnknown"),
                })}
              </p>
            ) : null}
          </div>
          {!unavailable ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy || unsaved || projection.loading || !model.canGenerate}
              onClick={() => {
                void projection.generate(undefined, true, model.selection);
              }}
              data-testid="plugin-guide-regenerate"
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              {format("regenerate")}
            </Button>
          ) : null}
        </div>
        {snapshot?.stale ? (
          <p className="text-ui-base text-warning" data-testid="plugin-guide-stale">
            {format("stale")}
          </p>
        ) : null}
        {error || unsaved ? (
          <div
            role="alert"
            className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 text-ui-base"
          >
            <p className="min-w-0 flex-1 break-words">
              {unsaved ? format("saveFailed") : format("failed")}
              {error ? ` ${error}` : ""}
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={
                busy || projection.loading || (!unsaved && Boolean(snapshot) && !model.canGenerate)
              }
              data-testid={unsaved ? "plugin-guide-retry-save" : "plugin-guide-retry"}
              onClick={() => {
                if (unsaved) void projection.retrySave();
                else if (!snapshot) void projection.retryRead();
                else void projection.generate(lastQuestion, !lastQuestion, model.selection);
              }}
            >
              {unsaved ? (
                <Save className="size-3.5" aria-hidden="true" />
              ) : (
                <RefreshCw className="size-3.5" aria-hidden="true" />
              )}
              {format(unsaved ? "retrySave" : "retry")}
            </Button>
          </div>
        ) : null}
        {snapshot?.phase === "cancelled" ? (
          <Button
            type="button"
            variant="outline"
            disabled={projection.loading || !model.canGenerate}
            onClick={() => {
              void projection.generate(lastQuestion, !lastQuestion, model.selection);
            }}
            data-testid="plugin-guide-retry"
          >
            {format("retry")}
          </Button>
        ) : null}
      </header>
      {!unavailable ? (
        <div className="grid min-w-0 gap-6 @min-[48rem]/plugin-guide:grid-cols-[12rem_minmax(0,1fr)]">
          <nav
            aria-label={format("contents")}
            className="min-w-0 @min-[48rem]/plugin-guide:sticky @min-[48rem]/plugin-guide:top-4 @min-[48rem]/plugin-guide:self-start"
          >
            <h2 className="mb-2 text-ui-caption font-medium text-foreground-subtle">
              {format("contents")}
            </h2>
            <div className="flex flex-wrap gap-1 @min-[48rem]/plugin-guide:flex-col">
              {PLUGIN_GUIDE_SECTIONS.map((section) => (
                <Button
                  key={section.id}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto justify-start whitespace-normal text-left text-ui-caption"
                  disabled={!document}
                  onClick={() => {
                    const heading = [...(article.current?.querySelectorAll("h2") ?? [])].find(
                      (node) =>
                        node.textContent?.trim() === section.title[target?.locale ?? "en-US"],
                    );
                    heading?.scrollIntoView({ block: "start", behavior: "instant" });
                  }}
                >
                  {format(`section.${section.id}`)}
                </Button>
              ))}
            </div>
          </nav>
          <div className="min-w-0 space-y-6">
            {document ? (
              <article
                ref={article}
                className="min-w-0 max-w-prose"
                data-testid="plugin-guide-document"
              >
                <MessageResponse {...markdownProps}>{document.markdown}</MessageResponse>
              </article>
            ) : !snapshot?.previewMarkdown ? (
              <div className="flex items-center gap-2 py-8 text-ui-base text-foreground-subtle">
                {busy || projection.loading ? (
                  <Loader2 className="size-4 animate-spin" aria-hidden="true" />
                ) : null}
                <p>{format(busy ? "generatingHint" : "empty")}</p>
              </div>
            ) : null}
            {snapshot?.previewMarkdown ? (
              <section
                className="space-y-2"
                aria-label={format(unsaved ? "pendingSave" : "preview")}
                data-testid="plugin-guide-preview"
              >
                <h2 className="text-ui-caption font-medium text-foreground-subtle">
                  {format(unsaved ? "pendingSave" : "preview")}
                </h2>
                <Conversation
                  className="h-96 rounded-xl border border-border"
                  aria-label={format("preview")}
                >
                  <ConversationContent className="py-4">
                    <MessageResponse {...markdownProps} streaming={busy}>
                      {snapshot.previewMarkdown}
                    </MessageResponse>
                  </ConversationContent>
                  <ConversationScrollButton aria-label={format("scrollBottom")} />
                </Conversation>
              </section>
            ) : null}
            {document ? (
              <details className="rounded-xl border border-border p-3 text-ui-caption text-foreground-subtle">
                <summary className="cursor-pointer font-medium">{format("sources")}</summary>
                <dl className="mt-3 grid min-w-0 gap-2">
                  <div>
                    <dt className="font-medium">{format("source")}</dt>
                    <dd className="break-words">{target?.marketplace}</dd>
                  </div>
                  <div>
                    <dt className="font-medium">{format("version")}</dt>
                    <dd>{document.version || format("versionUnknown")}</dd>
                  </div>
                </dl>
                <ul className="mt-3 list-inside list-disc break-words">
                  {document.sourcePaths.map((path) => (
                    <li key={path}>{path}</li>
                  ))}
                </ul>
                {document.diagnostics.map((diagnostic, index) => (
                  <p key={index} className="mt-2 break-words">
                    {diagnostic}
                  </p>
                ))}
              </details>
            ) : null}
            <PluginGuideQuestions
              target={target!}
              model={model}
              snapshot={snapshot}
              projection={projection}
              markdownProps={markdownProps}
              busy={busy}
              disabled={unsaved || !snapshot || snapshot.phase === "reading"}
            />
          </div>
        </div>
      ) : null}
    </section>
  );
}
