# aiscoo-admin 本机集成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在保留现有桌面布局、自配 Provider 与历史的前提下，将普通官方 Plan 推理切至本机 aiscoo-admin，贯通主账号、真实模型能力、本机 worker、指定套餐与账号用量，同时保留独立官方云连接。

**Architecture:** 窗口 Local Host 持有 aiscoo-admin 主身份和秘密；现有 AccountProviderService/Registry 发布无秘密的能力与授权快照，worker 通过原协议接收并在请求期取 relay key。套餐与用量沿现有 RPC/hooks 投影 canonical 数据；官方 MCP、闲时任务和分享沿独立 owner-scoped 官方连接取凭据，绝不借用私有主账号。

**Tech Stack:** Node 24.14.0、pnpm 10.33.2、TypeScript、Zod 4、现有受限 CEL 编译器、Electron、React、现有 RPC 与安全凭据 Repo；服务端依赖现有 aiscoo-admin Go/GORM/Bun。

**Spec:** [客户端设计](../../aiscoo/specs/aiscoo-admin-integration.md)；[唯一 HTTP/认证/计费 canonical spec](../../../../aiscoo-admin/docs/specs/xcode-integration.md)；[升级页视觉恢复规格](../../aiscoo/specs/aiscoo-admin-upgrade-ui.md)。本文原 T01–T10 实施 XCode，aiscoo-admin N1–N4 是有真实证据的前置交付；本次明确新增跨仓 U01–U04，仅恢复升级 UI 及所需展示元数据，不扩展资金、支付或企业业务。

## Global Constraints

- 本期全部本机启动、部署、访问；显式 `AISCOO_ADMIN_BASE_URL=http://127.0.0.1:3001` 才启用本机桌面私有组合，HTTP 仅允许本机 loopback，不能从 metadata/server_address 推导 origin。未配置的非私有宿主及独立 Web/远程路径保留；私有链路失败不回退。
- 普通 BigModel/Z.ai 个人、企业、Start Plan 全部 clean cutover；自配 Provider/key/模型、历史 ref 与现有远程/Web功能不删除。
- 旧官方 Plan 选择一律要求用户重选，即使 model_id 相同。私有 Provider 固定三个 anchor，group 为 `new-api-family`，不是按套餐生成 ID。
- 不做已有 aiscoo-admin 用户/订阅迁移绑定、企业组织权限、Start 独立余额、线上购买、额外 reset 机会或新增遥测采集。
- 服务端是唯一授权/资金事实源：指定实例仅供托管 key；钱包/其他订阅不兜底；账号图表统计所有原生消费/退款。
- 官方 MCP、闲时任务、分享保留官方 origin、真实身份/Plan/模型与账务；官方登录不得替换 Native 主账号。
- Renderer/provider config/header rules/个人配置/日志/Web Storage 不含 control、refresh、relay secret；refresh 只归 Host。
- 原始 ID/revision/额度/计数使用十进制字符串；Unix 毫秒时间；unlimited 和未知指标为明确 null/availability，不补假零。
- 保留布局、导航、组件和交互；真实数据文案通过现有 i18n。产品名称、发布渠道、New API/QuantumNous归属不改。
- 先核对 exported symbol 的 LSP references、架构受控上下文和 spec，再修改 union/实现；跨包走公开入口，UI走RPC/hooks。
- 上游文件最小修改并加 `// XCODE: <原因>`；bug修复说明原因与依据使用中文。不要增加兼容别名、全局 backend framework 或第二套 Registry。
- 当前功能分支 `feature/private-server-technical-design` 可按设计继续；PR目标 `XCode-main`，不切到 `main`。提交、推送、DB变更和现有服务重启不由本计划编写自动授权。

## Review Focus

1. 商品事实/展示元数据错位与 strict 解码破坏 → U01 `controller/xcode_plan_display_test.go` 覆盖 CRUD roundtrip、same-batch sidecar、资格和公共 `/plans` 不扩展；XCode `aiscooAdminWire.test.ts` 保持兼容。
2. 重复 SKU/缺周期/浮点折扣/币种混用 → U03 `plans-catalog.test.ts` 覆盖精确 ID、冲突回退、原生日历周期、可比价格和非日历时长。
3. 过期/耗尽/停用模板状态与假支付 → U03 `plans.test.tsx` 覆盖独立实例摘要、精确匹配、manual CTA 与无写请求，不从 trial/title 推断授权。
4. 错分类/主题语言首帧/字号与普通页面污染 → U02 `display-context.test.ts` 与 U04 `aiscooAdminUpgradePresentationElectron.mjs`，验证实际 Bootstrap、入口和首帧，不只断言生产字段。
5. Cookie await 换号/迟到分区/缩放/嵌套限宽 → U02 现有 `aiscooAdminWebHandoffElectron.mjs` 及 U04 新 smoke，覆盖 owner清理、CSP/同源防护和 guest DOM/zoom，不以独立网页代替。

## 0. 当前证据与实施前置门槛

2026-10-09 已开始实施。当前主身份、wire、安全库与 Main 路由已进入回归；目录/worker、套餐/用量、WebView/UI、独立官方连接按互不共享写入的切片实施，shared/node/Main 接线由集成执行者统一负责。实际完成与验收证据记录在 `.superpowers/sdd/2026-10-08-aiscoo-admin-integration/progress.md`；本计划任务未验收前不勾选。

开工 freshness 与架构基线通过；保留功能分支 `feature/private-server-technical-design` 的既有提交、追踪分支和用户本地修改。现有 3001 为旧二进制且新接口 404，不重启、不改其业务库；33519 隔离服务为 dirty build，不能作为当前源码部署/发布证据。已有隔离数据库矩阵及源码测试不替代本次桌面、SDK 和官方账号验收。

| Gate       | aiscoo-admin 必须交付的真实前提                                                                                       | 放行客户端任务                               | 未满足时行为                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------- |
| G1 / N1    | purpose/scope迁移、唯一授权关系、general排除xcode、托管请求只扣指定实例、跨reset结算与cache分类保护；三真实数据库验证 | T01可写客户端边界；T02真实登录仅在G2也通过后 | 不开放托管凭据、不修改原生资金、不用mock当验收                  |
| G2 / N2+N3 | 管理员grant/renew/replace/revoke/reset与revision；PKCE、专用Session/control/refresh/relay、所有认证入口用途隔离及撤销 | T02–T04运行时验收                            | 后端缺失只阻塞真实验收，可完成纯客户端RED/GREEN，任务标“未验收” |
| G3 / N4    | plans/entitlements/models/usage/client-config、精确metadata与revision、只读handoff/Web页面；真实日志开启              | T03、T05–T08真实读路径                       | 不猜目录/能力、不补零、不仿官方endpoint                         |
| G4 / 官方  | 可用BigModel/Z.ai官方账号、真实Plan/MCP/闲时权限，以及允许实际分享/推理的测试数据                                     | T09完整云验收                                | 完成可达边界验证；列具体缺项，不称完成                          |
| G5 / 部署  | 实际新二进制对应源码/构建标记、挂载和origin；隔离测试数据与已有本机服务区分                                           | T10                                          | 不用latest标签或旧服务status代替证明                            |

