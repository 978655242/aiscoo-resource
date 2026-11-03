import { access, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  TID_AUTOMATIONS_PAGE_TAB,
  TID_CHAT_WORKFLOW_RUN_DIGEST,
  TID_WORKFLOW_CARD,
  TID_WORKFLOW_CARD_RUN,
  TID_WORKFLOW_DETAIL,
  TID_WORKFLOW_DETAIL_DESCRIPTION,
  TID_WORKFLOW_META_SAVE,
  type NativeMcpServerRecord,
} from "@zcode/shared";
import {
  TID_AUTOMATIONS_OPEN,
  TID_SETTINGS_BACK_BUTTON,
  TID_SETTINGS_PAGE,
  TID_SETTINGS_PERSONALIZATION_EDITOR,
  TID_SETTINGS_PERSONALIZATION_SAVE,
  TID_SETTINGS_SECTION_NAV,
  TID_TASK_SETTINGS_BUTTON,
  testId,
} from "@zcode/shared/test-ids";
import {
  clickTestIdByDom,
  DEFAULT_WORKSPACE,
  getE2EAppDataPaths,
  setInputValueByTestIdDom,
  waitForTestIdByDom,
} from "../../../helpers/desktop-app.js";
import { restartIntoWorkspacePreservingProfile } from "../../../helpers/model-provider-restart-runtime.js";
import {
  buildReadonlyToolPrompt,
  ensureReadonlyToolFixtureFile,
} from "../../../helpers/conversation-session-readonly-tool.js";
import { ensureProjectExpanded, startDraftFromProject } from "../../../helpers/project-sidebar.js";
import { getUpstreamRequestEvidence } from "../../../helpers/conversation-session-network.js";
import { readDynamicWorkflowGrayMockStatus } from "../../../helpers/dynamic-workflow-gray.js";
import { selectPluginSettingsScope } from "../../../helpers/plugin-management-lifecycle.js";
import {
  prepareV4ConversationE2E,
  selectV4TaskById,
  sendV4Prompt,
  waitForV4AssistantMessageContaining,
  waitForV4Pane,
  waitForV4TimelineContaining,
} from "../../../helpers/v4-conversation.js";
import {
  nativeResourceAcceptancePaths,
  nativeResourceWorkflowSource,
} from "../../../helpers/native-resource-directories.js";

// NCR01–NCR07：已批准的资源策略验收。专用 wrapper 在 Main/Host 启动前播种新旧根，
// HOME、项目、App 根三者分离；默认入口跳过，不接触开发者真实资源。invalid 由入口工程回归覆盖。
const home = process.env.AISCOO_E2E_STORAGE_HOME;
const mode = process.env.AISCOO_E2E_NATIVE_MODE;
const directoryName = mode === "override" ? ".native-e2e" : ".aiscoo";
const paths = nativeResourceAcceptancePaths(
  home ?? "",
  getE2EAppDataPaths().homeDir,
  DEFAULT_WORKSPACE,
  directoryName,
);
const configured = Boolean(home) && ["product", "override"].includes(mode ?? "");
const coreCases = ["NCR01", "NCR02", "NCR03", "NCR04", "NCR06", "NCR07"];
const passedCases: string[] = [];
const workflowBlockedCode = "AISCOO_OFFICIAL_CLOUD_UNAVAILABLE";
const facts: Record<string, unknown> = {
  mode,
  paths,
  coreCases,
  corePassed: false,
  passedCases,
  NCR05: { status: "pending", covered: false },
};

