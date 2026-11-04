# aiscoo-admin + XCode 一键启动 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 双击 `~/Desktop/启动 XCode.command`，补启动现有数据库及原生 aiscoo-admin，启动或激活本仓库 XWork 桌面，保留原用户和数据。

**Architecture:** Python 标准库薄入口负责互斥、固定部署身份和启动预检；原生 API 复用既有 `com.new-api.local-backend`，桌面复用现有 Node/pnpm 开发链路并按需由 launchd 驻留。数据库仍使用精确的现有 `new-api-local-postgres` 容器，不创建数据库或重新启用旧 API 容器。

**Tech Stack:** macOS、Python 3 标准库、launchd、Docker Desktop（仅承载既有数据库依赖）、已安装 Node 24.18.0 / pnpm 10.33.2、现有 Electron 开发入口。

**Spec:** 本文件 §1，来自本会话批准的双入口方案及用户追加选择“复用当前原生服务”。Ailoop 见[对应计划](../../../../lago-lianlian/docs/superpowers/plans/2026-10-18-ailoop-one-click-start.md)。

**Status:** 已实施并完成真实启动、用户/模型目录恢复、只读套餐页、窗口关闭重开、重复点击和跨组共存验收。原始 Docker API 设计已被用户明确选择的原生部署替代；不保留旧 API 启动兼容分支。

## Global Constraints

- 仅管理既有原生 API 作业、本仓库桌面及准确数据库容器；不创建、拉取、重建镜像，不使用默认 Compose，不创建新卷。
- 原生 binary、私密 `.env` 和 plist 以 SHA-256 固定；配置变化时正常启动器拒绝，不自动升级、重新基线化或改写密钥。
- `AISCOO_ADMIN_BASE_URL=http://127.0.0.1:3001` 显式固定；失败不回退官方身份或钱包。
- 原生 API 的数据库为 PostgreSQL `127.0.0.1:15433/new_api`；这是另一任务完成的现有迁移，不是本轮导入或迁移的数据。
- 保留系统 HOME、OS 钥匙串、原业务根和用户状态；不复制活动 SQLite，不改业务账号、套餐、额度或限流配置。
- 桌面新作业 `RunAtLoad=false`、`KeepAlive=false`；原生 API 既有自启/自动重启策略保持，不冒称由本轮新增。
- 退出桌面不停止 API 或数据库；不全局 pkill，不提交/合并/推送。

## Review Focus

1. 错误仓库/origin/原生作业监听者必须拒绝，不按 HTTP 200 认领。
2. 并发点击、已有构建及孤立 Vite 不得重复执行会删除 out 的 pre-dev。
3. 原生 binary、配置、plist 和数据库卷/端口变化必须在开发启动前拒绝。
4. Finder/Terminal 缺少交互 PATH 时仍使用正确 Node/pnpm；构建进程失败不能空等600秒。
5. 关闭终端不停止应用，关窗口可重新显示，Cmd+Q 不停止 API，不遗留另一套 watcher。

---

## 1. 当前已批准部署与接口

