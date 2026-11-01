import { readPluginGuideSource } from "@zcode/adapters/plugins";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import { streamWorkspaceModelText } from "@zcode/core";
import { zcodeProtocolNotifications, zcodeWorkspaceGenerateTextResultSchema } from "@zcode/shared";
import {
  pluginGuideSourceParamsSchema,
  pluginGuideSourceSchema,
  pluginGuideStreamTextParamsSchema,
  pluginGuideTextDeltaSchema,
} from "@zcode/shared/aiscoo-plugin-guides";
import { getCliStorageRoot, getPluginStorageRoot } from "../app/paths.js";
import { withPluginStorageLock } from "../lib/plugin-storage-lock.js";
import {
  parseParams,
  type ZCodeProtocolAgentServerContext,
} from "../zcode-protocol/server-types.js";
import { createWorkspaceZCodeApp } from "../zcode-protocol/workspace-model-runtime.js";

export async function readPluginSource(
  _context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(pluginGuideSourceParamsSchema, rawParams);
  const config = createConfig({ workingDirectory: params.workspace.workspacePath });
  const storageRoot = getPluginStorageRoot(
    getCliStorageRoot(resolvePath(config.config.storage.dir)),
  );
  const source = await readPluginGuideSource({
    storageRoot,
    marketplace: params.marketplace,
    name: params.pluginName,
    mode: params.mode,
    withWriteLock: (write) => withPluginStorageLock(storageRoot, write),
  });
  return pluginGuideSourceSchema.parse(source);
}

export async function streamWorkspaceText(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
  abortSignal?: AbortSignal,
) {
  const params = parseParams(pluginGuideStreamTextParamsSchema, rawParams);
  abortSignal?.throwIfAborted();
  const identity = params.workspace.workspaceIdentity?.trim() || params.workspace.workspacePath;
  const active = Array.from(context.sessions.values()).find(
    (record) =>
      record.workspace.workspaceKey === params.workspace.workspaceKey &&
      (record.workspace.workspaceIdentity?.trim() || record.workspace.workspacePath) === identity &&
      record.workspace.remoteSessionId === params.workspace.remoteSessionId,
  );
  const app =
    active?.app ??
    (await createWorkspaceZCodeApp(context, params.workspace, {
      env: context.deps.env,
      eventStore: context.deps.createSessionEventStore("workspace-stream-text"),
      runtimeConfig: { workingDirectory: params.workspace.workspacePath },
      sessionStore: context.deps.sessionStore,
      version: context.deps.version,
    }));
  let sequence = 0;
  try {
    const result = await streamWorkspaceModelText(
      app.runtime,
      {
        selection: params.selection,
        ...(params.prompt ? { prompt: params.prompt } : {}),
        ...(params.messages ? { messages: params.messages } : {}),
        ...(params.tools ? { tools: params.tools } : {}),
        querySource: params.querySource,
        ...(params.maxOutputTokens === undefined
          ? {}
          : { maxOutputTokens: params.maxOutputTokens }),
      },
      {
        abortSignal,
        onDelta: (text) => {
          abortSignal?.throwIfAborted();
          context.notify({
            method: zcodeProtocolNotifications.xworkWorkspaceTextDelta,
            params: pluginGuideTextDeltaSchema.parse({
              operationId: params.operationId,
              sequence: ++sequence,
              text,
            }),
          });
        },
      },
    );
    return zcodeWorkspaceGenerateTextResultSchema.parse(result);
  } finally {
    if (!active) await app.close?.();
  }
}
