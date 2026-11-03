# cli-zen-account

独立 CLI Zen 账号的唯一 owner。bootstrap 通过 adapters 端口执行外部操作，不依赖桌面 Services 实现。

- owner = origin/userId/SID/generation，异步返回必须同时满足当前代次和存储 revision。
- 登录总期限 10 分钟；取消先失效代次，已兑换而未接受的 SID 精确补偿撤销。
- 系统库 unavailable 在授权之前失败；503 不删除凭据，明确会话撤销立即使 owner 不可执行。
- 刷新使用跨进程租约、后继重读与 CAS；换号与退出不能被旧刷新覆盖。
- onDidChange 只通知读投影，不传密钥。AccountProviderService 独占模型授权投影刷新。
- 独立 CLI 在装配点将 Built-in 源设为严格校验的 `AISCOO_ADMIN_BASE_URL`；原下载器、Release 解析、缓存、revision 与刷新策略不变。缺配置或非法地址不得回退官方服务，不改变其他上游 endpoint。
- `/models` 仅决定授权成员、transport、名称、图标和禁用原因；旧 `model_config` 被丢弃。账号快照的 `modelPresentation` 只含展示字段；能力统一由 Built-in 与 Personal exact/manual rules 合成。
- 请求凭据 IO 前后检查当前 owner、授权 revision、账号权益及真实目录成员；纯能力或展示更新不能撤销已冻结 turn。换号、撤权或目录移除立即不可执行，个人偏好不能新增授权成员。
