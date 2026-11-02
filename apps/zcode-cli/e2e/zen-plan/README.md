# XWork Zen Plan E2E

真实链路验收：隔离 Go New API（独立 SQLite、随机服务密钥、合成账号）+ 真实 Chrome 原生页面 + 真实 CLI 构建产物 + 真实 PTY TUI + 不计费的本机合成上游。不连接、不修改任何正式实例。

## 前置

```bash
# New API（feat/cli-zen-plan 或其合并结果）
cd <new-api> && bun run --cwd web build && go build -o /tmp/zen-e2e-backend .
# XWork CLI
pnpm --filter @zcode/cli... build
```

node-pty 的 macOS 预编译 `spawn-helper` 在 `--ignore-scripts` 安装后可能缺少执行位，harness 会报错并给出 `chmod +x` 路径。

## 运行

```bash
node apps/zcode-cli/e2e/zen-plan/run.mjs --backend /tmp/zen-e2e-backend
node apps/zcode-cli/e2e/zen-plan/run.mjs --backend /tmp/zen-e2e-backend --case=passkey-login
```

`--keep` 保留隔离目录以排查。默认结束时停止自有进程、删除隔离目录，并只删除本次设备数据根派生的钥匙串条目。

## 覆盖

| case | 证明 |
| --- | --- |
| password-login-and-secure-storage | 原生密码登录→主动授权→回环；授权页标明 aiscoo zen（CLI）；单一 xwork-cli SID；凭据文件 0600 且无明文 |
| cold-restore-prompt-and-tool-call | 新进程冷恢复；`--prompt` 经 Go relay；真实 Bash 工具结果回传模型 |
| cancel-model-request | 流式请求中 SIGINT 退出且不报成功；账号随后仍可用 |
| tui-login-model-and-logout | PTY：`/login` 首项 Zen→等待态→浏览器授权→成功提示→`/model` 选择→对话→`/logout zen` 撤销服务端 SID |
| tui-cancel-during-authorization | 等待态 Esc 返回菜单；迟到授权不激活账号、无残留 SID |
| headless-login-interrupted | 授权前 SIGINT 退出非零、无本地会话 |
| headless-login-interrupted-after-exchange | 服务端已签发 SID、客户端未提交时 SIGINT：精确撤销该 SID |
| two-factor-login | 原生 UI 启用 TOTP；授权必须经过 2FA 步骤 |
| passkey-login | 原生 UI 注册 Passkey（Chrome 虚拟认证器，localhost RP）；新浏览器以 Passkey 登录并授权 |
| browser-account-switch | 授权页“使用其他账户”后 CLI 登录为切换后的账号 |
| multi-process-and-account-switch | 同设备两进程并发不增发 SID；第二设备独立 SID 且退出互不影响；同设备换号 |
| desktop-cli-coexistence | 桌面 client（真实 zcode:// 授权页链路）与 CLI SID 并存；CLI client 不能撤销桌面 SID；桌面退出不影响 CLI |
| plan-revocation-and-restore | 撤销指定套餐后请求被拒且不泄露凭据；重新指定后恢复 |
| server-side-session-revocation | 服务端撤销 SID 后不能继续调用模型 |
| backend-outage-recovery | 后端停止时请求及时失败、不删除凭据；恢复后可用 |
| missing-origin | 缺少 `AISCOO_ADMIN_BASE_URL` 时不发起授权并给出提示 |
| logout-default-and-aliases | 无参数 `logout` 及 zen/aiscoo 别名撤销本设备精确 SID、清除本地凭据；其他会话保留；重复退出无额外撤销或凭据恢复 |

## 不覆盖

- Windows Credential Manager 与 Linux Secret Service 真机；SEA 单文件分发的原生钥匙串资源。
- 正式 New API 实例与真实计费模型。
- 真实系统级 `zcode://` 深链分发与 Electron 桌面应用本体（桌面以协议替身经真实授权页取得 code）。
- 管理后台指定套餐 UI（套餐与模型直接写入隔离库，等价于管理员授权结果）。
