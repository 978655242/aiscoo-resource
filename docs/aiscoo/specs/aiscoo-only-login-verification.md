# Aiscoo 唯一登录清理验证

日期：2026-10-31。规格为 [aiscoo-only-login.md](aiscoo-only-login.md)。以下验证完成于 `fix/aiscoo-only-login` 的提交前工作树，该分支从本地 `release@1c0419b9e5e4d1cbe9bf3560e291865a36e0cf08` 切出，不代表该基线提交自身已包含清理。本记录保留实施阶段的验证事实；后续本地提交与合入结果以 Git 历史为准。未推送、部署或替换正在运行的应用。

## 1. 行为与边界

Aiscoo Desktop、Web、CLI 产品入口只允许 Aiscoo/New API，CLI 使用既有 Zen 授权。删除官方主登录回退、polling、独立官方连接卡与 hook、官方 callback 产品装配和旧身份恢复。合法 Aiscoo 账号继续使用原有 owner、精确 callback、PKCE、generation 与持久化接口。

缺失、空或非法账号配置进入不可用投影：Host 不创建旧 OAuth owner，不恢复或解密历史官方身份；UI 无官方登录按钮，Main 不登记或投递官方 state，scheduler 无官方执行 owner。Main 的远控与遥测凭据读取也使用同一产品策略，缺配置不初始化私有 OS 加密 key。

历史官方凭据保留，不迁移或自动删除。Provider provisioning 通过可选来源端口和目标 allowlist 阻止旧账号凭据读取、分发、覆盖与清理。自配模型/API Key、第三方 MCP OAuth、协议与主题标识保留。需要官方身份的 MCP、闲时云和受保护分享能力明确不可用；Aiscoo token 不用于这些服务。

Web 的旧远控登录及分享回调页显示不可用，不扩展公网 Aiscoo callback、CORS、relay 或 attachment 权限。公开只读分享继续使用原页面，实际请求强制 `credentials: omit` 且拒绝重定向。Vite dev/preview 的 `/api/v1/oauth/*` 在代理之前返回固定 403。此变更没有提供新的 Aiscoo 远控认证方案。

## 2. 根因与修复证据

| 触发场景                                  | 已确认原因                                                                                      | 修复与验证                                                                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 缺少 Aiscoo 配置仍看到 Z.ai/BigModel 登录 | 服务组合以 origin 是否存在选择 Native 或旧官方 owner；品牌包装没有限制服务能力                  | 产品入口固定注入不可变策略；缺配置使用无状态不可用 authority，目录、用量、套餐和官方能力不再走旧身份分支                                     |
| 新包装阻止合法冷恢复                      | `getActiveProvider` 只在 Native 恢复建立 owner 后返回 new-api；包装提前要求 active 已为 new-api | 有合法 enabled 来源且没有明确官方 active 时委托原 owner 恢复；authenticated 后再确认来源。实际 Native owner 的 cached/validated 冷启动均通过 |
| 带首尾空白的官方凭据 key 可绕过           | 包装先比较原 key，底层随后 trim；纯内存复现读出了被禁历史值                                     | Host 在同样 trim 语义下检查；CLI 先规范化再检查所有单项/批量 key 与 manual 来源。回归证明禁用 key 不触发 backing IO                          |
| 恢复或 pending 期间退出，迟到结果重新登录 | 包装因 active 为 null 跳过 owner.logout；实际 held `/me` 复现 authenticated 与 signed-in        | logout/logoutAll/cancelPending 立即委托原 owner 的 new-api 作用域方法；真实 Native 挂起恢复、pending callback 与同步失效回归通过             |
| Vite preview 新中间件无法启动             | configure hook 隐式返回 Connect app，被 Vite 当作后置 hook 无请求调用                           | hook 显式返回 void；真实 Vite preview 启动与 HTTP 403 回归通过，完整产品 preview 上的两组浏览器验收通过                                      |

上述修复均先复现再改实现。账号事实仍由既有 owner 持有；适配器不新增登录队列、会话缓存或第二身份所有者。

## 3. 实际验证结果

使用仓库固定 Node 24.14.0、pnpm 10.33.2。以下定向组覆盖范围有重叠，不相加作为全套测试数。

