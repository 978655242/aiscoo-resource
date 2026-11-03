# aiscoo-admin 授权页账户切换 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本计划建议 Native 顺序执行，原因是四项任务共享同一条浏览器会话/授权链路；完成后做一次独立评审。

**Goal:** 用户在 aiscoo-admin 授权页可明确选择保留当前账户或切换账户，重新登录后再次确认，最终只把所确认账户授权给 XWork。

**Architecture:** 复用现有浏览器 Session、AuthStore、跨标签同步、原生登录及 PKCE。授权页增加页面内交互门禁，退出只针对确认时的 SID；根路由保留合法授权返回目标。主按钮直接完成一次明确授权，不新增多账户缓存、后端端点或桌面协议。

**Tech Stack:** aiscoo-admin Web 现有 React、TypeScript、TanStack Query/Router、Zustand、Zod、i18next、Vitest/Testing Library；真实浏览器和既有 Electron/CDP；Go Session/AuthFlow 保持现行契约。

**Spec:** [已确认页面规格](../../aiscoo/specs/aiscoo-admin-authorization-account-switch.md)；[aiscoo-admin canonical spec](../../../../aiscoo-admin/docs/specs/xcode-integration.md) §4.2/§6.2。

## Global Constraints

- 状态：2026-10-18 S01–S03/独立评审及S04隔离验收已有分项证据；另获授权后真实3001部署和生产授权专项全部执行/清理完成，独立最终复核通过，状态 **PASS WITH DISCLOSED CONCERNS**。真实OS/原Host Me B、全进程退出冷恢复、专用设备撤销/浏览器分离、两账号原生password step-up/self-delete及精确handler恢复均有证据；首次过期/429/驱动历史和独立缺陷保留。未提交/推送，不声称全质量绿。
- 展示名为 XWork；内部 `xcode-desktop`、`provider=new-api`、`zcode://oauth/callback`、state 和 PKCE 不变。
- 采用当前浏览器单会话切换；提前说明其他已打开的 aiscoo-admin 后台页面会受到影响；不建立独立授权会话或多账户中心。
- 保持 10 分钟请求期限、60 秒 code 及精确 callback 校验；换号不续期。
- 登录本身不是授权；重新登录后必须主动确认；一次性 complete 不因错误、focus/online 或重复点击自动重试。
- 退出失败不能清理当前身份；迟到退出或授权响应不能清理新身份或打开旧 deep link；A→B→A 不复活旧动作。
- 不增加依赖；复用两仓库各自的主题/语言/组件规则，不把客户端的 `text-ui-*` 强加到 aiscoo-admin。
- 不改变数据库、用户权限、套餐、模型、额度或支付，不为登录验收调用模型。
- 桌面启动必须显式携带 `AISCOO_ADMIN_BASE_URL`。已有业务连接使用 `http://127.0.0.1:3001`；隔离验收使用明确配置且与隔离服务完全一致的 loopback origin，禁止裸启动。
- 当前 XCode 分支 `feature/private-server-technical-design`、aiscoo-admin 分支 `feat/xcode-integration`；执行前重新确认工作区，保留用户改动。客户端 PR 目标 `XCode-main`，禁止在镜像 `main` 提交产品改动。
- 对上游认证文件保持最小改动；固定 SID 边界使用一行中文原因注释，例如 `// XCODE: 换号只退出已确认的 SID，不能追随刷新后的账户。`；保留既有版权头。
- 未获另行授权，不提交/推送、不退出用户真实管理员账号、不改业务数据库、不重启/替换 3001 容器。实现与生产部署是两个门禁。

## Review Focus

1. 浏览器 cookie 已是 B、页面仍是 A：409 后不得刷新再退出 B；S01 的真实 logout 入口回归及 S04 双标签验收覆盖。
2. 退出清理 QueryClient 时当前授权查询被移除：安全 flow 返回目标仍应保留；S02 的完整路由回归覆盖。
3. 根路由先收到其他标签 signed_out：不能丢失授权返回地址或影响普通后台导航；S03 路由场景及 S04 真双标签覆盖。
4. 换号期间请求到期、换 flow 或 A→B→A：旧请求、旧错误和旧成功不能复活；S02 的时序回归覆盖。
5. 一次性授权提交中切账号、重复点击或返回不安全 deep link：不能二次签发或把错误身份交给桌面；S03 行为回归及 S04 真实 Host 覆盖。