服务端前提的验收逐项对应 canonical §11，包括资金域、跨周期、Redis热缓存/缺字段、JWT升级攻击、原生面板仍可购买。服务端默认未通过，执行者保存后端提供的源码SHA、命令、原始结果和实际请求证据后才勾选。

## 1. 文件职责与依赖

新文件名称是本计划的目标，不表示当前已有实现。按既有模块新增，不另造模块树。

| 目标         | 新建文件                                                                                                                                      | 主要复用/修改文件                                                                                                         |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Wire与origin | `packages/shared/src/aiscoo-admin.ts`；`packages/services/src/aiscoo-admin/aiscooAdminClient.ts`、`aiscooAdminOrigin.ts`                      | shared公开入口；oauth/runtimeConfig与node组装                                                                             |
| Native身份   | `packages/services/src/oauth/providers/aiscooAdminProviderAdapter.ts`                                                                         | shared/oauth、OAuthService、providerAdapter、OAuthCredentialRepo、desktopOAuthDeepLink                                    |
| 官方独立连接 | `packages/services/src/official-mcp/officialCloudConnection.ts`、`officialCloudConnectionService.ts`；`packages/shared/src/official-cloud.ts` | 旧官方adapters、Repo、service descriptor/channel与RPC登记、node                                                           |
| 动态目录     | `packages/services/src/aiscoo-admin/aiscooAdminAccountProviderResolution.ts`                                                                  | provider sources/resolver/account service/config unions；provider-node model-selection；shared/protocol；CLI snapshot解析 |
| 套餐/统计    | `packages/services/src/aiscoo-admin/aiscooAdminSubscriptionReadAdapter.ts`、`aiscooAdminUsageMapper.ts`                                       | coding-plan-subscription、usage-stats、shared套餐/统计/reset DTO                                                          |
| UI           | 不新建页面体系                                                                                                                                | OAuth hooks、ModelProviderSection、usage/reset panels、升级WebView、现有i18n                                              |
| 回归         | 下列T01–T09指定测试文件                                                                                                                       | `node:test`+assert，安装的tsx；不引入测试框架                                                                             |

```mermaid
flowchart TD
  T01[T01 Wire 与安全控制 client] --> T02[T02 主账号与 PKCE]
  T02 --> T03[T03 Account 目录与能力]
  T03 --> T04[T04 worker 同步与真实调用]
  T02 --> T05[T05 套餐 RPC 与支付 guards]
  T02 --> T06[T06 账号用量与单周期 reset]
  T05 --> T07[T07 只读升级 WebView]
  T03 --> T08[T08 UI clean cutover]
  T04 --> T08
  T06 --> T08
  T07 --> T08
  T02 --> T09[T09 官方独立连接与全部云 caller]
  T08 --> T10[T10 两仓真实验收与发布门槛]
  T09 --> T10
```

任务执行默认按编号；只有无共享文件的步骤可并行。shared unions、node组装和RPC注册由一个集成执行者统一修改；不能多个任务并发写这些文件。T09的官方owner DTO/purpose先在T02定义，避免T02先做无法隔离的官方登录再返工。

```mermaid
sequenceDiagram
  participant UI as Renderer
  participant H as Local Host owner
  participant N as aiscoo-admin
  participant W as 本机 worker
  UI->>H: startOAuth(aiscoo-admin)
  H->>H: 新authGeneration，保存state/verifier/purpose/window
  H->>N: 原生授权页与PKCE兑换
  N-->>H: SessionBundle
  H->>H: 核对origin/user/SID/generation，原子持久化
  H->>N: me + entitlements + models
  H->>H: 同owner/revision校验能力后发布
  H->>W: providerUpdateAccountConfig（无秘密）
  W->>H: model-request请求期凭据
  H-->>W: 当前SID relay credential
  UI->>H: logout / 换号 / 明确撤销
  H->>H: 先递增generation、失效授权/缓存/WebView/官方视图
  H->>W: fail-closed配置与凭据失效
  H->>N: 尽力撤销SID，记录真实结果
  N-->>H: 旧异步结果
  H->>H: fence拒绝，不回写当前用户
```

## 2. 通用执行与验证规则

每任务先阅读设计对应章节及现有实现，再写消费者可见的RED用例，观察失败原因，最小实现，执行GREEN和实际路径smoke。具体源码改动先运行 `pnpm architecture:check --changed` 并按实际模块ID执行 `pnpm architecture:context <module-id>`；ID来自当前policy，不猜。导出变更使用LSP references，列全调用者后同任务迁移，不留未判别兼容分支。

新增回归使用已存在的 `node:test` 风格，直接运行：

`mise.toml` 固定Node 24.14.0与pnpm 10.33.2；本机当前没有 `mise` 可执行程序，Homebrew node@24实测为24.18.0、pnpm为10.33.2。下列命令以已配置固定版本的mise为标准；本机执行前提供24.14.0工具链。仅文档格式检查已使用24.18.0完成，不作为固定版本业务验证。若不使用mise，在准备相同固定版本并核对 `node --version` / `pnpm --version` 后，去掉命令中的 `mise exec --` 前缀直接执行，不引入包装函数或修改仓库工具链。

```sh
mise exec -- pnpm exec tsx --experimental-test-module-mocks --tsconfig packages/services/test/tsconfig.json --test packages/services/test/aiscooAdminWire.test.ts
```

该入口与现有运行手册一致。T01–T10 中 Files 的 Create 是最初规划，执行时按当前实现核对，不重复创建或恢复移除模块；本轮 U01–U04 明确列出现有 Modify 与将新增 Create。每任务列出实际验证路径。单例数据目录用临时目录/finally清理、禁用watch；不可读写真实用户安全库。HTTP fixture仅验证解析/拒绝/竞态，不替代真实服务验收；不写转发mock echo/source-text测试。

每任务证据记录：spec条款、源码SHA、RED/GREEN命令及结果、实际smoke步骤/结果、未通过门槛。任务通过后更新对应使用文档；最终整合文档在T10列出。提交仅用户明确要求后进行，不能照技能模板自动commit/push。

### T01：严格 wire 与固定 origin 控制 client

**依赖：** canonical §6–§8；真实HTTP验收需G3。

**Files:** Create `packages/shared/src/aiscoo-admin.ts`、`packages/services/src/aiscoo-admin/aiscooAdminOrigin.ts`、`aiscooAdminClient.ts`、`packages/services/test/aiscooAdminWire.test.ts`；Modify `packages/shared/src/index.ts`、`packages/services/src/oauth/runtimeConfig.ts`、`packages/services/src/node.ts`。