| 验证                                                   | 实际结果                                                                                                          |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                                       | 最终工作树通过，退出 0                                                                                            |
| `pnpm lint`                                            | 最终工作树 0 errors / 308 warnings；无本次新增诊断                                                                |
| `pnpm architecture:check --changed`                    | 0 violations / 0 baseline / 0 new                                                                                 |
| 本次变更文件 `oxfmt --check`、`git diff --check`       | 通过；只格式化本次改动与已确认基线格式化文件                                                                      |
| `pnpm fmt:check` 全仓                                  | 退出 1，1700 个存量/无关文件有格式差异，含既有技能、文档及未跟踪资料；未全仓改写                                  |
| `pnpm --filter @zcode/desktop build:no-runtime-assets` | 最终 Main、Host、scheduler、preload、Renderer 生产构建通过；复用已有 runtime assets，不是重新打包安装器           |
| `pnpm --filter @zcode/web build`                       | 最终 Web 生产构建通过                                                                                             |
| UI 登录/Root/身份/推广四个获批回归文件                 | 首轮完整组 43/43 通过；后续退出/取消修复将 Root 从 16 条增至 23 条，最终单文件 23/23 通过，未再把完整组伪报为重跑 |
| 真实组件 Chrome/Electron fixture                       | Chrome 12 个视口/语言/主题、4 个 provider 组合、通用 API Key 表单、2 个隔离 Electron 场景通过；合成授权、外网阻断 |
| Host 与 Main 渠道回归                                  | 最终 Host 7/7：五类无效配置、有效 PKCE/凭据保留、规范化 key；Main/渠道/scheduler 10/10，共 17 项分次通过          |
| Web browser account 与实际 main entry 回归             | 52/52，通过代理前台输出确认；没有该组独立持久化日志                                                               |
| CLI `test:zen`                                         | 11/11，通过代理前台输出确认                                                                                       |
| Bootstrap Zen account/runtime                          | account 20/20、runtime 8/8；trim 修复后 runtime 8/8 再验并保存日志                                                |
| Web 启动器/profile 工程回归                            | 18/18，含真实 preview 与禁止官方 token 代理，通过代理前台输出确认                                                 |
| CLI 全包 typecheck                                     | 34 个任务通过；trim 修复后 Bootstrap 包 typecheck 再验通过                                                        |
| CLI / Bootstrap lint                                   | CLI 0 errors / 54 warnings；最终 Bootstrap 0 errors / 21 warnings，均为既有诊断                                   |
| 真实产品 Web preview 的远控入口 Chrome 验收            | 20/20：两种语言、有无旧 JWT、五类旧入口均无认证、换码或 relay 请求                                                |
| 真实产品 Web preview 的分享 Chrome 验收                | 6/6：中英文公开 200、401、404；公开页面可见，无 cookie/Authorization，无官方登录控件                              |
| 直接 POST 旧官方 token 入口                            | HTTP 403，响应仅 `AISCOO_ACCOUNT_LOGIN_UNSUPPORTED`                                                               |
| `pnpm test:unit:node`                                  | 本轮完整执行 275 项，266 通过 / 9 失败，退出 1；后续 key/退出窄修只执行对应定向组，未重跑完整 runner              |

完整 Native runner 的九项失败与此前 release 验证同名：六项旧 LocalWebAccount logout/撤销补偿，以及三个旧 factory/provider 装配场景。没有为绿灯恢复退役 Host 凭据方案、放宽断言或修改这些旧实现。此前证据及限制见 [desktop-product-identity-verification.md](desktop-product-identity-verification.md)。直接对测试 tsconfig 的额外非正式类型探测被既有 TS6307/项目文件列表等阻断；正式源码项目及根类型检查通过，未改测试配置。

最终验收采用临时数据、合成凭据与受控响应。服务测试首轮曾在路径绑定前隔离不完整，读入继承的 settings/provider/bot 元数据；该轮已弃用，不能据此宣称整个过程完全没有读取既有配置。后续正式 Host 证据在 import 前隔离 HOME/设置路径、固定数据根并禁止外部网络；未调用真实钥匙串或计费模型，未操作真实 3001。

未验证真实账号完整登录、发布安装器、安装后 OS key 恢复、Windows/Linux 运行或新的远控身份方案。现存运行应用未重启，不能把源码构建通过解释为运行实例已升级。

## 4. 上游文件与扩展理由

本次以独立 `aiscoo-account-policy`、`aiscoo/account-login`、Web 账号入口模块及既有 CLI Zen 包装实现产品差异。架构登记仅追加到 `architecture-policy.xwork.yaml`。通用 OAuth 状态机和 New API owner 未改写。下表逐个列出本次与 `upstream/main` 同路径的已修改文件；其中删除的连接卡、专属文案和官方连接回调分支是先前下游追加内容。