## 文件与事实地图

以下 `aiscoo-admin/...` 路径相对 `/Users/timo/ai`；命令工作目录明确标注。XCode 文档仍在本仓库，不能误把产品修改写进 XCode 的镜像文件。

| 文件                                                                                    | 本次职责                                                                |
| --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `aiscoo-admin/docs/specs/xcode-integration.md`                                          | 在 §4.2 增补已确认 UI 会话切换规则，不修改 wire/时限/身份来源           |
| `aiscoo-admin/web/src/features/auth/api.ts`、`api.test.ts`                              | 原 logout 入口增加固定期望 SID 的安全调用方式；保留普通调用者行为       |
| `aiscoo-admin/web/src/features/xcode/authorize.tsx`、`__tests__/authorization.test.tsx` | 页面重排、换号确认、互斥动作/归属、取消终态、一次明确授权及路由行为回归 |
| `aiscoo-admin/web/src/routes/__root.tsx`                                                | 跨标签 signed_out 的授权页返回目标；其他路由行为不变                    |
| `aiscoo-admin/web/src/i18n/locales/{en,zh,zh-TW,fr,ja,ru,vi}.json`                      | 本页新文案、XWork 展示名与换号影响；仅清理本页淘汰且没有消费者的旧 key  |
| `XCode/docs/aiscoo/specs/aiscoo-admin-authorization-account-switch.md`                  | 本增量 UI/状态规格、A01–A12 验收依据及后续真实证据                      |
| `XCode/docs/aiscoo/aiscoo-admin-integration-runbook.md`                                 | 功能完成后记录入口、浏览器换号影响、实际验证与部署限制                  |

已核对：`logout()` 的当前消费者为 `components/sign-out-dialog.tsx`、`features/auth/hooks/use-oauth-login.ts`，并由 `features/auth/index.ts` 导出。2026-10-17 LSP references 确认这些引用；S01 执行时再次查询。它们不改成固定 SID 模式，保留原生普通退出和 OAuth 登录语义。

`clearAuthenticatedClientState(queryClient)` 会先清全部 query 再清身份/广播；根路由也在 SID 改变时清 query。根路由 `authenticated` 事件目前 reload 同一 URL，`signed_out` 事件目前跳 `/sign-in` 丢失返回目标。不能只在授权组件中做假路由测试而忽略真实根路由。

---

## S01：限定换号退出目标，不误退后来登录的账户

**Files:** 修改 `aiscoo-admin/web/src/features/auth/api.ts:94-141`、`api.test.ts:116-181`、`aiscoo-admin/docs/specs/xcode-integration.md:108-118`。

**Interfaces:**

- 保留 `executeLogout(runtime: LogoutRuntime, allowMismatchRecovery = true): Promise<ApiResponse>`。
- 将现有入口扩展为 `logout(expectedSID?: string): Promise<ApiResponse>`。不传参数的既有消费者保持原行为；传入非空 SID 时固定该 SID，并通过现成的 `allowMismatchRecovery=false` 禁止追随刷新后的账户重试。明确拒绝显式空 SID，不能退化为无目标退出。
- 继续使用唯一 `POST /api/user/auth/logout` 路径及 `X-Auth-Session`；不创建第二个 logout helper/端点，不在调用方复制 HTTP。

- [x] 更新 canonical §4.2：明确当前浏览器会话切换、影响提示、重新登录不自动授权、请求不续期和独立设备会话边界；链接本 UI 规格，避免维护第二套 HTTP 定义。
- [ ] 用 LSP 查询 logout 引用后，在现有 `api.test.ts` 增加真实 `logout(expectedSID)` 入口场景：捕获 SID A 后浏览器状态改为 B；409 必须返回失败、没有第二次登出，B 保留。覆盖显式空 SID 拒绝及 `success:false` 不冒充成功。测试观察目标账户未被撤销/清理，不只比对某个 header。
- [ ] 在 `aiscoo-admin/web` 运行 `bun run test src/features/auth/api.test.ts`，确认新增安全场景在旧实现下失败；旧普通 mismatch recovery 场景应保留。
- [x] 按上述签名最小修改入口，复用现有 executeLogout，不改普通调用者。409 可以交给页面重新核对身份，但禁止在同一动作中继续退出新 SID。
- [x] 再运行同一测试文件，新增与原普通退出/OAuth 场景全部通过后进入 S02。

