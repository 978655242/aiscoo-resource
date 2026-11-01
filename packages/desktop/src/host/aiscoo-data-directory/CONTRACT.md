# Aiscoo 本地 Host 默认数据目录

`registerAiscooDataDirectoryServices(services, defaultDataBaseDir)` 在本地 Host RPC 暴露前，通过现有 ServiceCollection.register 包装已经注册的 system 与 setting 实例。参数为 Main 早期选定的默认 App 根 C；undefined 不注册任何包装，保留上游行为。模块不依赖 Main，不读环境、不保存根目录状态。

- `system.info` 调用 base.info 一次并追加 `defaultDataBaseDir`，保留真实 homedir、platform 和其它字段。
- `setting.updateDataBaseDir` 只将空值/空白转为 C，显式真实 HOME 或其它目录仍原样传给 base。调用已注册 base.updateDataBaseDir 一次，使方法中的 this.update 继续走原 observable 提交后通知；不直接写 settings，不复制迁移算法。
- App 当前根 D 仍归 paths/settings，固定 CLI 根 B 由 aiscoo-desktop-runtime sidecar 单独持有；此模块不读写 B，不迁移 CLI DB，不扩展 AppSettings schema。
- 规格与事件顺序见 [desktop-product-identity](../../../../../docs/aiscoo/specs/desktop-product-identity.md)。回归调用真实设置/observable 服务与隔离文件 IO；E2E 通过实际设置入口验证 C 与 HOME 不同、清空和显式 HOME。
