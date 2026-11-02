# Aiscoo 本地 Host 默认数据目录

`registerAiscooDataDirectoryServices(services, defaultDataBaseDir)` 在本地 Host RPC 暴露前，通过现有 `ServiceCollection.register` 包装已注册的 system 与 setting 实例。参数是 Main 早期选定的默认 App 根；传入 undefined 时不注册包装，保持上游行为。模块不依赖 Main，不读环境变量，不保存目录状态。

- `system.info` 调用原实现一次，再追加 `defaultDataBaseDir`，保留真实 `homedir`、`platform` 等字段。
- `setting.updateDataBaseDir` 只把空值或空白转为默认根；显式选择的真实 HOME 或其他目录原样传入。通过已注册实例调用一次，原方法里的 `this.update` 仍走 observable 的提交后通知；不直接写设置，不复制迁移算法。
- 当前 App 根仍归 paths 与 settings；CLI 会话库根由 `aiscoo-desktop-runtime` 的绑定记录持有。本模块不读写该记录，不迁移 CLI 数据库，不扩展 AppSettings。
- 规格与事件顺序见 [desktop-product-identity](../../../../../docs/aiscoo/specs/desktop-product-identity.md)。