## S02：实现可换号的授权页面与明确的终态

**Files:** 修改 `aiscoo-admin/web/src/features/xcode/authorize.tsx`、`__tests__/authorization.test.tsx`、七个现有 locale JSON。保留共享 `auth-layout.tsx`、登录表单及 AuthStore 数据结构。

**Interfaces:**

- 保留 `XCodeAuthorize(props: { flowToken: string })`。
- 消费 S01 的 `logout(owner.sid)`、既有 `clearAuthenticatedClientState(queryClient)`、`sanitizeAuthRedirect(value, origin)` 与 Router 导航。
- 换号确认目标为当前显示的 `flowToken/user.id/session.sid`；页面内交互序号只用于失效旧动作，不保存第二份业务身份。异步完成还需核对未卸载与同一操作归属，不能只依赖 effect cleanup 或 SID 最终相等。
- 页面动作互斥：确认换号、执行退出、授权提交、取消终态不能并行。返回目标在统一清理前捕获，清理成功后立即导航；自动未登录导航不能抢先丢失目标。

- [x] 扩展现有路由级测试，使用真实登录组件/Router/AuthStore：A→打开并取消换号、A→成功退出→登录 B→返回同一 flow，断言完整安全 redirect 保留、显示 B 且尚无 complete；覆盖七类失败/时序：`success:false`、网络、5xx、409、新 flow、A→B→A、卸载后迟到结果。409 重新读取身份可使用既有身份刷新机制，但不得继续同一次退出；刷新失败应提示不可用，不声称 B 已退出或 A 仍已确认。
- [x] 增加确定性期限与清理场景：真实 QueryClient 清理后仍携原 flow 进入登录；登录期间期限耗尽不能授权；退出后中断登录不恢复 A；取消授权不发送 complete/logout/deep link 且本页不再可提交。
- [ ] 在 `aiscoo-admin/web` 运行 `bun run test src/features/xcode/__tests__/authorization.test.tsx`，先看到新增行为失败。
- [x] 按规格 §2 实现账户块、始终可见的换号入口、影响确认、前置权限、有效期、取消和单次授权按钮。保留设备会话期限及撤销说明；使用现有 UI 组件，布局仅限本页内容容器。
- [x] 实现固定 SID 换号及归属门禁。成功才统一清理/广播并携同源返回目标导航；失败不清理、不导航，旧动作不覆盖新 owner。取消显示终态说明，不调用服务端完成或伪造取消回调。
- [x] 七语言补齐对应文案；展示名 XWork，协议标识不变。移除重复授权弹框及仅服务旧弹框的死状态/无消费者翻译，不移除换号影响确认。不批量格式化语言文件或顺手改其他页面品牌。
- [x] 将旧测试中依赖“先开授权弹框再确认”的操作改为一次明确点击；删除只锁定旧文案/弹框结构的断言，保留其证明的一次性、身份隔离和安全 callback 场景。运行同一文件并确认 S01 测试仍通过。

## S03：覆盖真实根路由与一次性授权边界

**Files:** 修改 `aiscoo-admin/web/src/routes/__root.tsx:73-104`、`features/xcode/authorize.tsx:114-174`、`features/xcode/__tests__/authorization.test.tsx`。阅读但不无故修改 `lib/auth-session-sync.ts`、`lib/auth-session.ts`、`features/auth/hooks/use-auth-redirect.ts`。

**Interfaces:**

- 继续消费既有 `subscribeAuthSessionEvents`，不增加广播通道或在事件里加入 token/flow。
- 匹配当前 SID 的 signed_out 事件：只有当前路由是合法 `/xcode/authorize` 时，将当前同源授权目标经 `sanitizeAuthRedirect` 放进 `/sign-in?redirect=...`。其他路由仍按现有方式退出。authenticated 事件继续重载当前 URL，不添加循环重试。
- 主授权按钮在点击时绑定显示 owner、即时 store 和当前交互，继续使用 `singleUseAuthorization: true`、`retry:false` 与现有 `validatedCallback`。不确定结果不重放。