describe(`原生资源目录 ${mode ?? "unconfigured"}`, () => {
  before(function () {
    if (!configured) this.skip();
  });
  after(async () => {
    if (!configured) return;
    facts.uiAtEnd = await browser
      .execute(() => ({
        text: document.body.innerText.slice(0, 8000),
        automationTestIds: Array.from(document.querySelectorAll("[data-testid]"))
          .map((element) => element.getAttribute("data-testid") ?? "")
          .filter((id) => id.includes("automation") || id.includes("workflow")),
      }))
      .catch((error) => ({ unavailable: String(error) }));
    const artifacts = process.env.ZCODE_E2E_ARTIFACT_DIR;
    if (artifacts)
      await writeFile(
        join(artifacts, "native-resource-directories.json"),
        JSON.stringify(facts, null, 2),
      );
    // Main/Host 仍拥有隔离根；退出屏障后由 runner 清理。
  });

  it("NCR01–04/06/07: 当前根读写、兼容 fallback、真实请求与完整冷恢复保持运行时库", async function () {
    this.timeout(360_000);
    expect(paths.home).not.toBe(paths.appRoot);
    expect(paths.home).not.toBe(paths.workspace);
    await prepareV4ConversationE2E({ resetDraftBeforeProvider: true });
    const runtime = await browser.electron.execute(() => ({
      home: process.env.HOME,
      settings: process.env.ZCODE_SETTINGS_FILE_PATH,
      resource: process.env.ZCODE_NATIVE_RESOURCE_DIR_NAME,
      pid: process.pid,
    }));
    expect(runtime.home).toBe(paths.home);
    expect(runtime.settings).toBe(paths.settings);
    expect(runtime.resource).toBe(directoryName);
    facts.initialRuntime = runtime;

    // Main 的真实 preload → IPC → 文件适配器，校验 location/file 与读写目标一致。
    const servers = await loadMcp();
    expect(servers.map((server) => server.name).sort()).toEqual(["native-project", "native-user"]);
    for (const server of servers)
      expect(server.file?.filePath).toBe(
        server.scope === "user" ? paths.userConfig : paths.projectConfig,
      );
    await saveMcp({
      source: "zcodeagentmcp",
      action: "upsert",
      name: "written-user",
      config: { command: "node", args: ["--version"], enabled: false },
    });
    await saveMcp({
      source: "zcodeagentmcp",
      action: "upsert",
      name: "written-project",
      projectPath: paths.workspace,
      config: { command: "node", args: ["--version"], enabled: false },
    });
    expect(await readFile(paths.oldUserConfig, "utf8")).toBe(paths.oldUserConfigBytes);
    expect(await readFile(paths.oldProjectConfig, "utf8")).toBe(paths.oldProjectConfigBytes);
    const written = await loadMcp();
    expect(written.some((server) => server.name === "written-user")).toBe(true);
    expect(written.some((server) => server.name === "written-project")).toBe(true);
    for (const name of ["written-user", "written-project"]) {
      const server = written.find((item) => item.name === name)!;
      await saveMcp({
        source: "zcodeagentmcp",
        action: "set-enabled",
        name,
        enabled: false,
        location: server.location,
        ...(server.projectPath ? { projectPath: server.projectPath } : {}),
      });
      await saveMcp({
        source: "zcodeagentmcp",
        action: "delete",
        name,
        ...(server.projectPath ? { projectPath: server.projectPath } : {}),
      });
    }
    const nativeUser = JSON.parse(await readFile(paths.userConfig, "utf8"));
    const nativeProject = JSON.parse(await readFile(paths.projectConfig, "utf8"));
    await writeFile(
      paths.userConfig,
      JSON.stringify({ ...nativeUser, mcp: { ...nativeUser.mcp, servers: {} } }),
    );
    await writeFile(
      paths.projectConfig,
      JSON.stringify({ ...nativeProject, mcp: { ...nativeProject.mcp, servers: {} } }),
    );
    expect((await loadMcp()).map((server) => server.name).sort()).toEqual([
      "compat-project",
      "compat-user",
    ]);
    await writeFile(paths.userConfig, JSON.stringify(nativeUser));
    await writeFile(paths.projectConfig, JSON.stringify(nativeProject));

    await openSettings("personalization");
    const editor = await readEditor();
    expect(editor).toContain("NCR_SELECTED_USER_AGENTS");
    expect(editor).not.toContain("NCR_OLD_USER_AGENTS");
    await setInputValueByTestIdDom(
      TID_SETTINGS_PERSONALIZATION_EDITOR,
      `${editor}\nNCR_EDITED_USER_AGENTS\n`,
    );
    await clickTestIdByDom(TID_SETTINGS_PERSONALIZATION_SAVE);
    await browser.waitUntil(
      async () => (await readFile(paths.userAgents, "utf8")).includes("NCR_EDITED_USER_AGENTS"),
      { timeout: 15_000, timeoutMsg: "用户 AGENTS 编辑未写入选定根" },
    );
    expect(await readFile(paths.oldUserAgents, "utf8")).toBe("NCR_OLD_USER_AGENTS\n");
    // XCODE: 当前独立能力页由 PluginsSection 承载；技能入口是单数 skill，不能拿资源类型 skills 拼旧导航。
    for (const { resource, section } of [
      { resource: "skills", section: "skill" },
      { resource: "commands", section: "commands" },
    ] as const) {
      await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, section));
      await selectPluginSettingsScope("user");
      await browser.waitUntil(
        async () => (await readResourcePanelText())?.includes("ncr-native-user") ?? false,
        { timeout: 30_000, timeoutMsg: `${resource} 用户视图未发现当前根资源` },
      );
      const text = await readResourcePanelText();
      expect(text).not.toBeNull();
      expect(text).not.toContain("ncr-old");
      expect(text).not.toContain("ncr-fake-library");
      // XCODE: 用户技能合并 .agents；Host 命令沿用同 scope native 非空时不参与 .agents 的原规则。
      if (resource === "skills") expect(text).toContain("ncr-compat-user");
      else expect(text).not.toContain("ncr-compat-user");
      expect(text).not.toContain("ncr-refreshed-user");
      if (resource === "skills") {
        const skillDir = join(paths.home, directoryName, "skills/ncr-refreshed-user");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
          join(skillDir, "SKILL.md"),
          "---\nname: ncr-refreshed-user\ndescription: NCR_NATIVE_REFRESH\n---\nSynthetic refreshed skill.\n",
        );
      } else {
        await writeFile(
          join(paths.home, directoryName, "commands/ncr-refreshed-user.md"),
          "---\ndescription: NCR_NATIVE_REFRESH\n---\nSynthetic refreshed command.\n",
        );
      }
      // XCODE: 两个设置列表沿用既有显式刷新语义，不把未提供的自动监听当成本次目录策略要求。
      await refreshResourcePanel();
      await browser.waitUntil(
        async () => (await readResourcePanelText())?.includes("ncr-refreshed-user") ?? false,
        { timeout: 30_000, timeoutMsg: `${resource} 用户视图显式刷新后未发现当前根新增资源` },
      );
      const refreshed = await readResourcePanelText();
      expect(refreshed).toContain("ncr-native-user");
      expect(refreshed).not.toContain("ncr-old");
      expect(refreshed).not.toContain("ncr-fake-library");
      if (resource === "skills") {
        expect(refreshed).toContain("ncr-compat-user");
      } else {
        expect(refreshed).not.toContain("ncr-compat-user");
        const nativeCommands = join(paths.home, directoryName, "commands");
        const backup = join(paths.home, "ncr-commands-fallback-backup");
        const originalCommand = join(nativeCommands, "ncr-native-user.md");
        const newCommand = join(nativeCommands, "ncr-refreshed-user.md");
        const originalBytes = await readFile(originalCommand, "utf8");
        const newBytes = await readFile(newCommand, "utf8");
        expect(await exists(backup)).toBe(false);
        // XCODE: 只临时移开本例合成 HOME 的选定命令目录，验证空 native fallback；旧 .zcode canary 不动。
        await rename(nativeCommands, backup);
        try {
          await refreshResourcePanel();
          await browser.waitUntil(
            async () => {
              const fallback = await readResourcePanelText();
              return Boolean(
                fallback?.includes("ncr-compat-user") &&
                !fallback.includes("ncr-native-user") &&
                !fallback.includes("ncr-refreshed-user"),
              );
            },
            {
              timeout: 30_000,
              timeoutMsg: "Host 命令显式刷新后未切换到空 native 的 .agents fallback",
            },
          );
          const fallback = await readResourcePanelText();
          expect(fallback).not.toContain("ncr-old");
          expect(fallback).not.toContain("ncr-fake-library");
        } finally {
          // 任何 UI 或断言失败都必须先原址恢复目录，不留资源改动给后续冷启动。
          await rename(backup, nativeCommands);
        }
        expect(await readFile(originalCommand, "utf8")).toBe(originalBytes);
        expect(await readFile(newCommand, "utf8")).toBe(newBytes);
        expect(await exists(backup)).toBe(false);
        await refreshResourcePanel();
        await browser.waitUntil(
          async () => {
            const restored = await readResourcePanelText();
            return Boolean(
              restored?.includes("ncr-native-user") &&
              restored.includes("ncr-refreshed-user") &&
              !restored.includes("ncr-compat-user"),
            );
          },
          { timeout: 30_000, timeoutMsg: "Host 命令恢复后显式刷新未重新使用 native 优先规则" },
        );
        const restored = await readResourcePanelText();
        expect(restored).not.toContain("ncr-old");
        expect(restored).not.toContain("ncr-fake-library");
        facts.hostCommandFallbackVerified = true;
      }
    }
    await clickTestIdByDom(TID_SETTINGS_BACK_BUTTON);

    await startDraftFromProject(paths.workspace);
    await ensureReadonlyToolFixtureFile();
    await sendV4Prompt(buildReadonlyToolPrompt("E2E_NCR_BEFORE"));
    await waitForV4AssistantMessageContaining("NCR_BEFORE_DONE", 60_000);
    const wire = await getUpstreamRequestEvidence({ lastUserMessageIncludes: ["E2E_NCR_BEFORE"] });
    expect(wire.length).toBeGreaterThan(0);
    const requestText = JSON.stringify(wire.map((request) => request.requestJson));
    expect(requestText).toContain("NCR_EDITED_USER_AGENTS");
    expect(requestText).not.toContain("NCR_OLD_USER_AGENTS");
    facts.agentInstructionsVerified = true;
    const pane = await waitForV4Pane(
      (state) => Boolean(state.sessionId && state.sessionId !== "draft") && !state.canStop,
      "会话未完成",
      60_000,
    );
    const sessionId = pane.sessionId!;
    await browser.waitUntil(
      async () => (await exists(paths.cliDb)) && (await exists(paths.indexDb)),
      { timeout: 30_000, timeoutMsg: "原 App/CLI 数据库未创建" },
    );
    const original = await runtimeFacts(sessionId);
    expect(original.messages.length).toBeGreaterThan(1);
    expect(JSON.parse(await readFile(paths.sidecar, "utf8"))).toEqual({
      version: 1,
      cliBaseDir: paths.appRoot,
    });
    expect(await exists(join(paths.home, directoryName, "cli/db/db.sqlite"))).toBe(false);
    facts.beforeRestart = original;

    await restartIntoWorkspacePreservingProfile(paths.workspace);
    const restartedRuntime = await browser.electron.execute(() => ({
      pid: process.pid,
      resource: process.env.ZCODE_NATIVE_RESOURCE_DIR_NAME,
    }));
    expect(restartedRuntime.pid).not.toBe(runtime.pid);
    expect(restartedRuntime.resource).toBe(directoryName);
    facts.restartedRuntime = restartedRuntime;
    await ensureProjectExpanded(paths.workspace);
    await selectV4TaskById(sessionId);
    await waitForV4TimelineContaining("E2E_NCR_BEFORE", 60_000);
    await waitForV4AssistantMessageContaining("NCR_BEFORE_DONE", 60_000);
    await sendV4Prompt("E2E_NCR_AFTER");
    await waitForV4AssistantMessageContaining("NCR_AFTER_DONE", 60_000);
    const continuedWire = await getUpstreamRequestEvidence({
      lastUserMessageIncludes: ["E2E_NCR_AFTER"],
    });
    expect(continuedWire.length).toBeGreaterThan(0);
    const continuedRequestText = JSON.stringify(
      continuedWire.map((request) => request.requestJson),
    );
    expect(continuedRequestText).toContain("NCR_EDITED_USER_AGENTS");
    expect(continuedRequestText).not.toContain("NCR_OLD_USER_AGENTS");
    facts.continuedAgentInstructionsVerified = true;
    await waitForV4Pane(
      (state) => state.sessionId === sessionId && !state.canStop,
      "冷恢复未继续同会话",
      60_000,
    );
    const continued = await runtimeFacts(sessionId);
    expect(continued.cliInode).toBe(original.cliInode);
    expect(continued.messages.slice(0, original.messages.length)).toEqual(original.messages);
    expect(continued.messages.length).toBeGreaterThan(original.messages.length);
    expect(await readFile(paths.fakePluginInventory, "utf8")).toBe(paths.fakePluginInventoryBytes);
    // 资源信任和 agents 状态可以使用 native/v2；这里只禁止 App 运行时文件改根。
    for (const relative of ["v2/setting.json", "v2/tasks-index.sqlite", "cli/db/db.sqlite"]) {
      expect(await exists(join(paths.home, directoryName, relative))).toBe(false);
    }
    facts.afterRestart = continued;
    facts.corePassed = true;
    passedCases.push(...coreCases);
  });

  it("NCR05: 真实产品 UI 可用时工作流完整 watch/save/run 使用实际资源目录", async function () {
    this.timeout(240_000);
    // XCODE: 2026-11-03 已确认 Aiscoo wrapSubscription 拒绝官方云工作流配置；不能用 fixture alwaysOn 旁路。
    // 现有 preload 没有公开的配置查询，读取本轮当前 Main 的真实 RPC 错误响应；未知 tab 缺失仍让原断言失败。
    const mainPid = await browser.electron.execute(() => process.pid);
    const blocker = await readWorkflowPolicyBlocker(mainPid);
    if (blocker) {
      facts.NCR05 = {
        status: "pending",
        covered: false,
        blockedCode: workflowBlockedCode,
        source: blocker,
        policySource: "packages/services/src/aiscoo-account-policy/index.ts#wrapSubscription",
        applicability: "Aiscoo 官方云策略；后端 saved-workflow-library CLI 回归仍有效",
      };
      this.skip();
    }

    // list 返回的同一目录负责 UI watcher；在页面保持打开时落盘，不手动刷新。
    expect((await readDynamicWorkflowGrayMockStatus()).mode).toBe("alwaysOn");
    await clickTestIdByDom(TID_AUTOMATIONS_OPEN);
    await waitForTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"), { timeout: 15_000 });
    await clickTestIdByDom(testId(TID_AUTOMATIONS_PAGE_TAB, "workflow"));
    await waitForTestIdByDom(testId(TID_WORKFLOW_CARD, "ncr-native-project"), { timeout: 30_000 });
    await waitForTestIdByDom(testId(TID_WORKFLOW_CARD, "ncr-native-user"), { timeout: 30_000 });
    const workflowText = await browser.execute(() => document.body.textContent ?? "");
    expect(workflowText).not.toContain("ncr-old");
    await writeFile(
      join(paths.projectWorkflows, "ncr-watched-project.dwf.ts"),
      nativeResourceWorkflowSource("NCR_WATCHED_PROJECT"),
    );
    await writeFile(
      join(paths.userWorkflows, "ncr-watched-user.dwf.ts"),
      nativeResourceWorkflowSource("NCR_WATCHED_USER"),
    );
    await waitForTestIdByDom(testId(TID_WORKFLOW_CARD, "ncr-watched-project"), { timeout: 30_000 });
    await waitForTestIdByDom(testId(TID_WORKFLOW_CARD, "ncr-watched-user"), { timeout: 30_000 });

    const projectWorkflow = join(paths.projectWorkflows, "ncr-native-project.dwf.ts");
    await clickTestIdByDom(testId(TID_WORKFLOW_CARD, "ncr-native-project"));
    await waitForTestIdByDom(TID_WORKFLOW_DETAIL, { timeout: 20_000 });
    await setInputValueByTestIdDom(TID_WORKFLOW_DETAIL_DESCRIPTION, "NCR_METADATA_SAVED");
    await clickTestIdByDom(TID_WORKFLOW_META_SAVE);
    await browser.waitUntil(
      async () => (await readFile(projectWorkflow, "utf8")).includes("NCR_METADATA_SAVED"),
      { timeout: 15_000, timeoutMsg: "工作流保存未写当前资源目录" },
    );
    expect(
      await readFile(join(paths.workspace, ".zcode/workflows/ncr-old-project.dwf.ts"), "utf8"),
    ).toBe(nativeResourceWorkflowSource("NCR_OLD_WORKFLOW"));
    await clickTestIdByDom("settings-breadcrumb-section");
    await waitForTestIdByDom(testId(TID_WORKFLOW_CARD, "ncr-native-project"), { timeout: 20_000 });
    await clickTestIdByDom(testId(TID_WORKFLOW_CARD_RUN, "ncr-native-project"));
    await browser.waitUntil(
      async () =>
        browser.execute(
          (prefix) =>
            document
              .querySelector(`[data-testid^="${prefix}"]`)
              ?.getAttribute("data-workflow-run-status") === "completed",
          testId(TID_CHAT_WORKFLOW_RUN_DIGEST, ""),
        ),
      { timeout: 90_000, timeoutMsg: "选定资源目录工作流未完成真实运行" },
    );
    facts.workflowSavedSource = await readFile(projectWorkflow, "utf8");
    facts.NCR05 = { status: "passed", covered: true };
    passedCases.push("NCR05");
  });
});

