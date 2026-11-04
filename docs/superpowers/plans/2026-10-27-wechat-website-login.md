# 微信网站登录 Implementation Plan

> **For agentic workers:** 本次由主代理负责协议与安全集成，后端和前端独立文件切片协作；执行中不提交、部署或改生产业务数据。用户已明确要求开始实施，执行方式由主代理选择，无需再次确认。

**Goal:** 实现微信官方网站扫码/快捷登录、首次自动注册、现有账号安全绑定，并复用 XWork 原有浏览器授权与 PKCE。

**Architecture:** 在 aiscoo-admin OAuth 注册表追加 wechat-open，使用独立可空唯一身份字段，复用原生 AuthFlow、Session 和安全验证。浏览器持有单次流程证明，以既有 Web Locks 串行化 Cookie 写入请求，避免迟到响应跨账号污染。XWork 桌面不增加认证协议。

**Tech Stack:** Go/Gin/GORM，React/TypeScript/TanStack/Zustand，Bun/Vitest，官方 WxLogin；无新依赖。

**Spec:** [微信网站应用登录与自动注册](../../aiscoo/specs/wechat-website-login.md)

**实施状态：** S01/S02 已实现并完成受控验证，工作树保持未提交、未合入、未部署。W10 真实扫码、电脑快捷登录和完整 Host/安全凭据库验收受外部前提阻塞；受控协议验证不替代 W10。

## Global Constraints

- Backend worktree: `/Users/timo/ai/new-api-wechat-open`，`feat/wechat-open-login`，从 backend release `d2abf9c` 切出。
- 原 `/Users/timo/ai/aiscoo-admin` 与 `/Users/timo/ai/XCode` 的无关改动不动；只写本任务规格/计划与隔离实现文件。
- 保留 New API / QuantumNous 归属；保留旧公众号微信、其他登录方式、既有 Session/PKCE 语义。
- SQLite/MySQL/PostgreSQL 真实实例验证迁移与约束，隔离浏览器验证真实响应 headers/body；真实微信验收另受应用资质/密钥/回调域名约束，不伪造通过。
- 可执行协作接口与所有权清单见 `local://wechat-open-contract.md`；执行证据记入 `local://wechat-open-progress.md`。

## Review Focus

- MySQL 默认大小写不敏感不能合并两个不同 OpenID，未绑定账户的 NULL 必须能共存。
- 并发同身份首次注册最多创建一人，唯一冲突不留下用户或重复奖励。
- callback 缺失/错误浏览器证明、跨标签复制、旧配置不得签发任何 Session 或 Cookie。
- 旧登录响应必须先收完 headers/body 才允许另一 Cookie mutation；包括二次验证与冷刷新。
- 新的绑定字段必须贯穿安全验证、解绑、最后因子保护、用户投影与删除。

## Task 1: Provider、配置与身份模型

**Files:** backend `oauth/wechat_open.go`、`setting/system_setting/wechat_open.go`、`common/constants.go`、`controller/misc.go`、`model/option.go`、`model/user.go`、`model/wechat_open.go`、`model/main.go`、认证绑定枚举及 `service/security_verification.go`。

**Interfaces:** 提供 `oauth.GetWeChatOpenConfig`、`oauth.WeChatOpenFingerprint`、`model.FindOrCreateWeChatOpenUser`；具体签名见协作契约。父代理负责 `controller/oauth.go`。

- [x] 在 `controller/wechat_open_test.go` 先追加默认关闭能力的行为回归，观察到当前未提供 website capability 的失败；补齐 state/身份边界覆盖。
- [x] 实现官方 HTTP 交互、严格配置验证、公开 capability、nullable 唯一字段及原子注册/绑定；上游响应只在请求内持有。
- [x] 接入所有内置字段枚举与解绑/最后因子保护；不依赖旧公众号字段。
- [x] 运行 controller/model/oauth/service 回归、MySQL/PostgreSQL 网站微信回归及三数据库迁移矩阵。

## Task 2: AuthFlow、浏览器证明与 Cookie 顺序

**Files:** backend `controller/oauth.go`、`controller/wechat_open_flow.go`、`controller/secure_verification.go`；web `features/auth/lib/wechat-open-flow.ts`、`features/auth/api.ts`、`routes/oauth/$provider.tsx`、`lib/oauth.ts`、`lib/http-client.ts`、`lib/auth-cookie-lock.ts`，以及安全验证 OAuth 提交路径。

