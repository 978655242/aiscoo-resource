# Aiscoo 桌面身份修复验证

日期：2026-10-31。本文件分别保留本地 release（实际构建 `9932e053`）与 PR #52 独立发布树（`f52e110d`，基线 `cd4af779`）的证据，均不代表本轮 `6a4ab9cd` 合并后的重新验证。前者保留旧 Host WIP 与 Native 9 项失败，后者不包含该 WIP；定向通过不证明旧失败已修。真实账号 Native 登录及本地签名包私有钥匙串恢复仍未通过验收。

## 本地 release 合并后验证（本次交付）

客户端身份提交 `654fef2e` 合入最新 `b4aeece7`，得到 `3f28e90c`；架构模块追加保留双方清单，NewApiClient 同时保留桌面绑定 redirect 与已有本地 Web 参数。之后提交 keyring 外置修复 `e2642c10`、PTY 执行权限修复 `e5a3687d`，均以 merge commit 合入本地 release。实际最终编译、测试与打包源码为 `9932e0532e3d74ca6e7c2d7dbf4379030e2bff4a`；后续验证记录只改本文档，不改变运行源码。

Admin 身份提交 `92682035ad707c5d87371e78cafdb2d862dfad26` 合入最新 `d24f6994`，实际编译测试 merge 为 `c3a3fd7bb474485e9213c2ea052edd5ea3019e41`；最终本地 release `37c87abd6c7b327f914dd8b18c6f22a8845b35a1` 只追加既有 spec 验证记录。两仓均未 push、未部署或重启真实 3001。

| 本次检查                                           | 实际结果                                                                                                        |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Node24.14.0 / pnpm10.33.2、frozen lockfile install | 成功，未修改锁文件，Electron native rebuild 完成                                                                |
| 根 typecheck / lint / architecture                 | 通过；lint 308 warnings / 0 errors；架构 0 violations                                                           |
| 最终 Native runner                                 | **268 测，259 通过，9 失败**；命令退出 1，不能标记全绿                                                          |
| macOS launcher Python                              | 单独运行 11/11；runner 因 Native 失败未进入该阶段                                                               |
| 最终身份与回调精确回归                             | 5 文件 42/42                                                                                                    |
| 现行 browser account 回归                          | 5 文件 80/80，含共享 Zen callback 1 例                                                                          |
| 身份/开发包工程回归                                | 20/20；另 PTY/archive 工程回归 4/4                                                                              |
| 原生钥匙串与 PTY 打包回归                          | 8/8；包含真实 esbuild 依赖图和临时可执行 helper，已进入 Native runner                                           |
| Desktop production + Agent runtime assets          | Main/Host/preload/scheduler/Renderer、CLI、npm、native search 与 macOS helper 成功                              |
| 最终 macOS `.app`                                  | 打包闭包通过，精确 buildCommitId=9932e053，本地 ad-hoc 签名严格校验通过                                         |
| 最终包原生运行时                                   | Electron44.7.0 / Node24.21.0 / ABI149；keyring 原生 loader 加载成功；真实 PTY spawn 退出 0                      |
| Admin 合并后回归                                   | controller20 + service6 + middleware5 组通过，Web133/133                                                        |
| Admin 构建/类型/变更 lint                          | Go build ./...、独立 binary、Web build、tsgo 通过，变更 lint 0/0                                                |
| Admin 基线限制                                     | 全量 lint151 errors / 66 warnings；原 typecheck 调用不存在 bun check 失败；固定 Go1.26.10 不可用，实际 Go1.27.2 |

最终产物：`packages/desktop/dist/aiscoo-release-9932e053/mac-arm64/Aiscoo.app`。Main PID90853，窗口 DOM ready；Host PID91224，desktop-continuous 服务 ready，数据库 terminal=ready。测试保持真实 HOME，私有测试根为 `/Users/timo/.local/share/aiscoo-release-5c3872c9-acceptance`（目录名沿用首次验收 SHA）；设置、session DB 和 Electron 数据均位于其中。用户 CLI config 与两个插件清单逐字节比对不变；仓库预先存在的 19 个未跟踪文件也均不变。