// XCODE: 跳过依据必须是当前进程的精确产品策略错误，不能由缺失页签或 mock 服务自报推断。
async function readWorkflowPolicyBlocker(mainPid: number) {
  const logDir =
    process.env.ZCODE_E2E_RUNTIME_LOG_DIR?.trim() || join(paths.appRoot, ".zcode/v2/logs");
  if (!(await exists(logDir))) return null;
  for (const name of (await readdir(logDir)).filter((entry) => entry.endsWith(".log")).sort()) {
    const file = join(logDir, name);
    const lines = (await readFile(file, "utf8")).split("\n");
    const index = lines.findIndex(
      (line) =>
        line.includes(`[pid:${mainPid}] [main]`) &&
        line.includes(
          "[rpc:call] coding-plan-subscription.getDynamicWorkflowClientConfig FAIL (",
        ) &&
        line.includes(`"message":"${workflowBlockedCode}"`),
    );
    if (index >= 0)
      return {
        file,
        line: index + 1,
        mainPid,
        method: "coding-plan-subscription.getDynamicWorkflowClientConfig",
        message: workflowBlockedCode,
      };
  }
  return null;
}

async function loadMcp(): Promise<NativeMcpServerRecord[]> {
  return browser.execute(async (workspacePath) => {
    const bridge = (
      window as unknown as {
        zcode: {
          loadMcpFromUserDirectory(request: {
            workspacePath: string;
          }): Promise<{ servers: NativeMcpServerRecord[] }>;
        };
      }
    ).zcode;
    return (await bridge.loadMcpFromUserDirectory({ workspacePath })).servers;
  }, paths.workspace);
}