**Interfaces:** 对 Task 1 的新 Provider 创建 proof-bound state；提供 `createWeChatOpenLoginAttempt`、`invalidateWeChatOpenAttempt`、`weChatOpenProofHeaders`；交换结果保持 AuthBundle/challenge。

- [x] 覆盖非法证明/旧 attempt 拒绝及 Cookie mutation 串行化回归，使用真实状态与受控网络边界。
- [x] flow 只存 proof hash 与配置指纹，兑换先检查再请求微信；设置安全返回目标、当前用户/SID，处理协议同意、重开、取消和二次验证。
- [x] 在统一 Axios adapter 上复用 `new-api:auth-refresh` Web Lock，覆盖会写 Cookie 的认证请求；refresh 原有锁不重复获取，只读密码公钥请求不占锁，错误路径释放且不重放一次性请求。
- [x] 用真实 headers/body 延迟及双标签冷刷新验证 W08；阻塞期间旧微信兑换请求为零，释放后两标签仍为新账号。

## Task 3: 登录、注册与安全绑定 UI

**Files:** web `features/auth/components/wechat-open-login.tsx`、sign-in/sign-up、AuthLayout、系统认证设置、`features/security/components/account-bindings.tsx`、auth/profile types、`features/users/types.ts`、`features/users/components/dialogs/user-binding-dialog.tsx`、`features/users/components/data-table-row-actions.tsx`、七个语言 JSON，以及 backend `controller/user.go` 的管理员身份投影。

**Interfaces:** 消费 status.wechat_open 与 Task 2 helper，组件 props 包括 capability、协议是否同意、原安全返回目标。

- [x] 覆盖协议未同意不发起、官方组件加载/失败/重开/取消清理、窄屏及能力关闭时账号可用。
- [x] 复用现有组件组合双栏卡片和微信区；官方 SDK 只在允许时加载，保留默认快捷登录能力；实际 iframe 300×400，调用 SDK 回写的 `options.onCleanup` 释放消息监听。
- [x] 配置 UI 使用真实开关/密钥遮蔽；网站微信可独立绑定/解绑，管理员可查看/清除；关闭原菜单后再打开绑定弹窗，避免模态焦点竞争。
- [x] 新增 UI/API 消息覆盖七种语言；七语种大字号、深浅主题及手机账号入口完成真实 Chromium 检查，相关登录/安全回归通过。

## Task 4: 验证与交付

**Files:** 上述行为测试、已有数据库测试基础与临时隔离验证程序；规格状态与现有 aiscoo-admin 认证文档同步。

- [x] Go 定向回归、Bun typecheck、36 个任务 TS/TSX 文件 lint、11 文件 128 项相关测试与前端生产构建通过；43 个任务前端文件按保护原版权头的方式格式化。全仓 lint 的 226 条诊断和 copyright check 的 24 个非本次文件问题单独保留，不记为通过。
- [x] SQLite 3.50.4 / MySQL 8.0.46 / PostgreSQL 16.14 新库、release `d2abf9c` 完整用户表升级，每场景实际迁移三次；验证旧数据、索引、NULL、唯一和大小写语义。该旧库 fixture 不是生产全库副本。
- [x] 隔离浏览器验证协议门禁、官方 SDK、主题/窄屏、受控登录注册、绑定/解绑/管理员清除与桌面授权返回；实际 Node 24 桌面适配器完成 PKCE、Me/refresh/logout/重放拒绝，未操作 OS handler 或真实安全凭据库。
- [x] 已登记 W10 外部阻塞：未核验已审核网站应用、可用 AppID/AppSecret、登记 HTTPS 回调域名；没有真实扫码/电脑快捷登录或完整 Host 验收通过的声明。
- [x] 独立后端/前端审查及对应回归完成，已移除临时 Go/桌面探针源码与 bundle、关闭浏览器和隔离服务、停止并移除两个测试数据库容器；匿名测试卷保留。正常无测试 tag 的 `go build -o /tmp/xwork-wechat-verify.qcXJYF/new-api-review .` 及该二进制 `--help` 通过。实现工作树保留供审阅，未提交、合入或部署。
