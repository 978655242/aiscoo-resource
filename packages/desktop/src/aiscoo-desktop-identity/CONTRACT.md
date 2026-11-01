# Aiscoo Desktop Runtime

只装配桌面早期数据根，不拥有设置、账号、会话、队列或 owner/lease。只有编译期注入 Aiscoo profile 才启用；未注入原样调用上游 bootstrap。

Aiscoo 的默认业务数据根是系统 appData 下对应渠道的数据目录，再由现有 paths owner派生 .zcode/v2 等路径。显式 ZCODE_DATA_BASE_DIR 保留；bootstrap 只读取所选根的 setting.json，不读取旧 ZCode 全局设置。支持同根持久化的用户自定义 dataBaseDir。

- 不覆盖 HOME/USERPROFILE，不导入、复制、删除任何旧数据库或凭据。
- 先设置默认根，再调用原 bootstrap 的可选精确 settingsFile，返回值由原 owner 决定。
- Main→Host 使用现有 buildHostProcessEnv 注入根目录；Host→CLI 的既有环境覆盖键补齐 storage/db/log 三条路径，不改变上游已显式指定的值。
- 历史迁移不在启动时自动发生；需要退出旧写入者、备份及单独验收。

## 打包账号源

正式包不继承构建 shell 的环境，也不读取开发 `.env`，所以公开账号源由构建期编译常量 `__AISCOO_ADMIN_BASE_URL__` 携带。规则见 [Aiscoo 唯一账号登录](../../../../docs/aiscoo/specs/aiscoo-only-login.md) 的“正式安装包的账号源”。

- `resolvePackagedAiscooAccountOrigin` 只在编译了 Aiscoo 渠道且常量非空时返回值，并用 `normalizeNewApiOrigin` 复核；未编译的上游构建返回 `undefined`，行为不变。
- `applyPackagedAiscooAccountOrigin` 仅在 `app.isPackaged` 时把该值写入 `process.env.AISCOO_ADMIN_BASE_URL`，覆盖继承值；开发运行不覆盖。它不拥有账号状态，Main、Host、scheduler 与 Agent 继续经现有环境继承读取同一值。
- 不记录实际地址到日志。编译值在运行时复核失败（构建门禁理论上已拦截）时失败关闭：清除继承到的值，由现有账号策略显示稳定的“配置不可用”，不在启动最早期抛错，也不回退到用户环境里的值。
- 调用点只有一处：`main/desktopEarlyDataBaseDirBootstrap.ts` 既有的早期 bootstrap，位于 `main/index.ts` 的最早导入序列，早于 Main、Host 与 scheduler 的任何账号源读取。

## 应用内更新源

规则见 [Aiscoo 应用内更新](../../../../docs/aiscoo/specs/aiscoo-auto-update.md)。

- `resolveAiscooUpdateEndpointOrigin` 只读取并复核当前账号源，不写环境、不拥有更新状态。非 Aiscoo 渠道返回 `undefined`，Main 保持上游官方更新源；Aiscoo 渠道取不到合法 origin 返回 `null`，Main 关闭自动更新。
- 更新状态机、下载、安装仍由上游 `autoUpdater.ts` 持有。Main 只把该 origin 作为 `resolveEndpointOrigin` 与受信 origin 传给 `initAutoUpdater`，并作为强制升级检查的 `endpointOrigin`。