OS 最终查询：aiscoo 指向上述9932包，zcode 仍指向 `/Applications/ZCode.app`。只注销本任务生成的旧 Aiscoo 测试包注册，再登记最终包；未注销或停止 ZCode。默认 `open aiscoo://...` 投递合成未登记 state，当前 Main 拒绝，证明热投递到正确应用且没有接受未知回调。Dev/Preview 未安装，冷启动与安装顺序矩阵未验。

私有登录第一次启动（5c3872c9 的本地签名包）在 macOS `SecItemCopyMatching` / `CSSM_DecryptDataFinal` 等待系统钥匙串；正常终止无响应后仅结束该一次性测试进程。未输入密码、未修改钥匙串，也未注入测试 AES secret。之后用既有显式空 `AISCOO_ADMIN_BASE_URL` 关闭私有登录，验证最终9932包的主窗口/Host/数据库/协议。因此当前包私有凭据恢复及真实授权不能计为通过；上一阶段成功不能覆盖本次限制。

Native 九项失败分为：历史 LocalWebAccount 的六项 logout（后继 refresh 持久化/撤销、忽略 abort、冷恢复 active pointer、失效与授权补偿失败）；另三项旧 factory/provider 装配测试仍假设已退役的 Host 凭据方案。e272 五个源码/测试文件在临时影子目录复验得到26/20/6，重写相对 import、其余依赖沿用当前，**不是全仓历史 checkout**；六项同名失败均复现。旧 factory/provider 与 `b4aeece7` 的现行 browser authority 装配不匹配，未为绿灯恢复已退役入口或修改断言。初次 QueuedCapability 失败是旧 core dist 混用新 contracts；有序重建后2/2通过。现行 Web 规范为 [browser-new-api.md](browser-new-api.md)。

打包首轮另外发现两项实际问题并修复：共享服务图将原生 keyring 内联导致解析其他平台 `.node`，改为追加现有 runtime externals；asar 重打包丢失 macOS PTY helper 执行位，改为最终 repack 后、签名前恢复，真实 final `.app` PTY 已通过。仅给源 node_modules chmod 的中间尝试仍失败，不作为最终验收。

日志前缀为 `/tmp/aiscoo-release-9932e053-`：`build.log`、`package.log`、`native.log`、`aiscoo.log`、`architecture.log`、`codesign.log`、`native-runtime.json`、`os-handlers.json`、`build-meta.json`。最后类型/lint日志为 `/tmp/aiscoo-release-pty-final-{typecheck,lint,architecture}.log`；Agent assets 为 `/tmp/aiscoo-release-integration-runtime.log`；完整历史失败分析日志为临时目录 `aiscoo-native-local-web-current.log`、`aiscoo-native-local-web-e272-account.log`、`aiscoo-native-queued-current.log`。Admin 日志和二进制见 `aiscoo-admin-desktop-identity/.cache/desktop-identity/release-merge-d24f699/`。

`git merge-tree --write-tree --name-only 9932e053 upstream/main` exit0，结果 tree `7c41edc41dbd1a7f79becec0c91c7bfcfe7e3f47`。新增修改的上游文件 `packages/desktop/scripts/node-pty-package-assets.mjs` 只追加异步权限适配，electron-builder 既有 afterPack 只增加一次调用；tsup 只追加原生依赖外置条目，均带中文 XCODE 原因注释。

## PR #52 独立发布树验证（f52e110d）

