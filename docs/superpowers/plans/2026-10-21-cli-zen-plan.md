# CLI XWork Zen Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在独立 `zcode` CLI 中提供 XWork Zen Plan 登录、冷恢复、退出和真实套餐模型调用。

**Architecture:** aiscoo-admin 增加严格注册的 `xwork-cli` 客户端和回环回调，CLI bootstrap 拥有独立账号状态。I/O 在 adapters 中实现，模型授权复用现有 AccountProviderService、Registry 和请求期 credential resolver；桌面 SID、密钥与 active pointer 不共享。

**Tech Stack:** TypeScript、Node.js 24.14.0、pnpm 10.33.2、现有 Vitest/Node test；aiscoo-admin Go/Gin/GORM 和现有 React 授权页面；平台系统凭据库。

**Spec:** [CLI Zen Plan](../../../apps/zcode-cli/docs/design/v2/zen-plan.md)，后端 canonical spec 为 `/Users/timo/ai/aiscoo-admin/docs/specs/xcode-integration.md`。

## Global Constraints

- 展示名 `XWork Zen Plan`，命令 `zcode login zen`，保留官方入口；无参数 logout 保留官方语义。
- 客户端 `xwork-cli`，回调 `http://127.0.0.1:<port>/oauth/callback`；桌面仍为 `xcode-desktop` 与 `zcode://oauth/callback`。
- 显式 `AISCOO_ADMIN_BASE_URL`；不猜 origin，不明文保存凭据，不复制桌面密钥或 SID。
- 本机浏览器授权；`--no-browser` 不表示支持跨机 SSH 登录。购买、续费留在浏览器。
- 新代码模块先登记架构与 contract；CLI bootstrap 不跨域导入 Services 实现。
- 各仓库从 release 创建功能分支；不部署、不推送、不重启正式后端，不修改真实账号授权。真实模型请求单独明确范围。
- 每项先建立失败回归，再实现并运行定向测试；未实跑平台必须如实说明。

## Review Focus

1. CLI client_id 携带桌面 SID 刷新/退出必须拒绝，旧桌面会话继续可用（Task 1）。
2. 浏览器预取、favicon 和错误 state 不能提前消费回调或关闭正确登录（Task 2）。
3. 多个 CLI 进程同时刷新或退出，不得覆盖新账号或使轮换凭据丢失（Task 3）。
4. 原默认模型不属于 Zen 或 Zen 目录为空时，不得自动迁移或调用其他资金来源（Task 4）。
5. 已兑换成功但本机写入失败或用户取消时，精确补偿撤销，且不输出假成功（Task 3/5）。

## File Structure

aiscoo-admin 扩展 `service/xcode_auth.go` 的客户端校验和回调生成，在 `model/user_session.go` 增加客户端归属并贯穿缓存；优先扩展已有认证测试。XCode 的 `packages/shared/src/aiscoo-admin.ts` 保持既有默认常量并增加 CLI 常量/严格解析契约。

CLI 新增集中目录 `adapters/src/auth/zen/`（HTTP、回环监听、平台凭据）与 `bootstrap/src/zen/`（账号 owner、登录协调、Account overlay）。两个目录分别登记 managed module，提供 `module.ts`、`contract.ts`、`contract.example.ts`、`contract.test.ts`、`CONTRACT.md` 和公开出口。CLI 呈现接在已有 login/logout、command-center、i18n，不另建账号菜单框架。

### Task 1: 后端注册 CLI 授权与会话归属

**Files:** aiscoo-admin `docs/specs/xcode-integration.md`、`service/xcode_auth.go`、`model/user_session.go`、现有 migration/cache 合同与 `service/auth_session_test.go`；XCode `packages/shared/src/aiscoo-admin.ts`、`packages/shared/test/aiscooAdmin*.test.ts`（选择现存合适文件，最多新增一份协议测试）。

**Interfaces:** 新增 `XWorkCLIClientID = "xwork-cli"`；后端客户端校验函数接收 client ID/完整 redirect URI，分别执行桌面精确匹配或 CLI loopback 校验。UserSession 持久化 `ClientID`，空值仅在历史 xcode-purpose 会话中按 `xcode-desktop` 解释；缓存重建携带归属。

