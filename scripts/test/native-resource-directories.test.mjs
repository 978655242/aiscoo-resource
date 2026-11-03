import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { getAiscooDesktopIdentity } from "../../packages/shared/src/aiscoo-desktop-identity/runtime.js";

const entry = fileURLToPath(
  new URL("../../packages/shared/src/native-resource-directories/node.ts", import.meta.url),
);
const output = await build({
  entryPoints: [entry],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
});
const native = await import(
  `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
);

const { resolveNativeResourceDirectoryPolicy, NATIVE_RESOURCE_DIRECTORY_ENV } = native;

test("native resource defaults preserve upstream and select each Aiscoo profile", () => {
  assert.deepEqual(resolveNativeResourceDirectoryPolicy(), { directoryName: ".zcode" });
  for (const channel of ["production", "development", "preview"]) {
    const identity = getAiscooDesktopIdentity(channel);
    assert.equal(identity.nativeResourceDirectoryName, ".aiscoo");
    const policy = resolveNativeResourceDirectoryPolicy({
      productDirectoryName: identity.nativeResourceDirectoryName,
    });
    assert.deepEqual(policy, { directoryName: ".aiscoo" });
    assert.equal(Object.isFrozen(policy), true);
  }
});

test("nonempty environment wins; blank environment keeps the product default", () => {
  for (const value of [undefined, "", " \t\n "]) {
    assert.deepEqual(
      resolveNativeResourceDirectoryPolicy({
        productDirectoryName: ".aiscoo",
        env: { [NATIVE_RESOURCE_DIRECTORY_ENV]: value },
      }),
      { directoryName: ".aiscoo" },
    );
  }
  for (const directoryName of [".zcode", ".aiscoo-work", ".custom_2", ".项目", ".aiscoo work"]) {
    assert.equal(
      resolveNativeResourceDirectoryPolicy({
        productDirectoryName: ".aiscoo",
        env: { [NATIVE_RESOURCE_DIRECTORY_ENV]: ` ${directoryName} ` },
      }).directoryName,
      directoryName,
    );
  }
});

test("invalid user or injected directory names fail instead of returning the old root", () => {
  const invalid = [
    ".",
    "..",
    "/tmp/.aiscoo",
    "../.aiscoo",
    ".aiscoo/other",
    ".aiscoo\\other",
    "C:\\aiscoo",
    "C:.aiscoo",
    "aiscoo",
    ".aiscoo.",
    ".aiscoo?",
    ".aiscoo*",
    ".aiscoo\0",
    ".aiscoo\nother",
  ];
  for (const directoryName of invalid) {
    assert.throws(
      () =>
        resolveNativeResourceDirectoryPolicy({
          env: { [NATIVE_RESOURCE_DIRECTORY_ENV]: directoryName },
        }),
      { code: "INVALID_NATIVE_RESOURCE_DIR_NAME" },
      directoryName,
    );
    assert.throws(
      () => native.nativeUserConfigPath("/isolated/home", { directoryName }),
      { code: "INVALID_NATIVE_RESOURCE_DIR_NAME" },
      directoryName,
    );
  }
});

test("resource selection does not mutate the runtime storage environment", () => {
  const env = Object.freeze({
    [NATIVE_RESOURCE_DIRECTORY_ENV]: ".aiscoo-work",
    ZCODE_STORAGE_DIR: "/channel/Aiscoo/.zcode",
    ZCODE_SESSION_DB_PATH: "/channel/Aiscoo/.zcode/cli/db/db.sqlite",
    ZCODE_LOG_DIR: "/channel/Aiscoo/.zcode/cli/log",
    HOME: "/real/home",
  });
  const before = { ...env };
  assert.equal(resolveNativeResourceDirectoryPolicy({ env }).directoryName, ".aiscoo-work");
  assert.deepEqual(env, before);
});

test("selected user and project roots preserve paths containing spaces", () => {
  const home = join(tmpdir(), "native home with spaces");
  const workspace = join(home, "project with spaces");
  const policy = resolveNativeResourceDirectoryPolicy({ productDirectoryName: ".aiscoo" });
  assert.equal(
    native.nativeUserConfigPath(home, policy),
    join(home, ".aiscoo", "cli", "config.json"),
  );
  assert.equal(
    native.nativeProjectConfigPath(workspace, policy),
    join(workspace, ".aiscoo", "config.json"),
  );
  assert.equal(
    native.nativeUserResourcePath(home, policy, "AGENTS.md"),
    join(home, ".aiscoo", "AGENTS.md"),
  );
  assert.equal(
    native.nativeProjectResourcePath(workspace, policy, "skills"),
    join(workspace, ".aiscoo", "skills"),
  );
  assert.equal(native.nativeUserConfigPath(home), join(home, ".zcode", "cli", "config.json"));
});

test("native resource writes leave old, common and runtime canaries untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "native-resource-policy-"));
  try {
    const home = join(root, "home");
    const workspace = join(root, "project");
    const oldUser = native.nativeUserConfigPath(home);
    const oldProject = native.nativeProjectConfigPath(workspace);
    const common = join(home, ".agents", "skills", "canary.txt");
    const runtime = join(
      root,
      "Application Support",
      "Aiscoo",
      ".zcode",
      "cli",
      "db",
      "canary.txt",
    );
    for (const path of [oldUser, oldProject, common, runtime]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "original");
    }
    const policy = resolveNativeResourceDirectoryPolicy({ productDirectoryName: ".aiscoo" });
    for (const path of [
      native.nativeUserConfigPath(home, policy),
      native.nativeProjectConfigPath(workspace, policy),
    ]) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, "selected");
      assert.equal(await readFile(path, "utf8"), "selected");
    }
    for (const path of [oldUser, oldProject, common, runtime]) {
      assert.equal(await readFile(path, "utf8"), "original");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