async function saveMcp(payload: import("@zcode/shared").SaveCliMcpToUserDirectoryRequest) {
  const result = await browser.execute(async (request) => {
    const bridge = (
      window as unknown as {
        zcode: {
          saveMcpToUserDirectory(
            input: typeof request,
          ): Promise<{ success: boolean; error?: string }>;
        };
      }
    ).zcode;
    return bridge.saveMcpToUserDirectory(request);
  }, payload);
  expect(result.success).toBe(true);
}

async function openSettings(section: string) {
  await clickTestIdByDom(TID_TASK_SETTINGS_BUTTON);
  await waitForTestIdByDom(TID_SETTINGS_PAGE, { timeout: 15_000 });
  await clickTestIdByDom(testId(TID_SETTINGS_SECTION_NAV, section));
  await waitForTestIdByDom(TID_SETTINGS_PERSONALIZATION_EDITOR, { timeout: 15_000 });
}

// XCODE: 使用现有按钮的真实 UI 点击刷新，不直接改 store 或额外调用资源 API。
async function refreshResourcePanel() {
  const panel = `[data-testid="${TID_SETTINGS_PAGE}"] [role="tabpanel"][data-state="active"]`;
  const refreshButton = $(
    `${panel} button[aria-label="刷新"], ${panel} button[aria-label="Refresh"]`,
  );
  await refreshButton.waitForClickable({
    timeout: 15_000,
    timeoutMsg: "当前资源页没有可点击的显式刷新入口",
  });
  await refreshButton.click();
}