- [ ] 阅读 aiscoo-admin 适用目录规则及 OWASP Authentication、Session Management、OAuth2 guidance，记录适用控制；先更新 canonical spec 的客户端、redirect、refresh/logout 语义。
- [ ] 扩展认证回归：桌面原路径成功；CLI 随机端口成功；拒绝别名 IPv4、localhost、IPv6、空/越界/非数字端口、userinfo、query/hash、错误路径、encoded path 与尾斜杠。
- [ ] 写回归：code 的 client/完整 URI/PKCE 不匹配与重复消费失败；CLI SID 不能以 desktop 刷新/退出，反向同样拒绝；历史空 ClientID 的桌面会话仍可恢复；错误请求不能撤销其他 SID。
- [ ] 运行 `go test ./service -run 'Test.*XCode' -count=1`，确认新增断言失败后实现。完成授权返回值必须用 AuthFlow 保存的 redirect，不再固定拼接桌面 URI。
- [ ] 更新会话 schema、缓存 schema/读写、issue/refresh/logout 的客户端归属；不改变 xcode 资金用途或套餐归属。迁移须重复启动幂等，旧缓存缺字段时从 DB 重建。
- [ ] 使用仓库现有数据库测试入口验证真实 SQLite/MySQL/PostgreSQL：空库、旧库升级、重复迁移、旧 SID 与新 CLI SID。记录版本及准确命令，不以 SQLite 替代三数据库验证。
- [ ] 执行定向 Go 回归和 shared 协议测试，gofmt 后提交 `feat: register isolated XWork CLI authorization`。两个仓库各自提交，不部署。

### Task 2: CLI 授权与系统安全存储 adapters

**Files:** `apps/zcode-cli/packages/adapters/src/auth/zen/`、`adapters/src/auth/index.ts`、`adapters/tests/zen-auth.test.ts`、`adapters/package.json`、根 `pnpm-lock.yaml`、`architecture-policy.yaml`；相关打包脚本与测试仅按原生依赖需要修改。

**Interfaces:** `ZenCredentialStore` 提供 `assertAvailable(): Promise<void>`、`read(origin): Promise<ZenStoredSession|null>`、`compareAndSwap(origin, expectedRevision, next): Promise<boolean>`；`ZenAuthorizationListener` 提供 `redirectUri`、`wait(signal): Promise<{code,state}>`、`close(): Promise<void>`。HTTP client 使用 shared SessionBundle/Me/catalog/entitlements schema，客户端固定为 xwork-cli。

- [ ] 运行架构基线，登记 adapters managed module，生成并读受控上下文。先填写端口和可运行 contract 示例。
- [ ] 核验 `@napi-rs/keyring` 当前 Node/三平台 API、维护与打包支持，将核验结果和固定版本记录到 contract，再添加依赖；选择一个异步适配实现，禁止业务层直接系统调用。若底层只有同步原生 API，放到 worker 中执行。
- [ ] 在现有目录锁/原子写入基础设施上实现跨进程 CAS；系统库保存独立随机加密 key，CLI 专属文件保存加密 bundle 和 revision。文件命名按规范化 origin/client 分区，不触碰桌面 active pointer。
- [ ] 先写回归：安全库不可用时授权 HTTP 为零；秘密不出现在错误文本；并发 CAS 只有一个成功；系统库读取失败不生成替代 key。运行 `pnpm --filter @zcode/adapters exec vitest run tests/zen-auth.test.ts` 确认失败。
- [ ] 写真实 loopback 测试覆盖错误 state/path/重复参数、favicon、浏览器预取、重复正确回调、取消和超时；错误请求不完成 wait，成功回调只接受一次；close 后端口不可再访问。
- [ ] 实现 listener 与 HTTP adapter：先监听后生成 URI，限制请求大小/方法/路径，响应设 no-store，响应正文不回显 code/state；取消和异常清理全部资源。
- [ ] 执行 adapter 测试、包 typecheck/lint、普通 Node bundle 与原生依赖解析 smoke；macOS 做真实临时 Keychain 记录写读删，不访问已有账号凭据。提交 `feat: add secure CLI Zen auth adapters`。

