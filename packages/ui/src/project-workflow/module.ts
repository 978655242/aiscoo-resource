/**
 * project-workflow 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const projectWorkflowModule = {
  id: "project-workflow",
  requires: ["shared", "ui", "project-sidebar"],
  provides: ["project-workflow"],
  publicEntrypoints: [
    "contract.ts",
    "useWorkflowRunSave.ts",
    "WorkflowRunSaveControls.tsx",
    "WorkflowRunPaneSaveSlots.tsx",
    // XCODE: 既有保存弹层与落点预览纳入同一保存控制器边界，不移动上游文件。
    "../components/workflow-timeline/WorkflowSavePopover.tsx",
    "../components/workflow-timeline/workflowRunSave.ts",
  ],
} as const;