该独立发布树以已安装 Node 24.18.0 / pnpm 10.33.2 执行定向验证；仓库固定版本仍是 Node 24.14.0。当前身份模块架构检查已通过（0 violations / 0 baseline / 0 new）。打包/数据隔离/深链、Main OAuth 投递与 Dev bundle 共 5 个 Node 文件 33/33 通过；`pnpm test:aiscoo` 的 Native redirect、settings path、Desktop/Web branding 与 CLI callback 共 5 文件 42/42 通过；`pnpm test:engineering` 的 desktopProductIdentity 与 devElectronAppBundle 共 2 文件 20/20 通过。随后在精确 Node 24.14.0 下新增冷启动回归：修复前真实启动 owner 错误预热旧 HOME 的 workspace A；Main 复用已选设置路径后预热渠道 workspace B，未注入仍沿用 HOME。该数据隔离文件 6/6 通过，定向 lint 为 0 errors / 3 warnings（Main 既有未使用导入）。根 typecheck、lint 和推送门禁由整合负责人统一运行，以最终命令输出为准。该独立发布树未重新打包、注册协议、启动产品或操作钥匙串，未执行全套测试、真实账号登录和计费模型请求。

## 上一阶段隔离实现记录（历史）

以下内容描述身份分支合并前的验证范围，不能代替上述最新 release 结果。

- Desktop 当时为 `fix/aiscoo-desktop-identity`，基线 `691b3a4e`；此阶段尚未提交。
- Admin 当时为 `feat/aiscoo-desktop-identity`，6 文件尚未提交或部署。
- 规格：[desktop-product-identity.md](./desktop-product-identity.md)。
- 当时 macOS 产物为 `packages/desktop/dist/aiscoo-identity-final/mac-arm64/Aiscoo.app`，ad-hoc 签名校验通过；没有 Developer ID 发布签名或公证。

## 修改后行为

正式版为 `dev.aiscoo.app` / `aiscoo://oauth/callback`；Dev 为 `dev.aiscoo.app.dev` / `aiscoo-dev://oauth/callback`；Preview 为 `dev.aiscoo.app.preview` / `aiscoo-preview://oauth/callback`。构建、Main、Host、Renderer 与系统声明复用只读 profile。

New API authorize、严格 callback parser 与 token exchange 绑定同一精确 redirect；保留内部 client ID 和 refresh/logout。Aiscoo Admin 的服务端与网页同时允许三个新完整回调及旧 `zcode://oauth/callback`，不放宽 CLI 回环和 Web origin。

Electron/业务数据、设置文件、Agent storage/db/log 按渠道隔离。设置队列/锁、账号 owner 和窗口路由沿用现有实现。早期硬件加速也读取选定设置文件；审查发现的旧 HOME 误读已用 RED→GREEN 回归修复。

macOS Finder、Linux desktop/MIME/图标按渠道独立，不清理 ZCode 或其他渠道的条目；Web 分享的 Aiscoo CTA 使用 aiscoo 协议，通用链接函数默认保留 zcode。

历史钥匙串名称保持，启动不自动迁移旧数据库或凭据。

## 原身份工作目录验证（691b3a4e 阶段）

