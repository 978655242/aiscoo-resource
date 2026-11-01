# Aiscoo 上游文件变更与合并预演

基线：origin/release；上游：`3c5b227649371507ddc4eb46ac5133afe6db1cab`。清单由工作区实际 diff 与 upstream/main 文件树交集生成，含每个被修改的上游文件。新增下游模块与资源不计为上游文件。

品牌事实与图形均在独立 aiscoo-brand / aiscoo-brand-ui / cli-aiscoo-brand 模块，既有文件只作模板／资源／入口接线。严格 JSON、二进制和生成文件通过本清单说明，不写无效注释。

共 216 个被修改的上游文件。

| 文件                                                                                       | 必要性与扩展方式                                                                                                                                     |
| ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONTEXT.md`                                                                               | 当前产品入口或安装路径说明更新为 Aiscoo；上游来源、协议示例、第三方版权和历史事实保留。                                                              |
| `DESIGN.md`                                                                                | 当前产品入口或安装路径说明更新为 Aiscoo；上游来源、协议示例、第三方版权和历史事实保留。                                                              |
| `NOTICE.md`                                                                                | 当前产品入口或安装路径说明更新为 Aiscoo；上游来源、协议示例、第三方版权和历史事实保留。                                                              |
| `README.en.md`                                                                             | 当前产品入口或安装路径说明更新为 Aiscoo；上游来源、协议示例、第三方版权和历史事实保留。                                                              |
| `README.md`                                                                                | 当前产品入口或安装路径说明更新为 Aiscoo；上游来源、协议示例、第三方版权和历史事实保留。                                                              |
| `UI_PLUGIN.en.md`                                                                          | 当前产品入口或安装路径说明更新为 Aiscoo；上游来源、协议示例、第三方版权和历史事实保留。                                                              |
| `UI_PLUGIN.md`                                                                             | 当前产品入口或安装路径说明更新为 Aiscoo；上游来源、协议示例、第三方版权和历史事实保留。                                                              |
| `apps/zcode-cli/README.md`                                                                 | 当前产品入口或安装路径说明更新为 Aiscoo；上游来源、协议示例、第三方版权和历史事实保留。                                                              |
| `apps/zcode-cli/docs/usage/01-quickstart.md`                                               | 当前产品入口或安装路径说明更新为 Aiscoo；上游来源、协议示例、第三方版权和历史事实保留。                                                              |
| `apps/zcode-cli/docs/usage/README.md`                                                      | 当前产品入口或安装路径说明更新为 Aiscoo；上游来源、协议示例、第三方版权和历史事实保留。                                                              |
| `apps/zcode-cli/packages/adapters/src/auth/shared-credentials.ts`                          | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/adapters/src/browser/descriptor.ts`                               | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/adapters/src/mcp/oauth-interactive.ts`                            | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/adapters/src/mcp/oauth.ts`                                        | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/adapters/src/plugins/hook-sources.ts`                             | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/adapters/src/plugins/index.ts`                                    | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/adapters/src/plugins/marketplace.ts`                              | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/bootstrap/src/app/create-app.ts`                                  | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/bootstrap/src/app/official-plugin-definitions.ts`                 | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/bootstrap/src/app/process-provider-registry-runtime.ts`           | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/bootstrap/src/app/standalone-account-provider-runtime.ts`         | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/bootstrap/src/auth-login.ts`                                      | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/bootstrap/src/builtin-prompt-command.ts`                          | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/transcript-hydration.ts`          | 新增 Aiscoo 错误生成与识别，同时保留所有旧文案恢复分类；不修改协议字段或重试时序。                                                                   |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/runtime-resources.ts`                | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts`                | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server.ts`                           | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/transport.ts`                        | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/cli/src/plugin-host-command.ts`                                   | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/cli/src/plugins-command.ts`                                       | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/cli/src/prompt-command.ts`                                        | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/cli/src/provider-runtime-env.ts`                                  | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/cli/src/tui-prompt-handler-runtime.ts`                            | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/core/src/context/sections/cli-prefix.ts`                          | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/core/src/context/sections/desktop.ts`                             | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/core/src/context/sections/identity.ts`                            | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/core/tests/context-builder.test.ts`                               | 既有下游品牌定制断言更新当前展示事实；增加隔离环境或产物验证，历史身份断言保留。上游原品牌测试通过可选装配兼容，未机械更改。                         |
| `apps/zcode-cli/packages/i18n/package.json`                                                | 只追加品牌公共子路径或 workspace 依赖；既有包名、脚本与原条目保留，严格 JSON 不写注释。                                                              |
| `apps/zcode-cli/packages/i18n/src/index.ts`                                                | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/tui/src/app-empty-transcript.tsx`                                 | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `apps/zcode-cli/packages/tui/src/app-sidebar.tsx`                                          | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `architecture-policy.yaml`                                                                 | 共享 requires 列表仅追加品牌依赖；精确例外只覆盖已存在文件的静态模板接线，不调整基线或扩大源码归属。                                                 |
| `packages/desktop/build/dmg_background.png`                                                | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/dmg_background@2x.png`                                             | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/icon.icns`                                                         | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/icon.ico`                                                          | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/icon.png`                                                          | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/icon_installer.icns`                                               | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/icon_installer.ico`                                                | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/icon_installer.png`                                                | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/icon_windows.png`                                                  | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/icons/1024x1024.png`                                               | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/icons/128x128.png`                                                 | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/icons/16x16.png`                                                   | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/icons/24x24.png`                                                   | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/icons/256x256.png`                                                 | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/icons/32x32.png`                                                   | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/icons/48x48.png`                                                   | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/icons/512x512.png`                                                 | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/icons/64x64.png`                                                   | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/desktop/build/installer.nsh`                                                     | 仅安装器展示文案读取现有产品名宏，技术宏、安装清单和用户数据保护逻辑不变。                                                                           |
| `packages/desktop/electron-builder.config.js`                                              | 复用既有产品身份配置与构建扩展；从唯一品牌事实派生展示名，显式保留 Windows EXE / Linux 命令与 appId。                                                |
| `packages/desktop/scripts/desktop-product-identity.d.mts`                                  | 复用既有产品身份配置与构建扩展；从唯一品牌事实派生展示名，显式保留 Windows EXE / Linux 命令与 appId。                                                |
| `packages/desktop/scripts/desktop-product-identity.mjs`                                    | 复用既有产品身份配置与构建扩展；从唯一品牌事实派生展示名，显式保留 Windows EXE / Linux 命令与 appId。                                                |
| `packages/desktop/scripts/dev.mjs`                                                         | 复用既有产品身份配置与构建扩展；从唯一品牌事实派生展示名，显式保留 Windows EXE / Linux 命令与 appId。                                                |
| `packages/desktop/scripts/devElectronAppBundle.mjs`                                        | 复用既有产品身份配置与构建扩展；从唯一品牌事实派生展示名，显式保留 Windows EXE / Linux 命令与 appId。                                                |
| `packages/desktop/src/host/browserControlMainBridge.ts`                                    | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/host/index.ts`                                                       | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/host/sourceServerConnectionManager.ts`                               | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/main/about.ts`                                                       | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/main/aboutWindow.ts`                                                 | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/main/cuaAccessibilitySettings.ts`                                    | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/main/desktopCommandHandlers.ts`                                      | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/main/desktopCuaPermissionIpc.ts`                                     | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/main/desktopFinderOpenFolderWorkflow.ts`                             | 展示名由品牌契约提供，旧系统条目按原身份验证后迁移；appId/scheme/可执行名保留，并识别历史名称。                                                      |
| `packages/desktop/src/main/desktopLinuxDeepLinkRegistration.ts`                            | 展示名由品牌契约提供，旧系统条目按原身份验证后迁移；appId/scheme/可执行名保留，并识别历史名称。                                                      |
| `packages/desktop/src/main/desktopOAuthDeepLink.ts`                                        | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/main/desktopRuntimeEnv.ts`                                           | 分离 Aiscoo 展示名、历史 Electron 数据名与历史 macOS 钥匙串名，后两者保持兼容；仅从产品身份配置派生，不改凭据格式或数据目录。                        |
| `packages/desktop/src/main/desktopWindowsOpenFolderContextMenu.ts`                         | 展示名由品牌契约提供，旧系统条目按原身份验证后迁移；appId/scheme/可执行名保留，并识别历史名称。                                                      |
| `packages/desktop/src/main/forceUpdateGuard.ts`                                            | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/main/forceUpdatePrompt.ts`                                           | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/main/index.ts`                                                       | 既有 app.setName 入口在 macOS ready 前使用历史钥匙串名，ready 后恢复展示名，避免品牌迁移切换 safeStorage 加密身份；不重置或迁移凭据。                |
| `packages/desktop/src/main/pluginSandbox/host.ts`                                          | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/main/pluginSandbox/module.ts`                                        | 模块清单只追加与实际公开品牌入口相符的依赖，状态和分层不变。                                                                                         |
| `packages/desktop/src/main/pluginSandbox/permissionGate.ts`                                | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/main/pluginSandbox/permissions.ts`                                   | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/main/windowsCuaOperationIndicatorContent.ts`                         | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/main/zcodeDataSizeScanner.ts`                                        | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/main/zcodeDataSizeTelemetryState.ts`                                 | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/main/zcodeDataSizeWorkerClient.ts`                                   | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/renderer/cua-permission-panel.html`                                  | 首屏标题／内联 favicon／启动图不经过 React 注入，直接引用仓库内原稿派生资源，保持离线首帧与主题合同。                                                |
| `packages/desktop/src/renderer/cuaPermissionPanelMessages.ts`                              | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/desktop/src/renderer/index.html`                                                 | 首屏标题／内联 favicon／启动图不经过 React 注入，直接引用仓库内原稿派生资源，保持离线首帧与主题合同。                                                |
| `packages/desktop/src/renderer/src/main.tsx`                                               | 只在现有应用入口替换 Provider 装配为 Aiscoo 包装，复用原语言状态与 UI 生命周期。                                                                     |
| `packages/desktop/src/renderer/src/resource-manager.tsx`                                   | 只在现有应用入口替换 Provider 装配为 Aiscoo 包装，复用原语言状态与 UI 生命周期。                                                                     |
| `packages/desktop/test/about.test.ts`                                                      | 既有下游品牌定制断言更新当前展示事实；增加隔离环境或产物验证，历史身份断言保留。上游原品牌测试通过可选装配兼容，未机械更改。                         |
| `packages/desktop/test/desktopFinderOpenFolderWorkflow.test.ts`                            | 既有下游品牌定制断言更新当前展示事实；增加隔离环境或产物验证，历史身份断言保留。上游原品牌测试通过可选装配兼容，未机械更改。                         |
| `packages/desktop/test/desktopRuntimeEnv.test.ts`                                          | 既有下游品牌定制断言更新当前展示事实；增加隔离环境或产物验证，历史身份断言保留。上游原品牌测试通过可选装配兼容，未机械更改。                         |
| `packages/desktop/test/devElectronAppBundle.test.ts`                                       | 既有下游品牌定制断言更新当前展示事实；增加隔离环境或产物验证，历史身份断言保留。上游原品牌测试通过可选装配兼容，未机械更改。                         |
| `packages/desktop/test/macosReleaseAppDoctor.test.ts`                                      | 既有下游品牌定制断言更新当前展示事实；增加隔离环境或产物验证，历史身份断言保留。上游原品牌测试通过可选装配兼容，未机械更改。                         |
| `packages/desktop/tsup.config.ts`                                                          | 只追加构建期品牌 SVG 内嵌值，原生 About 不从源码目录或网络加载标志。                                                                                 |
| `packages/server/src/bundledZCodeBuiltinProviderConfig.ts`                                 | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/server/src/remote/remoteAssetPreflight.ts`                                       | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/server/src/source-server/sourceServerProbe.ts`                                   | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/bots/feishuChannelRuntime.ts`                                       | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/bots/messages.ts`                                                   | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/bots/telegramChannelRuntime.ts`                                     | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/bots/weixinChannelRuntime.ts`                                       | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.ts` | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/conversation-share/conversationShareHttpClient.ts`                  | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/credential/credentialService.ts`                                    | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/cua-permission-broker/cuaAgentAdmissionGate.ts`                     | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/feedback/feedbackLogArchive.ts`                                     | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/file/workspaceFileIgnore.ts`                                        | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/git/repo/gitCheckpointHelpers.ts`                                   | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/node.ts`                                                            | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/oauth/providers/bigmodelProviderAdapter.ts`                         | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/plugins/pluginsService.ts`                                          | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/runtime-tools/appCaCert.ts`                                         | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/session/offPeakRuntimeModel.ts`                                     | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/zcode-agent/zcodeAgentErrors.ts`                                    | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/zcode-agent/zcodeAgentProcessManager.ts`                            | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/zcode-agent/zcodeAgentService.ts`                                   | 新增 Aiscoo 错误生成与识别，同时保留所有旧文案恢复分类；不修改协议字段或重试时序。                                                                   |
| `packages/services/src/zcode-agent/zcodeProtocolClient.ts`                                 | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/zcode-agent/zcodeStdioTransport.ts`                                 | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts`                             | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/shared/package.json`                                                             | 只追加品牌公共子路径或 workspace 依赖；既有包名、脚本与原条目保留，严格 JSON 不写注释。                                                              |
| `packages/shared/src/desktopMenu.ts`                                                       | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/shared/src/feedback.ts`                                                          | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/shared/src/node/atomicFileLock.ts`                                               | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/shared/src/process-names.ts`                                                     | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/shared/src/zcode-agent-policy.ts`                                                | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/shared/src/zcode-agent-runtime.ts`                                               | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/shared/src/zcode-slash-command-help.ts`                                          | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/shared/src/zcodeEndpoint.ts`                                                     | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/shared/tsconfig.json`                                                            | 只追加品牌 JSON 编译输入；复用既有 allowJs 支持 JavaScript 公共入口，避免独立 CLI 跨 rootDir 编译。                                                  |
| `packages/ui/package.json`                                                                 | 只追加品牌公共子路径或 workspace 依赖；既有包名、脚本与原条目保留，严格 JSON 不写注释。                                                              |
| `packages/ui/src/App.tsx`                                                                  | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/ui/src/DesktopTopOverlay.tsx`                                                    | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/ui/src/SettingsPage.tsx`                                                         | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/ui/src/UpdateStatusWindowRoot.tsx`                                               | 只在现有应用入口替换 Provider 装配为 Aiscoo 包装，复用原语言状态与 UI 生命周期。                                                                     |
| `packages/ui/src/Root.tsx`                                                                 | 在既有登录入口传入 AiscooLoginHeader 展示插槽，登录业务状态与上游默认头部保持不变。                                                                  |
| `packages/ui/src/WelcomeScreen.tsx`                                                        | 只增加可选 header 插槽并透传；未提供时保留原 LoginPanelHeader 的 title／description／children 与默认图标，不直接改写上游视觉默认值。                 |
| `packages/ui/src/WindowsTopLeftLogo.tsx`                                                   | 现有组件没有产品图形插槽，最小接线至独立品牌模块；保留导出、布局和无障碍／测试合同，原稿 SVG 随 Vite 入包。                                          |
| `packages/ui/src/WorkspaceSidebarFooter.tsx`                                               | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/ui/src/components/mobile-ui/ZCodeAppLogo.tsx`                                    | 现有组件没有产品图形插槽，最小接线至独立品牌模块；保留导出、布局和无障碍／测试合同，原稿 SVG 随 Vite 入包。                                          |
| `packages/ui/src/components/mobile-ui/module.ts`                                           | 模块清单只追加与实际公开品牌入口相符的依赖，状态和分层不变。                                                                                         |
| `packages/ui/src/components/ui/ZCodeAboutLogo.tsx`                                         | 现有组件没有产品图形插槽，最小接线至独立品牌模块；保留导出、布局和无障碍／测试合同，原稿 SVG 随 Vite 入包。                                          |
| `packages/ui/src/feedback/feedbackSubmitDescription.ts`                                    | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/ui/src/feedback/feedbackSubmitSubmission.ts`                                     | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/ui/src/highspeed/HighspeedShareNoticeCard.tsx`                                   | 产品卡片和导出图在各自模板层接同一品牌 SVG；不改供应商标志，导出图内嵌原稿，用户数值保真。                                                           |
| `packages/ui/src/highspeed/highspeed-share.css`                                            | 产品卡片和导出图在各自模板层接同一品牌 SVG；不改供应商标志，导出图内嵌原稿，用户数值保真。                                                           |
| `packages/ui/src/highspeed/highspeedShare.ts`                                              | 产品卡片和导出图在各自模板层接同一品牌 SVG；不改供应商标志，导出图内嵌原稿，用户数值保真。                                                           |
| `packages/ui/src/i18n/IntlProvider.tsx`                                                    | 只增加可选 catalogTransform；原词典默认行为不变，Aiscoo 包装层在插值前装配品牌。                                                                     |
| `packages/ui/src/lib/builtinSkillI18n.ts`                                                  | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/ui/src/lib/zcodeUiError.ts`                                                      | 新增 Aiscoo 错误生成与识别，同时保留所有旧文案恢复分类；不修改协议字段或重试时序。                                                                   |
| `packages/ui/src/onboarding/OnboardingWelcomeView.tsx`                                     | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/ui/src/replay.ts`                                                                | 只在现有应用入口替换 Provider 装配为 Aiscoo 包装，复用原语言状态与 UI 生命周期。                                                                     |
| `packages/ui/src/root/PostUpdateReleaseNotesDialog.tsx`                                    | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/ui/src/root/RootStartupLoading.tsx`                                              | 现有组件没有产品图形插槽，最小接线至独立品牌模块；保留导出、布局和无障碍／测试合同，原稿 SVG 随 Vite 入包。                                          |
| `packages/ui/src/settings/mcpSettingsShared.ts`                                            | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/ui/src/v4/ConversationDraftEmptyState.tsx`                                       | 现有空态没有产品图形插槽，接线至独立品牌模块；按用户反馈让完整动态字标在问候语上方独立占位，保留问候语时序、字号与无障碍合同。                       |
| `packages/ui/src/v4/ConversationShareReadonlyTimeline.tsx`                                 | 只在现有应用入口替换 Provider 装配为 Aiscoo 包装，复用原语言状态与 UI 生命周期。                                                                     |
| `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`                                        | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/ui/src/v4/conversationProjectionStore.ts`                                        | 新增 Aiscoo 错误生成与识别，同时保留所有旧文案恢复分类；不修改协议字段或重试时序。                                                                   |
| `packages/web-share/index.html`                                                            | 首屏标题／内联 favicon／启动图不经过 React 注入，直接引用仓库内原稿派生资源，保持离线首帧与主题合同。                                                |
| `packages/web-share/src/main.tsx`                                                          | 只在现有应用入口替换 Provider 装配为 Aiscoo 包装，复用原语言状态与 UI 生命周期。                                                                     |
| `packages/web-share/vite.config.ts`                                                        | 精确 alias 追加品牌公共入口，独立分享页复用现有 Web public；不引入完整 UI 服务依赖。                                                                 |
| `packages/web/index.html`                                                                  | 首屏标题／内联 favicon／启动图不经过 React 注入，直接引用仓库内原稿派生资源，保持离线首帧与主题合同。                                                |
| `packages/web/public/favicon.ico`                                                          | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `packages/web/src/auth/webAuthLocale.ts`                                                   | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/web/src/main.tsx`                                                                | 只在现有应用入口替换 Provider 装配为 Aiscoo 包装，复用原语言状态与 UI 生命周期。                                                                     |
| `packages/web/src/share/ConversationShareLandingPage.tsx`                                  | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/web/src/web-remote-control/domain/webRemoteControlScreenCopy.ts`                 | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/web/src/web-remote-control/module.ts`                                            | 模块清单只追加与实际公开品牌入口相符的依赖，状态和分层不变。                                                                                         |
| `packages/web/src/web-remote-control/ui/webRemoteControlBrand.tsx`                         | 追加可选 productName 展示输入；原默认品牌保留，应用装配显式注入 Aiscoo，设备用户值原样。                                                             |
| `packages/web/src/web-remote-control/ui/webRemoteControlConnectingScreen.tsx`              | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/web/src/web-remote-control/ui/webRemoteControlConnectionSheet.tsx`               | 追加可选 productName 展示输入；原默认品牌保留，应用装配显式注入 Aiscoo，设备用户值原样。                                                             |
| `packages/web/src/web-remote-control/ui/webRemoteControlDeviceListPage.tsx`                | 追加可选 productName 展示输入；原默认品牌保留，应用装配显式注入 Aiscoo，设备用户值原样。                                                             |
| `packages/web/src/web-remote-control/ui/webRemoteControlScanPage.tsx`                      | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/web/test/conversationShareLandingPage.test.ts`                                   | 既有下游品牌定制断言更新当前展示事实；增加隔离环境或产物验证，历史身份断言保留。上游原品牌测试通过可选装配兼容，未机械更改。                         |
| `packages/zcode-cua/broker-helper-constants.d.ts`                                          | 现有辅助程序唯一配置读取品牌显示名；单独保留真实 Mach-O 可执行名与 bundle ID，声明同步公开契约。                                                     |
| `packages/zcode-cua/broker-helper-constants.js`                                            | 现有辅助程序唯一配置读取品牌显示名；单独保留真实 Mach-O 可执行名与 bundle ID，声明同步公开契约。                                                     |
| `packages/zcode-cua/package.json`                                                          | 只追加品牌公共子路径或 workspace 依赖；既有包名、脚本与原条目保留，严格 JSON 不写注释。                                                              |
| `packages/zcode-server-cli/src/cli.ts`                                                     | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/zcode-server-cli/src/platform/serviceManager.ts`                                 | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/zcode-server-cli/src/runtime/installationOwnership.ts`                           | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/zcode-server-cli/src/runtime/lock.ts`                                            | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/zcode-server-cli/src/runtime/manifest.ts`                                        | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/zcode-server-cli/src/runtime/stableLauncher.ts`                                  | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/zcode-server-cli/src/runtime/startupRecovery.ts`                                 | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/zcode-server-cli/src/runtime/updateCommand.ts`                                   | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/zcode-server-cli/src/runtime/updateHandoff.ts`                                   | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/zcode-server-cli/src/runtime/updatePreparation.ts`                               | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/zcode-server-cli/src/server-core/core.ts`                                        | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `packages/zcode-server-cli/src/server-core/proxyStdio.ts`                                  | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `pnpm-lock.yaml`                                                                           | 由 pnpm offline install 生成，仅追加 i18n / CUA 对 shared 的 workspace 依赖，无包版本变化。                                                          |
| `public/icon_512@2x.png`                                                                   | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `public/logo/icons/1024x1024.png`                                                          | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `public/logo/icons/128x128.png`                                                            | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `public/logo/icons/16x16.png`                                                              | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `public/logo/icons/24x24.png`                                                              | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `public/logo/icons/256x256.png`                                                            | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `public/logo/icons/32x32.png`                                                              | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `public/logo/icons/48x48.png`                                                              | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `public/logo/icons/512x512.png`                                                            | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `public/logo/icons/64x64.png`                                                              | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `public/logo/icons/icon.icns`                                                              | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `public/logo/icons/icon.ico`                                                               | 固定打包资源路径没有品牌注入点；桌面按品牌配置生成黑色原稿的派生图，内部 ai 放大 20%，保留底板几何、渐变、外部阴影与透明轮廓；其他资源消费既有原稿。 |
| `scripts/build-zcode.mjs`                                                                  | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `scripts/doctor-macos-release-app.sh`                                                      | 展示名由品牌契约提供，旧系统条目按原身份验证后迁移；appId/scheme/可执行名保留，并识别历史名称。                                                      |
| `scripts/native-search-tools-unix.mjs`                                                     | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `scripts/native-search-tools-windows.mjs`                                                  | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `scripts/zcode-distribution/installer.mjs`                                                 | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `scripts/zcode-distribution/runner.mjs`                                                    | 该自有静态模板没有现成产品注入口；仅增加共享品牌契约调用或常量读取，在用户插值前装配，原接口、存储和业务流程保留。                                   |
| `third-party/README.md`                                                                    | 当前产品入口或安装路径说明更新为 Aiscoo；上游来源、协议示例、第三方版权和历史事实保留。                                                              |

## 合并预演

当前 HEAD 的 `git merge-tree --write-tree --name-only HEAD upstream/main` 已通过，无冲突。为包含未提交改动，使用临时 index 创建工作区 tree（不改实际 index、不创建 commit），再执行同一合并内核：

`git merge-tree --write-tree --merge-base=3c5b227649371507ddc4eb46ac5133afe6db1cab --name-only 2de75d48b553bcb881a70139873838dc3d64a4e5 upstream/main`

退出码：**0**。输出：

```text
2de75d48b553bcb881a70139873838dc3d64a4e5
```

工作区全部品牌改动与当前 upstream/main 无合并冲突。上游当前是本地基线的祖先；此结果不预判未来上游提交。
