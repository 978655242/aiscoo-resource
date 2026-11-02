import { access, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_DATA_BASE_DIR_BROWSE,
  TID_SETTINGS_DATA_BASE_DIR_INPUT,
  TID_SETTINGS_DATA_BASE_DIR_SAVE,
  TID_SETTINGS_DATA_BASE_DIR_STATUS,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
} from "../../../helpers/desktop-app.js";
import { restartIntoWorkspacePreservingProfile } from "../../../helpers/model-provider-restart-runtime.js";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "../../../helpers/conversation-session-readonly-tool.js";
import { ensureProjectExpanded } from "../../../helpers/project-sidebar.js";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";

const mode = process.env.AISCOO_E2E_STORAGE_MODE;
const home = process.env.AISCOO_E2E_STORAGE_HOME;
// 只由专用 wdio 包装提供合成 HOME 和渠道根；标准 manual-review 入口选中本文件时跳过，不报加载错误。
const configured = Boolean(home) && ["new", "legacy"].includes(mode ?? "");
const syntheticHome = home ?? "";
const channelRoot = getE2EAppDataPaths().homeDir;
const cliRoot = mode === "legacy" ? join(syntheticHome, "legacy") : channelRoot;
const movedRoot = join(syntheticHome, "moved");
const app = (root: string) => join(root, ".zcode/v2");
const settingsFile = join(app(channelRoot), "setting.json");
const sidecar = join(app(channelRoot), "setting.json.aiscoo-cli-root.json");
const cliDb = join(cliRoot, ".zcode/cli/db/db.sqlite");
const indexDb = (root: string) => join(app(root), "tasks-index.sqlite");
const beforeMarker = "E2E_ACDD_BEFORE";
const afterMarker = "E2E_ACDD_AFTER";
const beforeReply = "ACDD_BEFORE_DONE";
const afterReply = "ACDD_AFTER_DONE";
const facts: Record<string, unknown> = {
  mode,
  syntheticHome,
  channelRoot,
  cliRoot,
  movedRoot,
  stages: [],
};
const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;