| 检查                                                                                        | 实际结果                                                               |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| 根 `pnpm typecheck`                                                                         | 最终通过；初次 TS6307 已通过追加新模块 include 修复                    |
| 根 `pnpm lint`                                                                              | 最终 0 errors / 308 warnings，未把 warnings 写成零                     |
| `pnpm architecture:check --changed`                                                         | 最终 0 violations / 0 baseline / 0 new                                 |
| 本次 56 个变更文件 `oxfmt --check`、两个仓库 `git diff --check`                             | 通过                                                                   |
| `pnpm test:unit:node`                                                                       | 最终 236/236；macOS launcher Python 回归 11/11                         |
| 精确 `pnpm test:aiscoo`：Native redirect、settings path、Desktop/Web branding、CLI callback | 5 文件 42/42                                                           |
| 打包/数据/深链工程回归                                                                      | 21/21；审查后硬件回归新增 1 项，已进入上述最终 Native 236/236          |
| 现有身份/开发包工程回归                                                                     | 27/27                                                                  |
| Desktop production build                                                                    | Main/Host/preload/scheduler/Renderer 全部成功                          |
| prepare desktop runtime assets                                                              | Agent、npm、native search、macOS helper 成功                           |
| Electron/PTY                                                                                | Electron 44.7.0、ABI149，真实 PTY spawn 成功                           |
| 最终 `electron-builder --config electron-builder.config.js --dir --publish never`           | 成功，native/runtime closure 检查通过                                  |
| Admin 后端定向授权回归                                                                      | 30 个测试组通过，仅合成隔离 SQLite fixture，无 schema/存储行为变更     |
| Admin 授权网页回归                                                                          | 124/124                                                                |
| Admin Go build、Web build、`tsgo -b`                                                        | 通过                                                                   |
| Admin 原 typecheck 脚本                                                                     | 失败：脚本调用不存在的 `bun check`；替代直接 tsgo 通过，未称原脚本通过 |
| Admin 全量 lint                                                                             | 151 errors / 66 warnings；两份变更 TSX 定向为 0 errors / 0 warnings    |

主仓验证使用 Node24.14.0 / pnpm10.33.2。Admin 的 go.mod 固定 Go1.26.10 下载超时，实际以已安装 Go1.27.2 验证；没有修改 go.mod 或宣称已验证1.26.10。Bun1.4.2。

## macOS 真实运行证据

最终包 Info.plist 精确为 `dev.aiscoo.app`、显示名称 Aiscoo、仅一个 scheme `aiscoo`。

NSWorkspace 实际查询：`aiscoo://oauth/callback` 指向本次最终 Aiscoo 包，`zcode://oauth/callback` 仍指向已安装 ZCode。Dev/Preview 未安装注册，不计作实机通过。

使用全新隔离运行根启动实际产品 Main/Host：主窗口创建、数据库终态 ready、设置和 session DB 写入隔离目录。真实 safeStorage 初始化新的测试私钥；正常退出后用同根重启，新窗口/Host/数据库 ready 且测试密钥文件 checksum 不变，证明当前新包能恢复该测试数据。没有读取或复制真实账号凭据，也未验证旧 bundle 真实密文迁移。

通过系统 `open` 投递合成未登记 state 的 aiscoo OAuth 回调；最终 Aiscoo Main 收到并记录“未匹配已登记 OAuth 身份或用途，忽略此次回调”。证明热启动协议送达正确应用且未知 state 未被接纳；不代表真实 code 兑换或账号登录成功。

最终 app 与当前 ZCode 同时运行。只退出和重启本任务创建的测试实例，未停止原 ZCode 或自有账号后端。

新增静态/合成验收 runner：`packages/desktop/test/runAiscooDesktopIdentityElectron.mjs`，默认只读最终包和 OS 映射。外部 fixture 的 `--synthetic` 未执行，不能与上述实际产品重启证据混为一谈。

## 未执行与发布前置条件

Admin 身份补丁已进入本地 release，运行中的自有账号后端是否已加载新白名单尚未核验。需要先确认部署，再完成浏览器主动确认 → aiscoo 回跳 → Host 换码 → 模型目录的真实 Native E2E。账号与费用授权未就绪时不自动调用计费模型。

Windows/Linux 实机安装及协议共存、Dev/Preview 的实机 handler、安装顺序矩阵、旧用户数据和凭据迁移均未验。BigModel/Z.ai 官方云依赖对应服务端和中转支持新回调，单独协调与验收，不能由自有 Native 白名单替代。

## 上游扩展与合并预演

新增逻辑集中在 `aiscoo-desktop-identity` 共享配置与桌面适配模块。以下存量上游文件没有可直接使用的品牌身份参数，因此在已有装配点增加配置读取、可选参数或最小调用；没有新建账号/队列 owner。