### Task 3: 独立账号 owner 与登录生命周期

**Files:** `apps/zcode-cli/packages/bootstrap/src/zen/`、`bootstrap/src/index.ts`、`bootstrap/tests/zen-account.test.ts`、模块合同/架构注册。

**Interfaces:** `loginZenCli(options): Promise<ZenLoginResult>`、`logoutZenCli(options): Promise<{localCleared:boolean,serverRevoked:boolean}>`；`ZenAccountRuntime` 提供 `restore(signal)`、`login(options)`、`logout()`、`getOwner()`、`onDidChange`、`withControlSession(action)`、`getRelayCredential(owner)`、`dispose()`。结果仅返回用户与非秘密状态，不返回凭据内容。owner 使用 shared `AiscooAdminOwner`。

- [ ] 在 contract 中定义 timeout=10 分钟、取消、client/session/origin/generation 和存储 revision 规则；读取上下文后登记 bootstrap 模块。
- [ ] 写内存端口测试：首次登录、Me 不匹配、bundle 过期、取消迟到、两次登录交叉、写入失败与补偿；补偿只针对本次签发 SID，不能撤销已经切换的新账号。
- [ ] 写跨进程模拟回归：refresh CAS 输家重读后继值；另一个进程换号/退出时旧刷新不能提交；401 重试上限一次；503 保留凭据与不可用事实；明确撤销清除执行授权。
- [ ] 运行 `pnpm --filter @zcode/bootstrap exec vitest run tests/zen-account.test.ts`，确认新增回归失败，再实现状态机。首次执行先检查存储，再创建 listener，然后浏览器授权，最后 token/Me/commit；finally 清理监听。
- [ ] 凭据刷新复用服务器现有轮换语义；先核对撤销与重放窗口，跨进程刷新持现有锁，不自行设计第二套 refresh 协议。退出先失效内存 owner，再做精确清理与服务端撤销，返回真实结果。
- [ ] 执行定向回归和 bootstrap typecheck/lint，提交 `feat: manage standalone Zen account lifecycle`。

### Task 4: 套餐目录与请求期模型接入

**Files:** `bootstrap/src/app/process-provider-registry-runtime.ts`、`bootstrap/src/app/standalone-account-provider-runtime.ts`、`bootstrap/src/zen/account-provider.ts`、`bootstrap/tests/zen-provider-runtime.test.ts`；若复用桌面纯模型解析，新增 provider/provider-node 公共入口并更新原 Services 调用和对应测试。

**Interfaces:** `createZenAccountProviderResolver(account, client)` 产出已有 AccountProvider resolver 合同，完整返回 owner/modelConfigs/catalogIssues/catalogRevision/authorizationRevision；请求期 header port 仅在当前 account scope 有效时返回 relay 凭据。

- [ ] 读取 AccountProviderService 和请求期 header contract，明确 standalone 官方 source 与 Zen source 的组合与唯一刷新 owner；在实现前补充受影响公共合同。
- [ ] 写回归：现有官方/自配 provider 保留、Zen 未登录不可用、有效套餐目录可选择、无套餐/空目录/错误 revision 不可执行；原默认选择不自动改写。
- [ ] 写受控 HTTP 模型测试：请求命中配置 origin 与选定模型，control token 不用作 relay；换号、撤销、目录变化和迟到读取均拒绝旧 scope；TUI 与 prompt 使用同一 resolver。
- [ ] 执行 `pnpm --filter @zcode/bootstrap exec vitest run tests/zen-provider-runtime.test.ts` 确认失败；实现账号 source 与请求期凭据链路，不把 Zen 伪装为 Personal API Key。
- [ ] 执行新增与现有 standalone/registry 测试；如提取共享解析，执行桌面 aiscoo-admin model/registry 回归。提交 `feat: expose Zen Plan models to standalone CLI`。

