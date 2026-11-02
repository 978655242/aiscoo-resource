import assert from "node:assert/strict";
import { test } from "node:test";
import { basename, dirname, join } from "node:path";
import { chmod, mkdtemp, mkdir, readFile, readdir, stat, writeFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { build } from "esbuild";
import ts from "typescript";

const entry = new URL(
  "../../packages/desktop/src/aiscoo-desktop-identity/index.ts",
  import.meta.url,
);

const fixtureRoot = new URL("../../.tmp/aiscoo-storage-tests/", import.meta.url).pathname;
let runtimeSequence = 0;
async function createFixture(prefix) {
  await mkdir(fixtureRoot, { recursive: true });
  return mkdtemp(join(fixtureRoot, prefix));
}

async function loadRuntime(channel) {
  const result = await build({
    entryPoints: [entry.pathname],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    define: channel ? { __AISCOO_DESKTOP_CHANNEL__: JSON.stringify(channel) } : {},
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#runtime-${++runtimeSequence}`
  );
}

test("Aiscoo selects channel data roots without reading legacy settings", async () => {
  for (const [channel, dataName] of [
    ["production", "Aiscoo"],
    ["development", "Aiscoo Dev"],
    ["preview", "Aiscoo Preview"],
  ]) {
    const { bootstrapAiscooDesktopData } = await loadRuntime(channel);
    let root;
    let settingsFile;
    const env = {};
    const result = bootstrapAiscooDesktopData(
      (file) => {
        settingsFile = file;
        return null;
      },
      {
        env,
        appDataPath: "/isolated/app-data",
        setDataBaseDir: (path) => {
          root = path;
        },
      },
    );
    assert.equal(result, null);
    assert.equal(root, join("/isolated/app-data", dataName));
    assert.equal(settingsFile, join(root, ".zcode", "v2", "setting.json"));
    assert.equal(env.ZCODE_SETTINGS_FILE_PATH, settingsFile);
    assert.equal(env.HOME, undefined);
  }
});

test("explicit data roots and existing custom settings remain owned by original bootstrap", async () => {
  const { bootstrapAiscooDesktopData } = await loadRuntime("production");
  const env = { ZCODE_DATA_BASE_DIR: "/explicit/data", HOME: "/real/home" };
  let root;
  const result = bootstrapAiscooDesktopData(
    (file) => {
      assert.equal(file, "/explicit/data/.zcode/v2/setting.json");
      root = "/custom/from-settings";
      return root;
    },
    {
      env,
      appDataPath: "/unused",
      setDataBaseDir: (value) => {
        root = value;
      },
    },
  );
  assert.equal(result, "/custom/from-settings");
  assert.equal(root, "/custom/from-settings");
  assert.equal(env.HOME, "/real/home");
});

test("unconfigured upstream bootstrap receives no Aiscoo side effects", async () => {
  const { bootstrapAiscooDesktopData } = await loadRuntime();
  const env = { HOME: "/real/home" };
  let calls = 0;
  assert.equal(
    bootstrapAiscooDesktopData(
      (...args) => {
        assert.deepEqual(args, []);
        calls++;
        return "/upstream";
      },
      {
        env,
        appDataPath: "/unused",
        setDataBaseDir: () => assert.fail("Unexpected Aiscoo mutation"),
      },
    ),
    "/upstream",
  );
  assert.equal(calls, 1);
  assert.deepEqual(env, { HOME: "/real/home" });
});

function bootstrapRuntime(runtime, root, currentRoot = root, settingsFile) {
  const env = {
    ZCODE_DATA_BASE_DIR: root,
    HOME: homedir(),
    ...(settingsFile ? { ZCODE_SETTINGS_FILE_PATH: settingsFile } : {}),
  };
  runtime.bootstrapAiscooDesktopData(() => currentRoot, {
    env,
    appDataPath: dirname(root),
    setDataBaseDir() {},
  });
  return env;
}

async function assertMissing(file) {
  await assert.rejects(stat(file), { code: "ENOENT" });
}

test("CLI root binds the first restored default/custom root, then survives App moves and restarts", async () => {
  const fixture = await createFixture("binding-");
  try {
    for (const custom of [false, true]) {
      const root = join(fixture, custom ? "existing-custom-channel" : "new-channel");
      const firstData = custom ? join(fixture, "old-custom") : root;
      const movedData = join(fixture, "moved", basename(root));
      const runtime = await loadRuntime("production");
      const env = bootstrapRuntime(runtime, root, firstData);
      assert.equal(runtime.isAiscooDesktopStorageReady(), false);
      assert.throws(() => runtime.getAiscooDesktopCliBaseDir(), /not initialized/i);
      const cliBaseDir = await runtime.initializeAiscooDesktopStorage({
        settingsFile: env.ZCODE_SETTINGS_FILE_PATH,
        dataBaseDir: firstData,
      });
      assert.equal(cliBaseDir, firstData);
      assert.equal(runtime.isAiscooDesktopStorageReady(), true);
      const binding = join(
        dirname(env.ZCODE_SETTINGS_FILE_PATH),
        "setting.json.aiscoo-cli-root.json",
      );
      assert.deepEqual(JSON.parse(await readFile(binding, "utf8")), {
        version: 1,
        cliBaseDir: firstData,
      });
      if (process.platform !== "win32") assert.equal((await stat(binding)).mode & 0o777, 0o600);
      await assertMissing(join(firstData, ".zcode", "cli"));
      assert.equal(
        await runtime.initializeAiscooDesktopStorage({
          settingsFile: env.ZCODE_SETTINGS_FILE_PATH,
          dataBaseDir: movedData,
        }),
        firstData,
      );
      const restarted = await loadRuntime("production");
      bootstrapRuntime(restarted, root, movedData);
      assert.equal(
        await restarted.initializeAiscooDesktopStorage({
          settingsFile: env.ZCODE_SETTINGS_FILE_PATH,
          dataBaseDir: movedData,
        }),
        firstData,
      );
      const child = restarted.buildAiscooDesktopStorageEnv(
        movedData,
        env,
        restarted.getAiscooDesktopCliBaseDir(),
      );
      assert.equal(child.ZCODE_DATA_BASE_DIR, movedData);
      assert.equal(child.AISCOO_DESKTOP_DEFAULT_DATA_BASE_DIR, root);
      assert.equal(
        child.ZCODE_SESSION_DB_PATH,
        join(firstData, ".zcode", "cli", "db", "db.sqlite"),
      );
      for (const key of ["ZCODE_STORAGE_DIR", "ZCODE_SESSION_DB_PATH", "ZCODE_LOG_DIR"])
        assert.equal(env[key], undefined);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("concurrent independent initializers converge on one persisted CLI root", async () => {
  const fixture = await createFixture("concurrent-");
  try {
    const root = join(fixture, "channel");
    const runtimes = await Promise.all(Array.from({ length: 6 }, () => loadRuntime("production")));
    const candidates = runtimes.map((_, index) => join(fixture, `custom-${index}`));
    const results = await Promise.all(
      runtimes.map((runtime, index) => {
        const env = bootstrapRuntime(runtime, root, candidates[index]);
        return runtime.initializeAiscooDesktopStorage({
          settingsFile: env.ZCODE_SETTINGS_FILE_PATH,
          dataBaseDir: candidates[index],
        });
      }),
    );
    assert.equal(new Set(results).size, 1);
    assert.ok(candidates.includes(results[0]));
    assert.equal(
      JSON.parse(
        await readFile(join(root, ".zcode", "v2", "setting.json.aiscoo-cli-root.json"), "utf8"),
      ).cliBaseDir,
      results[0],
    );
    assert.deepEqual(await readdir(join(root, ".zcode", "v2")), [
      "setting.json.aiscoo-cli-root.json",
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("invalid or unreadable CLI bindings fail closed and preserve their evidence", async () => {
  const fixture = await createFixture("invalid-");
  try {
    const badRecords = [
      "{broken",
      "null",
      JSON.stringify({ version: 2, cliBaseDir: fixture }),
      JSON.stringify({ version: 1, cliBaseDir: "" }),
      JSON.stringify({ version: 1, cliBaseDir: "   " }),
      JSON.stringify({ version: 1, cliBaseDir: "relative" }),
      JSON.stringify({ version: 1, cliBaseDir: `${fixture}\0` }),
    ];
    for (const [index, contents] of badRecords.entries()) {
      const root = join(fixture, `bad-${index}`);
      const runtime = await loadRuntime("production");
      const env = bootstrapRuntime(runtime, root);
      const binding = join(
        dirname(env.ZCODE_SETTINGS_FILE_PATH),
        "setting.json.aiscoo-cli-root.json",
      );
      await mkdir(dirname(binding), { recursive: true });
      await writeFile(binding, contents);
      await assert.rejects(
        runtime.initializeAiscooDesktopStorage({
          settingsFile: env.ZCODE_SETTINGS_FILE_PATH,
          dataBaseDir: root,
        }),
        /Aiscoo.*CLI.*root.*binding/i,
      );
      assert.equal(await readFile(binding, "utf8"), contents);
      assert.equal(runtime.isAiscooDesktopStorageReady(), false);
      assert.throws(() => runtime.getAiscooDesktopCliBaseDir(), /not initialized/i);
    }
    const runtime = await loadRuntime("production");
    const env = bootstrapRuntime(runtime, join(fixture, "unreadable"));
    const binding = join(
      dirname(env.ZCODE_SETTINGS_FILE_PATH),
      "setting.json.aiscoo-cli-root.json",
    );
    await mkdir(binding, { recursive: true });
    await assert.rejects(
      runtime.initializeAiscooDesktopStorage({
        settingsFile: env.ZCODE_SETTINGS_FILE_PATH,
        dataBaseDir: fixture,
      }),
      /Aiscoo.*CLI.*root.*binding/i,
    );
    assert.equal(runtime.isAiscooDesktopStorageReady(), false);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("an unwritable binding directory stops initialization without selecting another DB", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0)
    return t.skip("requires POSIX directory permissions");
  const fixture = await createFixture("unwritable-");
  try {
    const root = join(fixture, "channel");
    const runtime = await loadRuntime("production");
    const env = bootstrapRuntime(runtime, root);
    const directory = dirname(env.ZCODE_SETTINGS_FILE_PATH);
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o500);
    try {
      await assert.rejects(
        runtime.initializeAiscooDesktopStorage({
          settingsFile: env.ZCODE_SETTINGS_FILE_PATH,
          dataBaseDir: root,
        }),
        /Aiscoo.*CLI.*root.*binding/i,
      );
      assert.equal(runtime.isAiscooDesktopStorageReady(), false);
      await assertMissing(join(root, ".zcode", "cli"));
    } finally {
      await chmod(directory, 0o700);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("storage overrides remain independent and App HOME is still explicit", async () => {
  const runtime = await loadRuntime("production");
  const env = bootstrapRuntime(runtime, "/isolated/default");
  const cliBaseDir = "/isolated/cli-root";
  const defaults = runtime.buildAiscooDesktopStorageEnv(homedir(), env, cliBaseDir);
  assert.deepEqual(defaults, {
    ZCODE_DATA_BASE_DIR: homedir(),
    AISCOO_DESKTOP_DEFAULT_DATA_BASE_DIR: "/isolated/default",
    ZCODE_STORAGE_DIR: join(cliBaseDir, ".zcode"),
    ZCODE_SESSION_DB_PATH: join(cliBaseDir, ".zcode", "cli", "db", "db.sqlite"),
    ZCODE_LOG_DIR: join(cliBaseDir, ".zcode", "cli", "log"),
  });
  for (const key of ["ZCODE_STORAGE_DIR", "ZCODE_SESSION_DB_PATH", "ZCODE_LOG_DIR"]) {
    assert.deepEqual(
      runtime.buildAiscooDesktopStorageEnv(
        homedir(),
        { ...env, [key]: "/explicit/value" },
        cliBaseDir,
      ),
      { ...defaults, [key]: "/explicit/value" },
    );
  }
  assert.equal(env.HOME, homedir());
  const upstream = await loadRuntime();
  assert.equal(
    await upstream.initializeAiscooDesktopStorage({
      settingsFile: "/unused/settings",
      dataBaseDir: "/unused/data",
    }),
    undefined,
  );
  assert.equal(upstream.isAiscooDesktopStorageReady(), true);
  assert.equal(upstream.getAiscooDesktopCliBaseDir(), undefined);
  assert.deepEqual(upstream.buildAiscooDesktopStorageEnv("/upstream", env, undefined), {});
});

async function loadDirectoryServices() {
  const result = await build({
    stdin: {
      contents: `
        export { registerAiscooDataDirectoryServices } from "./packages/desktop/src/host/aiscoo-data-directory/index.ts";
        export { ServiceCollection, ISettingService, ISystemService } from "./packages/services/src/index.ts";
        export { createSettingService } from "./packages/services/src/setting/settingService.ts";
        export { createObservableSettingService } from "./packages/services/src/setting/observableSettingService.ts";
        export { createSystemService } from "./packages/services/src/system/systemService.ts";
        export { setDataBaseDir, copyDataDirectory } from "./packages/services/src/paths.ts";
      `,
      resolveDir: new URL("../..", import.meta.url).pathname,
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#services-${++runtimeSequence}`
  );
}

test("nonstandard settings bindings stay distinct and are excluded by the real v2 migration", async () => {
  const fixture = await createFixture("sidecar-copy-");
  try {
    const root = join(fixture, "channel");
    const moved = join(fixture, "moved");
    const directory = join(root, ".zcode", "v2");
    for (const name of ["setting.json", "profile-one.json", "profile-two.json"]) {
      const runtime = await loadRuntime("production");
      const env = bootstrapRuntime(runtime, root, root, join(directory, name));
      await runtime.initializeAiscooDesktopStorage({
        settingsFile: env.ZCODE_SETTINGS_FILE_PATH,
        dataBaseDir: root,
      });
    }
    const names = await readdir(directory);
    assert.equal(names.length, 3);
    assert.ok(names.includes("setting.json.aiscoo-cli-root.json"));
    for (const name of names)
      assert.match(name, /^setting\.json\.aiscoo-cli-root(?:-[a-f0-9]{64})?\.json$/);
    await writeFile(join(directory, "app-data.txt"), "preserve v2");
    const { copyDataDirectory } = await loadDirectoryServices();
    await copyDataDirectory(root, moved);
    assert.deepEqual(await readdir(join(moved, ".zcode", "v2")), ["app-data.txt"]);
    assert.equal(
      await readFile(join(moved, ".zcode", "v2", "app-data.txt"), "utf8"),
      "preserve v2",
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Host default-root wrapper preserves real settings migration, explicit HOME, and one notification", async () => {
  const fixture = await createFixture("host-services-");
  const previousHome = process.env.HOME;
  const previousSettings = process.env.ZCODE_SETTINGS_FILE_PATH;
  try {
    const home = join(fixture, "real-home");
    const defaultRoot = join(fixture, "channel");
    const currentRoot = join(fixture, "custom");
    const settingsFile = join(defaultRoot, ".zcode", "v2", "setting.json");
    process.env.HOME = home;
    process.env.ZCODE_SETTINGS_FILE_PATH = settingsFile;
    await mkdir(join(currentRoot, ".zcode", "v2"), { recursive: true });
    await writeFile(join(currentRoot, ".zcode", "v2", "app-data.txt"), "existing app data");
    const runtime = await loadDirectoryServices();
    runtime.setDataBaseDir(currentRoot);
    const setting = runtime.createObservableSettingService(runtime.createSettingService());
    const system = runtime.createSystemService();
    const services = new runtime.ServiceCollection()
      .register(runtime.ISettingService, setting)
      .register(runtime.ISystemService, system);
    runtime.registerAiscooDataDirectoryServices(services, undefined);
    assert.equal(services.get(runtime.ISettingService), setting);
    assert.equal(services.get(runtime.ISystemService), system);
    const beforeInfo = await system.info();
    assert.equal(beforeInfo.homedir, home);
    const notifications = [];
    setting.onDidUpdate((event) => notifications.push(event));
    runtime.registerAiscooDataDirectoryServices(services, defaultRoot);
    const wrapped = services.get(runtime.ISettingService);
    assert.deepEqual(await services.get(runtime.ISystemService).info(), {
      ...beforeInfo,
      defaultDataBaseDir: defaultRoot,
    });
    for (const input of [undefined, "", "   ", home]) {
      const target = input === home ? home : defaultRoot;
      const count = notifications.length;
      await wrapped.updateDataBaseDir(input);
      assert.equal((await wrapped.get()).dataBaseDir, target);
      assert.equal(JSON.parse(await readFile(settingsFile, "utf8")).dataBaseDir, target);
      assert.equal(
        await readFile(join(target, ".zcode", "v2", "app-data.txt"), "utf8"),
        "existing app data",
      );
      assert.equal(notifications.length, count + 1);
      assert.deepEqual(notifications.at(-1).keys, ["dataBaseDir"]);
    }
    // 原写入失败仍向上传递，包装不能补发通知或写入第二次。
    const blocked = join(fixture, "blocked");
    await writeFile(blocked, "not a directory");
    const count = notifications.length;
    await assert.rejects(wrapped.updateDataBaseDir(blocked));
    assert.equal(notifications.length, count);
    assert.equal((await wrapped.get()).dataBaseDir, home);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSettings === undefined) delete process.env.ZCODE_SETTINGS_FILE_PATH;
    else process.env.ZCODE_SETTINGS_FILE_PATH = previousSettings;
    await rm(fixture, { recursive: true, force: true });
  }
});

test("the production Host environment merges dotenv before process overrides and keeps fixed B", async () => {
  const fixture = await createFixture("host-env-");
  const keys = ["ZCODE_STORAGE_DIR", "ZCODE_SESSION_DB_PATH", "ZCODE_LOG_DIR"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    // 运行实际 finalEnv 合并表达式及调用，替换无关 Electron/遥测装配，不复制合并算法。
    const source = await readFile(
      new URL("../../packages/desktop/src/main/desktopRuntimeEnv.ts", import.meta.url),
      "utf8",
    );
    const parsed = ts.createSourceFile(
      "desktopRuntimeEnv.ts",
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const functions = parsed.statements.filter(ts.isFunctionDeclaration);
    const buildHost = functions.find((node) => node.name?.text === "buildHostProcessEnv");
    const readProcess = functions.find((node) => node.name?.text === "readDefinedProcessEnv");
    const raw = buildHost.body.statements
      .filter(ts.isVariableStatement)
      .flatMap((node) => [...node.declarationList.declarations])
      .find((node) => ts.isIdentifier(node.name) && node.name.text === "rawInheritedEnv");
    const resultObject = buildHost.body.statements.find(ts.isReturnStatement).expression;
    const storageSpread = resultObject.properties.find(
      (node) =>
        ts.isSpreadAssignment(node) &&
        ts.isCallExpression(node.expression) &&
        node.expression.expression.getText(parsed) === "buildAiscooDesktopStorageEnv",
    );
    assert.ok(raw?.initializer && readProcess && storageSpread);
    const compiled = await build({
      stdin: {
        contents: `import { buildAiscooDesktopStorageEnv, getAiscooDesktopCliBaseDir } from "../aiscoo-desktop-identity/index.ts"; export * from "../aiscoo-desktop-identity/index.ts"; ${readProcess.getText(parsed)}; export function childEnv(dataBaseDir, hostProcessLocalEnv) { const rawInheritedEnv = ${raw.initializer.getText(parsed)}; return ${storageSpread.expression.getText(parsed)}; }`,
        resolveDir: new URL("../../packages/desktop/src/main", import.meta.url).pathname,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      define: { __AISCOO_DESKTOP_CHANNEL__: JSON.stringify("production") },
    });
    const runtime = await import(
      `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}#final-env`
    );
    const env = bootstrapRuntime(runtime, join(fixture, "channel"));
    const initial = join(fixture, "old-custom");
    await runtime.initializeAiscooDesktopStorage({
      settingsFile: env.ZCODE_SETTINGS_FILE_PATH,
      dataBaseDir: initial,
    });
    for (const key of keys) delete process.env[key];
    const localEnv = {
      ZCODE_STORAGE_DIR: "/dotenv/storage",
      ZCODE_SESSION_DB_PATH: "/dotenv/db",
      ZCODE_LOG_DIR: "/dotenv/log",
    };
    const dotenvChild = runtime.childEnv(homedir(), localEnv);
    for (const key of keys) assert.equal(dotenvChild[key], localEnv[key]);
    process.env.ZCODE_SESSION_DB_PATH = "/process/db";
    const processChild = runtime.childEnv(homedir(), localEnv);
    assert.equal(processChild.ZCODE_SESSION_DB_PATH, "/process/db");
    assert.equal(processChild.ZCODE_STORAGE_DIR, localEnv.ZCODE_STORAGE_DIR);
    assert.equal(processChild.ZCODE_LOG_DIR, localEnv.ZCODE_LOG_DIR);
    assert.equal(processChild.ZCODE_DATA_BASE_DIR, homedir());
    delete process.env.ZCODE_SESSION_DB_PATH;
    assert.equal(
      runtime.childEnv(homedir(), {}).ZCODE_SESSION_DB_PATH,
      join(initial, ".zcode", "cli", "db", "db.sqlite"),
    );
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await rm(fixture, { recursive: true, force: true });
  }
});

test("Main cold startup warms only the selected channel workspace and retains the default HOME fallback", async () => {
  const root = await createFixture("startup-settings-");
  const previousHome = process.env.HOME;
  const previousSettings = process.env.ZCODE_SETTINGS_FILE_PATH;
  try {
    const home = join(root, "old-home");
    const legacySettings = join(home, ".zcode", "v2", "setting.json");
    const selectedSettings = join(root, "channel", "setting.json");
    const legacyWorkspace = join(root, "workspace-a");
    const selectedWorkspace = join(root, "workspace-b");
    for (const directory of [
      join(home, ".zcode", "v2"),
      join(root, "channel"),
      legacyWorkspace,
      selectedWorkspace,
    ]) {
      await mkdir(directory, { recursive: true });
    }
    for (const [file, workspacePath] of [
      [legacySettings, legacyWorkspace],
      [selectedSettings, selectedWorkspace],
    ]) {
      await writeFile(
        file,
        JSON.stringify({
          lastActiveWorkspace: { kind: "local", workspacePath, workspacePurpose: "project" },
        }),
      );
    }
    process.env.HOME = home;

    // XCODE: 取实际 Main 的配置表达式并调用真实启动 owner，只替换外层 Electron 启动，避免测试复制路径选择逻辑。
    const source = await readFile(
      new URL("../../packages/desktop/src/main/index.ts", import.meta.url),
      "utf8",
    );
    const parsed = ts.createSourceFile("index.ts", source, ts.ScriptTarget.Latest, true);
    const declaration = parsed.statements
      .filter(ts.isVariableStatement)
      .flatMap((statement) => [...statement.declarationList.declarations])
      .find((item) => ts.isIdentifier(item.name) && item.name.text === "settingsFile");
    assert.ok(declaration?.initializer, "Main must explicitly select its startup settings file");
    const compiled = await build({
      stdin: {
        contents: `import { join } from "node:path"; import { homedir } from "node:os"; import { resolveStartupWindowBootstrap } from "./startupWorkspace.ts"; export const settingsFile = ${declaration.initializer.getText(parsed)}; export { resolveStartupWindowBootstrap };`,
        resolveDir: new URL("../../packages/desktop/src/main", import.meta.url).pathname,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
    });
    const compiledUrl = `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`;
    for (const [override, workspacePath] of [
      [selectedSettings, selectedWorkspace],
      [undefined, legacyWorkspace],
    ]) {
      if (override === undefined) delete process.env.ZCODE_SETTINGS_FILE_PATH;
      else process.env.ZCODE_SETTINGS_FILE_PATH = override;
      const runtime = await import(
        `${compiledUrl}#startup-${override === undefined ? "default" : "channel"}`
      );
      const result = await runtime.resolveStartupWindowBootstrap({
        settingsFile: runtime.settingsFile,
        conversationWorkspaceDir: join(root, "conversation"),
      });
      assert.deepEqual(result.agentWarmupTargets, [{ workspacePath }]);
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSettings === undefined) delete process.env.ZCODE_SETTINGS_FILE_PATH;
    else process.env.ZCODE_SETTINGS_FILE_PATH = previousSettings;
    await rm(root, { recursive: true, force: true });
  }
});

test("early Chromium settings use the same isolated file instead of legacy HOME", async () => {
  const root = await createFixture("hardware-settings-");
  const previousHome = process.env.HOME;
  const previousSettings = process.env.ZCODE_SETTINGS_FILE_PATH;
  try {
    const oldFile = join(root, "old-home", ".zcode", "v2", "setting.json");
    const newFile = join(root, "aiscoo", "setting.json");
    await mkdir(join(root, "old-home", ".zcode", "v2"), { recursive: true });
    await mkdir(join(root, "aiscoo"));
    await writeFile(oldFile, JSON.stringify({ desktopChromiumHardwareAccelerationEnabled: true }));
    await writeFile(newFile, JSON.stringify({ desktopChromiumHardwareAccelerationEnabled: false }));
    process.env.HOME = join(root, "old-home");
    process.env.ZCODE_SETTINGS_FILE_PATH = newFile;
    const result = await build({
      stdin: {
        contents:
          'import "./desktopEarlyChromiumHardwareAccelerationBootstrap.ts"; export { calls } from "electron";',
        resolveDir: new URL("../../packages/desktop/src/main", import.meta.url).pathname,
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      write: false,
      plugins: [
        {
          name: "isolated-electron-app",
          setup(builder) {
            builder.onResolve({ filter: /^electron$/ }, () => ({
              path: "electron",
              namespace: "fixture",
            }));
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents:
                "export let calls=0; export const app={disableHardwareAcceleration(){calls++;}};",
              loader: "js",
            }));
          },
        },
      ],
    });
    const runtime = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#isolated-hardware`
    );
    assert.equal(runtime.calls, 1, "Aiscoo disabled setting must win over legacy enabled setting");
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSettings === undefined) delete process.env.ZCODE_SETTINGS_FILE_PATH;
    else process.env.ZCODE_SETTINGS_FILE_PATH = previousSettings;
    await rm(root, { recursive: true, force: true });
  }
});