**Interfaces:** shared导出SessionBundle/AuthorizationSnapshot/CatalogSnapshot/AccountUsageSnapshot的类型与运行时schema，字段逐项从canonical复制。服务层目标接口 `normalizeAiscooAdminOrigin(value: string): string`；`AiscooAdminClient`提供 `exchangeCode/refresh/logout/me/plans/entitlements/models/usage/clientConfig/createWebHandoff`，参数和结果只使用canonical定义，不返回any。读请求冻结 `{origin,userId,sessionId,authGeneration}`；快照来源的authorization/catalog revision保持十进制字符串。

- [ ] 按canonical创建schema，严格区分 `success:false` 和合法空值；SessionBundle identity/expiry检查后才允许持久化。所有异常响应拒绝执行授权，原始错误code/status保留。
- [ ] 创建以下可直接运行的origin RED用例，再补schema用例：大ID `9007199254740993123456`不变、unlimited三个字段null、合法负net_quota保留、非字符串计数/错误schema_version/缺能力布尔拒绝。

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAiscooAdminOrigin } from "../src/aiscoo-admin/aiscooAdminOrigin.js";
test("private HTTP origin is loopback only and cannot contain credentials", () => {
  assert.equal(normalizeAiscooAdminOrigin("http://127.0.0.1:3001/"), "http://127.0.0.1:3001");
  assert.throws(() => normalizeAiscooAdminOrigin("http://127.0.0.1.evil.invalid:3001"));
  assert.throws(() => normalizeAiscooAdminOrigin("http://user:password@127.0.0.1:3001"));
  assert.throws(() => normalizeAiscooAdminOrigin("http://192.168.1.2:3001"));
});
```

- [ ] 实现固定origin、异步IO与严格解析。不得跟随重定向向别源传Authorization；session/key明确失效、access过期、503/网络错误分开；只读access过期最多一次正常refresh重试，不将403安全拒绝当刷新提示。
- [ ] 运行 `mise exec -- pnpm exec tsx --experimental-test-module-mocks --tsconfig packages/services/test/tsconfig.json --test packages/services/test/aiscooAdminWire.test.ts`；实际aiscoo-admin读取时验证no-store、response schema、origin，不保存秘密到证据。接口未落地时报告G3而不是伪造成功。

### T02：Native主账号、PKCE、恢复与owner隔离

**依赖：** T01，G1/G2；客户端设计§3/§4、canonical§4/§6.2。

**Files:** Create `packages/services/src/oauth/providers/aiscooAdminProviderAdapter.ts`、`packages/shared/src/official-cloud.ts`；实际回归为现有 `packages/services/test/aiscooAdminAccountLifecycle.test.ts`、`packages/services/test/aiscooAdminCredentialBoundary.test.ts`；Modify `packages/shared/src/oauth.ts`、`packages/services/src/oauth/{oauthService.ts,oauthProviderLogout.ts,providers/providerAdapter.ts,providers/index.ts,repo/oauthCredentialRepo.ts}`、`packages/desktop/src/main/desktopOAuthDeepLink.ts`；shared公开入口与RPC wiring由集成owner处理。

**Interfaces:** `OAuthProviderId`增加 `new-api`；pending flow明确 `purpose: "primary" | "official-cloud"`，记录origin、window/state/verifier与generation；Native token分支以真实control/refresh/relay/SID命名，不借用zcodeJwtToken。官方owner为规范化Native origin+原生user_id，不用username；官方公开snapshot无秘密，T09消费。

- [ ] RED：A的exchange延迟→取消/开始B→A返回有效SID；观察B仍为主身份，A不落库且执行真实logout。覆盖错误state/provider/窗口、另origin、PKCE S256、恢复时网络503保留凭据、明确撤销清授权、refresh单飞与后继refresh原子持久化。
- [ ] 扩展adapter context以保存PKCE与purpose，复用现有adapter/service/Repo。主登录浏览器只开Native授权URL；deep link精确按pending window/provider/state路由，无“当前窗口”fallback。private polling稳定拒绝，不返回假pending。
- [ ] 安全库按 `new-api:<origin-key>:<user-id>:<sid>` 保存；恢复先确认服务端身份，JWT exp只是提示。opaque token不能被当作已验证会话；解密失败沿用明确人工恢复错误。refresh同SID保持relay key，删除key不得自动修复。
- [ ] logout/切换/refresh明确失效先封闭私有执行、worker秘密、订阅/目录/usage/WebView，再尽力服务端撤销；网络失败显示撤销未确认。官方存储保留但锁定，只原主user_id可恢复。无owner旧全局官方凭据不自动认领、不删除。
- [ ] 运行 `mise exec -- pnpm exec tsx --experimental-test-module-mocks --tsconfig packages/services/test/tsconfig.json --test packages/services/test/aiscooAdminAccountLifecycle.test.ts packages/services/test/aiscooAdminCredentialBoundary.test.ts`；真实桌面注册/登录/重启恢复/A→B→A，查Renderer DTO/日志无秘密；服务器确认SID撤销。此任务不宣称官方云请求已接通。

### T03：私有 anchors、完整能力与一致revision的Account目录

**依赖：** T02、G3；客户端§5.1/§5.2/§5.4。

**Files:** Create `packages/services/src/aiscoo-admin/aiscooAdminAccountProviderResolution.ts`、`packages/services/test/aiscooAdminRegistry.test.ts`；Modify `packages/provider/src/{sources.ts,resolver.ts,account-provider-resolution.ts,account-provider-state.ts,account-provider-service.ts,config-service.ts,registry-service.ts}`、`packages/provider/src/config/{provider-data-schema.ts,provider-config.ts,schema.ts,rule-data-schema.ts}`、`packages/shared/src/model-provider-types.ts`、`packages/services/src/model-provider/{providerRuntime.ts,providerConfigRuntime.ts}`、`packages/provider-node/src/zcode-builtin-provider-config-materializer.ts`。

**Interfaces:** `AiscooAdminAccountAccess={type:"new-api-account",accountType:"new-api",mode:"private-subscription",entitled:boolean}`；Account snapshot新增 `modelConfigs: providerId→modelId→ModelConfigData` 与 `catalogIssues: {source:"new-api",modelId,displayName,code}[]`。模型、issue、access/state进入同一revision；保留basedOnZCodeBuiltinRevision栅栏。私有身份使用opaque connectionKey，无fake org/project。

- [ ] RED：目录同ID不同协议只出现管理员指定transport；Personal模型不能放宽context/tool/输出上限；metadata null或CEL编译失败成为不可选择issue；换号/撤销与等待builtin revision时旧模型立即不可执行；CDN刷新不移除私有anchors。
- [ ] 在现有本地builtin materializer seam始终合并三个anchor：`account:new-api-anthropic-messages`、`account:new-api-openai-chat-completions`、`account:new-api-openai-responses`；无key/假GLM默认模型。不要要求CDN先发布私有ID。
- [ ] 用真实login+entitlements+models生成snapshot，完整能力使用completeModelConfigDataSchema与既有CEL编译器；无reasoning neutral配置也必须来自后端。非法模型只进issues，不生成Registry ref；管理员修复后按新revision移入真实目录。
- [ ] source/config/resolver/Registry同步支持新access和modelConfigs；私有能力优先于Personal/Template/manual覆盖，只允许管理员范围内的reasoning/output选择。No Plan/目录空/网络错误不造entitled或默认模型。
- [ ] ModelSelectionView/ProviderSettingsView及shared RPC增加只读issues；解耦ordinary selection与原account-plan唯一provider自动remap。
- [ ] 运行 `mise exec -- pnpm exec tsx --experimental-test-module-mocks --tsconfig packages/services/test/tsconfig.json --test packages/services/test/aiscooAdminRegistry.test.ts`；真实管理员metadata编辑、grant/replace/revoke后观察Host目录、disabledReason及旧ref拒绝，而不是只看selector列表。

### T04：本机worker快照、请求期secret与三个SDK transport

**依赖：** T03、G2/G3；客户端§5.3/§9。

**Files:** Create `packages/services/test/aiscooAdminWorkerBoundary.test.ts`；Modify `packages/shared/src/zcode-protocol/index.ts`、`packages/services/src/zcode-agent/zcodeAgentService.ts`、`apps/zcode-cli/packages/bootstrap/src/{app/process-provider-registry-runtime.ts,app/provider-registry-model-runtime.ts,zcode-protocol/account-provider-config.ts}`、`packages/services/src/model-provider/{accountProviderConnectionResolver.ts,accountProviderRequestAuthService.ts,accountProviderApiKeyResolver.ts,providerProvisioningSource.ts,providerProvisioningTarget.ts}`、`packages/services/src/node.ts`。

**Interfaces:** `providerUpdateAccountConfig`传modelConfigs/issues与owner/revision一致性信息，不传secret；`parseProcessAccountProviderConfigSnapshot`严格保留/校验新字段；现有请求期auth理由 `model-request`取当前Native SID relay，`off-peak`对private access拒绝。不新增远程lease或provisioning秘密。

- [ ] RED：worker真实解析并解析出完整context/tools/option maps；旧owner/旧revision请求被拒；logout后已运行worker不能再获取或复用可执行secret；snapshot无control/refresh/relay。缺新字段不能静默回旧能力执行。
- [ ] Host push与worker parser一起扩展；按当前generation校验请求期secret，只有model-request使用relay key；不读官方JWT/MaaS/env fallback。失效顺序与T02一致，不用timeout掩盖同步。
- [ ] transport baseUrl遵守canonical：Anthropic origin→`/v1/messages`；OpenAI origin+`/v1`→`/chat/completions`与`/responses`。复用真实SDK，不重新封装SSE、不裁tools/vision/reasoning参数。
- [ ] shared新union引起的远程caller编译同步修正；私有远程明确unsupported，不被zhipu fallback解释；provisioning envelope无Native秘密。原非私有remote功能保留。
- [ ] 运行 `mise exec -- pnpm exec tsx --experimental-test-module-mocks --tsconfig packages/services/test/tsconfig.json --test packages/services/test/aiscooAdminWorkerBoundary.test.ts`；真实本机Agent分别用三种transport流式文本/tool、metadata允许的vision/reasoning及取消；观察实际请求路径、日志、consume和额度变化。额度/撤销/上游失败各自保留可识别错误。

### T05：Native套餐读RPC与完整manual purchase guards

**依赖：** T02、G3；客户端§6。

**Files:** Create `packages/services/src/aiscoo-admin/aiscooAdminSubscriptionReadAdapter.ts`、`packages/services/test/aiscooAdminSubscription.test.ts`；Modify `packages/shared/src/coding-plan-subscription.ts`、`packages/services/src/coding-plan-subscription/{codingPlanSubscription.ts,codingPlanSubscriptionService.ts}`；所有支付读caller由LSP references列出并在本任务一并迁移，UI展示整合由T08完成。

**Interfaces:** DTO明确 `source:"new-api"`、`purchaseMode:"manual_admin"`、`scope:"private-user"`，真实模板/唯一实例，不伪造team。六读方法改 `SelfServiceReadResult<T> = {availability:"available",data:T} | {availability:"not-supported",reason:"manual_admin",data:null}`；非private仍包装真实available，不能保持旧裸T。

- [ ] RED：各private支付写抛 `XCODE_SELF_SERVICE_DISABLED`；六读返回not-supported且不触发轮询/假成功；网络/身份失败仍是真实错误。模板价格/原生period真实映射、无fake org/project/wallet。
- [ ] 批量preview/static个人/static team/Start/productInfo/preview映射plans+entitlements；企业预算入口显示统一私人订阅。把真实官方team scope移至官方连接读路径，不能与主Native余额混用。
- [ ] 全面拒绝createSign/updateSign、bind/unbind/payStripe、Paypal setup/subscribe、calculate/create/cancel/continue enterprise order；拒绝前不调用支付HTTP、不造agreement/card/setup token。
- [ ] 六读逐个改签名并迁移caller：checkPayment/checkPendingOrders/queryStripeCards/checkPaypalSupport/getEnterprisePendingOrders/checkEnterpriseOrderStatus，先判availability，停止付款/订单poll。保留入口转手工说明；不新增支付读HTTP。
- [ ] 保留preflight-v1与实际应用更新来源；offPeak/dynamicWorkflow仍是官方路径，T09重接，Native client-config不能开启官方feature。
- [ ] 运行 `mise exec -- pnpm exec tsx --experimental-test-module-mocks --tsconfig packages/services/test/tsconfig.json --test packages/services/test/aiscooAdminSubscription.test.ts`；实际RPC访问套餐、点击原升级/续费入口，确认没有订单请求/支付成功状态。Native原生面板仍可购买由后端联调T10验证。

### T06：账号用量、指定单周期额度与reset只读语义

**依赖：** T02、G3；客户端§7、canonical§8。

**Files:** Create `packages/services/src/aiscoo-admin/aiscooAdminUsageMapper.ts`、`packages/services/test/aiscooAdminUsage.test.ts`；Modify `packages/shared/src/{usage-stats.ts,usage-quota.ts,coding-plan-reset.ts}`、`packages/services/src/usage-stats/{usageStats.ts,usageStatsService.ts}`、`packages/ui/src/{hooks/useCodingPlanQuotaResetUi.ts,lib/codingPlanQuotaResetUi.ts,lib/codingPlanQuotaResetCoordinator.ts}`。

**Interfaces:** private-user quota与new-api-account统计分开；modelCallCount nullable、consumptionRecordCount/source明确；agent duration/tool/decode等availability明确。ResetStatus联合 `mode:"official-windows"` 与设计§7.3的 `mode:"native-single-period"`，Native包含authorizationStatus/revision、真实period/time/timezone和not-supported history，无机会数组。markHistory返回not-supported结果，不再Promise<void>假成功。

- [ ] RED：有限额度used%=25展示剩余75%，unlimited null不显示0；大十进制精确保留；负净退款保留；消费记录不映射模型调用；未知时长/工具不填零；同用户不同key数据来自账号范围，额度仅指定实例。today/7d/30d/custom含DST；非法custom超过30自然日明确报错。
- [ ] 用只读client分别读usage/entitlements，generic getSnapshot明确来源，无private失败→local/官方fallback；App Usage现有本地实现不改。历史模型统计可显示但不授予选择权限。
- [ ] Native reset状态精确按设计联合映射；period未授予null，时间毫秒，不重算服务端nextResetTime。机会申请/use拒绝自助disabled，markHistory not-supported，UI不进入poll/已读/成功动画。
- [ ] Native mcpQuota=null；官方MCP卡由T09真实官方来源读取。支持零消费桶，但不能将缺失token/cache/reasoning/Agent时长补零。
- [ ] 运行 `mise exec -- pnpm exec tsx --experimental-test-module-mocks --tsconfig packages/services/test/tsconfig.json --test packages/services/test/aiscooAdminUsage.test.ts`；真实usage查询含多key/general/wallet/退款，reset后重新读取：预扣100→reset→actual150显示新周期150；actual100也计入；旧占用退款不减新请求。该资金算法由后端执行，UI只读取事实。

### T07：同源只读Web handoff与账号分区清理

**依赖：** T05、G3；客户端§4.3、canonical§9。

**Files:** Existing `packages/services/test/aiscooAdminWebHandoff.test.ts`；Modify `packages/ui/src/settings/{CodingPlanUpgradeDialog.tsx,NativePlanEmbeddedWebviewDialog.tsx}`、`packages/services/src/coding-plan-subscription/codingPlanSubscription.ts`；通过 IPlatformService 的 Main/分区实现执行，不复用官方 dialog 的认证注入，不在UI直接window.zcode或fetch。

**Interfaces:** 在套餐服务增加 `createPlanWebHandoff(): Promise<{url:string;ownerGeneration:number}>`，Host调用canonical `/web-handoffs`并校验精确origin与`/xcode/plans`路径，Renderer只拿短期URL及非秘密generation。真实分区按主owner/generation绑定，owner失效即关闭/清理。

- [ ] RED：handoff跨源/恶意用户名origin/错误路径拒绝；A分区不能由B复用；迟到A handoff不打开；logout关视图；页面导航不能把短code/秘密带到别源。
- [ ] 复用dialog/sidebar/navigation，Native路径移除官方localStorage注入与购买完成假成功语义；展示原版结构的真实套餐比较只读页。旧首次页面打开只证明认证链路，视觉恢复另按 U01–U04 验收；关闭/回客户端可刷新真实entitlements，不自行标paid。
- [ ] 清理generation专属WebView分区，保持官方origin防护不放宽；禁止control/refresh/sk-key入URL/页面。短handoff一次性消费后303移除query，由服务器设置只读cookie。
- [ ] 运行 `mise exec -- pnpm exec tsx --experimental-test-module-mocks --tsconfig packages/services/test/tsconfig.json --test packages/services/test/aiscooAdminWebHandoff.test.ts`；实际打开升级嵌入页、导航、过期/重放、A→B、SID撤销；查看Storage与请求：无长期secret，cookie不能升级原生面板。

### T08：全部UI选择、身份分支与真实空值展示clean cutover

**依赖：** T03–T07；客户端§5.4/§6/§7。

**Files:** Create `packages/services/test/aiscooAdminSelectionCutover.test.ts`；Modify `packages/provider-node/src/model-selection-facade.ts`、`packages/ui/src/{hooks/useOAuth.ts,hooks/usePlanIdentitySnapshot.ts,hooks/useModelSelectionView.ts,lib/accountProviderAccess.ts,lib/codingPlanUsageSources.ts,settings/ModelProviderSection.tsx}`、`packages/ui/src/settings/usage-stats/CodingPlanUsagePanel.tsx`、`packages/ui/src/i18n/locales/{zh-CN.ts,en-US.ts}`。由references补齐ModelProvider Detail、vision badge、reset dialog及支付caller，不凭文件名猜路径。

**Interfaces:** Native作为ordinary选择但managed access；旧official ref保留历史显示、不可执行、不可自动remap。selector/settings读取同revision catalogIssues，不提供issue的model ref/action；主账号头像/用户名始终Native。

- [ ] RED：保存旧official provider+同名model时启动/新发消息明确要求重选；custom选择与历史不变；三个Native transport不自动互转；个人config不能覆写admin能力。可通过实际model-selection-facade恢复持久ref验证，而不是匹配源码文字。
- [ ] 迁移所有family二元fallback为显式Native/official处理；计划身份、usage source、vision badge、Provider detail、失效提示与group unions一起修改。只清普通路径旧依赖，保留官方off-peak/hidden config/adapter。
- [ ] 用现有问题提示区显示metadata缺失/CEL失败模型实际名称和原因，无选择动作。修复metadata后移入真实目录；换号清旧issues。
- [ ] 原卡片/导航/日期控件保留：单周期/unlimited、账号用量标签、消费记录数、未知“暂不提供”、手工授予说明、官方MCP独立连接按钮/来源。升级页恢复原版布局按 U01–U04，不以只读详情代替；其他页面禁止无关重做或删除未知卡片。
- [ ] 运行 `mise exec -- pnpm exec tsx --experimental-test-module-mocks --tsconfig packages/services/test/tsconfig.json --test packages/services/test/aiscooAdminSelectionCutover.test.ts`；实际Electron检查登录菜单、selector、Provider设置/详情、套餐、用量所有卡片/图表/date controls、reset外壳、升级dialog。保存脱敏截图；切换主题/语言并核对长model/plan名称，无假双周期或假次数。

### T09：独立官方连接、MCP/闲时任务/分享全部重接

**依赖：** T02，T03/T04的普通路径切换；完整验收需G4；客户端§8。

**Files:** Create `packages/services/src/official-mcp/{officialCloudConnection.ts,officialCloudConnectionService.ts}`、`packages/services/test/officialCloudOwner.test.ts`；Modify `packages/services/src/{official-mcp/officialMcpCredentials.ts,session/offPeakRuntimeModel.ts,model-provider/offPeakModelSelectionView.ts,node.ts}`、`packages/services/src/coding-plan-subscription/codingPlanSubscriptionService.ts`、shared/service channels/RPC登记与现有UI服务hooks。

**Interfaces:** `IOfficialCloudConnectionService`定义 `getSnapshot()`、`startOAuth(family)`、`handleCallback(url)`、`logout()`、`refresh()`；family使用真实官方union，snapshot含owner、credentialGeneration、family/official identity/真实scope和云view但无secret。复用T02 purpose/Repo与BigModel/Z.ai adapters；credential fingerprint二次核对继续保留。

- [ ] RED：官方登录不改变主getActiveProvider/aiscoo-admin UserInfo；A→B隐藏A云连接且官方请求拒绝；A回来可恢复；迟到cloud entitlement/share import不覆盖B；旧全局无owner凭据不自动认领。
- [ ] 新服务按Native origin/user_id隔离官方安全库；official-cloud pending与primary分离，官方OAuth只更新对应owner连接。真实org/project/Plan来自官方服务，没有权益则不可用。
- [ ] MCP credential resolver不扫描普通Registry找唯一zhipu-provider；scope与`buildOfficialMcpAuthHeaders`保留，官方usage仍 `/api/v1/mcp/usage`。offPeakRuntimeModel与node resolveAccountProvider从同connection取官方key/JWT，拒绝private off-peak。
- [ ] 独立云model view取原官方配置；getOffPeakClientConfig/getDynamicWorkflowClientConfig维持原origin/灰度/权限，不读取Native目录/client-config。
- [ ] ConversationShareHttpClient的tokenProvider取当前owner官方连接，覆盖发布/能力发现/分享读取；无连接required-auth仍authentication_required，public preview/continuation optional-auth保留匿名且不附Native token。返回前核对主owner+official generation。
- [ ] 运行 `mise exec -- pnpm exec tsx --experimental-test-module-mocks --tsconfig packages/services/test/tsconfig.json --test packages/services/test/officialCloudOwner.test.ts`；真实官方账号完成MCP、闲时任务、分享发布与匿名导入，观察官方model/账务与出站origin/认证来源。没有实际账号/Plan时此项不得勾完成，写出受阻的精确能力。

### T10：两仓真实联调、回归与可发布门槛

**依赖：** T01–T09全部实现和G1–G5；客户端§11、canonical§11。

**Files:** Create `docs/aiscoo/aiscoo-admin-integration-runbook.md`；Update `docs/aiscoo/specs/aiscoo-admin-integration.md` 的实际状态与当前可执行命令，不改变canonical契约；证据保存到本次执行报告，不提交secret/真实用户数据。

- [ ] 核对实际新aiscoo-admin二进制的源码/构建标记、数据挂载、origin；只在明确允许的部署环境启用 `XCODE_INTEGRATION_ENABLED` 与 `XCODE_PUBLIC_ORIGIN`，不能凭现有status成功直接继续。数据库/重启授权单独取得，不影响现有服务。
- [ ] 运行全部本计划新增回归；执行仓库现有providerConfigMigration测试证明custom/历史保留。实际命令：

```sh
mise exec -- pnpm exec tsx --experimental-test-module-mocks --tsconfig packages/services/test/tsconfig.json --test packages/services/test/aiscooAdmin*.test.ts packages/services/test/officialCloudOwner.test.ts packages/services/test/offPeakExecutionLifetime.test.ts packages/services/test/conversationShareOperationFence.test.ts packages/services/test/officialInvocationDispatch.test.ts packages/services/test/providerConfigMigration.test.ts packages/desktop/test/aiscooAdminOAuthRoutes.test.ts
mise exec -- node packages/desktop/test/runAiscooAdminElectronSmokes.mjs
mise exec -- pnpm typecheck
mise exec -- pnpm lint
mise exec -- pnpm fmt:check
mise exec -- pnpm architecture:check --changed
```

- [ ] 启动真实桌面：`AISCOO_ADMIN_BASE_URL=http://127.0.0.1:3001 mise exec -- pnpm dev:desktop:test`，使用隔离开发数据目录；复核环境变量实际到Host，不默认launcher已透传。操作原生注册→私有登录→无授权推理拒绝→管理员grant→手动选择模型→三SDK流/tool/允许的vision/reasoning/取消→实际consume/额度/账号图表→额度耗尽→撤销。
- [ ] 额度耗尽时钱包/general订阅仍充足，实际检查两者余额不变；不同Native key/general/wallet消费进入账号图表，另一用户不进入；Native套餐卡只指定实例。逐项复核后台renew/expired renew/replace/revoke/同模板单实例reset、并发revision及跨周期settle/refund/reserve证据。
- [ ] 重启恢复、A→B→A、迟到callback/usage/catalog/cloud结果、网络503、明确SID/key撤销；观察Host和worker都拒绝旧执行、WebView关闭、云凭据只同owner恢复，网络失败不假signed-out/no_plan/0。
- [ ] 检查原生面板购买仍可用；private payment/reset guards无伪造成功；所有三类凭据交换攻击、普通key旁路/热缓存/旧hash/缺purpose拒绝结果由aiscoo-admin报告对应。真实SQLite/MySQL/PostgreSQL矩阵不可用时记缺项，不能以SQLite覆盖三方言。
- [ ] 实际官方MCP/闲时任务/分享验收；无连接时UI要求独立连接，公共分享匿名能力保留，Native秘密从未到官方origin；自配Provider与原非私有remote/Web路径不删除，private remote清楚unsupported。
- [ ] 写runbook：配置、双身份操作、手工授予/重选、真实单位与统计范围、metadata维护、故障区分、未支持平台、部署与安全回滚。关闭开关仍保留key purpose与资金隔离；旧二进制回滚前须撤销专用Session/key、取消所有有效xcode实例并保留审计，不能只改URL/feature flag。
- [ ] 对下面覆盖表逐条附原始证据并签验收状态。仅当全部完成且无G4等阻塞才标集成完成；typecheck/lint通过、页面能打开、mock请求成功均不等于完成。