- [x] 在现有授权集成测试中覆盖请求发出前/发出后账户改变：旧动作不能 POST 或不能打开迟到 callback；覆盖同 owner 双击和 focus/online 不重试、全部现有非法 callback 表、登录/注册返回目标及 framed 页面拒绝。断言动作及身份结果，不锁定实现结构。
- [x] 将根路由 signed_out 的行为验收明确交给 S04 的生产页面双标签 E2E：合法授权页保留 redirect，普通后台路由无授权 redirect，外部地址被拒绝。现有 authorization 单测夹具的 root 是测试自建路由，不能把它当成生产根路由证据，不复制生产代码造假测试。
- [ ] 运行 `bun run test src/features/xcode/__tests__/authorization.test.tsx src/features/auth/api.test.ts src/lib/auth-session.test.ts src/features/auth/lib/auth-redirect.test.ts`，对新增门禁场景确认先失败。
- [x] 最小调整根路由的授权返回目标及授权页提交门禁；保留现有账户刷新/广播、防 iframe、精确回调及请求错误处理，不增安全绕过或通用认证框架。
- [x] 再运行上述聚焦集合并全部通过，记录 A01–A10 与 Review Focus 的对应场景。源码/确定性回归完成后进入 S04；生产根路由和真实 Host 的最终验收仍由 S04 阻断交付。

## S04：真实浏览器、桌面交付与发布准备

**Files:** 更新客户端本 UI 规格的验证记录和 `docs/aiscoo/aiscoo-admin-integration-runbook.md`；不新增测试框架、不修改业务部署配置。

**Interfaces:** 消费 S01–S03 的实际页面/服务；证据区分真实浏览器 UI、真实 Session/PKCE/Host、模拟网络故障及尚未授权的部署。浏览器自动化复用现成工具或 XCode Desktop 已安装的 `playwright-core`，不为几行验收增加依赖。

- [x] 在 `aiscoo-admin/web` 构建 `bun run build:check`。aiscoo-admin 页面嵌在 Go 二进制中，Web 构建成功不代表运行中的 3001 已更新。
- [x] 使用独立临时 SQLite、独立日志及会话密钥启动隔离 aiscoo-admin：显式设置 `SQLITE_PATH`，不继承业务 SQL/Redis 连接；`XCODE_INTEGRATION_ENABLED=true`，`XCODE_PUBLIC_ORIGIN` 与实际空闲 loopback 端口完全一致。通过现有注册/设置流程准备两个合成测试账户 A/B，秘密仅保存在限权临时目录或内存。不得往真实业务库造账户/套餐。
- [x] 运行真实授权页 E2E，按规格 A01–A11 逐项记录：A→取消换号、A→B、退出失败、未登录/中断、过期、重复确认、取消授权、非法回调及真双标签事件。真实网络故障/409 用浏览器请求拦截控制时序，清楚标注故障注入，不把合成账户冒充用户业务数据。
- [x] 真双标签覆盖生产根路由：标签一停留授权页，标签二退出/登录 B；标签一的原 flow 返回目标不丢、新身份不被迟到退出清理，无循环 reload，普通后台页退出行为不变。保留能证明顺序的脱敏记录，不能只对临时假 root route 测试。
- [x] 视觉/无障碍验收：中文和英文、浅深色、桌面、360/393px、200%缩放、长用户名、键盘 Tab/Enter/Escape 与弹窗焦点恢复。记录实际 viewport/缩放，保存主页面、换号框、B 确认页、失败/过期态截图；按钮可滚动到达不冒充首屏完全可见。
- [x] 用独立桌面 userData/sessionData/业务根及系统原 HOME 验收 A12。桌面必须显式携带隔离后端 `AISCOO_ADMIN_BASE_URL`，Main/Host/Worker 同版；真实浏览器登录 B 并完成原 PKCE/deep link，观察 Host 主身份/真实 Me 为 B。不要注入假的安全库 key，缺真实 OS keystore 时如实阻塞 A12，不声称已通过。全过程不调用模型，不配置套餐以伪造成功。
- [ ] 在 `aiscoo-admin/web` 一次性运行 `bun run test`、`bun run typecheck`、`bun run lint`、`bun run copyright:check`、`bun run format:check`。最后一条是现有受保护版权头检查器：会临时格式化整包再恢复快照，只能在没有并发编辑时执行；不支持按文件参数。报告全包现有失败，禁止运行全库 format 修复来顺手改动无关文件。
- [x] 在 `XCode` 根运行 `pnpm typecheck`、`pnpm lint`；若执行阶段修改客户端代码，按仓库规则先做架构检查/目标模块上下文，并最终执行 `pnpm architecture:check --changed`。当前计划不要求改客户端实现，不因缺少一次 UI 行为而直接改 Host/RPC。
- [x] 完成一次独立代码/安全评审，修复本范围问题。移除临时浏览器拦截、进程和合成数据，保留脱敏证据；更新 canonical、UI 规格和 runbook 的实际实现/验证状态。没有执行的项目明确写未执行。
- [x] 仅提交发布准备结论：源码可验收不等于用户 3001 已更新。若用户另行授权部署，再按既有 runbook 备份一致数据库/现有二进制/私有容器配置，重建 Go embed，保留密钥及挂载后切换；在真实 origin 验证新静态资源、换号及账号恢复。不修改真实套餐/额度，不把前端重启当后端部署。

