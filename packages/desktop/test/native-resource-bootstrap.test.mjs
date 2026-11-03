import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const envKey = "ZCODE_NATIVE_RESOURCE_DIR_NAME";
let sequence = 0;
async function loadAdapter(relativePath, channel) {
  const result = await build({
    entryPoints: [new URL(relativePath, import.meta.url).pathname],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    define: channel ? { __AISCOO_DESKTOP_CHANNEL__: JSON.stringify(channel) } : {},
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}#native-${++sequence}`
  );
}
const loadNative = (channel) =>
  loadAdapter("../src/aiscoo-desktop-identity/nativeResourceDirectories.ts", channel);

// 启动装配工程回归：仅使用合成 env map，不创建 App/Host，也不触碰真实 HOME。
test("desktop product defaults and upstream default are selected once", async () => {
  for (const channel of [undefined, "production", "development", "preview"]) {
    const {
      initializeDesktopNativeResourceDirectories: initialize,
      getDesktopNativeResourceDirectories: getPolicy,
    } = await loadNative(channel);
    assert.throws(getPolicy, /not initialized/);
    const env = {
      HOME: "/synthetic/home",
      ZCODE_STORAGE_DIR: "/synthetic/runtime",
      ZCODE_SETTINGS_FILE_PATH: "/synthetic/settings.json",
    };
    const policy = initialize({}, env);
    assert.equal(policy.directoryName, channel ? ".aiscoo" : ".zcode");
    assert.equal(Object.isFrozen(policy), true);
    assert.equal(getPolicy(), policy);
    assert.equal(env[envKey], policy.directoryName);
    assert.deepEqual(
      { ...env, [envKey]: undefined },
      {
        HOME: "/synthetic/home",
        ZCODE_STORAGE_DIR: "/synthetic/runtime",
        ZCODE_SETTINGS_FILE_PATH: "/synthetic/settings.json",
        [envKey]: undefined,
      },
    );
    env[envKey] = ".changed-after-start";
    assert.equal(initialize({}, env), policy);
    assert.equal(getPolicy(), policy);
  }
});

test("dotenv and defined process values preserve merge priority including blank override", async () => {
  for (const [local, inherited, expected] of [
    [".dotenv", ".process", ".process"],
    [".dotenv", undefined, ".dotenv"],
    [".dotenv", "   ", ".aiscoo"],
    ["   ", undefined, ".aiscoo"],
    [undefined, ".zcode", ".zcode"],
  ]) {
    const { initializeDesktopNativeResourceDirectories: initialize } =
      await loadNative("production");
    const env = { [envKey]: inherited };
    assert.equal(initialize({ [envKey]: local }, env).directoryName, expected);
    assert.equal(env[envKey], expected);
  }
});

test("invalid startup resource policy fails before publication and cannot scan a fallback", async () => {
  for (const value of [
    "..",
    "/absolute",
    "C:\\absolute",
    ".nested/path",
    ".nested\\path",
    ".trailing.",
    ".nul\u0000",
    "non-hidden",
  ]) {
    const {
      initializeDesktopNativeResourceDirectories: initialize,
      getDesktopNativeResourceDirectories: getPolicy,
    } = await loadNative("production");
    const env = { HOME: "/synthetic/home", [envKey]: value };
    assert.throws(() => initialize({ [envKey]: ".valid-dotenv" }, env), {
      code: "INVALID_NATIVE_RESOURCE_DIR_NAME",
    });
    assert.deepEqual(env, { HOME: "/synthetic/home", [envKey]: value });
    assert.throws(getPolicy, /not initialized/);
  }
});

test("Host plugin inventory follows runtime storage independently of native resources", async () => {
  const { resolveDesktopPluginStorageRoot: pluginRoot } = await loadAdapter(
    "../src/host/aiscoo-data-directory/runtimePluginStorage.ts",
  );
  assert.equal(pluginRoot({ HOME: "/synthetic/home", [envKey]: ".native" }), undefined);
  assert.equal(
    pluginRoot({
      HOME: "/synthetic/home",
      ZCODE_STORAGE_DIR: "/bound/runtime",
      [envKey]: ".native",
    }),
    join("/bound/runtime", "cli/plugins"),
  );
  assert.equal(
    pluginRoot({ HOME: "/synthetic/home", ZCODE_STORAGE_DIR: "/explicit/cli", [envKey]: ".other" }),
    join("/explicit/cli", "plugins"),
  );
  assert.equal(
    pluginRoot({ HOME: "/synthetic/home", ZCODE_STORAGE_DIR: "~/.runtime" }),
    join("/synthetic/home", ".runtime/cli/plugins"),
  );
  assert.equal(
    pluginRoot({ USERPROFILE: "/synthetic/profile", ZCODE_STORAGE_DIR: "~/.runtime" }),
    join("/synthetic/profile", ".runtime/cli/plugins"),
  );
  assert.equal(
    pluginRoot({ ZCODE_STORAGE_DIR: "relative-runtime" }),
    join(resolve("relative-runtime"), "cli/plugins"),
  );
});
