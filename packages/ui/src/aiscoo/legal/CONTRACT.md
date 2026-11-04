# aiscoo-legal-ui

桌面通用设置底部与登录按钮下的只读法律信息入口。链接的唯一 owner 是已配置 aiscoo-admin adapter 的公开 metadata，正文由其后端 `/user-agreement`、`/privacy-policy` 维护；法定运营主体由 `@zcode/shared/aiscoo-brand` 配置提供。

`AiscooLegalLinks` 接受已有 `useOAuth` 的 providers 投影，校验启用的 aiscoo-admin provider、完整同源公开路径、HTTP loopback / HTTPS origin，以及没有 query、fragment 或凭据。缺失或不合法时不渲染，无官方地址 fallback。`AiscooLegalSettings` 以 `useOptionalBaseWorkspaceServices` 读取本窗口 Host，在局部 ServiceProvider 中复用 `useOAuth`；远程 workspace context 不得覆盖该来源。登录面板通过可选插槽传已有 providers，不重复读取或维护身份状态；桌面装配，普通 Web 与远控不启用。

共享 `SettingsGroupCard` / `SettingsRow` / `Button` 提供布局和操作；`usePlatform().openExternal` 是唯一副作用。中文和英文标签来自现有字典，法定中文公司名在两种语言均原样展示；不提供勾选、自动接受、启动弹窗、正文副本或凭据交接。不修改 OAuth、PKCE、会话与账务行为。

```mermaid
flowchart LR
  Host["AiscooAdminProviderAdapter：已验证 origin"] --> Public["IOAuthService.getProviders：可选 legalLinks"]
  Public --> Hook["useOAuth：现有展示投影"]
  Hook --> Entry["法律信息：只读校验及布局"]
  Entry -->|用户点击| Platform["IPlatformService.openExternal"]
  Platform --> Page["aiscoo-admin 公开法律页"]
```