## 3. 设计覆盖与验收追踪

| 客户端设计条款 / 场景                     | 执行任务            | 证据要求                                                 |
| ----------------------------------------- | ------------------- | -------------------------------------------------------- |
| §1本机范围/非目标/用户自配保留            | T04/T08/T10         | private remote明确拒绝、custom实际回归、无无关配置变化   |
| §3 owner/fencing/撤销/官方存储恢复        | T02/T04/T09         | A→B→A、迟到结果、worker执行阻断                          |
| §4.1–4.2登录/PKCE/恢复/单飞               | T01/T02             | 真实Native浏览器/Host登录、SID与用户、取消竞态、重启     |
| §4.3 Web handoff及展示首帧                | T07/U02/U04         | 精确短码准入、Cookie await换号、真实Native首帧与分区清理 |
| §5.1 access/anchors/ordinary行为          | T03/T08             | 三anchor同一family，无自动remap                          |
| §5.2完整能力/modelConfigs/issues/revision | T03/T04/T08         | admin编辑→Host→worker→执行，非法目录不可选               |
| §5.3协议/secret/错误/stream能力           | T04                 | 三SDK实际路径/流/tool/取消，明确错误，无fallback         |
| §5.4全部caller clean cutover              | T03–T09             | LSP调用者清单完成、旧同名模型必须重选                    |
| §6套餐/支付读写/§6.1升级UI                | T05/T07/T08/U01–U04 | RPC拒绝假订单、真实模板比较、原版结构及DOM/首帧截图      |
| §7.1–7.2数据范围/null/大数/DST            | T01/T06/T08         | 多key资金消费、超安全整数、无限/空值与UI范围标签         |
| §7.3 mode联合/mark结果/跨周期             | T06/T10             | Native无机会/动画；真实reset与在途结算后卡片             |
| §8独立官方连接/MCP/闲时/分享              | T02/T09/T10         | 真实官方账号/Plan、来源与账单、匿名分享仍可用            |
| §9 Host→本机worker/非本期remote           | T04/T10             | 实际Agent消费、provisioning无Native秘密                  |
| §10架构/上游边界/安全回滚                 | 全任务/T10          | 受控上下文、references、架构check、runbook               |
| §11全部验收 + canonical §11               | T10汇总，G1–G5      | 逐场景原始结果、源码/二进制来源、未通过项明确            |

