// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";
import {
  persistPaneSession,
  readPersistedPaneSession,
  usePaneSessionPersistence,
} from "@/v4/usePaneSessionPersistence.js";
import { restoreDraftContext } from "./restoreDraftContext.js";

const path = "/srv/project";
const identity = "remote:server:host-a:/srv/project";

beforeEach(() => {
  useZCodeSessionStore.setState({ workspaces: {} });
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  useZCodeSessionStore.setState({ workspaces: {} });
  localStorage.clear();
});

function restoredPane(workspaceIdentity?: string, enabled = true) {
  return renderHook(() => {
    const workspace = useZCodeSessionStore((state) =>
      state.getWorkspaceState(path, workspaceIdentity),
    );
    usePaneSessionPersistence({
      workspaceKey: workspaceIdentity ?? path,
      activeSessionId: workspace.activeTaskId,
      draftFocusVersion: workspace.draftFocusVersion,
      enabled,
      restoreOnStartup: true,
      selectSession: (taskId) =>
        useZCodeSessionStore.getState().setActiveTaskId(path, taskId, workspaceIdentity),
    });
    return workspace;
  });
}

describe("XWork startup draft context", () => {
  it.each([undefined, identity])(
    "记住归属但无文字草稿时，%s 冷启动仍恢复原会话",
    (workspaceIdentity) => {
      persistPaneSession(workspaceIdentity ?? path, "task-before-exit");
      restoreDraftContext({
        workspacePath: path,
        workspaceIdentity,
        projectId: "project-a",
        taskGroupId: "group-a",
      });
      const { result } = restoredPane(workspaceIdentity);
      expect(result.current.activeTaskId).toBe("task-before-exit");
      expect(result.current.draftProjectId).toBe("project-a");
      expect(result.current.draftTaskGroupId).toBe("group-a");
      expect(result.current.draftFocusVersion).toBe(0);
      expect(readPersistedPaneSession(workspaceIdentity ?? path)).toBe("task-before-exit");
    },
  );

  it("显式 New Task 后，迟到的自动归属恢复不能抢回原会话", () => {
    persistPaneSession(identity, "task-before-exit");
    const store = useZCodeSessionStore.getState();
    store.startDraft(path, undefined, identity, { projectId: "user-project" });
    restoreDraftContext({
      workspacePath: path,
      workspaceIdentity: identity,
      projectId: "old-project",
    });
    const { result } = restoredPane(identity);
    expect(result.current.activeTaskId).toBeNull();
    expect(result.current.draftProjectId).toBe("user-project");
    expect(result.current.draftFocusVersion).toBe(1);
    expect(readPersistedPaneSession(identity)).toBeNull();
  });

  it("已选中任务后，迟到水合不清选择也不产生状态通知", () => {
    useZCodeSessionStore.getState().setActiveTaskId(path, "newly-selected-task", identity);
    const before = useZCodeSessionStore.getState();
    restoreDraftContext({
      workspacePath: path,
      workspaceIdentity: identity,
      projectId: "old-project",
    });
    expect(useZCodeSessionStore.getState()).toBe(before);
    expect(before.getWorkspaceState(path, identity).activeTaskId).toBe("newly-selected-task");
  });

  it("显式未归类新建的 undefined 归属也不能被旧项目覆盖", () => {
    useZCodeSessionStore.getState().startDraft(path, undefined, identity);
    const before = useZCodeSessionStore.getState();
    restoreDraftContext({
      workspacePath: path,
      workspaceIdentity: identity,
      projectId: "old-project",
    });
    expect(useZCodeSessionStore.getState()).toBe(before);
    expect(before.getWorkspaceState(path, identity).draftProjectId).toBeUndefined();
  });

  it("初始化后的项目和分组不被重复或迟到水合覆盖", () => {
    restoreDraftContext({ workspacePath: path, projectId: "project-a", taskGroupId: "group-a" });
    const before = useZCodeSessionStore.getState();
    restoreDraftContext({ workspacePath: path, projectId: "project-b", taskGroupId: "group-b" });
    expect(useZCodeSessionStore.getState()).toBe(before);
    expect(before.getWorkspaceState(path).draftTaskGroupId).toBe("group-a");
  });

  it("同路径的本地和两个远端主机分别恢复各自的归属", () => {
    restoreDraftContext({ workspacePath: path, projectId: "local-project" });
    restoreDraftContext({
      workspacePath: path,
      workspaceIdentity: identity,
      projectId: "remote-a",
    });
    const secondIdentity = "remote:server:host-b:/srv/project";
    restoreDraftContext({
      workspacePath: path,
      workspaceIdentity: secondIdentity,
      projectId: "remote-b",
    });
    const state = useZCodeSessionStore.getState();
    expect(state.getWorkspaceState(path).draftProjectId).toBe("local-project");
    expect(state.getWorkspaceState(path, identity).draftProjectId).toBe("remote-a");
    expect(state.getWorkspaceState(path, secondIdentity).draftProjectId).toBe("remote-b");
  });

  it("手机 replayable 水合归属时不消费桌面 pane 选择", () => {
    persistPaneSession(identity, "desktop-task");
    restoreDraftContext({
      workspacePath: path,
      workspaceIdentity: identity,
      projectId: "project-a",
    });
    const { result } = restoredPane(identity, false);
    expect(result.current.activeTaskId).toBeNull();
    expect(result.current.draftProjectId).toBe("project-a");
    expect(readPersistedPaneSession(identity)).toBe("desktop-task");
  });
});
