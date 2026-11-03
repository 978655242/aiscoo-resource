// XCODE: 使用合成 HOME 回归原生资源目录扩展，禁止读取真实用户资源。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DefaultRuntimeConfig } from "@zcode/contracts";
import { resolveNativeResourceDirectoryPolicy } from "@zcode/shared/native-resource-directories";
import { createConfig, getDefaultConfigPath } from "../src/config/index.js";
import { loadProjectConfigs } from "../src/config/project-config.adapter.js";
import { resolveDefaultSkillRoots } from "../src/skills/roots.js";
import { resolveDefaultCustomCommandRoots } from "../src/commands/roots.js";
import { createNodeSkillAdapter } from "../src/skills/index.js";
import { createNodeCustomCommandAdapter } from "../src/commands/index.js";
import { createNodeContextSourceAdapter } from "../src/context/index.js";
import { resolveWorkspaceHookTrustStorePath } from "../src/storage/workspace-hook-trust-store.js";

let root: string;
let home: string;
let workspace: string;
const nativeDirectories = resolveNativeResourceDirectoryPolicy({ productDirectoryName: ".aiscoo" });
const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};
const loggerFactory = { createLogger: () => logger };
async function put(path: string, content: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "native-resource-aiscoo-"));
  home = join(root, "home");
  workspace = join(root, "repo");
  await mkdir(home);
  await mkdir(workspace);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe("native resources remain independent from runtime storage", () => {
  it("preserves generic defaults and uses selected config metadata including skipped explicit paths", async () => {
    await put(join(home, ".zcode", "cli", "config.json"), { skills: { metadataBudget: 123 } });
    await put(join(home, ".aiscoo", "cli", "config.json"), { skills: { metadataBudget: 456 } });
    expect(getDefaultConfigPath()).toBe(join(home, ".zcode", "cli", "config.json"));
    expect(getDefaultConfigPath(nativeDirectories)).toBe(
      join(home, ".aiscoo", "cli", "config.json"),
    );
    expect(createConfig({ env: {}, loggerFactory }).config.skills.metadataBudget).toBe(123);
    const selected = createConfig({ env: {}, loggerFactory, nativeDirectories });
    expect(selected.config.skills.metadataBudget).toBe(456);
    expect(selected.config.storage).toEqual(DefaultRuntimeConfig.storage);
    const explicit = join(root, "explicit", "user.json");
    await put(explicit, { skills: { metadataBudget: 789 } });
    expect(
      createConfig({ env: {}, loggerFactory, nativeDirectories, userConfigPath: explicit }).config
        .skills.metadataBudget,
    ).toBe(789);
    expect(
      createConfig({
        env: {},
        loggerFactory,
        nativeDirectories,
        userConfigPath: explicit,
        skipUserConfig: true,
      }).sources.user,
    ).toMatchObject({ path: explicit, loaded: false });
    expect(
      createConfig({ env: {}, loggerFactory, nativeDirectories, skipUserConfig: true }).sources.user
        .path,
    ).toBe(join(home, ".aiscoo", "cli", "config.json"));
  });

  it("keeps root config ordering, explicit append, selected project baseDir and relative MCP cwd", async () => {
    const child = join(workspace, "src");
    await mkdir(join(workspace, ".git"));
    await mkdir(child);
    await put(join(workspace, "zcode.json"), {
      mcp: { servers: { root: { type: "stdio", command: "node" } } },
    });
    await put(join(workspace, ".zcode", "config.json"), {
      mcp: { servers: { old: { type: "stdio", command: "node" } } },
    });
    const configPath = join(child, ".aiscoo", "config.json");
    await put(configPath, {
      mcp: { servers: { selected: { type: "stdio", command: "node", cwd: "./tools" } } },
    });
    const explicit = join(root, "external.json");
    await put(explicit, { mcp: { servers: { explicit: { type: "stdio", command: "node" } } } });
    const discovery = loadProjectConfigs(child, explicit, { nativeDirectories });
    expect(discovery.paths).toEqual([join(workspace, "zcode.json"), configPath, explicit]);
    expect(discovery.files[1]?.baseDir).toBe(child);
    expect(discovery.files[1]?.config.mcp?.servers?.selected).toMatchObject({
      cwd: join(child, "tools"),
    });
    expect(discovery.mcpServerNames).not.toContain("old");
    const oldExplicit = loadProjectConfigs(child, join(workspace, ".zcode", "config.json"), {
      nativeDirectories,
    });
    expect(oldExplicit.files.at(-1)?.baseDir).toBe(workspace);
    expect(oldExplicit.files.at(-1)?.config.mcp?.servers?.old).toMatchObject({ cwd: workspace });
  });

  it("merges .agents with selected native skill and command roots throughout ancestors and additions", async () => {
    const child = join(workspace, "src");
    const extra = join(root, "extra");
    await mkdir(join(workspace, ".git"));
    await mkdir(child);
    for (const base of [home, workspace, child, extra]) {
      for (const dir of [".aiscoo", ".agents", ".zcode"]) {
        const name = `${dirname(base) === root ? base.split(/[\\/]/u).at(-1) : "child"}-${dir.slice(1)}`;
        await put(
          join(base, dir, "skills", name, "SKILL.md"),
          `---\nname: ${name}\ndescription: fixture\n---\n${dir}`,
        );
        await put(join(base, dir, "commands", `${name}.md`), `${dir} command`);
      }
    }
    const options = { nativeDirectories, homeDirectory: home, additionalDirectories: [extra] };
    const skillRoots = await resolveDefaultSkillRoots(child, options);
    const commandRoots = await resolveDefaultCustomCommandRoots(child, options);
    for (const roots of [skillRoots, commandRoots]) {
      expect(roots.some((item) => item.path.includes(`${join("", ".zcode")}/`))).toBe(false);
      expect(roots.filter((item) => item.source === "zcode")).toHaveLength(4);
      expect(roots.filter((item) => item.source === "agents")).toHaveLength(4);
    }
    const skills = await createNodeSkillAdapter(options).discoverSkills({
      workingDirectory: child,
    });
    const commands = await createNodeCustomCommandAdapter(options).discoverCommands({
      workingDirectory: child,
    });
    expect(skills.skills).toHaveLength(8);
    expect(commands.commands).toHaveLength(8);
    expect(skills.skills.every((item) => !item.name.endsWith("zcode"))).toBe(true);
    expect(commands.commands.every((item) => !item.name.endsWith("zcode"))).toBe(true);
  });

  it("reads selected user AGENTS together with unchanged workspace AGENTS", async () => {
    await put(join(home, ".zcode", "AGENTS.md"), "old user canary");
    await put(join(home, ".aiscoo", "AGENTS.md"), "selected user canary");
    await put(join(workspace, "AGENTS.md"), "workspace canary");
    const result = await createNodeContextSourceAdapter({
      env: { HOME: home },
      nativeDirectories,
    }).resolveContextSources({
      workingDirectory: workspace,
      userInstructions: { workingDirectory: workspace },
    });
    expect(result.userInstructions?.content).toContain("selected user canary");
    expect(result.userInstructions?.content).toContain("workspace canary");
    expect(result.userInstructions?.content).not.toContain("old user canary");
  });

  it("does not fall back to old native resources when a legal custom root is absent", async () => {
    await put(join(home, ".zcode", "cli", "config.json"), { skills: { metadataBudget: 123 } });
    await put(join(workspace, ".zcode", "config.json"), {
      mcp: { servers: { old: { type: "stdio", command: "node" } } },
    });
    const custom = resolveNativeResourceDirectoryPolicy({
      env: { ZCODE_NATIVE_RESOURCE_DIR_NAME: ".fixture" },
    });
    const result = createConfig({
      env: {},
      loggerFactory,
      nativeDirectories: custom,
      workingDirectory: workspace,
    });
    expect(result.sources.user.loaded).toBe(false);
    expect(result.sources.project.paths).toEqual([]);
    expect(result.config.storage).toEqual(DefaultRuntimeConfig.storage);
    expect(() =>
      resolveNativeResourceDirectoryPolicy({
        env: { ZCODE_NATIVE_RESOURCE_DIR_NAME: "../escape" },
      }),
    ).toThrow();
  });

  it("uses selected user trust root unless the user explicitly configured storage.dir", async () => {
    const selected = join(home, ".aiscoo", "cli", "config.json");
    const trust = await resolveWorkspaceHookTrustStorePath({ homeDir: home, nativeDirectories });
    expect(trust).toBe(join(home, ".aiscoo", "security", "workspace-hook-trust-v1.json"));
    await put(selected, { storage: { dir: "~/explicit-runtime" } });
    expect(await resolveWorkspaceHookTrustStorePath({ homeDir: home, nativeDirectories })).toBe(
      join(home, "explicit-runtime", "security", "workspace-hook-trust-v1.json"),
    );
    expect(JSON.parse(await readFile(selected, "utf8"))).toEqual({
      storage: { dir: "~/explicit-runtime" },
    });
  });
});
