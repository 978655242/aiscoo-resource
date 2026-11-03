// XCODE: 下游独立 CLI 资源目录回归，所有资源使用合成 HOME。
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/run.js";
import { runAiscoo } from "../src/aiscoo/run.js";
import { resolveTuiStartupLocale } from "../src/tui-startup-locale.js";
import { listSkillsForTui, listCustomCommandsForTui } from "../src/tui-command-data.js";
import { resolveNativeResourceDirectoryPolicy } from "@zcode/shared/native-resource-directories";
import type { RunDependencies } from "../src/cli-types.js";
import type { RunContext } from "@zcode/shared-types";

function context(argv: string[]) {
  let out = "";
  let err = "";
  return {
    ctx: {
      argv,
      stdout: {
        write: (value: string) => {
          out += value;
          return true;
        },
      },
      stderr: {
        write: (value: string) => {
          err += value;
          return true;
        },
      },
      stdin: { isTTY: false },
    } as unknown as RunContext,
    stdout: () => out,
    stderr: () => err,
  };
}
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child: () => logger,
};
async function fixture<T>(body: (root: string) => Promise<T>) {
  const root = await mkdtemp(join(tmpdir(), "native-cli-aiscoo-"));
  const beforeHome = process.env.HOME;
  const beforeProfile = process.env.USERPROFILE;
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  try {
    return await body(root);
  } finally {
    if (beforeHome === undefined) delete process.env.HOME;
    else process.env.HOME = beforeHome;
    if (beforeProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = beforeProfile;
    await rm(root, { recursive: true, force: true });
  }
}
function base(root: string): RunDependencies {
  return {
    env: { HOME: root, USERPROFILE: root, ZCODE_STORAGE_DIR: join(root, "runtime") },
    cwd: () => root,
    logger,
  };
}

test("generic management list/inspect preserves default and forwards one explicit resource policy", async () =>
  fixture(async (root) => {
    const policy = resolveNativeResourceDirectoryPolicy({ productDirectoryName: ".custom" });
    for (const [nativeDirectories, name] of [
      [undefined, ".zcode"],
      [policy, ".custom"],
    ] as const) {
      const list = context(["skills", "list", "--json"]);
      assert.equal(
        await run(list.ctx, {
          ...base(root),
          ...(nativeDirectories ? { nativeDirectories } : {}),
          userConfigPath: join(root, "explicit.json"),
          listSkills: async (options) => {
            assert.equal(options.nativeDirectories?.directoryName, name);
            assert.equal(options.userConfigPath, join(root, "explicit.json"));
            return { diagnostics: [], skills: [], totalDiscovered: 0 };
          },
        }),
        0,
      );
      const inspect = context(["commands", "inspect", "fixture"]);
      assert.equal(
        await run(inspect.ctx, {
          ...base(root),
          ...(nativeDirectories ? { nativeDirectories } : {}),
          inspectCustomCommand: async (options) => {
            assert.equal(options.nativeDirectories?.directoryName, name);
            throw new Error("fixture missing");
          },
        }),
        1,
      );
      assert.match(inspect.stderr(), /fixture missing/u);
    }
  }));

test("Aiscoo product entry reuses product default, env override and explicit .zcode restore", async () =>
  fixture(async (root) => {
    for (const [value, selected] of [
      [undefined, ".aiscoo"],
      ["  ", ".aiscoo"],
      [".custom", ".custom"],
      [".zcode", ".zcode"],
    ]) {
      const capture = context(["skills", "list", "--json"]);
      const deps = base(root);
      deps.env!.ZCODE_NATIVE_RESOURCE_DIR_NAME = value;
      deps.listSkills = async (options) => {
        assert.equal(options.nativeDirectories?.directoryName, selected);
        assert.equal(options.env?.HOME, root);
        assert.equal(options.env?.ZCODE_NATIVE_RESOURCE_DIR_NAME, selected);
        assert.equal(options.env?.ZCODE_STORAGE_DIR, join(root, "runtime"));
        return { diagnostics: [], skills: [], totalDiscovered: 0 };
      };
      assert.equal(await runAiscoo(capture.ctx, deps), 0);
    }
  }));

test("illegal env rejects before resource list, app factory or management port invocation", async () =>
  fixture(async (root) => {
    for (const invoke of [run, runAiscoo]) {
      let calls = 0;
      const capture = context(["skills", "list"]);
      assert.equal(
        await invoke(capture.ctx, {
          ...base(root),
          env: { ZCODE_NATIVE_RESOURCE_DIR_NAME: "../escape" },
          listSkills: async () => {
            calls++;
            throw new Error("unexpected");
          },
        }),
        1,
      );
      assert.equal(calls, 0);
      assert.match(capture.stderr(), /ZCODE_NATIVE_RESOURCE_DIR_NAME/u);
    }
  }));

test("protocol command receives the same frozen policy and leaves runtime storage unchanged", async () =>
  fixture(async (root) => {
    const capture = context(["app-server"]);
    const policy = resolveNativeResourceDirectoryPolicy({ productDirectoryName: ".custom" });
    assert.equal(
      await run(capture.ctx, {
        ...base(root),
        nativeDirectories: policy,
        runZCodeProtocolAgent: async (options) => {
          assert.equal(options?.nativeDirectories, policy);
          assert.equal(options?.env?.ZCODE_NATIVE_RESOURCE_DIR_NAME, ".custom");
          assert.ok(Object.isFrozen(options!.nativeDirectories));
          assert.equal(options?.env?.ZCODE_STORAGE_DIR, join(root, "runtime"));
        },
      }),
      0,
    );
  }));

test("hooks management target and TUI catalogs use the injected policy", async () =>
  fixture(async (root) => {
    const nativeDirectories = resolveNativeResourceDirectoryPolicy({
      productDirectoryName: ".custom",
    });
    const deps = { ...base(root), nativeDirectories };
    const capture = context(["hooks", "trust", "status", "--json"]);
    assert.equal(
      await run(capture.ctx, {
        ...deps,
        inspectWorkspaceHookTrust: async (options) => {
          assert.equal(options.nativeDirectories, nativeDirectories);
          return {
            workspaceIdentity: root,
            workspacePath: root,
            bundleDigest: null,
            reasonCode: "workspace_hooks_not_applicable",
            items: [],
          };
        },
      }),
      0,
    );
    await listSkillsForTui({
      ...deps,
      listSkills: async (options) => {
        assert.equal(options.nativeDirectories, nativeDirectories);
        return { diagnostics: [], skills: [], totalDiscovered: 0 };
      },
    });
    await listCustomCommandsForTui({
      ...deps,
      listCustomCommands: async (options) => {
        assert.equal(options.nativeDirectories, nativeDirectories);
        return { diagnostics: [], commands: [], totalDiscovered: 0 };
      },
    });
    await mkdir(join(root, ".custom", "cli"), { recursive: true });
    await writeFile(
      join(root, ".custom", "cli", "config.json"),
      JSON.stringify({ ui: { locale: "zh-CN" } }),
    );
    assert.equal(
      resolveTuiStartupLocale({
        deps,
        workingDirectory: root,
        options: { detectedLocale: "en-US" } as never,
      }),
      "zh-CN",
    );
  }));
