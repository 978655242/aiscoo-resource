# Todo159：连接测试输出预算统一调整（512 → 1,024 Token）

状态：**已实施（2026-10-19）**。2026-09-17 用户确认目标值 512 时仅记录 Todo 未实施；实施前新增证据表明 512 仍低于 aiscoo-admin 原生 Claude 渠道下限，目标值修订为 1,024 后完成实施。本文件名保留 512 历史锚点，当前裁决以本文为准。

## 问题与实际证据

### 2026-09-17（原调查，512 的来源）

MacBook Air 的 ZCode 3.12.2 在设置页测试 OpenCode Go（Responses）的 `gpt-5.6-luna` 时失败。两次请求均返回 HTTP 400；请求包含 `reasoning.effort: "none"` 和 `max_output_tokens: 1`。

- 使用 Air 原有 Key、地址、Prompt 和请求参数复现，服务端原始错误为：`[integer_below_min_value] Invalid 'max_output_tokens': integer below minimum value. Expected a value >= 16, but got 1 instead.`
- 对照请求仅将 `max_output_tokens` 改为 `16`，返回 HTTP 200。原始失败记录位于 Air 的 `~/.zcode/cli/log/zcode-2026-09-17.jsonl` 与 `~/.zcode/cli/rollout/model-io-sess_8c93aadb-89ce-4f3e-bee9-8aaa0de12488.jsonl`。文档不保存 Key。

### 2026-10-19（512 被取代的证据）

用户在 XWork 设置的套餐模型列表点击连通测试，aiscoo-admin 原生 Claude 模型（`claude-opus-5.5`、`claude-sonnet-5.5`）一致报错：

```text
连接失败： Model 'claude-opus-5.5', field 'max_tokens':
Requested 1; use a value in [1024, 128000]. Token counts are never clamped.
```

- Core 探针固定 `max_tokens=1` 被上游 400 拒绝；该渠道下限 1024 同时高于 Todo144 的 1 与 Todo159 原定的 512，故统一目标值修订为 1,024。
- 已知各协议下限：aiscoo-admin 原生 Claude 1024、OpenCode/Luna Responses 16、Chat Completions 1。1,024 满足全部已知约束。

## 已确认目标与边界

1. Core `testModelConnectivity()` 的独立输出预算统一为 `min(1024, optionSpecs.maxOutputTokens.max)`，适用于所有 Provider 的连接测试，不增加渠道特判，不按失败动态提高预算。
2. 仍取模型公开有序推理档位首项；system `You are ZCode connectivity probe.`、user `hi` 的文本、角色及顺序保持原契约，不混入历史或工具。
3. 保留正式流与错误处理：正常 finish（含 length）即成功，允许无正文；error、缺少 finish、超时、鉴权及参数拒绝仍失败。沿用既有空响应重试，重试预算同为钳制后的值。
4. 仅改变连接测试预算。普通会话与 Git、标题等辅助生成预算、模型输出能力上限、用户保存的配置和选择均不变；不新增配置、协议、持久化或迁移。
5. 预算策略仍由 Core 连接测试入口唯一持有，桌面、远端 Worker 和手机 shared-host 复用既有链路，保留 workspaceIdentity、owner 与 continuous/replayable 边界。

本项取代 [Todo144](todo-144-connectivity-one-token-budget.md) 的“连接测试固定 1 Token”裁决；其余契约和历史验证记录保留。1,024 不代表已验证所有上游兼容性，未知渠道仍按正式错误边界报告。

## 实施记录（2026-10-19）

- [Settings 连接测试规格](../design/registry/settings.md)与 [steps 索引](steps.md) 已改为 1,024 + 模型上限钳制；[桌面连接测试用例说明](../../../testing/desktop-local-model-provider-p0-e2e-cases.md)已加修订注记。
- [Core 测试](../../../../apps/zcode-cli/packages/core/tests/workspace-generate-text-streaming.test.ts)先改断言证明旧实现（1）不满足，再修改生产常量为 1,024；钳制用例固定模型上限 512 时绑定 512。最低推理档位、固定 Prompt、无正文 stop/length 成功、流异常／缺少 finish 失败、Git 辅助预算 5,000 断言保留。
- [Adapter wire 测试](../../../../apps/zcode-cli/packages/adapters/tests/connectivity-probe-wire.test.ts)序列化断言改为 1,024（Anthropic `max_tokens`、Chat `max_completion_tokens`、Responses `max_output_tokens`）。
- 桌面 pending E2E（`provider-connectivity-prompt.test.ts`、`provider-reasoning-fallback.test.ts`）wire 预算断言同步改为 1,024；保持 pending，未代替人工审阅。
- 真实 aiscoo-admin 渠道在 App 内点击“测试”的最终验收待用户复核；未消耗用户额度做直接 API 对照。
