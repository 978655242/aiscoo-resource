# cli-aiscoo

Aiscoo 对独立 CLI 的组合层。上游 `run`、`createCommandCenter` 原样委托，本模块只处理 Aiscoo 专属命令（Zen Plan）。

不变量：

- 不改写上游函数、文案和选项顺序；帮助与 `/login` 选项只在上游结果后追加或前置 Zen 项。
- 不保存账号状态：Zen owner 在 bootstrap `ZenAccountRuntime`，本层只调用其公开方法；输出不含 token、凭据路径。
- 接线点：`main.ts` 用 `runAiscoo` 替代 `run`；`runAiscoo` 经 `RunDependencies.createTuiCommandCenter` 注入 `createAiscooCommandCenter`，上游 `tui-prompt-handler.ts` 只在未注入时回退 `createCommandCenter`，不引用本模块。
- Zen 依赖读取的 Provider Registry runtime 由 `withAiscooTuiCommandCenter` 包装 `startProcessProviderRegistryRuntime` 记录，与 TUI 进程级 runtime 是同一实例。
- `login zen` 收到 SIGINT 时转为 abort 并等待补偿撤销完成再退出，避免服务端孤儿 SID。