describe(`Aiscoo 数据目录 ${mode ?? "unconfigured"}: 渠道根与 HOME 分离`, () => {
  before(function () {
    if (!configured) this.skip();
  });

  after(async () => {
    if (!configured) return;
    if (artifactDir)
      await writeFile(
        join(artifactDir, `aiscoo-directory-${mode}.json`),
        JSON.stringify(facts, null, 2),
      );
    // 运行中的 Main/Host 仍拥有数据目录；清理由 runner 完整退出后负责。
  });

  it(
    mode === "legacy"
      ? "ACDD03 旧 custom CLI 原库捕获后迁移仍可续聊"
      : "ACDD01/02 新安装迁移、默认渠道及真实 HOME 保存重启一致",
    async () => {
      expect(channelRoot).not.toBe(syntheticHome);
      await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
      await assertRuntime("initial", cliRoot);
      await openSettings();
      expect(await inputPath()).toBe(cliRoot);
      await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
      await ensureReadonlyToolFixtureFile();
      await sendV4Prompt(buildReadonlyToolPrompt(beforeMarker));
      await waitForV4AssistantMessageContaining(beforeReply, 60_000);
      const completed = await waitForV4Pane(
        (s) => Boolean(s.sessionId && s.sessionId !== "draft") && !s.canStop,
        "初始任务未完成",
        60_000,
      );
      const taskId = completed.sessionId!;
      facts.taskId = taskId;
      await waitForIndex(cliRoot, taskId);
      const first = cliFacts(taskId);
      expect(first.sessionId).toBe(taskId);
      expect(first.messages.length).toBeGreaterThan(1);
      const originalInode = (await stat(cliDb)).ino;
      facts.initialCli = first;
      const projectCanary = join(DEFAULT_WORKSPACE, ".zcode/aiscoo-directory-project-canary.txt");
      await mkdir(join(DEFAULT_WORKSPACE, ".zcode"), { recursive: true });
      await writeFile(projectCanary, "ACDD_PROJECT_UNMOVED\n");

      if (mode === "legacy") {
        // 只在完整退出屏障内移除本测试产生的绑定记录，模拟带现有自定义根和 CLI 库的首次升级。
        // 不复制或重建 CLI 库、不改 session/message 行；重启必须从现有文件原址捕获该根。
        await coldRestart("legacy-first-capture", cliRoot, async () => {
          expect((await stat(cliDb)).ino).toBe(originalInode);
          await rm(sidecar);
        });
        await restoreTask(taskId);
        expect((await stat(cliDb)).ino).toBe(originalInode);
        expect(cliFacts(taskId).messages).toEqual(first.messages);
        expect(await exists(join(channelRoot, ".zcode/cli/db/db.sqlite"))).toBe(false);
      }
      expect(JSON.parse(await readFile(sidecar, "utf8"))).toEqual({
        version: 1,
        cliBaseDir: cliRoot,
      });
      await mkdir(movedRoot, { recursive: true });
      expect(await readdir(movedRoot)).toEqual([]);
      await writeFile(join(app(cliRoot), "aiscoo-app-canary.txt"), "ACDD_ORIGINAL\n");
      await saveDirectory(movedRoot);
      expect(await persistedRoot()).toBe(movedRoot);
      expect(await readFile(join(app(movedRoot), "aiscoo-app-canary.txt"), "utf8")).toBe(
        "ACDD_ORIGINAL\n",
      );
      expect(await exists(indexDb(movedRoot))).toBe(true);
      expect(await exists(join(app(movedRoot), "setting.json"))).toBe(false);
      expect(await exists(join(app(movedRoot), "setting.json.aiscoo-cli-root.json"))).toBe(false);
      await coldRestart("moved", movedRoot);
      await restoreTask(taskId);
      const oldIndex = indexTime(cliRoot, taskId);
      const newIndex = indexTime(movedRoot, taskId);
      expect(oldIndex).not.toBeNull();
      expect(newIndex).not.toBeNull();
      await sendV4Prompt(afterMarker);
      await waitForV4AssistantMessageContaining(afterReply, 60_000);
      await waitForV4Pane(
        (s) => s.sessionId === taskId && !s.canStop,
        "迁移后同任务续聊未完成",
        60_000,
      );
      await browser.waitUntil(async () => (indexTime(movedRoot, taskId) ?? 0) > (newIndex ?? 0), {
        timeout: 30_000,
        timeoutMsg: "新 App task-index 未推进",
      });
      expect(indexTime(cliRoot, taskId)).toBe(oldIndex);
      const continued = cliFacts(taskId);
      expect(continued.sessionId).toBe(taskId);
      expect(continued.messages.length).toBeGreaterThan(first.messages.length);
      expect(continued.messages.slice(0, first.messages.length)).toEqual(first.messages);
      expect((await stat(cliDb)).ino).toBe(originalInode);
      expect(await exists(join(movedRoot, ".zcode/cli/db/db.sqlite"))).toBe(false);
      expect(await readFile(projectCanary, "utf8")).toBe("ACDD_PROJECT_UNMOVED\n");
      facts.continuedCli = continued;
      facts.index = {
        oldIndex,
        oldAfter: indexTime(cliRoot, taskId),
        newBefore: newIndex,
        newAfter: indexTime(movedRoot, taskId),
      };

      if (mode === "new") {
        await writeFile(join(app(movedRoot), "aiscoo-return-canary.txt"), "ACDD_RETURN_NEW_FILE\n");
        await writeFile(join(app(movedRoot), "aiscoo-app-canary.txt"), "ACDD_SOURCE_CHANGED\n");
        await saveDirectory(channelRoot);
        expect(await persistedRoot()).toBe(channelRoot);
        expect(await readFile(join(app(channelRoot), "aiscoo-return-canary.txt"), "utf8")).toBe(
          "ACDD_RETURN_NEW_FILE\n",
        );
        // 已有渠道根沿用既有 force:false；不要求把迁移目录的 task-index 覆盖或合并回来。
        expect(await readFile(join(app(channelRoot), "aiscoo-app-canary.txt"), "utf8")).toBe(
          "ACDD_ORIGINAL\n",
        );
        await coldRestart("default-channel", channelRoot);
        await openSettings();
        expect(await inputPath()).toBe(channelRoot);
        await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
        expect(await exists(join(syntheticHome, ".zcode/v2"))).toBe(false);
        await saveDirectory(syntheticHome);
        expect(await persistedRoot()).toBe(syntheticHome);
        expect(await readFile(join(app(syntheticHome), "aiscoo-return-canary.txt"), "utf8")).toBe(
          "ACDD_RETURN_NEW_FILE\n",
        );
        await coldRestart("real-home", syntheticHome);
        await openSettings();
        expect(await inputPath()).toBe(syntheticHome);
        expect(await exists(join(syntheticHome, ".zcode/cli/db/db.sqlite"))).toBe(false);
      }
      expect(JSON.parse(await readFile(sidecar, "utf8"))).toEqual({
        version: 1,
        cliBaseDir: cliRoot,
      });
      expect((await stat(cliDb)).ino).toBe(originalInode);
      if (artifactDir)
        await browser.saveScreenshot(join(artifactDir, `aiscoo-directory-${mode}.png`));
      facts.passed = true;
    },
  );
});

