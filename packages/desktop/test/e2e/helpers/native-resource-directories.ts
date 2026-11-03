import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export function nativeResourceAcceptancePaths(
  home: string,
  appRoot: string,
  workspace: string,
  directoryName: string,
) {
  const oldUserConfigBytes = JSON.stringify({
    mcp: { servers: { "old-user": { command: "node", args: ["--version"], enabled: false } } },
  });
  const oldProjectConfigBytes = JSON.stringify({
    mcp: { servers: { "old-project": { command: "node", args: ["--version"], enabled: false } } },
  });
  const fakePluginInventoryBytes = JSON.stringify({
    version: 1,
    plugins: [
      {
        id: "ncr-fake-plugin@ncr-fake-market",
        name: "ncr-fake-plugin",
        marketplace: "ncr-fake-market",
        version: "1.0.0",
        scope: "user",
        installPath: join(
          home,
          directoryName,
          "cli/plugins/cache/ncr-fake-market/ncr-fake-plugin/1.0.0",
        ),
      },
    ],
  });
  return {
    home,
    appRoot,
    workspace,
    directoryName,
    userConfig: join(home, directoryName, "cli/config.json"),
    projectConfig: join(workspace, directoryName, "config.json"),
    oldUserConfig: join(home, ".zcode/cli/config.json"),
    oldProjectConfig: join(workspace, ".zcode/config.json"),
    oldUserConfigBytes,
    oldProjectConfigBytes,
    userAgents: join(home, directoryName, "AGENTS.md"),
    oldUserAgents: join(home, ".zcode/AGENTS.md"),
    userWorkflows: join(home, directoryName, "workflows"),
    projectWorkflows: join(workspace, directoryName, "workflows"),
    settings: join(appRoot, ".zcode/v2/setting.json"),
    sidecar: join(appRoot, ".zcode/v2/setting.json.aiscoo-cli-root.json"),
    indexDb: join(appRoot, ".zcode/v2/tasks-index.sqlite"),
    cliDb: join(appRoot, ".zcode/cli/db/db.sqlite"),
    fakePluginInventory: join(home, directoryName, "cli/plugins/installed_plugins.json"),
    fakePluginInventoryBytes,
  };
}

export function nativeResourceWorkflowSource(description: string) {
  return `/* zcode-workflow\ndescription: ${description}\n*/\nexport default async () => {};\n`;
}

/** 只允许调用专用隔离 wrapper；播种必须早于 Electron Main import。 */
export async function seedNativeResourceAcceptance(
  paths: ReturnType<typeof nativeResourceAcceptancePaths>,
) {
  async function put(path: string, content: string) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, { mode: 0o600 });
  }
  await put(
    paths.userConfig,
    JSON.stringify({
      plugins: { enabledPlugins: { "ncr-fake-plugin@ncr-fake-market": true } },
      mcp: { servers: { "native-user": { command: "node", args: ["--version"], enabled: false } } },
    }),
  );
  await put(
    paths.projectConfig,
    JSON.stringify({
      mcp: {
        servers: { "native-project": { command: "node", args: ["--version"], enabled: false } },
      },
    }),
  );
  await put(paths.oldUserConfig, paths.oldUserConfigBytes);
  await put(paths.oldProjectConfig, paths.oldProjectConfigBytes);
  await put(paths.userAgents, "NCR_SELECTED_USER_AGENTS\n");
  await put(paths.oldUserAgents, "NCR_OLD_USER_AGENTS\n");
  await put(paths.fakePluginInventory, paths.fakePluginInventoryBytes);
  const fakePluginRoot = join(
    paths.home,
    paths.directoryName,
    "cli/plugins/cache/ncr-fake-market/ncr-fake-plugin/1.0.0",
  );
  await put(
    join(fakePluginRoot, ".claude-plugin/plugin.json"),
    JSON.stringify({
      name: "ncr-fake-plugin",
      version: "1.0.0",
      description: "NCR_FAKE_PLUGIN_LIBRARY",
    }),
  );
  await put(
    join(fakePluginRoot, "skills/ncr-fake-library/SKILL.md"),
    "---\nname: ncr-fake-library\ndescription: NCR_FAKE_PLUGIN_LIBRARY\n---\nWrong runtime library canary.\n",
  );
  for (const [base, scope] of [
    [paths.home, "user"],
    [paths.workspace, "project"],
  ] as const) {
    for (const [directory, marker] of [
      [paths.directoryName, "native"],
      [".zcode", "old"],
      [".agents", "compat"],
    ] as const) {
      const root = join(base, directory);
      await put(
        join(root, "skills", `ncr-${marker}-${scope}`, "SKILL.md"),
        `---\nname: ncr-${marker}-${scope}\ndescription: NCR_${marker.toUpperCase()}_SKILL\n---\nSynthetic resource canary.\n`,
      );
      await put(
        join(root, "commands", `ncr-${marker}-${scope}.md`),
        `---\ndescription: NCR_${marker.toUpperCase()}_COMMAND\n---\nSynthetic command canary.\n`,
      );
      if (directory === ".agents") {
        await put(
          join(root, "mcp.json"),
          JSON.stringify({
            mcpServers: {
              [`compat-${scope}`]: { command: "node", args: ["--version"], enabled: false },
            },
          }),
        );
      } else {
        await put(
          join(root, "workflows", `ncr-${marker}-${scope}.dwf.ts`),
          nativeResourceWorkflowSource(`NCR_${marker.toUpperCase()}_WORKFLOW`),
        );
      }
    }
  }
}