| 上游同路径文件                                                                  | 最小变更与理由                                                                             |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/desktop/src/host/index.ts`                                            | 在服务工厂组合点注入产品策略；通用工厂不自行决定产品渠道                                   |
| `packages/desktop/src/main/desktopOAuthDeepLink.ts`                             | 仅在 IPC 登记 parser 拒绝官方 state；路由表只经此登记，派发与 pending 投递不再重复判断     |
| `packages/desktop/src/main/index.ts`                                            | 同一策略包装 Main 凭据读取，分开 scheduler 限制与有效配置下的私有 key 初始化               |
| `packages/server/src/entry-http.ts`                                             | 产品入口注入策略及现有 browser authority                                                   |
| `packages/server/src/stdioServices.ts`                                          | 远端产品服务装配拒绝恢复官方身份，复用原 attachment                                        |
| `packages/services/src/model-provider/providerProvisioningSource.ts`            | 追加可选凭据来源端口；否则直接文件解密会绕过服务包装，默认读取行为保留                     |
| `packages/services/src/model-provider/providerProvisioningTarget.ts`            | 追加可选账号凭据 allowlist；空清单不读写/删除历史账号，默认清单保留                        |
| `packages/services/src/node.ts`                                                 | 追加可选策略与公开导出，组合既有 authority、目录/用量/套餐和不可用官方能力；未注入保留默认 |
| `packages/ui/src/Root.tsx`                                                      | 产品 Root 必然组合服务与平台包装，effects 与 Context 使用同一实例                          |
| `packages/ui/src/i18n/locales/en-US.ts`                                         | 追加产品静态错误；删除四个下游独立连接专属条目，未删除上游通用文案                         |
| `packages/ui/src/i18n/locales/zh-CN.ts`                                         | 同步中文产品静态错误及下游专属连接条目清理                                                 |
| `packages/ui/src/root/useRootOAuthEffects.ts`                                   | 移除先前下游追加的 official-cloud callback 消费分支                                        |
| `packages/ui/src/settings/ModelProviderSection.tsx`                             | 只删除对已移除 `useOfficialCloudConnection` 的调用，其余与 origin/release 相同             |
| `packages/ui/src/settings/model-provider-section/useModelProviderNavigation.ts` | 可选策略只过滤账号套餐节点，保留自配/API Key 供应商                                        |
| `packages/ui/src/settings/usage-stats/CodingPlanUsagePanel.tsx`                 | 移除下游 NativeOfficialMcpCard 与其连接按钮，上游原用量组件保留                            |
| `packages/web/src/main.tsx`                                                     | 仅组合产品不可用账号适配器、匿名分享及 bootstrap entry gate，不改通用浏览器 OAuth owner    |
| `packages/web/vite.config.ts`                                                   | 在插件组合列表追加产品 HTTP 拒绝边界                                                       |

2026-11-01 上游文件最小化后（见 [唯一登录规格](aiscoo-only-login.md) 第 13 节），`README.md`、`README.en.md`、`WelcomeScreen.tsx`、`useOAuth.ts` 与两个 Web pending E2E 已恢复 origin/release；渠道过滤、登录拒绝与完成信号由 Renderer 服务包装唯一执行，产品 E2E 断言迁到 `aiscoo-remote-login-admission.mjs` 与 `aiscoo-share-entry.mjs`。

上游 TS/TSX 接线与可选端口带 `XCODE` 原因注释。被删除的专属下游 hook 与文案不再保留空调用。没有改共享上游架构清单、依赖锁或通用 provider 协议。

## 5. 合并预演与证据

已只读刷新 `upstream/main`，为 `a60ba6a7e5a06742270ca605f5d2cc2766afa7e1`。使用临时 `GIT_INDEX_FILE` 从 HEAD 加入本次文件快照，`write-tree` 后以真实 merge-base 对 `upstream/main` 执行 `git merge-tree --write-tree --name-only --merge-base <base> <snapshot-tree> upstream/main`，退出 0，无冲突。没有创建提交或修改真实 index；本地 release 与其他 worktree 不变。

工作树清单、精确 tree 与日志摘要保存在 `packages/desktop/out/aiscoo-only-login/upstream-review.json` 和同目录 `verification-evidence.json`；原始已落盘日志复制到其 `logs/`。未独立落盘的代理前台结果明确按上表记录，不伪造日志文件。证据目录为忽略构建产物，不进入本次源码提交。

与本任务无关的品牌 ZIP、素材包说明、icon 规格及既有 `.zcode/` 资料原样保留，未加入本次预演快照或格式化范围。临时浏览器 preview 已停止。
