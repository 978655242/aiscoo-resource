// XCODE: 合成 HOME / 项目 / 运行时根回归，不读写真实用户资源。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createAgentStateId } from "@zcode/shared";
import type { ModelRequest } from "@zcode/contracts";
import { resolveNativeResourceDirectoryPolicy } from "@zcode/shared/native-resource-directories";
import { createConfig } from "@zcode/adapters/config";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  listSavedWorkflows,
  resolveSavedWorkflow,
  saveSavedWorkflow,
  serializeSavedWorkflow,
} from "@zcode/core";
import { listZCodeSkills, inspectZCodeSkill } from "../src/skills.js";
import { listZCodeCustomCommands, inspectZCodeCustomCommand } from "../src/custom-commands.js";
import { setZCodePluginEnabled, isWorkspacePluginConfigPath } from "../src/plugins.js";
import { loadZCodeAgentProfiles } from "../src/subagents.js";
import { createWorkspaceMcpTrust } from "../src/workspace-mcp-trust/index.js";
import {
  inspectWorkspaceHookTrust,
  grantWorkspaceHookTrust,
} from "../src/workspace-hook-trust-cli.js";
import { createWorkspaceHookReviewMutationPort } from "../src/app/workspace-hook-review-mutation.js";
import { getSkillReferenceCatalog } from "../src/zcode-protocol/skill-reference-catalog.js";
import {
  listSavedWorkflowsOp,
  getSavedWorkflowOp,
  moveSavedWorkflowOp,
} from "../src/zcode-protocol/saved-workflows.js";
import { createWorkflowChildSkillPort } from "../src/app/script-workflow-child-runtime.js";
import { inferScriptWorkflowScope } from "../src/app/script-workflow-utils.js";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