## 4. 完成定义与交接

T01–T09 的可达客户端实现与确定性回归已经落地，T10 已执行隔离后端、三 SDK 与真实 Desktop Agent/主账号/只读页面联调。实际任务状态、源码/二进制来源、回归与审查证据见 `.superpowers/sdd/2026-10-08-aiscoo-admin-integration/progress.md` 和 [运行手册](../../aiscoo/aiscoo-admin-integration-runbook.md)。未提交、推送、发布或重启既有 3001 服务，未修改其业务数据库。

**未完成正式发布验收。** G1 全资金/跨周期/Redis/三数据库矩阵、G4 真实官方 Plan/MCP/闲时/分享、目标 OS 安全库和 G5 完整 clean release deployment 均不能以合成上游或源码检查代替。当前隔离构建 `vcs.modified=true`；实际消费证明只覆盖明确记录的受控上游。同一任务包含未满足的 live acceptance 时，不批量勾选步骤、不将其记为完整验收。

存在外部依赖时继续完成可达实现与确定性回归，但blocked任务不记完成，也不偷偷缩减三transport、官方云或保留UI的验收范围。执行方式可选同会话逐任务或subagent切片；无论方式都必须统一shared/node集成owner并遵守上述完成门槛。

## 5. 升级页评审修正：U01–U04

