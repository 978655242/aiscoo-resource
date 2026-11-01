import { Emitter } from "@zcode/rpc";
import type { PluginGuideChange } from "@zcode/shared/aiscoo-plugin-guides";
import {
  PLUGIN_GUIDE_MAX_DOCUMENT_BYTES,
  PLUGIN_GUIDE_TEMPLATE_VERSION,
  parsePluginGuideResponse,
  pluginGuideDocumentSchema,
  pluginGuideGenerateParamsSchema,
  pluginGuideSourceSchema,
  pluginGuideTargetKey,
  pluginGuideTargetSchema,
  previewPluginGuideResponse,
  type PluginGuideDocument,
  type PluginGuideGenerateParams,
  type PluginGuideSnapshot,
  type PluginGuideSource,
  type PluginGuideTarget,
} from "@zcode/shared/aiscoo-plugin-guides";
import type { IPluginGuideService, PluginGuideServiceDependencies } from "../contract.js";
import { buildPluginGuideMessages } from "../domain/prompt.js";

type Operation = {
  operationId: string;
  question?: string;
  regenerate?: boolean;
  controller: AbortController;
  promise: Promise<PluginGuideSnapshot>;
};
type PendingSave = { document: PluginGuideDocument; baseRevision: string | null };
const busy = (state: PluginGuideSnapshot) =>
  state.phase === "reading" || state.phase === "generating" || state.phase === "saving";

