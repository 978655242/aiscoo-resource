import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { globSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const cwd = fileURLToPath(new URL("..", import.meta.url));
const newApiTests = globSync("packages/services/test/newApi*.test.ts", { cwd }).sort();
assert.ok(newApiTests.length > 0, "Native account regressions are missing");
const root = await mkdtemp(join(tmpdir(), "xwork-native-unit-"));
try {
  const child = spawn(
    process.execPath,
    [
      "--import",
      pathToFileURL(resolve(cwd, "scripts/test/native-unit-test-setup.mjs")).href,
      require.resolve("tsx/cli"),
      "--experimental-test-module-mocks",
      "--tsconfig",
      "packages/services/test/tsconfig.json",
      "--test",
      ...newApiTests,
      // XCODE: Aiscoo 唯一账号策略的 Host 失败关闭回归，不挂 newApi 前缀，需显式登记。
      "packages/services/test/aiscooOnlyHost.test.ts",
      // XCODE: 命令同步的路径安全回归走真实服务入口，独立于已退役 App 单测。
      "packages/services/test/aiscooCommandDataSyncPathSafety.test.ts",
      "packages/services/test/officialCloudOwner.test.ts",
      "packages/services/test/offPeakExecutionLifetime.test.ts",
      "packages/services/test/conversationShareOperationFence.test.ts",
      "packages/services/test/officialInvocationDispatch.test.ts",
      "packages/desktop/test/newApiOAuthRoutes.test.ts",
      "packages/desktop/test/desktopLocalDevelopmentBundle.test.ts",
      "packages/desktop/scripts/devElectronAppArgs.test.mjs",
      "packages/desktop/scripts/devElectronAppBundle.test.mjs",
      "scripts/test/unit-test-isolation.test.mjs",
      "scripts/test/architecture-policy-xwork.test.mjs",
      // XCODE: 下游桌面身份与数据路径回归进入现有独立门禁。
      "scripts/test/aiscoo-desktop-packaging-identity.test.mjs",
      "scripts/test/aiscoo-desktop-data-identity.test.mjs",
      // XCODE: 公证续跑必须复用原提交与 DMG，离线命令替身验证实际脚本分流。
      "scripts/test/aiscoo-notarize-macos.test.mjs",
      // XCODE: 桌面登录凭据不触发系统钥匙串授权的门禁（2026-11-01 决定，规格 new-api-integration §4.2）。
      "scripts/test/aiscoo-desktop-credential-no-keychain.test.mjs",
      "scripts/test/aiscoo-desktop-deep-link-identity.test.mjs",
      "scripts/test/aiscoo-export-logs-credential-backup.test.mjs",
      // XCODE: 原生资源策略与运行时目录隔离的独立工程回归。
      "scripts/test/native-resource-directories.test.mjs",
      "packages/desktop/test/native-resource-bootstrap.test.mjs",
    ],
    {
      cwd,
      stdio: "inherit",
      // XCODE: 数据与备份归 runner；保留系统 TMPDIR，避免 macOS 的 tsx socket 路径超限。
      env: {
        ...process.env,
        HOME: root,
        USERPROFILE: root,
        ZCODE_DATA_BASE_DIR: root,
      },
    },
  );
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    process.exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 1));
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
  // 一键启动器依赖 launchctl 与 /usr/sbin/lsof，只在 macOS 上有意义；Linux CI 跳过。
  if (process.exitCode === 0 && process.platform === "darwin") {
    process.exitCode = await new Promise((resolve, reject) => {
      const python = spawn("python3", ["scripts/xcode/start-local.test.py"], {
        cwd,
        stdio: "inherit",
        env: { ...process.env, HOME: root, USERPROFILE: root },
      });
      python.once("error", reject);
      python.once("close", (code) => resolve(code ?? 1));
    });
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