2026-10-10 完成设计评审，2026-10-12 已实施 U01–U03 并完成 U04 原生管理、真实 Full Desktop 续期/替换和视觉闭环；最终回归及质量门禁结果见实施账本。两项设计评审共发现3个P1、5个P2，实施复审另修正 Unicode 边界、custom 周期折扣和 expired 授予说明；完整规则见 [UI规格](../../aiscoo/specs/aiscoo-admin-upgrade-ui.md) 与 canonical §9.1。新证据不复用旧T07页面打开结论，也不放行 G1–G5。

依赖：U01→U03；U02→U03；U01/U02/U03→U04。U01服务端与U02展示传递可并行，shared/platform与Main由一个集成owner处理；U03在两个契约确定后整合，不能先写固定截图商品。上线仍受原G1–G5约束。

### U01：原生展示元数据、授予资格与只读sidecar

**Spec:** UI§2–4、canonical§9.1；不改公共 `/plans`、认证和资金域。

**Files（相对 aiscoo-admin 根）:** Modify `model/{subscription.go,main.go,xcode_authorization.go}`、`controller/subscription.go`、`dto/xcode_web.go`、`service/{xcode_reads.go,xcode_web.go}`、`web/src/features/subscriptions/{types.ts,lib/plan-form.ts,components/subscriptions-mutate-drawer.tsx}`、`web/src/features/xcode/plans-api.ts`；Create `controller/xcode_plan_display_test.go`。XCode `packages/shared/src/aiscoo-admin.ts` 不扩展Plan字段。

