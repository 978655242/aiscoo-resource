import { useEffect, useMemo, useRef, useState } from "react";
import { Square } from "lucide-react";
import { ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import type { PluginGuideSnapshot, PluginGuideTarget } from "@zcode/shared/aiscoo-plugin-guides";
import { Button } from "@/components/ui/button.js";
import { ChatPromptEditor } from "@/prompt-editor/ChatPromptEditor.js";
import type { LexicalChatInputHandle } from "@/LexicalChatInput.js";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { getThoughtLevelLabel } from "@/chat-input-toolbar/thoughtLevelOptions.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { resolveChatEnterSubmits, useIsMobileTextInputViewport } from "@/lib/mobileTextInput.js";
import type { PluginGuideModel } from "./usePluginGuideModel.js";
import {
  Message,
  MessageContent,
  MessageResponse,
  type MessageResponseProps,
} from "@/components/ai-elements/message.js";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { PluginGuideProjection } from "./contract.js";

export function PluginGuideQuestions({
  snapshot,
  projection,
  markdownProps,
  busy,
  disabled,
  target,
  model,
}: {
  snapshot: PluginGuideSnapshot | null;
  projection: PluginGuideProjection;
  markdownProps: MessageResponseProps;
  busy: boolean;
  disabled: boolean;
  target: PluginGuideTarget;
  model: PluginGuideModel;
}) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState("");
  const input = useRef<LexicalChatInputHandle | null>(null);
  const mounted = useRef(true);
  const pending = useRef(false);
  const draftRevision = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isMobileTextInputViewport = useIsMobileTextInputViewport();
  const enterSubmits = resolveChatEnterSubmits({
    isMobileTextInputViewport,
    preferEnterNewline: true,
  });
  const thoughtOption = model.thoughtOption;
  const composerOptions = useMemo(
    () => ({
      providerLabel: intl.formatMessage({ id: "chat.toolbar.combined.provider" }),
      modelsLabel: intl.formatMessage({ id: "chat.toolbar.combined.models" }),
      effortLabel: intl.formatMessage({ id: "chat.toolbar.combined.effort" }),
      selectModelLabel: intl.formatMessage({ id: "chat.toolbar.combined.selectModel" }),
      levels:
        thoughtOption?.options?.map((entry) => ({
          value: entry.value,
          label: getThoughtLevelLabel(intl, ZCODE_AGENT_PROVIDER, thoughtOption, entry),
        })) ?? [],
      value: model.selection?.options?.reasoningLevel ?? "",
      onValueChange: (reasoningLevel: string) => {
        if (model.selection)
          model.setSelection({
            ...model.selection,
            options: { ...model.selection.options, reasoningLevel },
          });
      },
    }),
    [intl, thoughtOption, model.selection, model.setSelection],
  );
  const normalizedValue = model.selection
    ? encodeCustomModelValue(model.selection.providerId, model.selection.modelId)
    : "";
  const triggerLabel =
    model.groups.flatMap((group) => group.items).find((item) => item.value === normalizedValue)
      ?.name ??
    model.selection?.modelId ??
    composerOptions.selectModelLabel;
  const format = (key: string) => intl.formatMessage({ id: `settings.plugins.guide.${key}` });
  const canStop =
    (snapshot?.phase === "reading" || snapshot?.phase === "generating") &&
    Boolean(snapshot.operationId);
  return (
    <section className="space-y-3" aria-label={format("questions")}>
      <h2 className="text-ui-lg font-semibold">{format("questions")}</h2>
      {snapshot && (snapshot.messages.length > 0 || snapshot.previewReply) ? (
        <Conversation
          className="h-72 rounded-xl border border-border"
          aria-label={format("conversation")}
        >
          <ConversationContent className="space-y-4 py-4">
            {snapshot.messages.map((message) => (
              <Message key={message.id} from={message.role}>
                <MessageContent>
                  <MessageResponse {...markdownProps}>{message.content}</MessageResponse>
                </MessageContent>
              </Message>
            ))}
            {snapshot.previewReply ? (
              <Message from="assistant">
                <MessageContent>
                  <MessageResponse {...markdownProps} streaming={busy}>
                    {snapshot.previewReply}
                  </MessageResponse>
                </MessageContent>
              </Message>
            ) : null}
          </ConversationContent>
          <ConversationScrollButton aria-label={format("scrollBottom")} />
        </Conversation>
      ) : null}
      {model.issue ? (
        <p role="alert" className="text-ui-caption text-destructive">
          {model.issue}
        </p>
      ) : null}
      <ChatPromptEditor
        workspacePath={target.workspacePath}
        workspaceIdentity={target.workspaceIdentity}
        taskId={null}
        enableMentionPanel={false}
        enableSlashCommands={false}
        disabled={disabled}
        submitDisabled={
          disabled || busy || projection.loading || !model.canGenerate || !draft.trim()
        }
        enterSubmits={enterSubmits}
        avoidIosInputFocusZoom={isMobileTextInputViewport}
        placeholder={format("questionPlaceholder")}
        submitLabel={format("send")}
        inputTestId="plugin-guide-question"
        submitTestId="plugin-guide-send"
        inputApiRef={input}
        onChange={(value) => {
          draftRevision.current += 1;
          setDraft(value);
        }}
        onPaste={(event) => {
          if (event.clipboardData?.files.length) event.preventDefault();
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => event.preventDefault()}
        onSubmit={(value) => {
          const question = value.trim();
          if (
            !question ||
            question.length > 16 * 1024 ||
            disabled ||
            busy ||
            projection.loading ||
            pending.current ||
            !model.canGenerate
          )
            return false;
          const submittedRevision = draftRevision.current;
          const submittedInput = input.current;
          pending.current = true;
          void projection
            .generate(question, false, model.selection)
            .then((accepted) => {
              // 原因：失败保留草稿；旧目标、用户新编辑或已替换编辑器的迟到回执不能清空当前输入。
              if (
                accepted &&
                mounted.current &&
                input.current === submittedInput &&
                draftRevision.current === submittedRevision &&
                input.current?.getMarkdown() === value
              ) {
                input.current.clear();
                setDraft("");
                input.current.focus();
              }
            })
            .finally(() => {
              pending.current = false;
            });
          return false;
        }}
        leadingActions={
          <ModelConfigSelect
            composerOptions={composerOptions}
            modelGroups={model.groups}
            normalizedValue={normalizedValue}
            triggerLabel={triggerLabel}
            showManageModelsAction={false}
            lockReasonMessage=""
            isItemLocked={() => false}
            onValueChange={(value) => {
              const decoded = decodeCustomModelValue(value);
              if (decoded?.modelName) model.pickModel(decoded.providerId, decoded.modelName);
            }}
            disabled={model.loading || disabled || busy || projection.loading}
            triggerTestId="plugin-guide-model-select"
            focusSelectorOnClose={'[data-testid="plugin-guide-question"]'}
            labelVisibilityClassName="inline-flex"
            triggerClassName="max-w-full"
            triggerLabelClassName="min-w-0 max-w-48 truncate text-left"
          />
        }
        submitControl={
          canStop ? (
            <Button
              type="button"
              size="icon-md"
              onClick={() => {
                void projection.stop();
                input.current?.focus();
              }}
              aria-label={format("stop")}
              title={format("stop")}
              data-testid="plugin-guide-stop"
              className="gap-1 rounded-lg bg-brand text-ui-base text-foreground-inverse hover:bg-brand/80"
            >
              <Square className="size-3.5 fill-current" aria-hidden="true" />
            </Button>
          ) : undefined
        }
      />
    </section>
  );
}