let root: string;
let home: string;
let workspace: string;
let storage: string;
let env: NodeJS.ProcessEnv;
const nativeDirectories = resolveNativeResourceDirectoryPolicy({ productDirectoryName: ".aiscoo" });
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};
const loggerFactory = { createLogger: () => logger };
const script = 'const worker = agent("fixture"); return await worker.ask<string>("inspect");';
async function put(path: string, content: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
}
function context(): ZCodeProtocolAgentServerContext {
  return {
    deps: { env, nativeDirectories },
    logger,
    sessions: new Map(),
  } as unknown as ZCodeProtocolAgentServerContext;
}
function workspaceRef() {
  return { workspacePath: workspace, workspaceKey: workspace };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "native-bootstrap-aiscoo-"));
  home = join(root, "home");
  workspace = join(root, "repo");
  storage = join(root, "runtime");
  await mkdir(home);
  await mkdir(workspace);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  env = {
    HOME: home,
    USERPROFILE: home,
    ZCODE_STORAGE_DIR: storage,
    ZCODE_NATIVE_RESOURCE_DIR_NAME: ".aiscoo",
  };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function seedResources() {
  for (const [dir, name] of [
    [".aiscoo", "selected"],
    [".zcode", "old"],
    [".agents", "compatible"],
  ]) {
    await put(
      join(home, dir!, "skills", name!, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} skill\n---\n${name} skill body`,
    );
    await put(join(workspace, dir!, "commands", `${name}.md`), `${name} command body`);
  }
}

describe("bootstrap native resource boundaries", () => {
  it("uses one selected scope for list, inspect, draft catalog and workflow-child default adapters", async () => {
    await seedResources();
    const options = { env, logger, nativeDirectories, workingDirectory: workspace };
    const skills = await listZCodeSkills(options);
    expect(skills.skills.map((item) => item.name)).toEqual(
      expect.arrayContaining(["selected", "compatible"]),
    );
    expect(skills.skills.map((item) => item.name)).not.toContain("old");
    expect((await inspectZCodeSkill({ ...options, name: "selected" })).skill.content).toBe(
      "selected skill body",
    );
    const commands = await listZCodeCustomCommands(options);
    expect(
      commands.commands.filter((item) => item.source !== "plugin").map((item) => item.name),
    ).toEqual(["compatible", "selected"]);
    expect(
      (await inspectZCodeCustomCommand({ ...options, name: "selected" })).command.content,
    ).toBe("selected command body");
    const draft = await getSkillReferenceCatalog(context(), { workspace: workspaceRef() });
    expect(draft.skills.map((item) => item.name)).toContain("selected");
    expect(draft.skills.map((item) => item.name)).not.toContain("old");
    const child = createWorkflowChildSkillPort({
      appOptions: { nativeDirectories },
      configResult: createConfig({ env, nativeDirectories, loggerFactory }),
      pluginSkillRoots: [],
    });
    expect(
      (await child!.discoverSkills({ workingDirectory: workspace })).skills.map(
        (item) => item.name,
      ),
    ).toEqual(["compatible", "selected"]);
    const injected = { discoverSkills: vi.fn(), loadSkill: vi.fn() };
    expect(
      createWorkflowChildSkillPort({
        appOptions: { nativeDirectories, skillPort: injected },
        configResult: createConfig({ env, nativeDirectories, loggerFactory }),
        pluginSkillRoots: [],
      }),
    ).toBe(injected);
  });

  it("writes workspace plugin configuration only to selected native root and preserves plugin inventory root", async () => {
    const plugin = join(root, "inline-plugin");
    await put(join(plugin, ".zcode-plugin", "plugin.json"), {
      name: "fixture",
      version: "1.0.0",
      description: "fixture",
    });
    await put(join(home, ".aiscoo", "cli", "config.json"), { plugins: { dirs: [plugin] } });
    await put(join(workspace, ".zcode", "config.json"), {
      plugins: { enabledPlugins: { fixture: false } },
    });
    const patched = await setZCodePluginEnabled({
      env,
      nativeDirectories,
      logger,
      workingDirectory: workspace,
      plugin: "fixture",
      enabled: true,
      scope: "workspace",
    });
    expect(patched.path).toBe(join(workspace, ".aiscoo", "config.json"));
    expect(
      JSON.parse(await readFile(patched.path, "utf8")).plugins.enabledPlugins[patched.plugin.id],
    ).toBe(true);
    expect(
      JSON.parse(await readFile(join(workspace, ".zcode", "config.json"), "utf8")).plugins
        .enabledPlugins.fixture,
    ).toBe(false);
    expect(createConfig({ env, nativeDirectories, loggerFactory }).config.storage.dir).toBe(
      storage,
    );
    expect(isWorkspacePluginConfigPath(patched.path, "darwin", nativeDirectories)).toBe(true);
    expect(
      isWorkspacePluginConfigPath("C:\\repo\\.aiscoo\\config.json", "win32", nativeDirectories),
    ).toBe(true);
    expect(
      isWorkspacePluginConfigPath(
        join(workspace, ".zcode", "config.json"),
        "darwin",
        nativeDirectories,
      ),
    ).toBe(false);
  });

  it("loads selected agent definitions and resource state without migrating old native files", async () => {
    const profile = (name: string) => `---\nname: ${name}\ndescription: fixture\n---\nReview`;
    const selected = join(home, ".aiscoo");
    const oldState = join(home, ".zcode", "v2", "agents-state.json");
    await put(join(home, ".zcode", "agents", "old.md"), profile("old"));
    await put(oldState, { builtInModelOverrides: { Explore: "builtin:zai-coding-plan/glm" } });
    await put(join(selected, "agents", "selected.md"), profile("selected"));
    await put(join(selected, "agents", "disabled.md"), profile("disabled"));
    await put(join(selected, "v2", "agents-state.json"), {
      disabledAgentIds: [createAgentStateId({ name: "disabled", scope: "user", source: "user" })],
    });
    await put(join(workspace, ".aiscoo", "agents", "project.md"), profile("project"));
    const before = await readFile(oldState, "utf8");
    const result = await loadZCodeAgentProfiles({
      nativeDirectories,
      storageRoot: selected,
      workingDirectory: workspace,
    });
    expect(result.profiles.map((item) => item.name)).toEqual(
      expect.arrayContaining(["selected", "project"]),
    );
    expect(result.profiles.map((item) => item.name)).not.toContain("old");
    expect(result.profiles.map((item) => item.name)).not.toContain("disabled");
    expect(await readFile(oldState, "utf8")).toBe(before);
  });

  it("keeps MCP grant, stale-digest rejection and .agents fallback inside the selected resource domain", async () => {
    const path = join(workspace, ".aiscoo", "config.json");
    const server = { type: "stdio", command: "node", cwd: "./tools" };
    await put(path, { mcp: { servers: { selected: server } } });
    await put(join(workspace, ".zcode", "config.json"), { mcp: { servers: { old: server } } });
    const trust = createWorkspaceMcpTrust({
      env,
      nativeDirectories,
      workingDirectory: workspace,
      loggerFactory,
    });
    const review = await trust.inspect();
    expect(Object.keys(review)).toEqual(["selected"]);
    expect(review.selected!.trusted).toBe(false);
    await trust.decide("selected", review.selected!.declarationDigest, true);
    expect((await trust.inspect()).selected!.trusted).toBe(true);
    expect(
      await readFile(join(home, ".aiscoo", "security", "workspace-mcp-trust-v1.json"), "utf8"),
    ).toContain("selected");
    await put(path, { mcp: { servers: { selected: { ...server, args: ["changed"] } } } });
    expect((await trust.inspect()).selected!.trusted).toBe(false);
    await expect(
      trust.decide("selected", review.selected!.declarationDigest, true),
    ).rejects.toThrow("workspace_mcp_declaration_changed");
    await put(path, { mcp: { servers: {} } });
    await put(join(workspace, ".agents", "mcp.json"), { mcpServers: { compatible: server } });
    expect(Object.keys(await trust.inspect())).toEqual(["compatible"]);
  });

  it("uses matching Hook discovery, trust and reviewed mutation targets", async () => {
    const path = join(workspace, ".aiscoo", "config.json");
    const hooks = {
      enabled: true,
      events: { SessionStart: [{ hooks: [{ type: "command", command: "echo selected" }] }] },
    };
    await put(path, { hooks });
    await put(join(workspace, ".zcode", "config.json"), {
      hooks: { events: { SessionStart: [{ hooks: [{ type: "command", command: "echo old" }] }] } },
    });
    const target = { workspacePath: workspace, nativeDirectories };
    const before = await inspectWorkspaceHookTrust(target);
    expect(before.items).toHaveLength(1);
    expect(before.items[0]?.displayCommand).toContain("selected");
    const granted = await grantWorkspaceHookTrust({
      ...target,
      allCurrent: true,
      bundleDigest: before.bundleDigest!,
    });
    expect(granted.reasonCode).toBe("workspace_hooks_trusted_persistent");
    const config = createConfig({
      env,
      nativeDirectories,
      workingDirectory: workspace,
      loggerFactory,
    });
    const mutation = createWorkspaceHookReviewMutationPort({
      nativeDirectories,
      workingDirectory: workspace,
      workspaceIdentity: workspace,
      runtimeRoot: config.sources.project.workspaceHookRuntimeRoot!,
    });
    const snapshot = config.sources.project.workspaceHookSnapshot!;
    await mutation.toggle(
      { snapshot, reviewItemId: snapshot.hooks[0]!.reviewItemId, enabled: false },
      async () => {},
    );
    expect(
      JSON.parse(await readFile(path, "utf8")).hooks.events.SessionStart[0].hooks[0].enabled,
    ).toBe(false);
    expect(await readFile(join(workspace, ".zcode", "config.json"), "utf8")).toContain("echo old");
  });

  it("saves, lists, gets and moves definitions in selected roots while legacy scope classification agrees", async () => {
    const meta = { description: "fixture" };
    await put(
      join(workspace, ".zcode", "workflows", "old.dwf.ts"),
      serializeSavedWorkflow(meta, script),
    );
    const selected = saveSavedWorkflow({
      cwd: workspace,
      name: "selected",
      meta,
      script,
      nativeDirectories,
    });
    expect(selected.path).toBe(join(workspace, ".aiscoo", "workflows", "selected.dwf.ts"));
    expect(
      listSavedWorkflows({ cwd: workspace, nativeDirectories }).entries.map((item) => item.name),
    ).toEqual(["selected"]);
    expect(resolveSavedWorkflow({ cwd: workspace, name: "old", nativeDirectories }).ok).toBe(false);
    const listed = await listSavedWorkflowsOp(context(), { workspace: workspaceRef() });
    expect(listed.dir).toBe(join(workspace, ".aiscoo", "workflows"));
    expect(listed.workflows.map((item) => item.name)).toEqual(["selected"]);
    expect(
      (await getSavedWorkflowOp(context(), { workspace: workspaceRef(), name: "selected" })).ok,
    ).toBe(true);
    saveSavedWorkflow({
      cwd: workspace,
      name: "global",
      meta,
      script,
      scope: "global",
      nativeDirectories,
    });
    expect(
      (await moveSavedWorkflowOp(context(), { workspace: workspaceRef(), name: "global" })).ok,
    ).toBe(true);
    expect(inferScriptWorkflowScope(selected.path, workspace, nativeDirectories)).toBe("project");
    expect(
      inferScriptWorkflowScope(
        join(home, ".aiscoo", "workflows", "a.workflow.js"),
        workspace,
        nativeDirectories,
      ),
    ).toBe("user");
    expect(
      inferScriptWorkflowScope(
        join(workspace, ".zcode", "workflows", "a.workflow.js"),
        workspace,
        nativeDirectories,
      ),
    ).toBe("explicit");
  });

  // XCODE: .zcode 必须保留上游合并 storage 根的优先级，不能被 raw 用户来源重新覆盖。
  it.each([
    ["generic default", undefined],
    ["explicit .zcode", ".zcode"],
  ])(
    "%s keeps the merged agents root when env storage overrides user storage",
    async (_label, directoryName) => {
      const userStorageRoot = join(root, "user-storage-a");
      const appEnv = { ...env, ZCODE_NATIVE_RESOURCE_DIR_NAME: directoryName };
      const policy = resolveNativeResourceDirectoryPolicy({ env: appEnv });
      await put(join(home, ".zcode", "cli", "config.json"), {
        storage: { dir: userStorageRoot },
      });
      const profile = (name: string) =>
        `---\nname: ${name}\ndescription: fixture profile\n---\nReview`;
      await put(join(userStorageRoot, "agents", "user.md"), profile("user_storage_agent"));
      await put(join(storage, "agents", "merged.md"), profile("merged_storage_agent"));
      await put(join(storage, "agents", "disabled.md"), profile("disabled_by_merged_state"));
      const statePath = (base: string) => join(base, "v2", "agents-state.json");
      await put(statePath(userStorageRoot), {
        disabledAgentIds: [
          createAgentStateId({ name: "merged_storage_agent", scope: "user", source: "user" }),
        ],
      });
      await put(statePath(storage), {
        disabledAgentIds: [
          createAgentStateId({ name: "disabled_by_merged_state", scope: "user", source: "user" }),
        ],
      });
      const originalUserState = await readFile(statePath(userStorageRoot), "utf8");
      const config = createConfig({ env: appEnv, nativeDirectories: policy, loggerFactory });
      expect(config.sources.user.storageDir).toBe(userStorageRoot);
      expect(config.config.storage.dir).toBe(storage);
      const store = await createSqliteSessionStore({ dbPath: ":memory:" });
      const requests: string[] = [];
      let app: Awaited<ReturnType<typeof createRegistryBackedTestApp>> | undefined;
      try {
        app = await createRegistryBackedTestApp({
          env: appEnv,
          loggerFactory,
          sessionStore: store,
          runtimeConfig: {
            workingDirectory: workspace,
            mcp: { enabled: false },
            modelSelection: {
              providerId: "zai",
              modelId: "glm-4.6",
              options: { reasoningLevel: "high" },
            },
            memory: { enabled: false },
          },
          modelExecutor: {
            generateText: async (request: ModelRequest) => {
              requests.push(JSON.stringify(request));
              return {
                text: "done",
                finishReason: "stop",
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              };
            },
          },
        });
        await app.submitPrompt("fixture");
        expect(requests.join("\n").includes("merged_storage_agent")).toBe(true);
        expect(requests.join("\n").includes("user_storage_agent")).toBe(false);
        expect(requests.join("\n").includes("disabled_by_merged_state")).toBe(false);
        expect(await readFile(statePath(userStorageRoot), "utf8")).toBe(originalUserState);
      } finally {
        await app?.close();
        store.close();
      }
    },
    30_000,
  );

  it.each([false, true])(
    "main app and cold resume preserve selected resources and explicit user storage=%s",
    async (explicitStorage) => {
      await seedResources();
      const explicitUserRoot = join(root, "explicit-user-resources");
      if (explicitStorage)
        await put(join(home, ".aiscoo", "cli", "config.json"), {
          storage: { dir: explicitUserRoot },
        });
      const profile = (name: string) =>
        `---\nname: ${name}\ndescription: fixture profile\n---\nReview`;
      await put(join(home, ".aiscoo", "agents", "native.md"), profile("native_resource_agent"));
      await put(join(explicitUserRoot, "agents", "explicit.md"), profile("explicit_user_agent"));
      await put(join(storage, "agents", "runtime.md"), profile("runtime_agent_canary"));
      const dbPath = join(storage, "sessions.sqlite");
      await put(join(home, ".aiscoo", "AGENTS.md"), "selected instruction canary");
      await put(join(home, ".zcode", "AGENTS.md"), "old instruction canary");
      const store = await createSqliteSessionStore({ dbPath });
      const requests: string[] = [];
      const options = {
        env,
        loggerFactory,
        sessionStore: store,
        runtimeConfig: {
          workingDirectory: workspace,
          mcp: { enabled: false },
          modelSelection: {
            providerId: "zai",
            modelId: "glm-4.6",
            options: { reasoningLevel: "high" as const },
          },
          memory: { enabled: false },
        },
        modelExecutor: {
          generateText: async (request: ModelRequest) => {
            requests.push(JSON.stringify(request));
            return {
              text: "done",
              finishReason: "stop" as const,
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            };
          },
        },
      };
      const app = await createRegistryBackedTestApp(options);
      try {
        expect((await app.getSkillCatalog()).skills.map((item) => item.name)).toContain("selected");
        await app.submitPrompt("fixture");
        expect(requests.join("\n")).toContain(
          explicitStorage ? "explicit_user_agent" : "native_resource_agent",
        );
        expect(requests.join("\n")).not.toContain("runtime_agent_canary");
        expect(requests.join("\n")).toContain("selected instruction canary");
        expect(requests.join("\n")).not.toContain("old instruction canary");
        env.ZCODE_NATIVE_RESOURCE_DIR_NAME = ".zcode";
        expect((await app.getSkillCatalog()).skills.map((item) => item.name)).not.toContain("old");
        env.ZCODE_NATIVE_RESOURCE_DIR_NAME = ".aiscoo";
        const id = app.sessionId;
        await app.close();
        const resumed = await createRegistryBackedTestApp({
          ...options,
          sessionId: id,
          resume: true,
        });
        try {
          expect((await resumed.getSkillCatalog()).skills.map((item) => item.name)).not.toContain(
            "old",
          );
          expect(createConfig({ env, nativeDirectories, loggerFactory }).config.storage.dir).toBe(
            storage,
          );
        } finally {
          await resumed.close();
        }
      } finally {
        await app.close();
        store.close();
      }
    },
    30_000,
  );
});