async function assertRuntime(stage: string, active: string) {
  const runtime = await browser.electron.execute((electron) => ({
    pid: process.pid,
    home: process.env.HOME,
    electronHome: electron.app.getPath("home"),
    settings: process.env.ZCODE_SETTINGS_FILE_PATH,
    hostPids: electron.app
      .getAppMetrics()
      .filter(
        (metric) =>
          metric.name?.startsWith("zcode-host") || metric.serviceName?.startsWith("zcode-host"),
      )
      .map((metric) => metric.pid),
  }));
  expect(runtime.home).toBe(syntheticHome);
  expect(runtime.electronHome).toBe(syntheticHome);
  expect(runtime.settings).toBe(settingsFile);
  expect(runtime.hostPids.length).toBeGreaterThan(0);
  // macOS 在 Host 设置 process.title 后不再通过 ps 提供环境；不能将缺失读数当成路径错误。
  // 使用真实设置页与下方新旧 task-index / CLI 原库写入证据交叉验证生效目录。
  await openSettings();
  const displayedRoot = await inputPath();
  expect(displayedRoot).toBe(active);
  await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
  const response = await fetch(`${process.env.AISCOO_E2E_ACCOUNT_ORIGIN}/__e2e/facts`);
  const account = (await response.json()) as {
    requests: Array<{ path: string; authorized: boolean }>;
  };
  expect(
    account.requests.some((request) => request.path === "/api/xcode/v1/me" && request.authorized),
  ).toBe(true);
  (facts.stages as unknown[]).push({ stage, active, displayedRoot, runtime, account });
}

async function coldRestart(stage: string, active: string, afterExit?: () => Promise<void>) {
  const oldPid = await browser.electron.execute(() => process.pid);
  await restartIntoWorkspacePreservingProfile(DEFAULT_WORKSPACE, {
    afterElectronProcessExit: afterExit,
  });
  const newPid = await browser.electron.execute(() => process.pid);
  expect(newPid).not.toBe(oldPid);
  await assertRuntime(stage, active);
}

async function restoreTask(taskId: string) {
  await ensureProjectExpanded(DEFAULT_WORKSPACE);
  await selectV4TaskById(taskId);
  await waitForV4TimelineContaining(beforeMarker, 60_000);
  await waitForV4AssistantMessageContaining(beforeReply, 60_000);
  await waitForV4Pane(
    (s) => s.sessionId === taskId && !s.canStop,
    "冷恢复未回到原任务 idle",
    60_000,
  );
}

