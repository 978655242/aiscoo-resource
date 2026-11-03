// XCODE: 管理入口固定原生资源策略，并与运行时插件库存根分离。
import {
  resolveNativeResourceDirectoryPolicy,
  type NativeResourceDirectoryPolicy,
} from "@zcode/shared/native-resource-directories";
import { resolve } from "node:path";
import { createConfig } from "@zcode/adapters/config";
import { createNodeCustomCommandAdapter } from "@zcode/adapters/commands";
import type {
  CustomCommandContent,
  CustomCommandDiagnostic,
  CustomCommandLoadOutcome,
  Logger,
} from "@zcode/contracts";
import { resolveZCodePlugins } from "./plugins.js";
import { collectDisabledPaths } from "./skill-command-overrides.js";

export interface ListZCodeCustomCommandsOptions {
  nativeDirectories?: NativeResourceDirectoryPolicy;
  pluginStorageRoot?: string;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  logger?: Logger;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  workingDirectory?: string;
  additionalDirectories?: readonly string[];
}

export interface InspectZCodeCustomCommandOptions extends ListZCodeCustomCommandsOptions {
  name: string;
}

export interface ZCodeCustomCommandInspection {
  command: CustomCommandContent;
  diagnostics: CustomCommandDiagnostic[];
}

export async function listZCodeCustomCommands(
  options: ListZCodeCustomCommandsOptions = {},
): Promise<CustomCommandLoadOutcome> {
  const discovery = createCustomCommandDiscovery(options);
  return await discovery.adapter.discoverCommands({
    workingDirectory: discovery.workingDirectory,
  });
}

export async function inspectZCodeCustomCommand(
  options: InspectZCodeCustomCommandOptions,
): Promise<ZCodeCustomCommandInspection> {
  const discovery = createCustomCommandDiscovery(options);
  const workingDirectory = discovery.workingDirectory;
  const adapter = discovery.adapter;
  const outcome = await adapter.discoverCommands({ workingDirectory });
  const normalizedName = normalizeCommandName(options.name);
  if (!outcome.commands.some((command) => command.name === normalizedName)) {
    throw new Error(`Custom command not found: ${options.name}`);
  }

  return {
    command: await adapter.loadCommand({
      name: normalizedName,
      workingDirectory,
    }),
    diagnostics: outcome.diagnostics,
  };
}

export async function loadZCodeCustomCommand(
  options: InspectZCodeCustomCommandOptions,
): Promise<CustomCommandContent> {
  const discovery = createCustomCommandDiscovery(options);
  return await discovery.adapter.loadCommand({
    name: normalizeCommandName(options.name),
    workingDirectory: discovery.workingDirectory,
  });
}

function createCustomCommandDiscovery(options: ListZCodeCustomCommandsOptions) {
  options = {
    ...options,
    nativeDirectories:
      options.nativeDirectories ??
      resolveNativeResourceDirectoryPolicy({ env: options.env ?? process.env }),
  };
  const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
  const configResult = createConfig({
    nativeDirectories: options.nativeDirectories,
    env: options.env,
    projectConfigPath: options.projectConfigPath,
    workingDirectory,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
  });
  const pluginOutcome = resolveZCodePlugins({
    configResult,
    pluginStorageRoot: options.pluginStorageRoot,
    nativeDirectories: options.nativeDirectories,
    env: options.env,
    logger: options.logger,
    projectConfigPath: options.projectConfigPath,
    skipUserConfig: options.skipUserConfig,
    userConfigPath: options.userConfigPath,
    workingDirectory,
  });
  return {
    adapter: createNodeCustomCommandAdapter({
      nativeDirectories: options.nativeDirectories,
      extraResolvedRoots: pluginOutcome.commandRoots,
      disabledPaths: collectDisabledPaths(configResult.config.commandOverrides),
      homeDirectory: options.homeDirectory,
      additionalDirectories: options.additionalDirectories,
    }),
    workingDirectory,
  };
}

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase();
}
