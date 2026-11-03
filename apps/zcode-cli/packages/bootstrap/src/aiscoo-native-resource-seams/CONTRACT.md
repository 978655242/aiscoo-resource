# CLI Native Resource Seams

该窄模块为已接纳上游文件中的资源路径接线点提供受控归属，不移动原文件，也不接管整个 legacy protocol／executor／CLI 目录。

- plugins-command-shared 将 CLI 启动策略传入既有插件管理公共上下文，保持管理与会话发现一致。

- saved-workflows-run 将同一只读资源策略传到保存／按运行记录查找的工作流库。
- permission-input-adjustments 将同一策略传给审批前的工具输入解析，使审核路径与实际 handler 路径一致。
- 公共字段复用 NativeResourceDirectoryOptions；不新增工具 schema、权限或来源类型。
- 默认 `.zcode`、显式路径、会话运行产物和既有执行器所有权不变；无迁移、独立缓存或新状态 owner。
- 原函数仍通过其既有公开文件路径使用。完整合同见 native-resource-directories.md。
