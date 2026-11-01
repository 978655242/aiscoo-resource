# OAuth 账号准入策略端口

产品装配可通过平台上的可选 `oauthAccountPolicy` 声明哪些账号 provider 被接受。未注入时使用既有流程。策略是只读准入，不拥有账号、凭据、pending state 或 generation；这些事实仍由既有 OAuth owner 持有。

登录命令、回调、恢复与退出由产品服务包装（`aiscoo/account-login`）和 Host 账号策略拒绝，上游登录页与 `useOAuth` 不读取本策略。当前唯一的消费点是设置页导航：账号服务未配置时没有 `new-api-family` 供应商，导航需要据此隐藏不被接受的账号套餐入口。

旧本机 Web 的登录/会话/退出生命周期工厂（`OAuthLifecycleExtension`）已于兼容残留清理中移除，见 [唯一登录规格](../../../../docs/aiscoo/specs/aiscoo-only-login.md) 第 12、13 节。