**Interfaces:** nullable `SubscriptionPlan.xcode_display:XCodePlanDisplay|null` 为UI§3限定五字段；`XCodeWebView.plan_presentations:XCodePlanPresentation[]` 为 exact plan_id+metadata+assignable+assignment_reason+display_issue。共用原管理员模板资格校验；若须导出 model 校验，先 LSP references并迁移所有caller，不留下重复判断。控制plans与sidecar同批读取，不增加新HTTP endpoint或逐卡查询。

- [x] RED：原生管理员create→edit→reload元数据不丢，null清除生效；明确更新映射/plan-form，已有模板缺字段兼容，损坏旧记录不使整个目录消失；web实际收到sidecar，旧控制/plans保持严格解析通过。
- [x] RED：enabled且max_purchase_per_user=1为不可授予；metadata不改变资格、price/quota或钱包；重复元数据不能改授权。采用现有隔离数据库约定，不触碰3001用户DB。
- [x] 最小实现nullable展示字段/原生迁移、CRUD验证与保存、编辑器、缓存失效、单批projection及Web schema；原生管理表单同样需中英标签和重新编辑证明。不建立商品/折扣/试用历史表。
- [x] 在 aiscoo-admin 根执行 `go test ./model ./service ./controller -run XCode -count=1`，Web执行 `bun run --cwd web typecheck`、现有相关tests和lint；XCode按§2命令跑 `aiscooAdminWire.test.ts`。实际隔离管理员保存→重开→GET web/view/control plans，观察exactID与真实字段。

### U02：Native入口、隔离UI Cookie与同步首帧

**Spec:** UI§5–6、客户端§4.3/§6.1；保留已有Host ACK、URL白名单、one-use和owner防护。

**Files（XCode）:** Modify `packages/shared/src/platform.ts`及其公开入口、`packages/desktop/src/preload/index.ts`、`packages/desktop/src/renderer/src/desktopBrowserPlatformBridge.ts`、`packages/desktop/src/main/{nativePlanWebviewManager.ts,aiscooAdminPlanWebviewPolicy.ts,desktopWindowChrome.ts,desktopCommandHandlers.ts}`、`packages/ui/src/settings/{CodingPlanUpgradeDialog.tsx,NativePlanEmbeddedWebviewDialog.tsx}`、`packages/desktop/test/aiscooAdminWebHandoffElectron.mjs`；由LSP补齐prepare request现有callers/fixture。**Files（aiscoo-admin）:** Create `web/public/xcode-plan-display.js`、`web/src/features/xcode/__tests__/display-context.test.ts`；Modify `web/index.html`、`web/rsbuild.config.ts`、`web/src/{i18n/config.ts,context/theme-provider.tsx,main.tsx}`。遵守现有上游源码版权头。

**Interfaces:** shared公开 `NativePlanDisplayContext`、`NativePlanWebviewPrepareRequest` 按UI§5完整字段，`IPlatformService.prepareNativePlanWebview(request):Promise<{partition:string}>`；Main实际写session UI Cookie `xcode_plan_display_v1`，Web head同步消费并将initialAudience供React初始化。不改OAuth/control RPC、AiscooAdminClient.createWebHandoff或服务端AuthFlow。

