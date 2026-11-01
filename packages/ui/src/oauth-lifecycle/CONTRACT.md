# OAuth 账号准入策略端口

产品装配可通过平台上的可选 `oauthAccountPolicy` 限制登录入口的 provider。未注入时使用既有流程。策略是只读准入，不拥有账号、凭据、pending state 或 generation；这些事实仍由既有 OAuth owner 持有。

旧本机 Web 的登录/会话/退出生命周期工厂（`OAuthLifecycleExtension`）已于兼容残留清理中移除，见 [唯一登录规格](../../../../docs/aiscoo/specs/aiscoo-only-login.md) 第 12 节。
