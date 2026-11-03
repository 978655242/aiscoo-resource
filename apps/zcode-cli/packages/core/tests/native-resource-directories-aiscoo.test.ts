// XCODE: 保存工作流的审批、查找和执行使用同一资源策略，运行草稿路径不迁移。
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createSessionId, createToolCallId, type PermissionBrokerRequest } from "@zcode/contracts";
import { resolveNativeResourceDirectoryPolicy } from "@zcode/shared/native-resource-directories";
import { createToolExecutor } from "../src/tool/executor.js";
import { createToolRegistry } from "../src/tool/registry.js";
import { PermissionService, defaultPermissionConfig } from "../src/permission/service.js";
import { createWorkflowToolEntry } from "../src/tool/handlers/create-workflow.js";
import { saveWorkflowToolEntry } from "../src/tool/handlers/save-workflow.js";
import { listSavedWorkflowsToolEntry } from "../src/tool/handlers/list-saved-workflows.js";
import { serializeSavedWorkflow } from "../src/tool/handlers/saved-workflows/index.js";

let root: string;
let home: string;
let cwd: string;
const nativeDirectories = resolveNativeResourceDirectoryPolicy({ productDirectoryName: ".aiscoo" });
const script = 'const worker = agent("fixture"); return await worker.ask<string>("check");';
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "native-workflow-aiscoo-"));
  home = join(root, "home");
  cwd = join(root, "repo");
  await mkdir(home);
  await mkdir(cwd);
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

it("keeps SaveWorkflow approval, list and CreateWorkflow saved resolution in the selected archive", async () => {
  const registry = createToolRegistry();
  registry.register(saveWorkflowToolEntry);
  registry.register(listSavedWorkflowsToolEntry);
  registry.register(createWorkflowToolEntry);
  const approvals: PermissionBrokerRequest[] = [];
  const executor = createToolExecutor({
    nativeDirectories,
    registry,
    workingDirectory: cwd,
    sessionId: createSessionId(),
    emitEvent: async () => {},
    mode: "build",
    permissionService: new PermissionService(defaultPermissionConfig),
    permissionBroker: {
      requestPermission: async (request) => {
        approvals.push(request);
        return { decision: "allow" };
      },
    },
  });
  const execute = (name: string, input: unknown) =>
    executor.execute({ id: createToolCallId(), name, input });
  for (const scope of ["project", "global"] as const) {
    const saved = await execute("SaveWorkflow", {
      name: scope,
      description: "fixture",
      scope,
      script,
    });
    expect(saved.success).toBe(true);
    const path = join(scope === "project" ? cwd : home, ".aiscoo", "workflows", `${scope}.dwf.ts`);
    expect(saved.output).toMatchObject({ path, scope, ok: true });
    expect(JSON.stringify(approvals.at(-1))).toContain(path);
    expect(await readFile(path, "utf8")).toContain(script);
  }
  const oldPath = join(cwd, ".zcode", "workflows", "old.dwf.ts");
  await mkdir(dirname(oldPath), { recursive: true });
  await writeFile(oldPath, serializeSavedWorkflow({ description: "old canary" }, script));
  const listed = await execute("ListSavedWorkflows", {});
  expect(listed.success).toBe(true);
  expect(
    (listed.output as { workflows: { name: string }[] }).workflows.map((item) => item.name),
  ).toEqual(["project", "global"]);
  const created = await execute("CreateWorkflow", { saved: { name: "project" } });
  expect(created.success).toBe(true);
  expect(JSON.stringify(approvals.at(-1))).toContain(
    join(cwd, ".aiscoo", "workflows", "project.dwf.ts"),
  );
  expect(JSON.stringify(approvals.at(-1))).toContain(join(cwd, ".zcode", "workflow-drafts"));
  const missing = await execute("CreateWorkflow", { saved: { name: "old" } });
  expect(missing.success).toBe(false);
  expect(JSON.stringify(missing)).toContain("No saved workflow named 'old'");
  expect(await readFile(oldPath, "utf8")).toContain("old canary");
});