### Task 5: 命令、TUI 与用户文档

**Files:** CLI `src/login-command.ts`、现有 logout handler、`src/command-center/{login-flow,create,types}.ts`、`src/cli-types.ts`、帮助来源；`packages/i18n/src/` 实际中英词条文件；`cli/tests/cli.unit.test.ts`、`cli/tests/tui-login-polling.test.ts`、新增集中 `cli/tests/zen-login.test.ts` 并加入 package test script；usage `01-quickstart.md`、`02-cli-reference.md`、`03-config.md`。

**Interfaces:** CLI 顶层 `login zen`/`logout zen` 调用 Task 3 公共方法；TUI `/login zen` 与 `/logout zen` 共用同一 runtime。官方 provider union 不混入 Zen token 类型；如需联合结果，用显式 discriminant。

- [ ] 写命令测试：parser 接受 zen，帮助列出新命令，默认官方 logout 不变；JSON 输出无 token，缺 origin 清晰报错。
- [ ] 写 TUI 回归：首项文案为 XWork Zen Plan，中英一致；授权打开失败展示同机 URL；取消后迟到完成不显示成功；无可用模型展示真实原因，登录成功进入模型选择而非强制迁移默认值。
- [ ] 用现有 Node test runner运行定向 `zen-login.test.ts` 和 TUI 登录测试确认失败，再接入命令和呈现，不在 TUI 保存业务 owner。
- [ ] 更新使用指南，说明同机限制、系统安全库要求、origin、独立 SID、退出结果与无参数 logout 语义。命令错误只输出稳定码与可操作信息。
- [ ] 执行 CLI typecheck/lint 和修改测试，提交 `feat: add XWork Zen Plan CLI login experience`。

### Task 6: 整体验收与本机安装产物更新

**Files:** spec 的验证记录、`docs/aiscoo/aiscoo-admin-integration-runbook.md`；构建产物不提交。隔离测试脚本归入现有测试体系。

- [ ] 启动独立 aiscoo-admin 测试实例、私有数据与合成账号，浏览器真实授权到 Node loopback，不改正式监听服务。验证密码/2FA/Passkey 仍沿用既有原生登录，未启用的认证方式不宣称实测。
- [ ] PTY 驱动真实 TUI：登录、模型列表、取消、重启恢复、退出；两个 CLI 进程交叉刷新与换号。以受控上游验证一轮模型工具调用和取消，避免真实计费。
- [ ] 验证桌面与 CLI 各自 SID 并存、各自退出；平台安全存储只使用合成测试记录，结束精确删除自有数据与进程。
- [ ] 执行 `pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`、修改文件格式检查；对受影响 CLI 包运行 typecheck/lint 和定向测试。根全量单测不执行。
- [ ] 后端执行 Task 1 三数据库与认证回归，前端只在授权页受影响时执行其测试/类型检查；记录未运行平台和环境阻塞。
- [ ] 构建 `pnpm --filter @zcode/cli... build`，通过现有 `~/.local/bin/zcode` 验证 `--version`、`doctor --json`、帮助与 Zen 登录入口；不改启动器为明文凭据注入。
- [ ] 汇总两仓库提交、测试、迁移与部署依赖；正式 aiscoo-admin 未升级时明确新 CLI 登录尚不能用于该实例，不宣称已上线。更新 spec 的实现/验证状态并提交 `docs: record CLI Zen Plan verification`。

## Execution Handoff

本计划为一个跨仓库交付，Task 1–5 均完成后才具备完整产品能力。推荐本会话顺序执行，以保持认证接口和状态所有权一致。若选择并行代理，只可分派接口已固定的独立测试/审查任务，禁止同时修改同一认证状态机。

计划自检：spec 的入口、回调、安全存储、归属、模型、失败路径与平台限制分别落到 Task 1–6；Review Focus 五项均有指定回归。依赖包固定版本与真实三平台能力核验是 Task 2 的明确检查步骤，未完成前不得写成已支持。
