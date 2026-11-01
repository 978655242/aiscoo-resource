import { useEffect, useMemo, useRef, useState } from "react";
import type { IPluginGuideService } from "./contract.js";
import type { ModelSelection } from "@zcode/shared";
import {
  pluginGuideTargetKey,
  pluginGuideChangeSchema,
  type PluginGuideChange,
  type PluginGuideSnapshot,
  type PluginGuideTarget,
} from "@zcode/shared/aiscoo-plugin-guides";
import type { PluginGuideProjection } from "./contract.js";

function targetRoute(target: PluginGuideTarget | null): string {
  return JSON.stringify(
    target
      ? [
          target.workspacePath,
          target.workspaceIdentity?.trim() || target.workspacePath,
          target.remoteSessionId ?? null,
          target.marketplace,
          target.pluginName,
          target.locale,
          target.version ?? null,
        ]
      : null,
  );
}

export function usePluginGuide(
  service: IPluginGuideService | null | undefined,
  target: PluginGuideTarget | null,
): PluginGuideProjection {
  const route = targetRoute(target);
  const {
    workspacePath,
    workspaceIdentity,
    remoteSessionId,
    marketplace,
    pluginName,
    locale,
    version,
  } = target ?? {};
  const selected = useMemo<PluginGuideTarget | null>(
    () =>
      workspacePath && marketplace && pluginName && locale
        ? {
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            ...(remoteSessionId ? { remoteSessionId } : {}),
            marketplace,
            pluginName,
            locale,
            ...(version ? { version } : {}),
          }
        : null,
    [workspacePath, workspaceIdentity, remoteSessionId, marketplace, pluginName, locale, version],
  );
  const [state, setState] = useState<{
    service: typeof service;
    route: string;
    snapshot: PluginGuideSnapshot | null;
    error: string | null;
    loading: boolean;
  }>({ service, route, snapshot: null, error: null, loading: Boolean(service && selected) });
  const commands = useRef<Pick<
    PluginGuideProjection,
    "generate" | "stop" | "retrySave" | "retryRead"
  > | null>(null);

  useEffect(() => {
    let active = true;
    let latest: PluginGuideSnapshot | null = null;
    let pending = false;
    let error: string | null = null;
    const publish = (loading = false) => {
      if (active) setState({ service, route, snapshot: latest, error, loading });
    };
    const accept = (raw: PluginGuideChange) => {
      const parsed = pluginGuideChangeSchema.safeParse(raw);
      if (!parsed.success) {
        fail(new Error("The Host returned an invalid plugin guide state."));
        return false;
      }
      const value = parsed.data;
      if (
        !active ||
        !selected ||
        value.key !== pluginGuideTargetKey(selected) ||
        targetRoute(value.target) !== route ||
        (latest && value.sequence < latest.sequence)
      )
        return false;
      if ("type" in value) {
        if (latest && value.sequence <= latest.sequence) return false;
        if (
          !latest ||
          latest.operationId !== value.operationId ||
          value.sequence !== latest.sequence + 1
        ) {
          // 重连或漏增量时从同一 Host 重读快照，绝不重新生成或拼接不完整的正文。
          void read();
          return false;
        }
        latest = {
          ...latest,
          sequence: value.sequence,
          previewMarkdown: latest.previewMarkdown + value.markdownDelta,
          previewReply: latest.previewReply + value.replyDelta,
        };
      } else latest = value;
      error = null;
      publish();
      return true;
    };
    const fail = (reason: unknown) => {
      if (!active) return;
      error = reason instanceof Error ? reason.message : String(reason);
      publish();
    };
    const generate = async (
      question?: string,
      regenerate?: boolean,
      selection?: ModelSelection,
    ) => {
      if (
        !active ||
        !service ||
        !selected ||
        pending ||
        latest?.phase === "generating" ||
        latest?.phase === "saving" ||
        latest?.phase === "unsaved"
      )
        return false;
      pending = true;
      error = null;
      publish(true);
      try {
        const result = await service.generate({
          target: selected,
          operationId: crypto.randomUUID(),
          ...(question ? { question: question.trim() } : {}),
          ...(regenerate ? { regenerate: true } : {}),
          ...(selection ? { selection } : {}),
        });
        const accepted = accept(result);
        return active && accepted && (result.phase === "ready" || result.phase === "unsaved");
      } catch (reason) {
        fail(reason);
        return false;
      } finally {
        pending = false;
        if (active) publish();
      }
    };
    const read = async () => {
      if (!service || !selected) return;
      publish(true);
      try {
        const value = await service.read(selected);
        if (accept(value) && latest?.phase === "idle" && latest.document === null) await generate();
      } catch (reason) {
        fail(reason);
      }
    };
    commands.current = {
      generate,
      retryRead: read,
      stop: async () => {
        if (!active || !service || !selected || !latest?.operationId) return;
        try {
          await service.cancel({ target: selected, operationId: latest.operationId });
        } catch (reason) {
          fail(reason);
        }
      },
      retrySave: async () => {
        if (!active || !service || !selected || pending) return;
        pending = true;
        publish(true);
        try {
          accept(await service.retrySave(selected));
        } catch (reason) {
          fail(reason);
        } finally {
          pending = false;
          if (active) publish();
        }
      },
    };
    // Subscribe first: an in-flight Host operation may advance before read resolves.
    const subscription = service && selected ? service.onDidChange(accept) : null;
    publish(Boolean(service && selected));
    void read();
    return () => {
      active = false;
      subscription?.dispose();
      commands.current = null;
      // Navigation only detaches this projection; the Host keeps generating/saving.
    };
  }, [service, selected, route]);

  const current = state.service === service && state.route === route ? state : null;
  return {
    snapshot: current?.snapshot ?? null,
    error: current?.error ?? null,
    loading: current?.loading ?? Boolean(service && selected),
    generate: (question, regenerate, selection) =>
      commands.current?.generate(question, regenerate, selection) ?? Promise.resolve(false),
    stop: () => commands.current?.stop() ?? Promise.resolve(),
    retrySave: () => commands.current?.retrySave() ?? Promise.resolve(),
    retryRead: () => commands.current?.retryRead() ?? Promise.resolve(),
  };
}
