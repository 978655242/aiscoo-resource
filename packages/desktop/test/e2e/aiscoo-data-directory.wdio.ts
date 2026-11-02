import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { FileSystemPathService } from "@wdio/config/node";

const desktopDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const home = process.env.AISCOO_E2E_STORAGE_HOME?.trim();
const mode = process.env.AISCOO_E2E_STORAGE_MODE ?? "new";
if (
  !home ||
  !isAbsolute(home) ||
  dirname(home) !== desktopDir ||
  !basename(home).startsWith(".e2e-home-aiscoo-storage-") ||
  !["new", "legacy"].includes(mode)
)
  throw new Error("Use a dedicated desktop/.e2e-home-aiscoo-storage-* and new|legacy mode");
if (process.env.ZCODE_E2E_SKIP_BUILD !== "1" || process.env.ZCODE_E2E_SKIP_AGENT_BUILD !== "1") {
  throw new Error("Complete coordinated typecheck and fresh E2E/CLI builds before this acceptance");
}
const channel = join(home, "channel");
const legacy = join(home, "legacy");
const spec = "./test/e2e/conversation-session/manual-review/pending/aiscoo-data-directory.test.ts";
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ZCODE_E2E_HOME_DIR = channel;
process.env.ZCODE_E2E_SPEC = spec;
process.env.ZCODE_E2E_MANUAL_REVIEW = "1";
process.env.ZCODE_E2E_KEEP_HOME_ON_FAIL = "1";
process.env.E2E_PROVIDER_HTTP_MODE = "replay";
process.env.E2E_PROVIDER_REPLAY_FIXTURE_PATH = [
  join(desktopDir, "test/e2e/fixtures/upstream/common.json"),
  join(desktopDir, "test/e2e/fixtures/upstream/conversation-session/aiscoo-data-directory.json"),
].join(",");

// 上游 reporter 依赖 CJS named exports；复用 WDIO 自带兼容加载器，避免整个带顶层 await 的 wrapper 被 jiti 重译。
const { config: upstream } = await new FileSystemPathService().loadFile<{
  config: WebdriverIO.Config;
}>(pathToFileURL(join(desktopDir, "wdio.conf.ts")).href);
const { startAiscooDirectoryAccountFixture } = await import("./aiscoo-data-directory-account.js");
// 上游 helper 的夹具根仍为 C；仅真实进程 HOME 为 H，保留既有 provider/项目准备路径。
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.ZCODE_DESKTOP_HOME_DIR = home;
delete process.env.ZCODE_CREDENTIAL_SECRET;
const beforeSession = upstream.beforeSession;
const afterSession = upstream.afterSession;
const onComplete = upstream.onComplete;
if (
  typeof beforeSession !== "function" ||
  typeof afterSession !== "function" ||
  typeof onComplete !== "function"
) {
  throw new Error("Upstream WDIO lifecycle hook contract changed");
}
let account: Awaited<ReturnType<typeof startAiscooDirectoryAccountFixture>> | undefined;

export const config: WebdriverIO.Config = {
  ...upstream,
  rootDir: desktopDir,
  specs: [spec],
  mochaOpts: { ...upstream.mochaOpts, timeout: 360_000 },
  runnerEnv: {
    ...upstream.runnerEnv,
    HOME: home,
    USERPROFILE: home,
    ZCODE_DESKTOP_HOME_DIR: home,
    AISCOO_E2E_STORAGE_HOME: home,
    AISCOO_E2E_STORAGE_MODE: mode,
  },
  async beforeSession(workerConfig, capabilities, specs, cid) {
    await beforeSession.call(this, workerConfig, capabilities, specs, cid);
    account = await startAiscooDirectoryAccountFixture();
    process.env.AISCOO_E2E_ACCOUNT_ORIGIN = account.origin;
    const appDir = join(channel, ".zcode/v2");
    await account.seed(join(appDir, "credentials.json"));
    if (mode === "legacy") {
      const settingsFile = join(appDir, "setting.json");
      const settings = JSON.parse(await readFile(settingsFile, "utf8"));
      await writeFile(settingsFile, JSON.stringify({ ...settings, dataBaseDir: legacy }, null, 2));
      await mkdir(join(legacy, ".zcode"), { recursive: true });
      await cp(appDir, join(legacy, ".zcode/v2"), {
        recursive: true,
        filter: (source) => basename(source) !== "setting.json",
      });
    }
    const desktopCapabilities = capabilities as {
      "wdio:electronServiceOptions"?: { appArgs?: string[] };
      "goog:chromeOptions"?: { args?: string[] };
    };
    const electronOptions = desktopCapabilities["wdio:electronServiceOptions"];
    const appArg = electronOptions?.appArgs?.find((arg) => arg.startsWith("--app="));
    if (!appArg) throw new Error("Aiscoo acceptance requires the staged source build");
    const main = appArg.slice("--app=".length);
    const entry = join(dirname(main), "aiscoo-data-directory-e2e.mjs");
    // ChromeDriver 已在上游 hook 内启动；入口在生产 Main import 前覆盖环境，避免其继承的
    // C=HOME 和 reporter LOG override 把稳定 CLI 根的缺陷藏起来。生产路径实现不替换。
    await writeFile(
      entry,
      [
        `Object.assign(process.env, ${JSON.stringify({
          HOME: home,
          USERPROFILE: home,
          ZCODE_DESKTOP_HOME_DIR: home,
          ZCODE_DATA_BASE_DIR: channel,
          AISCOO_ADMIN_BASE_URL: account.origin,
        })});`,
        `for (const key of ${JSON.stringify([
          "ZCODE_STORAGE_DIR",
          "ZCODE_SESSION_DB_PATH",
          "ZCODE_LOG_DIR",
          "ZCODE_SETTINGS_FILE_PATH",
          "AISCOO_DESKTOP_DEFAULT_DATA_BASE_DIR",
          "ZCODE_CREDENTIAL_SECRET",
        ])}) delete process.env[key];`,
        `await import(${JSON.stringify(pathToFileURL(main).href)});`,
      ].join("\n"),
    );
    if (!electronOptions) throw new Error("Missing Electron capabilities");
    electronOptions.appArgs = electronOptions.appArgs?.map((arg) =>
      arg === appArg ? `--app=${entry}` : arg,
    );
    const chrome = desktopCapabilities["goog:chromeOptions"];
    if (chrome?.args)
      chrome.args = chrome.args.map((arg) => (arg.startsWith("--app=") ? `--app=${entry}` : arg));
  },
  async afterSession(...args) {
    try {
      await afterSession.call(this, ...args);
    } finally {
      await account?.close();
    }
  },
  async onComplete(...args) {
    await onComplete.call(this, ...args);
    // 上游 onComplete 已确认本轮完整进程树退出；失败保留现场，不在 spec.after 删除活跃数据。
    if (args[0] === 0) await rm(home, { recursive: true, force: true });
  },
};