- 桌面入口：`~/Desktop/启动 XCode.command`，链接到 `scripts/xcode/启动 XCode.command`。
- 原生 API：`~/Library/Application Support/new-api-local/new-api`，私密配置为同目录 `.env`，由既有 `com.new-api.local-backend` 监督。API 原生部署、PostgreSQL 迁移均为其他任务的变更；用户确认本启动器复用它们。
- 数据库：现有 `new-api-local-postgres`，仅 `127.0.0.1:15433`；固定内容绑定 image、挂载集合、端口、Cmd、entrypoint、网络及权限，不自动创建替代库。
- 旧 `new-api` 容器保留为停止备份，restart policy 已设为 `no`，避免 Docker 启动数据库时自动带起旧 API；没有删除容器或旧数据。
- 桌面：真实 `XWork Dev.app`，不是 Apple Xcode。main/Host/Agent、Vite 和原用户目录沿用既有标准开发链路。
- 标准命令：Node24 运行 `scripts/mise-run.mjs pnpm dev:desktop:prod`，由已有 `withPinnedNodePath` 固定全部 Node 子进程。mise 未安装，不为薄入口安装它；仓库检查要求 Node24+，实际24.18.0与 mise/CLI声明24.14.0的 warning 保留。
- 使用已有 `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 显式指向 `ROOT/config/provider/zcode-builtin.json`；现有构建校验器验证生产 Release，不复制配置到 Dev.app，不伪造模型。
- `main() -> int` 无参数CLI：0代表原生 API、数据库与真实桌面页面就绪；1代表失败。登录/授权仍由原生界面表达，不能以窗口存在签发任意账号的集成成功。

## 2. 文件与职责

| 文件                                                   | 操作     | 职责                                                               |
| ------------------------------------------------------ | -------- | ------------------------------------------------------------------ |
| `scripts/xcode/start-local.py`                         | 新建     | 固定运行身份、互斥、数据库/API/桌面补启动、正确实例激活            |
| `scripts/xcode/start-local.test.py`                    | 新建     | 真实锁/进程/套接字及信任边界回归                                   |
| `scripts/xcode/启动 XCode.command`                     | 新建     | 可执行 Terminal/Finder 入口，固定工具 PATH                         |
| `docs/aiscoo/aiscoo-admin-integration-runbook.md`      | 更新     | 使用方法、日志、当前原生部署和退出边界                             |
| `~/.config/xcode-local/start.json`                     | 本机0600 | 工具绝对路径、必要桌面环境、原生三文件指纹及数据库身份；父目录0700 |
| `~/Library/LaunchAgents/com.xwork.local-desktop.plist` | 本机0600 | 按需调用既有开发入口，不登录自启或自动重启                         |
| `~/.local/share/xcode-local/`                          | 本机0700 | 锁与0600的 desktop.log，无凭据副本                                 |

### Task 1: 固定真实运行身份

- [x] 确认用户追加选择原生部署，移除旧 API Docker 启动逻辑及其过时测试。
- [x] 固定原生 binary、`.env`、plist SHA、Label、WorkingDirectory 和 ProgramArguments；不复制 `.env` 明文。
- [x] 只读确认私有开关/origin及实际数据库端点，冻结现有数据库卷/镜像/端口/权限。
- [x] 核对 Node24+、pnpm10.33.2、开发资源及冲突标记；不自动 install/bootstrap。
- [x] 安装期另一任务追加 `CRITICAL_RATE_LIMIT=200` 导致正常启动器拒绝；重新核对端点、私有模式、binary/plist未变后更新安装清单。本轮没有修改此限流配置，正常入口不提供自动重设基线功能。

### Task 2: 实现幂等入口

- [x] 按红→绿实现进程互斥、未知监听拒绝、原生文件缺失/篡改拒绝、错误origin拒绝、作业祖先证明、手工部分dev拒绝、构建失败立即反馈、错误数据库卷/端口拒绝、退出中的PID不认领。
- [x] 全部工具检查固定cwd=ROOT；pnpm检查与launchd使用同一环境，避免Finder目录选择全局pnpm。
- [x] Electron 会重写ps的comm及环境展示，故用lsof txt识别真实可执行文件；必要时以已加载作业的精确origin、cwd和进程祖先证明启动来源，不凭名称/端口放行。
- [x] 仅补启动缺失的现有数据库容器及原生API作业；桌面已运行只激活，已有本作业构建只等待，孤立Vite则拒绝并保护out。
- [x] 只更新本轮自建桌面plist，并精确bootout/bootstrap加载新环境；原生API既有plist及配置内容不改。
- [x] 安装可执行桌面符号链接；关闭终端不停止launchd应用，失败窗口保留明确提示。

### Task 3: 实际场景验收

- [x] 用户批准两组短时维护；原生API准确bootout后由桌面入口恢复，数据库不停止。
- [x] 空shell、HOME目录和原生Terminal实际执行桌面文件均完成；第一次完整冷启动含编译约214.29秒，不承诺离线秒开。
- [x] 真实CDP/截图看到原用户、原项目、草稿及模型目录恢复；XWork·Plan授权有效。
- [x] 通过真实原生WebView读取生效套餐及参考价格，只有联系管理员等只读操作；没有购买、授权变更或模型调用。
- [x] 原生窗口关闭后进程仍存活；两次并发点击只有一套检查，激活同一PID并重新显示窗口，不重复pre-dev。
- [x] 关闭启动Terminal后桌面/API仍运行；原生Cmd+Q后5174/9229释放而API仍在，随后同数据/钥匙串重启恢复。
- [x] 与Ailoop同时运行：3001为原生API，15433为它的现有数据库；OpenAPI使用3000/8787/31104，不抢占3001。

## 3. 验证命令与已知边界

- `python3 scripts/xcode/start-local.test.py`：9项回归通过；本轮新增行为均有先失败证据。
- 两份 `.command` 的 `zsh -n` 及本轮四份 plist 的 `plutil -lint` 通过。
- Finder确实打开了桌面文件；一次按新窗口名采集输出的驱动超时、一次AppleScript tab取值错误均保留为采集器失败。最终以明确Terminal窗口/tab读取真实入口完整输出，并验证关闭后应用仍存活，不将采集失败伪称服务失败或成功。
- 原生API仍监听全接口，这是用户选择保留的既有部署风险，未擅自变更监听配置；地址不应对外开放。
- Dev.app 的 `config/default.json` 相对根问题仍可能影响社群/反馈配置读取。现有provider环境覆盖解决本入口的模型资源加载，不宣称该产品级路径缺陷已修复。
- 模型/套餐列表只读验收不等于真实供应商、支付、限流安全专项或全产品质量签发；未跑全仓前后端测试，未提交/推送。
- 完整执行裁定、并发部署变化和失败记录在本计划专属 `.superpowers/sdd/2026-10-18-xcode-one-click-start/progress.md`，不读取或覆盖其他任务台账。