## 执行与回滚门禁

- **源码完成：** S01–S03 的行为回归及 S04 真实浏览器/Host 门槛完成，A01–A12 均有证据；环境受限项不得写成通过。
- **提交/推送：** 仅用户明确要求时进行，两仓库按任务路径分别暂存，不提交临时证据中的秘密，不自动创建/推送产品主干提交。
- **业务部署：** 独立授权后才执行；缺少部署授权时交付源码及验收结果，并明确旧 3001 尚无该 UI。不要求为本页面重做资金/供应商全矩阵，也不把登录验收当成这些门槛通过。
- **回滚：** 本方案无 schema/资金变更。若授权部署后的 UI 不合格，恢复经备份的前端/Go embed 产物与原配置；已发生的浏览器退出/设备授权是真实会话操作，不能靠文件回滚伪称恢复旧登录。保留审计；不恢复过期凭据或自动给桌面重新登录。

## 计划自检与当前证据

规格 §1–§2 对应 S02；§3–§4 的固定 SID/失败语义对应 S01/S02；跨标签和单次授权对应 S03；A01–A12、移动端/语言/主题、真实 Host 及部署隔离对应 S04。上述五项 Review Focus 均有明确测试归属。

2026-10-18 实际执行记录见 [S04 报告](../../../.superpowers/sdd/2026-10-17-aiscoo-admin-authorization-account-switch/task-4-report.md) 和 [执行账本](../../../.superpowers/sdd/2026-10-17-aiscoo-admin-authorization-account-switch/progress.md)。S01–S03 源码与确定性回归已落地，聚焦 88/88、全 Web 2348/2348；S04 的生产根路由真双标签、受控失败/时钟、真实 OS keystore / Host Me B 和视觉证据分开记录。所有旧的“本轮只编写计划”状态由本段实际记录替代，不覆盖原验收要求。

### 执行偏差、失败与保留门槛

