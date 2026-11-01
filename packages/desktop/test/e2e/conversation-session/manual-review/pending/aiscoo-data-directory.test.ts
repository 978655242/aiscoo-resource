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
if (!home || !["new", "legacy"].includes(mode ?? "")) {
  throw new Error("Run with the dedicated aiscoo-data-directory.wdio.ts wrapper");
}
const H = home;
const C = getE2EAppDataPaths().homeDir;
const B = mode === "legacy" ? join(H, "legacy") : C;
const D = join(H, "moved");
const app = (root: string) => join(root, ".zcode/v2");
const settingsFile = join(app(C), "setting.json");
const sidecar = join(app(C), "setting.json.aiscoo-cli-root.json");
const cliDb = join(B, ".zcode/cli/db/db.sqlite");
const indexDb = (root: string) => join(app(root), "tasks-index.sqlite");
const beforeMarker = "E2E_ACDD_BEFORE";
const afterMarker = "E2E_ACDD_AFTER";
const beforeReply = "ACDD_BEFORE_DONE";
const afterReply = "ACDD_AFTER_DONE";
const facts: Record<string, unknown> = { mode, H, C, B, D, stages: [] };
const artifactDir = process.env.ZCODE_E2E_ARTIFACT_DIR;

describe(`Aiscoo 数据目录 ${mode}: 渠道根与 HOME 分离`, () => {
  after(async () => {
    await browser.electron.restoreAllMocks();
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
      expect(C).not.toBe(H);
      await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
      await assertRuntime("initial", B);
      await openSettings();
      expect(await inputPath()).toBe(B);
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
      await waitForIndex(B, taskId);
      const first = cliFacts(taskId);
      expect(first.sessionId).toBe(taskId);
      expect(first.messages.length).toBeGreaterThan(1);
      const originalInode = (await stat(cliDb)).ino;
      facts.initialCli = first;
      const projectCanary = join(DEFAULT_WORKSPACE, ".zcode/aiscoo-directory-project-canary.txt");
      await mkdir(join(DEFAULT_WORKSPACE, ".zcode"), { recursive: true });
      await writeFile(projectCanary, "ACDD_PROJECT_UNMOVED\n");

      if (mode === "legacy") {
        // 只在完整退出屏障内移除本测试产生的 sidecar，模拟带现有 D/CLI 库的首次升级。
        // 不复制/重建 CLI 库、不改 session/message 行；恢复必须从现有文件原址捕获 B=D。
        await coldRestart("legacy-first-capture", B, async () => {
          expect((await stat(cliDb)).ino).toBe(originalInode);
          await rm(sidecar);
        });
        await restoreTask(taskId);
        expect((await stat(cliDb)).ino).toBe(originalInode);
        expect(cliFacts(taskId).messages).toEqual(first.messages);
        expect(await exists(join(C, ".zcode/cli/db/db.sqlite"))).toBe(false);
      }
      expect(JSON.parse(await readFile(sidecar, "utf8"))).toEqual({ version: 1, cliBaseDir: B });
      await mkdir(D, { recursive: true });
      expect(await readdir(D)).toEqual([]);
      await writeFile(join(app(B), "aiscoo-app-canary.txt"), "ACDD_ORIGINAL\n");
      await saveDirectory(D);
      expect(await persistedRoot()).toBe(D);
      expect(await readFile(join(app(D), "aiscoo-app-canary.txt"), "utf8")).toBe("ACDD_ORIGINAL\n");
      expect(await exists(indexDb(D))).toBe(true);
      expect(await exists(join(app(D), "setting.json"))).toBe(false);
      expect(await exists(join(app(D), "setting.json.aiscoo-cli-root.json"))).toBe(false);
      await coldRestart("moved", D);
      await restoreTask(taskId);
      const oldIndex = indexTime(B, taskId);
      const newIndex = indexTime(D, taskId);
      expect(oldIndex).not.toBeNull();
      expect(newIndex).not.toBeNull();
      await sendV4Prompt(afterMarker);
      await waitForV4AssistantMessageContaining(afterReply, 60_000);
      await waitForV4Pane(
        (s) => s.sessionId === taskId && !s.canStop,
        "迁移后同任务续聊未完成",
        60_000,
      );
      await browser.waitUntil(async () => (indexTime(D, taskId) ?? 0) > (newIndex ?? 0), {
        timeout: 30_000,
        timeoutMsg: "新 App task-index 未推进",
      });
      expect(indexTime(B, taskId)).toBe(oldIndex);
      const continued = cliFacts(taskId);
      expect(continued.sessionId).toBe(taskId);
      expect(continued.messages.length).toBeGreaterThan(first.messages.length);
      expect(continued.messages.slice(0, first.messages.length)).toEqual(first.messages);
      expect((await stat(cliDb)).ino).toBe(originalInode);
      expect(await exists(join(D, ".zcode/cli/db/db.sqlite"))).toBe(false);
      expect(await readFile(projectCanary, "utf8")).toBe("ACDD_PROJECT_UNMOVED\n");
      facts.continuedCli = continued;
      facts.index = {
        oldIndex,
        oldAfter: indexTime(B, taskId),
        newBefore: newIndex,
        newAfter: indexTime(D, taskId),
      };

      if (mode === "new") {
        await writeFile(join(app(D), "aiscoo-return-canary.txt"), "ACDD_RETURN_NEW_FILE\n");
        await writeFile(join(app(D), "aiscoo-app-canary.txt"), "ACDD_SOURCE_CHANGED\n");
        await saveDirectory(C);
        expect(await persistedRoot()).toBe(C);
        expect(await readFile(join(app(C), "aiscoo-return-canary.txt"), "utf8")).toBe(
          "ACDD_RETURN_NEW_FILE\n",
        );
        // 已有 C 使用既有 force:false；不要求把 D 的 task-index 覆盖或合并回 C。
        expect(await readFile(join(app(C), "aiscoo-app-canary.txt"), "utf8")).toBe(
          "ACDD_ORIGINAL\n",
        );
        await coldRestart("default-channel", C);
        await openSettings();
        expect(await inputPath()).toBe(C);
        await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);
        expect(await exists(join(H, ".zcode/v2"))).toBe(false);
        await saveDirectory(H);
        expect(await persistedRoot()).toBe(H);
        expect(await readFile(join(app(H), "aiscoo-return-canary.txt"), "utf8")).toBe(
          "ACDD_RETURN_NEW_FILE\n",
        );
        await coldRestart("real-home", H);
        await openSettings();
        expect(await inputPath()).toBe(H);
        expect(await exists(join(H, ".zcode/cli/db/db.sqlite"))).toBe(false);
      }
      expect(JSON.parse(await readFile(sidecar, "utf8"))).toEqual({ version: 1, cliBaseDir: B });
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
  expect(runtime.home).toBe(H);
  expect(runtime.electronHome).toBe(H);
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
  // WDIO 9 的 mock registry 跨冷重启保留旧对象，mockReset 在新 Main 的原函数上静默失效。
  // 只替换当前 Main 的一次原生选目录返回，调用后立即恢复；设置页、复制与保存仍走真实路径。
  await browser.electron.execute((electron, directory) => {
    const original = electron.dialog.showOpenDialog;
    electron.dialog.showOpenDialog = async () => {
      electron.dialog.showOpenDialog = original;
      return { canceled: false, filePaths: [directory] };
    };
  }, target);
  await clickTestIdByDom(TID_SETTINGS_DATA_BASE_DIR_BROWSE);
  await browser.waitUntil(async () => (await inputPath()) === target, {
    timeout: 15_000,
    timeoutMsg: "所选目录未显示",
  });
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
