// XCODE: 管理入口固定原生资源策略，并与运行时插件库存根分离。
import {
  resolveNativeResourceDirectoryPolicy,
  type NativeResourceDirectoryPolicy,
} from "@zcode/shared/native-resource-directories";
import { resolve } from "node:path";
import { createConfig, resolvePath } from "@zcode/adapters/config";
import { createNodeSkillAdapter } from "@zcode/adapters/skills";
import type { Logger, SkillContent, SkillDiagnostic, SkillLoadOutcome } from "@zcode/contracts";
import { resolveBundledSkillRoots } from "./app/bundled-skills.js";
import { getCliStorageRoot } from "./app/paths.js";
import { filterVisualizeSkillRoots } from "./app/visualize-skill-gate.js";
import { resolveZCodePlugins } from "./plugins.js";
import { collectDisabledPaths } from "./skill-command-overrides.js";

export interface ListZCodeSkillsOptions {
  nativeDirectories?: NativeResourceDirectoryPolicy;
  additionalDirectories?: readonly string[];
  homeDirectory?: string;
  pluginStorageRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** 协议宿主草稿目录使用；CLI 命令缺省关闭。 */
  includeVisualize?: boolean;
  logger?: Logger;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  workingDirectory?: string;
}

export interface InspectZCodeSkillOptions extends ListZCodeSkillsOptions {
  name: string;
}

export interface ZCodeSkillInspection {
  diagnostics: SkillDiagnostic[];
  skill: SkillContent;
}

export async function listZCodeSkills(
  options: ListZCodeSkillsOptions = {},
): Promise<SkillLoadOutcome> {
  const discovery = createSkillDiscovery(options);
  if (!discovery.enabled) {
    return {
      diagnostics: [],
      skills: [],
      totalDiscovered: 0,
    };
  }

  return await discovery.skillPort.discoverSkills({
    workingDirectory: discovery.workingDirectory,
  });
}

export async function inspectZCodeSkill(
  options: InspectZCodeSkillOptions,
): Promise<ZCodeSkillInspection> {
  const discovery = createSkillDiscovery(options);
  if (!discovery.enabled) {
    throw new Error("Skills are disabled.");
  }

  const outcome = await discovery.skillPort.discoverSkills({
    workingDirectory: discovery.workingDirectory,
  });
  if (
    !outcome.skills.some(
      (skill) => skill.name === options.name || skill.qualifiedName === options.name,
    )
  ) {
    throw new Error(`Skill not found: ${options.name}`);
  }

  const skill = await discovery.skillPort.loadSkill({
    name: options.name,
    workingDirectory: discovery.workingDirectory,
  });

  return {
    diagnostics: outcome.diagnostics,
    skill,
  };
}

function createSkillDiscovery(options: ListZCodeSkillsOptions):
  | {
      enabled: false;
      workingDirectory: string;
    }
  | {
      enabled: true;
      skillPort: ReturnType<typeof createNodeSkillAdapter>;
      workingDirectory: string;
    } {
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

  if (!configResult.config.features.skill || !configResult.config.skills.enabled) {
    return {
      enabled: false,
      workingDirectory,
    };
  }
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

  // 内置技能包与插件技能根并列注入：`zcode skills list`、引用目录与 runtime 看到同一份发现结果。
  const bundledSkillRoots = resolveBundledSkillRoots({
    cliStorageRoot: getCliStorageRoot(resolvePath(configResult.config.storage.dir)),
    logger: options.logger,
  });

  return {
    enabled: true,
    skillPort: createNodeSkillAdapter({
      nativeDirectories: options.nativeDirectories,
      additionalDirectories: options.additionalDirectories,
      homeDirectory: options.homeDirectory,
      extraRoots: configResult.config.skills.roots,
      extraResolvedRoots: [
        ...filterVisualizeSkillRoots(pluginOutcome.skillRoots, options.includeVisualize),
        ...bundledSkillRoots,
      ],
      disabledPaths: collectDisabledPaths(configResult.config.skillOverrides),
    }),
    workingDirectory,
  };
}
