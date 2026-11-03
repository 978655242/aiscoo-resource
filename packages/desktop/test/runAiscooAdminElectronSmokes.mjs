import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const requireServices = createRequire(new URL("../../services/package.json", import.meta.url));
const { build } = requireServices("esbuild");
const requireDesktop = createRequire(new URL("../package.json", import.meta.url));
const electron = requireDesktop("electron");
const temporary = await mkdtemp(join(tmpdir(), "xwork-native-electron-tests-"));
const requested = new Set(process.argv.slice(2));
const fixtures = [
  "aiscooAdminComposerContextElectron",
  "aiscooAdminPeriodDetailsElectron",
  "aiscooAdminWebHandoffElectron",
  "aiscooAdminUpgradePresentationElectron",
  "aiscooAdminModelSettingsElectron",
  "aiscooAdminModelCapabilitiesElectron",
  // XCODE: 公开法律入口复用独立、无真实账号的 Electron 场景。
  "aiscooAdminLegalLinksElectron",
  // XCODE: 覆盖真实 Footer 和默认头像在隔离 Electron 中的图片解码。
  "aiscooAdminAccountAvatarElectron",
];
try {
  // XCODE: 精确选场景可独立复验，默认仍运行全部；未知名称失败，不能悄悄跳过验收。
  for (const name of requested)
    assert.ok(fixtures.includes(name), `Unknown smoke fixture: ${name}`);
  for (const name of fixtures.filter((fixture) => requested.size === 0 || requested.has(fixture))) {
    const entry = new URL(`./${name}.mjs`, import.meta.url);
    const output = join(temporary, `${name}.mjs`);
    await build({
      entryPoints: [fileURLToPath(entry)],
      outfile: output,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      external: ["electron", requireServices.resolve("esbuild"), "ssh2", "cpu-features"],
      alias: { esbuild: requireServices.resolve("esbuild") },
      define: {
        "import.meta.url": JSON.stringify(entry.href),
        "import.meta.dirname": JSON.stringify(fileURLToPath(new URL("../out/main/", entry))),
      },
      banner: {
        js: `import { createRequire as smokeCreateRequire } from "node:module"; const require = smokeCreateRequire(${JSON.stringify(new URL("../package.json", import.meta.url).href)});`,
      },
    });
    // XCODE: runner 独占临时目录；Electron/GPU 完全退出后再删除 profile，避免缓存写入竞态。
    const env = { ...process.env, TMPDIR: temporary, TMP: temporary, TEMP: temporary };
    delete env.ELECTRON_RUN_AS_NODE;
    const result = spawnSync(electron, [output, temporary], {
      env,
      stdio: "inherit",
      timeout:
        name === "aiscooAdminUpgradePresentationElectron"
          ? process.env.XCODE_UPGRADE_SMOKE_SEED
            ? 260_000
            : 200_000
          : name === "aiscooAdminModelCapabilitiesElectron"
            ? 120_000
            : 60_000,
    });
    assert.equal(
      result.status,
      0,
      `${name}: ${result.error?.message ?? result.signal ?? "regression failed"}`,
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}
