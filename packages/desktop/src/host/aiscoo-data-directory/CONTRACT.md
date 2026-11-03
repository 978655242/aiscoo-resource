# Aiscoo 本地 Host 默认数据目录

`registerAiscooDataDirectoryServices(services, defaultDataBaseDir)` 在本地 Host RPC 暴露前，通过现有 `ServiceCollection.register` 包装已注册的 system 与 setting 实例。参数是 Main 早期选定的默认 App 根；传入 undefined 时不注册包装，保持上游行为。模块不依赖 Main，不读环境变量，不保存目录状态。

- `system.info` 调用原实现一次，再追加 `defaultDataBaseDir`，保留真实 `homedir`、`platform` 等字段。
- `setting.updateDataBaseDir` 只把空值或空白转为默认根；显式选择的真实 HOME 或其他目录原样传入。通过已注册实例调用一次，原方法里的 `this.update` 仍走 observable 的提交后通知；不直接写设置，不复制迁移算法。
- 当前 App 根仍归 paths 与 settings；CLI 会话库根由 `aiscoo-desktop-runtime` 的绑定记录持有。本模块不读写该记录，不迁移 CLI 数据库，不扩展 AppSettings。
- `resolveDesktopPluginStorageRoot(env)` 是只读纯路径适配。输入是 Main 已装配的运行时 env，不直接读 process.env；有 `ZCODE_STORAGE_DIR` 时展开 `~/`、解析相对路径，末级 `cli` 保留否则追加 `cli`，再追加 `plugins`。未显式提供时返回 undefined，保持通用服务已有默认；Aiscoo Main 始终下发固定 CLI 基准根 B 派生的 storage env。Host 将结果显式注入资源服务，资源目录切换不能扫描新根里的另一套 cli/plugins，不更改 App/CLI 存储。
- 规格与事件顺序见 [desktop-product-identity](../../../../../docs/aiscoo/specs/desktop-product-identity.md) 和 `apps/zcode-cli/docs/design/v2/native-resource-directories.md`。
