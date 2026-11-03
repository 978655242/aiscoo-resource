# Aiscoo admin request auth

托管 Provider（`account:aiscoo-*`）调用期的两条规则，经上游已有扩展点接入 Host 装配，不改上游函数逻辑。

- `validateAiscooAdminRuntimeHeadersRequest` 注册到 `createZCodeAgentService` 的 `providerRuntimeHeadersRequestValidators`。只要外层 Provider、模型选择 Provider 之一是托管 ID，或访问类型是 `new-api-account`，就要求两个 Provider 相同且带 `new-api-account` 访问凭据；否则在任何凭据 IO 前返回拒绝文案。
- `createAiscooAdminAccountRequestAuthResolver` 包装官方解析器：托管请求只在 owner、授权版本、目录成员都仍有效时释放 relay 凭据，取凭据前后各核对一次；托管 Provider 不能借官方 access 取凭据。
- 账号会话 owner 仍是 `AiscooAdminAccountService`；本模块不保存状态。未注册时 Host 行为与上游一致。