- 上面 S01 引用调查项因要求 LSP 而保持未勾选：LSP 不可用；控制器明确允许精确 grep + 直接调用者/导出读取替代，相关入口测试已完成并通过，未声称运行了 LSP。
- S01/S02/S03 三条要求先看到旧实现失败的 RED 项保持未勾选。更高优先级工具规则禁止实现中途检查，所有运行由控制器在实现结束后统一执行；没有 TDD RED 证据，也不能从后验通过反推 RED。
- S04 全包检查项保持未勾选为“执行但非全绿”：控制器全 Web 测试 180 文件 / 2348 测试通过，aiscoo-admin typecheck 通过；首次全包 lint 为 233 诊断 / 120 文件，其中任务新增诊断已定点修复，最终任务五文件 lint 通过，余下基线未重跑计数。copyright 23 个范围外文件失败；protected-format 首次四文件失败，任务两文件修复后通过目标格式检查，未改另两个范围外文件。XCode typecheck 通过，lint 0 错误 / 71 警告。没有把范围检查通过写成全包全绿。
- A12 勾选仅表示**隔离原始 PKCE / 真实 Main handler / Host Me B / 真实 OS keystore**验收：浏览器打开和 callback 目标进程投递用定向测试运输，未验证 OS 全局 scheme 注册/投递；Worker 同源新构建但未运行，合成 B 无套餐/模型，不为登录验收造权益。2FA / Passkey 未在合成账号配置。
- 首次桌面尝试的硬编码系统 HOME 启动 settings 使真实工作区进入预热名单，发现后停止；第二次复用已有 `--open-workspace=<私有目录>` 显式隔离，未修改生产实现。具体路径归属和剩余风险必须保留，不能以第二次成功抹去首次暴露。
- S04 隔离阶段未获业务部署、提交或推送授权，当时均未执行。随后另获明确生产专项授权，当前部署与人工门槛由下节记录覆盖；用户已有5174 watcher / Desktop和真实账号仍不属于退出/停止操作范围。
- S04 fix round1 两项 Important 证据问题已闭合：过渡态换号框截图由真实动画完成/opacity1的中英稳态截图替代；200%稳定viewport确认的实际masthead/title重叠，经原实现者仅在授权wrapper增加`sm:pt-16`、重新Web/Go embed后通过。原生CSS640×409的header底64/title顶96不相交，1280×900和393×852亦无裁切/重叠，滚动按钮可见；最终截图不使用full-page拼接。失败→修复→运行GREEN、同一私有DB/密钥保留与第二次完整清理见S04报告§10，不把本次运行RED倒填为初始TDD单测RED。
- 最终 Cookie 修正记录：最终评审指出原 A05 body-only 迟到响应不保留真实 Set-Cookie，不能证明 B 浏览器持久身份安全。已先更新 canonical§4.2/UI规格，再执行旧实现单测 RED（5失败）与真实完整 headers 竞争 RED（B Cookie 消失/refresh401）；仅固定 SID 入口使用已安装 Axios fetch credentials omit，成功须匹配既有 revoked_sid，不变普通 logout/OAuth、Go或协议。GREEN 为聚焦79、全Web180文件/2355测试、类型/构建、五文件lint、三文件protected正文格式；重新Web/Go embed后，真实A已撤销、B迟到响应后Cookie不变且冷刷新200，匿名success真实清Cookie被忽略并失败关闭，普通logout仍清Cookie。详细证据、运行限制与清理见 [final-fix-report.md](../../../.superpowers/sdd/2026-10-17-aiscoo-admin-authorization-account-switch/final-fix-report.md)；不改写初始未执行RED历史，不复验或扩大A12/OS/模型门槛。最终定向复审已通过，P1 已关闭，无新增阻断；未提交、推送或部署3001。

## 2026-10-18 生产专项最终执行记录

用户明确另行授权一致备份/发布3001、两名专用合成非管理员原生注册与最终self-delete、独立真实Desktop/OS keystore、临时精确OS handler接管与恢复。已部署binary SHA-256 `da5ad356af59bb4fdab01421049ca90401df91ca6334d4d67cfc329bea1725e8`，实际HTML的新JS/CSS及容器内SHA已回读，不再沿用旧“未部署3001”状态。保持原容器/配置/密钥/挂载，不写SQL、不覆盖活动库、保留生产备份及审计。

实际A权限/取消换号、A→原生B/原flow/无自动complete、生产根路由真双标签和取消终态完成。首次人工超60秒的 `XCODE_AUTH_CODE_INVALID` 历史保留；最终稳定Chrome由用户连续亲点网页授权/原生打开，真实全局OS→原Main精确callback（1485ms）、原Host真实Me为B，fresh complete仅1次。Main/Host全退出0后同数据/真实keystore新Main冷恢复Me B；原publicHost.logout后专用xcode SID生产revoked，浏览器B冷refresh200，旧完成页无重登录；再全退出cold restart的Host身份/provider均null，截图pending-new-auth UI不称idle登录页。生产429按实际Retry-After自然等待后，B复用Cookie、A原生登录，均通过account.delete/password原生UI step-up/self-delete，旧protected401、全部专用session revoked、原生audit保留。最终只读一致事务确认原行/身份/会话安全/配置不变，另列并发usage/access及非本专项新增session/audit。自有进程/私有密码keys/bundle/profile已全清理，exact原OS handler finally恢复并在删除私有app后新查询相等，仅unregister私有app；原5174/9229 PIDs保持，生产备份/审计/部署保留。独立最终复核通过，状态 **PASS WITH DISCLOSED CONCERNS**，无阻断性 Important 缺口。

当前事实、实际命令来源、独立bundle/路径、正常生产限制、原有会话只读对照和脱敏证据见 [production-validation-report.md](../../../.superpowers/sdd/2026-10-17-aiscoo-admin-authorization-account-switch/production-validation-report.md)，独立最终复核见同目录 `production-final-review.md`。不把隔离故障注入冒充生产、不改生产rate limits、不补造套餐/模型调用，不重跑既有2355测试或扩大质量结论；控制器已审阅并关闭本专项，未作提交、推送或全质量/模型/资金批准。