原工作目录曾记录 `git merge-tree --write-tree <preview> upstream/main` 为 exit 0，tree 为 `35ec080a220915492231f21f290bd254febf3237`；该历史对象不代表当前 `cd4af779` 发布工作目录的预演。本轮不会更新原工作目录的 index 或 refs；最终整合负责人须对实际 PR tree 重新执行上游合并预演并在 PR 描述记录结果。

| 上游文件                                                                       | 最小改动理由                                       |
| ------------------------------------------------------------------------------ | -------------------------------------------------- |
| packages/desktop/electron-builder.config.js                                    | 打包装配接入 profile，平台协议与 appId 一致        |
| packages/desktop/scripts/desktop-product-identity.mjs                          | 原导出点叠加 profile，保留环境/CUA/钥匙串契约      |
| packages/desktop/scripts/desktop-product-identity.d.mts                        | 既有声明同步 profile 字段                          |
| packages/desktop/scripts/devElectronAppBundle.mjs                              | 开发副本身份配置与缓存指纹，移除旧协议残留         |
| packages/desktop/src/host/index.ts                                             | 服务工厂增加可选 Native redirect 参数              |
| packages/desktop/src/main/desktopChromiumHardwareAccelerationBootstrap.ts      | 只增加可选设置文件参数，默认保持                   |
| packages/desktop/src/main/desktopEarlyChromiumHardwareAccelerationBootstrap.ts | 装配选定设置文件                                   |
| packages/desktop/src/main/desktopDataBaseDirBootstrap.ts                       | 只增加可选设置文件参数，原恢复 owner 不变          |
| packages/desktop/src/main/desktopEarlyDataBaseDirBootstrap.ts                  | 调用独立下游 bootstrap 包装                        |
| packages/desktop/src/main/desktopDeepLinkUrl.ts                                | scheme 常量从可选 profile 读取，未注入保持 zcode   |
| packages/desktop/src/main/desktopOAuthDeepLink.ts                              | 注册和 Native canonical 校验读取同一 profile       |
| packages/desktop/src/main/desktopFinderOpenFolderWorkflow.ts                   | 配置级名称、协议、归属列表，防止清理其他产品       |
| packages/desktop/src/main/desktopLinuxAppImageIcon.ts                          | 可选 iconName，默认路径不变                        |
| packages/desktop/src/main/desktopLinuxDeepLinkRegistration.ts                  | 渠道 desktop/MIME/icon/归属列表配置                |
| packages/desktop/src/main/desktopRuntimeEnv.ts                                 | 数据名与已有 CLI storage/db/log 环境覆盖键接线     |
| packages/desktop/src/main/index.ts                                             | Windows AUMID 读取 profile；冷启动复用已选设置路径 |
| packages/desktop/test/desktopProductIdentity.test.ts                           | 既有工程断言反映确认后的身份                       |
| packages/desktop/test/devElectronAppBundle.test.ts                             | 既有工程断言反映独立开发副本                       |
| packages/desktop/tsconfig.main.json                                            | 编译清单只追加独立适配模块；严格 JSON 不能写注释   |
| packages/desktop/tsup.config.ts                                                | 构建期追加渠道 define                              |
| packages/desktop/vite.config.ts                                                | Renderer 追加同源渠道 define                       |
| packages/services/src/node.ts                                                  | 服务工厂可选 redirect 注入                         |
| packages/services/src/setting/settingService.ts                                | 可选精确设置路径，实例创建时固定                   |
| packages/shared/package.json                                                   | exports 只追加身份子路径；严格 JSON 不能写注释     |
| packages/web/src/share/conversationSharePreviewClient.ts                       | 可选 scheme 参数，默认 zcode 保持                  |
| packages/web/src/share/ConversationShareLandingPage.tsx                        | 下游 Aiscoo CTA 装配精确 scheme                    |

代码接线处使用 XCODE 中文原因注释。上述原身份阶段接线理由供整合审查使用，不代表本轮远端合并、部署或发布。