- [x] RED：personal/team/缺省入口、App浅/中文且系统深/英文、非法Cookie、存储禁止、字号12/14/20；实际Bootstrap首帧值正确且非viewer不改native后台设置，不能仅测传参对象。
- [x] RED：延迟 cookies.set 时A退出→B登录，旧prepare拒绝且清旧分区，不关B；重复attach、伪造generation、reload重放仍拒绝。调整既有fixture适配新必填context，非私有桥和普通guest保持原样。
- [x] 最小实现逐层 typed传递、严格Main解码、Cookie await后current entry/window/canAttach复核及失败清理；同步静态脚本在CSS/App module之前，locale映射和ThemeProvider消费不反覆盖，非法展示值不升级身份。不得unsafe-inline script/executeJavaScript/preload/通用函数桥。
- [x] Native guest在will-attach/attach与desktopCommandHandlers实际zoom写入路径同步当前父窗口factor；现有窗口初始化/重放zoom同样同步。不只监听事件、不塞zoom进Cookie。主题/locale/字号/入口变化沿现有request++铸码重建，不放URL query/hash。
- [x] aiscoo-admin 根执行 `bun run --cwd web test src/features/xcode/__tests__/display-context.test.ts`、typecheck和build，检查生成HTML静态Bootstrap顺序并实际加载/错误首帧；XCode执行 `node packages/desktop/test/runAiscooAdminElectronSmokes.mjs` 和现有服务handoff回归，观察Cookie/无secret/owner清理，而非浏览器模拟Main。

### U03：原版比较卡片、精确价格/状态和Native外壳

**依赖:** U01/U02完成；**Spec:** UI§2–6。Native手工授予不扩成支付或团队能力。

**Files（aiscoo-admin）:** Modify `web/src/features/xcode/{plans.tsx,plans-api.ts,plans-format.ts}`、`web/src/styles/index.css`、`web/src/i18n/locales/{zh.json,en.json}`；Create `web/src/features/xcode/plans-catalog.ts`、`web/src/features/xcode/__tests__/{plans-catalog.test.ts,plans.test.tsx}`。**Files（XCode）:** Modify `packages/ui/src/settings/NativePlanEmbeddedWebviewDialog.tsx`、`packages/ui/src/components/EmbeddedWebsiteHeader.tsx`、`packages/ui/src/i18n/locales/{zh-CN.ts,en-US.ts}`。Header的默认官方分支不变。

**Interfaces:** Web纯目录派生函数 `buildPlanCatalog(plans,presentations)` 输出按spec冲突回退的精确ID组/独立卡；`formatPlanPrice(plan,monthlyBaseline)` 只计算参考价/月均/可比折扣，不提供支付参数。plans.tsx消费真实sidecar和initialAudience；卡片状态只精确ID，授权摘要消费entitlements。

- [x] RED：同组月101/季102/重复月103任意输入顺序不覆盖，选季只102；month/12与year/1冲突、缺年、异币种、权益冲突、无display、day90/custom保留真实卡，不fallback月价；month10/quarter24/year96精确显示8/月、24/96总价、8折；月0/涨价/预算不等无折扣，不使用quota币种。
- [x] RED：年度授权切月/模板停用/模板后来改额度摘要仍真实；active/exhausted/expired/revoked/unassigned不同，0价非trial无“试用结束”；manual说明精确SKU/周期/续期vsreplace，无请求订单/支付/申请或成功提示；team首帧为空能力说明。
- [x] 移除重复后台头、独立主题语言控制、大授权详情与常驻壳manual长提示；建立分类→紧凑摘要→周期→卡片→页脚。按实际数据分组，不内置四商业档位，权益文本不表示官方授权。使用升级页scope的XWork tokens而非改全局aiscoo-admin外观。
- [x] Native main解除重复max-w-5xl/px-6限制；Header仅Native宽度覆写并对齐网页唯一内容边界；按848/416px实际卡片区域降4/2/1列、等高和CTA底部对齐，长文案纵滚不裁切。不改官方dialog认证或其他用量布局。
- [x] aiscoo-admin执行 `bun run --cwd web test src/features/xcode/__tests__/plans-catalog.test.ts src/features/xcode/__tests__/plans.test.tsx src/features/xcode/__tests__/plans-format.test.ts`、`bun run --cwd web typecheck`、`bun run --cwd web lint`、`bun run --cwd web build`；XCode跑 `pnpm typecheck`、`pnpm lint`、架构检查。实际网页与Native嵌入检查加载/错误/空目录/长权益，浏览器仅作前置，不替代U04。

### U04：真实Electron、原生管理闭环与新视觉验收

**依赖:** U01–U03；不宣称替代主集成T10/G1–G5。**Files:** Create `packages/desktop/test/aiscooAdminUpgradePresentationElectron.mjs`；Modify `packages/desktop/test/runAiscooAdminElectronSmokes.mjs`、两仓实际验收状态与 [运行手册](../../aiscoo/aiscoo-admin-integration-runbook.md)。新增smoke实际渲染当前Native dialog/真实compiled viewer，不用简化壳或复制页面代替。

- [x] fixture E2E先覆盖中英×浅深×personal/team，错误/加载首帧、Cookie写入中换号、旧guest关闭/Storage清空、无跨源资源/弹窗/下载/权限和无长期secret；明确fixture仅确定性UI/边界，不是账务或供应商证明。加入现有runner并按实际场景调整有限超时，不永久安装辅助依赖。
- [x] 在获准的隔离开发环境构建真实后端Web embed/Go来源；实际管理员配置trial1+三档各月/季/年共10个真实模板并保存权益，原生登录/grant→设置升级→切周期→manual说明→管理员renew/replace→回读真实状态。无体验产品则记录真实目录，不伪造试用；四档视觉fixture与部署商品事实分开。
- [x] 真实Electron记录Host/客户端/后端SHA、窗口content bounds、DPR、zoomFactor、UI字号、guest innerWidth、卡片DOMRect/脱敏截图。等比对照冻结原图，不宣称未知原DPI像素一致；基准四档首屏、top≤1px、height/CTA bottom≤2px、scrollWidth≤clientWidth+1px，页脚可下滚。
- [x] 验证zoom -3/0/5、中英、12/14/20px和长名称/权益，非基准可降列/滚动但不截断；重复打开/团队入口/刷新/关闭/A→B→A无旧分类/主题/内容残留。检查原官方升级行为未受宽度覆写或认证Cookie影响。
- [x] 按T10更新后的实际全回归命令运行，另运行两仓具体新增测试、Web build/lint/typecheck、XCode typecheck/lint/fmt/architecture。只勾具备运行证据的步骤；缺正式官方凭据/目标OS/clean deployment仍保留原blocked项，不趁UI恢复发布。

**完成定义:** U01–U04 的代码、消费者、迁移、管理员回读、实际WebView首帧/布局/状态/安全和原版对照均有独立证据。新UI范围与正式发布门禁分开；全仓 lint/fmt 的已有失败如实记录，既有 cold-session logout 尚未解释，G2 和 G1–G5 保持未验收。完整运行证据见 `.superpowers/sdd/2026-10-08-aiscoo-admin-integration/progress.md`。