export function createPluginGuideService(
  dependencies: PluginGuideServiceDependencies,
): IPluginGuideService & { dispose(): void } {
  const changes = new Emitter<PluginGuideChange>();
  const states = new Map<string, PluginGuideSnapshot>();
  const reads = new Map<string, Promise<PluginGuideSnapshot>>();
  const sources = new Map<string, PluginGuideSource>();
  const operations = new Map<string, Operation>();
  const pendingSaves = new Map<string, PendingSave>();
  let disposed = false;

  function current(target: PluginGuideTarget): PluginGuideSnapshot {
    const key = pluginGuideTargetKey(target);
    let snapshot = states.get(key);
    if (!snapshot) {
      snapshot = {
        key,
        target,
        sequence: 0,
        phase: "idle",
        document: null,
        messages: [],
        previewMarkdown: "",
        previewReply: "",
        stale: false,
      };
      states.set(key, snapshot);
    }
    return snapshot;
  }
  function publish(
    target: PluginGuideTarget,
    patch: Partial<PluginGuideSnapshot>,
  ): PluginGuideSnapshot {
    const before = current(target);
    const snapshot = {
      ...before,
      ...patch,
      target,
      key: before.key,
      sequence: before.sequence + 1,
    };
    states.set(before.key, snapshot);
    if (!disposed) changes.fire(snapshot);
    return snapshot;
  }
  function stale(document: PluginGuideDocument, source: PluginGuideSource): boolean {
    return (
      document.sourceRevision !== source.sourceRevision ||
      (source.fingerprintKind === "content" && document.fingerprint !== source.fingerprint)
    );
  }
  function ready(
    target: PluginGuideTarget,
    document: PluginGuideDocument,
    source?: PluginGuideSource,
  ): PluginGuideSnapshot {
    return publish(target, {
      phase: "ready",
      document,
      messages: document.messages,
      previewMarkdown: "",
      previewReply: "",
      error: undefined,
      operationId: undefined,
      stale: source
        ? stale(document, source)
        : Boolean(target.version && target.version !== document.version),
    });
  }

  function publishPreview(
    target: PluginGuideTarget,
    operationId: string,
    preview: { markdown: string; reply: string },
  ): void {
    if (
      preview.markdown.length > PLUGIN_GUIDE_MAX_DOCUMENT_BYTES ||
      preview.reply.length > 64 * 1024
    )
      throw new Error("Plugin guide model output exceeds its preview limit");
    const before = current(target);
    if (preview.markdown === before.previewMarkdown && preview.reply === before.previewReply)
      return;
    if (
      !preview.markdown.startsWith(before.previewMarkdown) ||
      !preview.reply.startsWith(before.previewReply)
    ) {
      publish(target, { previewMarkdown: preview.markdown, previewReply: preview.reply });
      return;
    }
    const sequence = before.sequence + 1;
    states.set(before.key, {
      ...before,
      sequence,
      previewMarkdown: preview.markdown,
      previewReply: preview.reply,
    });
    // 正文和问答只在快照中发送；连续预览只传新增文字，避免流式 IPC 平方增长。
    if (!disposed)
      changes.fire({
        type: "preview",
        key: before.key,
        target,
        sequence,
        operationId,
        markdownDelta: preview.markdown.slice(before.previewMarkdown.length),
        replyDelta: preview.reply.slice(before.previewReply.length),
      });
  }

  async function read(input: PluginGuideTarget): Promise<PluginGuideSnapshot> {
    const target = pluginGuideTargetSchema.parse(input);
    if (disposed) throw new Error("Plugin guide service has been disposed");
    const key = pluginGuideTargetKey(target);
    const existingRead = reads.get(key);
    if (existingRead) return existingRead;
    const existing = current(target);
    // 失败与取消由用户显式重试；重新挂载不能丢掉待重试问题或再次自动扣费。
    if (
      busy(existing) ||
      pendingSaves.has(key) ||
      existing.phase === "error" ||
      existing.phase === "cancelled"
    )
      return existing;
    const pending = (async () => {
      let fallback = existing.document;
      try {
        fallback ??= await dependencies.repository.readFallback(target);
        publish(target, {
          phase: "reading",
          document: fallback,
          messages: fallback?.messages ?? [],
          error: undefined,
        });
        const source = pluginGuideSourceSchema.parse(
          await dependencies.readSource(target, "identity"),
        );
        sources.set(key, source);
        const document = await dependencies.repository.read(source, target.locale);
        if (document) return ready(target, document, source);
        return publish(target, {
          phase: "idle",
          document: null,
          messages: [],
          stale: false,
          previewMarkdown: "",
          previewReply: "",
          error: undefined,
        });
      } catch (error) {
        if (fallback)
          return publish(target, {
            phase: "ready",
            document: fallback,
            messages: fallback.messages,
            stale: true,
            error: error instanceof Error ? error.message : String(error),
          });
        return publish(target, {
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    })();
    reads.set(key, pending);
    try {
      return await pending;
    } finally {
      if (reads.get(key) === pending) reads.delete(key);
    }
  }

  async function run(
    input: PluginGuideGenerateParams,
    controller: AbortController,
  ): Promise<PluginGuideSnapshot> {
    const { target, operationId, question, regenerate } = input;
    const key = pluginGuideTargetKey(target);
    const signal = controller.signal;
    try {
      await read(target);
      signal.throwIfAborted();
      publish(target, {
        phase: "reading",
        operationId,
        ...(question
          ? {
              messages: [
                ...(current(target).document?.messages ?? []),
                { id: `${operationId}:user`, role: "user" as const, content: question },
              ],
            }
          : {}),
        previewMarkdown: "",
        previewReply: "",
        error: undefined,
      });
      const identity = pluginGuideSourceSchema.parse(
        await dependencies.readSource(target, "identity", signal),
      );
      sources.set(key, identity);
      return await dependencies.repository.withLock(identity, target.locale, async () => {
        signal.throwIfAborted();
        const saved = await dependencies.repository.read(identity, target.locale);
        if (saved && saved.messages.some((message) => message.id === `${operationId}:assistant`))
          return ready(target, saved, identity);
        if (saved && !question && !regenerate && !stale(saved, identity))
          return ready(target, saved, identity);
        const source = pluginGuideSourceSchema.parse(
          await dependencies.readSource(target, "documents", signal),
        );
        if (
          source.sourceIdentity !== identity.sourceIdentity ||
          source.pluginId !== identity.pluginId
        )
          throw new Error(
            "Plugin source changed while preparing its guide. Reopen the guide and retry.",
          );
        if (source.fingerprintKind !== "content" || source.documents.length === 0)
          throw new Error("No readable plugin documentation is available for this guide.");
        sources.set(key, source);
        signal.throwIfAborted();
        const view = await dependencies.readModelSelectionView(target);
        const preferred = view.preferredSelection;
        const preferredModel = view.providers
          .find((provider) => provider.providerId === preferred?.providerId)
          ?.models.find((model) => model.modelId === preferred?.modelId);
        const lowestReasoning = preferredModel?.config.optionSpecs.reasoningLevel.values[0];
        // 说明的默认档位只属于本次请求，不能继承或改写普通会话的最高档位。
        const selection =
          input.selection ??
          (preferred && lowestReasoning !== undefined
            ? {
                providerId: preferred.providerId,
                modelId: preferred.modelId,
                options: { reasoningLevel: lowestReasoning },
              }
            : undefined);
        if (!selection)
          throw new Error(
            target.locale === "zh-CN"
              ? "请先在模型设置中配置并选择可用模型，再生成使用说明。"
              : "Configure and select an available model before generating this guide.",
          );
        const validated = await dependencies.readModelSelectionView(target, selection);
        const effective = validated.effectiveSelection;
        // Facade 可为普通会话迁移账号/旧档位；说明的显式选择必须原样执行。
        if (
          validated.selectionIssue ||
          !effective ||
          effective.providerId !== selection.providerId ||
          effective.modelId !== selection.modelId ||
          effective.options?.reasoningLevel !== selection.options?.reasoningLevel
        )
          throw new Error(
            target.locale === "zh-CN"
              ? "所选模型或思考档位已不可用，请重新选择后生成使用说明。"
              : "The selected model or reasoning level is unavailable. Select it again before generating this guide.",
          );
        signal.throwIfAborted();
        const baseMessages = saved?.messages ?? [];
        if (baseMessages.length > 196)
          throw new Error(
            target.locale === "zh-CN"
              ? "说明问答已达到本地记录上限，已保存的说明仍可阅读。"
              : "This guide has reached its discussion limit. The saved guide remains available.",
          );
        const messages = question
          ? [
              ...baseMessages,
              { id: `${operationId}:user`, role: "user" as const, content: question },
            ]
          : baseMessages;
        publish(target, {
          phase: "generating",
          document: saved,
          messages,
          operationId,
          stale: saved ? stale(saved, source) : false,
        });
        let raw = "";
        const result = await dependencies.streamText({
          workspacePath: target.workspacePath,
          workspaceIdentity: target.workspaceIdentity,
          remoteSessionId: target.remoteSessionId,
          selection,
          operationId,
          querySource: "plugin_usage_guide",
          maxOutputTokens: 8192,
          messages: buildPluginGuideMessages({ target, source, document: saved, question }),
          signal,
          onDelta(text) {
            if (signal.aborted || operations.get(key)?.operationId !== operationId) return;
            raw += text;
            if (raw.length > PLUGIN_GUIDE_MAX_DOCUMENT_BYTES * 2)
              throw new Error("Plugin guide model output exceeds its document limit");
            publishPreview(target, operationId, previewPluginGuideResponse(raw));
          },
        });
        signal.throwIfAborted();
        if (
          !result.finishReason ||
          !["stop", "end_turn", "end-turn", "completed"].includes(result.finishReason) ||
          result.toolCalls?.length
        )
          throw new Error(
            "The model did not complete the plugin guide. The saved version has been kept.",
          );
        const parsed = parsePluginGuideResponse(result.text, target.locale);
        const document = pluginGuideDocumentSchema.parse({
          schemaVersion: 1,
          templateVersion: PLUGIN_GUIDE_TEMPLATE_VERSION,
          pluginId: source.pluginId,
          sourceIdentity: source.sourceIdentity,
          sourceRevision: source.sourceRevision,
          fingerprint: source.fingerprint,
          version: source.version,
          locale: target.locale,
          markdown: parsed.markdown,
          messages: [
            ...messages,
            { id: `${operationId}:assistant`, role: "assistant", content: parsed.reply },
          ],
          updatedAt: (dependencies.now?.() ?? new Date()).toISOString(),
          revision: operationId,
          sourcePaths: source.documents.map((document) => document.path),
          diagnostics: source.diagnostics,
          providerId: result.selection.providerId,
          modelId: result.selection.modelId,
          selection: result.selection,
        });
        pendingSaves.set(key, { document, baseRevision: saved?.revision ?? null });
        publish(target, {
          phase: "saving",
          messages: document.messages,
          previewMarkdown: document.markdown,
          previewReply: parsed.reply,
        });
        try {
          await dependencies.repository.save(target, document);
        } catch (error) {
          return publish(target, {
            phase: "unsaved",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        pendingSaves.delete(key);
        return ready(target, document, source);
      });
    } catch (error) {
      return publish(target, {
        phase: signal.aborted ? "cancelled" : "error",
        error: signal.aborted ? undefined : error instanceof Error ? error.message : String(error),
      });
    }
  }

  function generate(raw: PluginGuideGenerateParams): Promise<PluginGuideSnapshot> {
    const input = pluginGuideGenerateParamsSchema.parse(raw);
    if (disposed) return Promise.reject(new Error("Plugin guide service has been disposed"));
    const key = pluginGuideTargetKey(input.target);
    const existing = operations.get(key);
    if (existing) {
      if (existing.operationId === input.operationId || (!input.question && !input.regenerate))
        return existing.promise;
      return Promise.reject(
        new Error("A guide request is already running. Stop it before sending another question."),
      );
    }
    if (pendingSaves.has(key))
      return Promise.reject(new Error("Save the completed guide before asking another question."));
    const controller = new AbortController();
    const { promise, resolve, reject } = Promise.withResolvers<PluginGuideSnapshot>();
    const operation = {
      operationId: input.operationId,
      question: input.question,
      regenerate: input.regenerate,
      controller,
      promise,
    };
    operations.set(key, operation);
    // 完成结果返回前先释放占位，避免用户立即追问仍被上一轮标成忙碌。
    void run(input, controller).then(
      (snapshot) => {
        if (operations.get(key) === operation) operations.delete(key);
        resolve(snapshot);
      },
      (error: unknown) => {
        if (operations.get(key) === operation) operations.delete(key);
        reject(error);
      },
    );
    return promise;
  }

  return {
    onDidChange: changes.event,
    read,
    generate,
    async cancel({ target: input, operationId }) {
      const target = pluginGuideTargetSchema.parse(input);
      const operation = operations.get(pluginGuideTargetKey(target));
      if (operation?.operationId === operationId && current(target).phase !== "saving")
        operation.controller.abort(
          new DOMException("Plugin guide generation cancelled", "AbortError"),
        );
    },
    async retrySave(input) {
      const target = pluginGuideTargetSchema.parse(input);
      const key = pluginGuideTargetKey(target);
      const pending = pendingSaves.get(key);
      if (!pending) return current(target);
      try {
        return await dependencies.repository.withLock(pending.document, target.locale, async () => {
          const latest = await dependencies.repository.read(pending.document, target.locale);
          // 另一窗口已成功保存新版时载入它，解除待保存状态，避免重试永远卡在冲突。
          if (
            latest &&
            latest.revision !== pending.document.revision &&
            latest.revision !== pending.baseRevision
          ) {
            pendingSaves.delete(key);
            ready(target, latest, sources.get(key));
            return publish(target, {
              error:
                target.locale === "zh-CN"
                  ? "另一窗口已保存新的说明，已载入该版本。请检查后重新提问。"
                  : "A newer guide from another window has been loaded. Review it before asking again.",
            });
          }
          if (!latest && pending.baseRevision !== null)
            throw new Error(
              "The saved guide was removed while saving. The unsaved revision has been kept.",
            );
          publish(target, { phase: "saving", error: undefined });
          await dependencies.repository.save(target, pending.document);
          pendingSaves.delete(key);
          return ready(target, pending.document, sources.get(key));
        });
      } catch (error) {
        return publish(target, {
          phase: "unsaved",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    dispose() {
      disposed = true;
      for (const operation of operations.values())
        operation.controller.abort(new DOMException("Plugin guide Host disposed", "AbortError"));
      changes.dispose();
    },
  };
}