async function openSettings() {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (id) => Boolean(document.querySelector(`[data-testid="${id}"]`)),
        TID_SETTINGS_PAGE,
      ),
    { timeout: 15_000, timeoutMsg: "设置页未出现" },
  );
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, "general"));
  await browser.waitUntil(async () => (await inputPath()) !== null, {
    timeout: 15_000,
    timeoutMsg: "目录输入框未出现",
  });
}

function inputPath(): Promise<string | null> {
  return browser.execute(
    (id) => document.querySelector<HTMLInputElement>(`[data-testid="${id}"]`)?.value ?? null,
    TID_SETTINGS_DATA_BASE_DIR_INPUT,
  );
}

async function saveDirectory(target: string) {
  await openSettings();
  // 只替代系统目录选择器的一次返回值；设置页、复制与保存仍走真实链路。
  // 不用 browser.electron.mock：wdio-electron-service 只在会话启动时保存一份原始 API，
  // 冷重启后 runner 里缓存的 mock 指向旧 Main，restore 也找不到新进程的原始函数，
  // 第二次起选择不会返回。这里在当前 Main 上替换一次，调用后立即还原，并记录调用参数。
  await browser.electron.execute((electron, directory) => {
    const original = electron.dialog.showOpenDialog;
    const calls: unknown[][] = [];
    (globalThis as { __aiscooDirectoryPickerCalls?: unknown[][] }).__aiscooDirectoryPickerCalls =
      calls;
    electron.dialog.showOpenDialog = (async (...args: unknown[]) => {
      electron.dialog.showOpenDialog = original;
      calls.push(
        args.map((arg) => (arg && typeof arg === "object" && "id" in arg ? "window" : arg)),
      );
      return { canceled: false, filePaths: [directory] };
    }) as typeof original;
  }, target);
  await clickTestIdByDom(TID_SETTINGS_DATA_BASE_DIR_BROWSE);
  await browser.waitUntil(async () => (await inputPath()) === target, {
    timeout: 15_000,
    timeoutMsg: "所选目录未显示",
  });
  const calls = await browser.electron.execute(
    () =>
      (globalThis as { __aiscooDirectoryPickerCalls?: unknown[][] }).__aiscooDirectoryPickerCalls ??
      [],
  );
  expect(calls).toHaveLength(1);
  expect(JSON.stringify(calls[0])).toContain("openDirectory");
  await clickTestIdByDom(TID_SETTINGS_DATA_BASE_DIR_SAVE);
  await browser.waitUntil(
    async () =>
      browser.execute(
        (id) =>
          document.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.dataset.state === "saved",
        TID_SETTINGS_DATA_BASE_DIR_STATUS,
      ),
    { timeout: 60_000, timeoutMsg: "复制未进入待重启状态" },
  );
}

async function persistedRoot(): Promise<string | undefined> {
  return (JSON.parse(await readFile(settingsFile, "utf8")) as { dataBaseDir?: string }).dataBaseDir;
}

function cliFacts(taskId: string) {
  const db = new DatabaseSync(cliDb, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const row = db.prepare("SELECT id FROM session WHERE id=?").get(taskId);
    const messages = db
      .prepare("SELECT id FROM message WHERE session_id=? ORDER BY time_created,id")
      .all(taskId)
      .map((message) => String(message.id));
    return { path: cliDb, sessionId: row?.id, messages };
  } finally {
    db.close();
  }
}

function indexTime(root: string, taskId: string): number | null {
  const db = new DatabaseSync(indexDb(root), { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const row = db.prepare("SELECT updated_at FROM tasks WHERE task_id=?").get(taskId);
    return typeof row?.updated_at === "number" ? row.updated_at : null;
  } finally {
    db.close();
  }
}

async function waitForIndex(root: string, taskId: string) {
  await browser.waitUntil(async () => indexTime(root, taskId) !== null, {
    timeout: 30_000,
    timeoutMsg: "初始 task-index 未持久化",
  });
}

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
