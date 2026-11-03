# Host Native Resource Watch

该窄模块登记既有 subagentRuntimeConfig 的原生项目目录监听接线；原文件位置和 API 保持。

- workspacePath 与可选 NativeResourceDirectoryOptions 决定被观察的原生 agents 目录。
- 文件系统与既有服务仍是配置事实 owner；本模块不引入第二份状态、定时器或 watcher。
- `.agents` 兼容来源、workspaceIdentity 隔离、订阅释放、快照和运行时存储归属不变。
- 只将所选原生目录用于既有监听，不跨旧根导入，不迁移文件。