// XCODE: 只读取设置页当前可见能力面板，不能让 forceMount 的隐藏页签满足发现/显式刷新断言。
async function readResourcePanelText(): Promise<string | null> {
  return browser.execute((pageId) => {
    const page = document.querySelector(`[data-testid="${pageId}"]`);
    const panel = Array.from(
      page?.querySelectorAll<HTMLElement>('[role="tabpanel"][data-state="active"]') ?? [],
    ).find((element) => element.checkVisibility());
    return panel?.innerText ?? null;
  }, TID_SETTINGS_PAGE);
}

async function readEditor() {
  return browser.execute(
    (id) => document.querySelector<HTMLTextAreaElement>(`[data-testid="${id}"]`)?.value ?? "",
    TID_SETTINGS_PERSONALIZATION_EDITOR,
  );
}

async function runtimeFacts(sessionId: string) {
  const db = new DatabaseSync(paths.cliDb, { readOnly: true });
  try {
    db.exec("PRAGMA busy_timeout=5000");
    expect(db.prepare("SELECT id FROM session WHERE id=?").get(sessionId)?.id).toBe(sessionId);
    return {
      cliDb: paths.cliDb,
      indexDb: paths.indexDb,
      cliInode: (await stat(paths.cliDb)).ino,
      messages: db
        .prepare("SELECT id FROM message WHERE session_id=? ORDER BY time_created,id")
        .all(sessionId)
        .map((row) => row.id),
    };
  } finally {
    db.close();
  }
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
