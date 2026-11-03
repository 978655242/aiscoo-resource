# Aiscoo Desktop Runtime

装配默认 App 根 C，唯一拥有 CLI 基准根 B 的一次绑定；当前 App 根 D 和设置仍由原 paths/settingService 持有，不拥有账号、会话、队列或 owner/lease。只有编译期注入 Aiscoo profile 才启用；未注入原样调用上游 bootstrap。

- `bootstrapAiscooDesktopData` 保留 C（显式 ZCODE_DATA_BASE_DIR 或 appData/渠道目录），再调用原 bootstrap 恢复 D；设置文件归属固定，不跟随 App 数据迁移。
- `initializeAiscooDesktopStorage({ settingsFile, dataBaseDir })` 在 Main 恢复设置后、所有 Host/scheduler 启动前 await。锁内重读 sidecar，首次记录 D 为 B，以后保留 B；`getAiscooDesktopCliBaseDir` 只返回已完成初始化的 B，提前调用抛清晰错误。`isAiscooDesktopStorageReady` 在未注入渠道时始终 true。
- sidecar 是 settingsFile 同目录的 `setting.json.aiscoo-cli-root.json`，非标准 settings basename 使用 `setting.json.aiscoo-cli-root-<basename 的完整 SHA-256>.json`。JSON 契约为 `{ version: 1, cliBaseDir: 非空绝对路径 }`。匹配原 v2 copy 的排除规则；原子写临时态在启动 Host 前结束。
- 复用 shared/node 的文件锁与私有原子写；损坏、未知版本、读取/锁/写失败全部向 Main 抛错，保留原数据；Main 展示错误并退出，不能回退到另一空库。不覆盖 HOME/USERPROFILE，不导入、复制、删除数据库或凭据。
- `buildAiscooDesktopStorageEnv(D, finalEnv, B)` 接收显式 B，从 B 派生 storage/db/log，逐键尊重最终合并的 `.env → process` 覆盖；始终返回 ZCODE_DATA_BASE_DIR=D（包括 HOME），并以 shared 导出的 `AISCOO_DESKTOP_DEFAULT_DATA_BASE_DIR_ENV` 为键下发 C。未注入返回空对象。早期 bootstrap 不写 storage/db/log 默认值到 process.env。
- Main 的 `canCreateWindow` 在绑定完成前返回 false，所有建窗入口都经窗口协调器记录阻断；初始化失败时按当前界面语言展示错误并退出。
- 默认设置语义由独立 `host-aiscoo-data-directory` 包装承接；本模块不改通用 settings schema、不迁移 CLI DB。规则、时序图与验收见 [产品规格](../../../../docs/aiscoo/specs/desktop-product-identity.md)。

## 原生资源启动策略

规则见 `apps/zcode-cli/docs/design/v2/native-resource-directories.md`。`initializeDesktopNativeResourceDirectories(localEnv, processEnv)` 在 Main 的任何资源服务初始化前执行一次，按原 `.env → 已定义 process` 合并（包括空白覆盖），显式环境优先、渠道默认其次、通用默认最后；非空非法值立即抛错，不进行资源 IO。不可变 policy 由 `getDesktopNativeResourceDirectories()` 读取，完整重启才更换，不新增 UI 设置或迁移。

Main 只将规范化 `ZCODE_NATIVE_RESOURCE_DIR_NAME` 发布到进程与 Host/scheduler 环境，Main MCP 的 user/project 路径使用同一 policy。Host 入口重新校验这个目录名，并给提前创建的 Setting 与 `createLocalServices` 注入同一对象；各进程仍用自己的 HOME 解析资源。`.agents` fallback、source 标签、原子写与文件锁保持。

Host 的 `host-aiscoo-data-directory` 纯适配从已装配的 `ZCODE_STORAGE_DIR` 解析库存根。Aiscoo Host 输入含固定 B 派生的 storage env，不从新资源文件反推另一套库。资源策略不修改 App 设置路径、sidecar、DB、log、session、安装库存或 cache。

```text
产品默认 + dotenv + process → Main 单次校验 → 不可变 policy / 规范目录名
                                    ├→ Main MCP / Setting 的资源 IO
                                    └→ Host env → Host policy → Setting / local services → Agent env
固定 CLI 根 B + 原显式 storage env ─────────────→ runtime cli/plugins 库
```

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
