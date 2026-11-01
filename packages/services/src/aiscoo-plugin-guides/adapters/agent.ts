import {
  zcodeProtocolMethods,
  zcodeProtocolNotifications,
  zcodeWorkspaceCancelGenerateTextResultSchema,
  zcodeWorkspaceGenerateTextResultSchema,
  type ZCodeProtocolNotification,
  type ZCodeWorkspaceRef,
} from "@zcode/shared";
import {
  pluginGuideSourceParamsSchema,
  pluginGuideSourceSchema,
  pluginGuideStreamTextParamsSchema,
  pluginGuideTextDeltaSchema,
} from "@zcode/shared/aiscoo-plugin-guides";
import type { ZCodeProtocolClient } from "../../zcode-agent/zcodeProtocolClient.js";
import type { ZCodeAgentWorkspaceTarget } from "../../zcode-agent/zcodeAgent.js";
import { createServiceLogger } from "../../logger/serviceLogger.js";
import type { PluginGuideAgentPort } from "../contract.js";

const GUIDE_REQUEST_DEADLINE_MS = 30 * 60_000;
const GUIDE_CANCEL_BUFFER_MS = 5_000;

interface Dependencies {
  getClient(target: ZCodeAgentWorkspaceTarget): Promise<ZCodeProtocolClient>;
  getPluginManagementClient(): Promise<ZCodeProtocolClient>;
  buildWorkspaceRef(target: ZCodeAgentWorkspaceTarget): ZCodeWorkspaceRef;
  syncAccount(input: {
    client: ZCodeProtocolClient;
    reason: string;
    workspace: ZCodeAgentWorkspaceTarget;
    refreshRegistry: boolean;
  }): Promise<void>;
}
export function createPluginGuideAgentExtension(dependencies: Dependencies) {
  const logger = createServiceLogger("plugin-guide-model");
  const listeners = new Map<
    ZCodeProtocolClient,
    Map<string, { sequence: number; onDelta: (text: string) => void; controller: AbortController }>
  >();
  const methods: PluginGuideAgentPort = {
    async readPluginGuideSource(target) {
      target.signal?.throwIfAborted();
      const client = await dependencies.getPluginManagementClient();
      const controller = new AbortController();
      const signal = target.signal
        ? AbortSignal.any([target.signal, controller.signal])
        : controller.signal;
      const deadline = setTimeout(
        () =>
          controller.abort(
            new DOMException(
              "Plugin guide material reading exceeded its 30-minute deadline",
              "TimeoutError",
            ),
          ),
        GUIDE_REQUEST_DEADLINE_MS,
      );
      try {
        return await client.request(
          zcodeProtocolMethods.xworkPluginGuideSource,
          pluginGuideSourceParamsSchema.parse({
            workspace: dependencies.buildWorkspaceRef(target),
            pluginName: target.pluginName,
            marketplace: target.marketplace,
            mode: target.mode,
          }),
          pluginGuideSourceSchema,
          { signal, timeoutMs: GUIDE_REQUEST_DEADLINE_MS + GUIDE_CANCEL_BUFFER_MS },
        );
      } finally {
        clearTimeout(deadline);
      }
    },
    async streamWorkspaceModelText(input) {
      input.signal.throwIfAborted();
      const client = await dependencies.getClient(input);
      await dependencies.syncAccount({
        client,
        reason: "plugin_usage_guide",
        workspace: input,
        refreshRegistry: true,
      });
      input.signal.throwIfAborted();
      const controller = new AbortController();
      const signal = AbortSignal.any([input.signal, controller.signal]);
      let operations = listeners.get(client);
      if (!operations) {
        operations = new Map();
        listeners.set(client, operations);
      }
      if (operations.has(input.operationId))
        throw new Error("Duplicate plugin guide stream operation ID");
      const listener = { sequence: 0, onDelta: input.onDelta, controller };
      operations.set(input.operationId, listener);
      // 协议 watchdog 会回收整个 workspace；先用说明自身 deadline 取消，再留控制面缓冲。
      const deadline = setTimeout(
        () =>
          controller.abort(
            new DOMException(
              "Plugin guide generation exceeded its 30-minute deadline",
              "TimeoutError",
            ),
          ),
        GUIDE_REQUEST_DEADLINE_MS,
      );
      const cancel = () => {
        void client
          .request(
            zcodeProtocolMethods.workspaceCancelGenerateText,
            { operationId: input.operationId },
            zcodeWorkspaceCancelGenerateTextResultSchema,
            { timeoutMs: 5_000 },
          )
          .catch((error: unknown) =>
            logger.debug(undefined, "说明生成取消通知失败", {
              error: error instanceof Error ? error.message : String(error),
            }),
          );
      };
      signal.addEventListener("abort", cancel, { once: true });
      try {
        return await client.request(
          zcodeProtocolMethods.xworkWorkspaceStreamText,
          pluginGuideStreamTextParamsSchema.parse({
            workspace: dependencies.buildWorkspaceRef(input),
            selection: input.selection,
            messages: input.messages,
            querySource: input.querySource,
            maxOutputTokens: input.maxOutputTokens,
            operationId: input.operationId,
          }),
          zcodeWorkspaceGenerateTextResultSchema,
          { signal, timeoutMs: GUIDE_REQUEST_DEADLINE_MS + GUIDE_CANCEL_BUFFER_MS },
        );
      } finally {
        clearTimeout(deadline);
        signal.removeEventListener("abort", cancel);
        if (operations.get(input.operationId) === listener) operations.delete(input.operationId);
        if (!operations.size) listeners.delete(client);
      }
    },
  };
  return {
    methods,
    accept(client: ZCodeProtocolClient, message: ZCodeProtocolNotification): boolean {
      if (message.method !== zcodeProtocolNotifications.xworkWorkspaceTextDelta) return false;
      const parsed = pluginGuideTextDeltaSchema.safeParse(message.params);
      if (!parsed.success) {
        logger.debug(undefined, "丢弃无效说明正文增量");
        return true;
      }
      const listener = listeners.get(client)?.get(parsed.data.operationId);
      if (!listener || parsed.data.sequence <= listener.sequence) return true;
      if (parsed.data.sequence !== listener.sequence + 1) {
        listener.controller.abort(new Error("Plugin guide stream has a sequence gap"));
        return true;
      }
      listener.sequence = parsed.data.sequence;
      try {
        listener.onDelta(parsed.data.text);
      } catch (error) {
        listener.controller.abort(error);
      }
      return true;
    },
    dispose() {
      for (const operations of listeners.values())
        for (const listener of operations.values())
          listener.controller.abort(new DOMException("Plugin guide agent disposed", "AbortError"));
      listeners.clear();
    },
  };
}
