# Aiscoo 数据目录冷恢复验收

状态：ACDD01–03 已接受，候选保持 pending。用例定义见 [case catalog 的 ACDD 组](../../conversation-session-case-catalog.md)，路径规则见 [desktop-product-identity](desktop-product-identity.md)。

## 运行环境

- 合成 HOME 位于 `packages/desktop/.e2e-home-aiscoo-storage-*`，渠道默认根是其下的 `channel/`，保证与 HOME 不同。
- 不设置 `ZCODE_STORAGE_DIR`、`ZCODE_SESSION_DB_PATH`、`ZCODE_LOG_DIR` 或设置文件覆盖，避免测试固定 CLI 路径而掩盖漂移。
- 账号由本地 HTTP 合成 fixture 提供，经真实 `AiscooAdminSessionRepo` 写入加密缓存；Host 冷启动时仍真实校验 Me。模型请求只用 `common.json` 与本例回放，禁止 capture。
- 只在 idle 时保存目录，并立即完整退出 Electron、Host 与 Agent。完整重启复用 `restartIntoWorkspacePreservingProfile`；runner 确认进程树退出后才清理合成 HOME，失败时保留现场。

## 复跑

先完成根 `pnpm typecheck` 和 CLI 构建，再串行构建桌面；不要在 `tsc -b` 写入 `out/host` 时并行构建或运行。

```bash
env -u AISCOO_ADMIN_BASE_URL ZCODE_ENV=test VITE_ZCODE_E2E_STORE_BRIDGE=1 \
  pnpm --filter @zcode/desktop build:no-runtime-assets

# 每个模式使用新的 HOME 目录，<suffix> 每次替换
env -u AISCOO_ADMIN_BASE_URL ZCODE_ENV=test \
  AISCOO_E2E_STORAGE_HOME="$PWD/packages/desktop/.e2e-home-aiscoo-storage-<suffix>" \
  AISCOO_E2E_STORAGE_MODE=new \
  ZCODE_E2E_SKIP_BUILD=1 ZCODE_E2E_SKIP_AGENT_BUILD=1 \
  pnpm --filter @zcode/desktop exec wdio run test/e2e/aiscoo-data-directory.wdio.ts
```

`AISCOO_E2E_STORAGE_MODE=legacy` 运行 ACDD03。标准 manual-review 入口选中该用例时会跳过，因为它依赖薄配置提供的合成 HOME。

## 观测边界

- macOS 的 Host 进程设置 `process.title` 后，`ps eww` 读不到其环境变量，所以不以此观测 Host 收到的路径。生效目录由设置页显示、持久化设置、App 文件 canary、原 CLI 库文件与消息、新旧 task-index 是否推进共同证明。Host 环境的精确合并规则由 `scripts/test/aiscoo-desktop-data-identity.test.mjs` 覆盖。
- wdio-electron-service 只在会话启动时保存一份原始 Electron API，冷重启后缓存的 mock 指向旧 Main，restore 也拿不到新进程的原始函数。用例因此在当前 Main 上只替换一次 `showOpenDialog` 的返回值，调用后立即还原，并断言只被调用一次、参数含 `openDirectory`。
- 不覆盖 busy 中迁移、非空目标、复制失败、Windows/Linux 原生、手机远控和正式账号服务端。返回已有数据的渠道根沿用 `force:false`，不合并 task-index 或 SQLite。

## 最近一次运行

| 覆盖                          | runId                             | 结果      |
| ----------------------------- | --------------------------------- | --------- |
| ACDD01/02                     | `desktop-e2e-20261101-152744-965` | 1/1 通过  |
| ACDD03                        | `desktop-e2e-20261101-152833-588` | 1/1 通过  |
| 标准 manual-review 入口       | 不设置薄配置环境变量              | 1 skipped |
| 上游 CDD01（C=H，2026-11-01） | `desktop-e2e-20261101-143220-907` | 1/1 通过  |

两组 ACDD 运行中，原 CLI 会话的消息由 10 条增至 12 条，原消息与数据库 inode 保持不变；每次冷重启后设置页显示的目录与预期生效目录一致，旧 App 索引停止推进，新索引推进。事实文件为各运行目录下的 `aiscoo-directory-<mode>.json`。macOS 本地 Electron 执行，未晋升 formal/CI。CDD01 结果来自规范修正前的同一生产实现，本次修正未改动其覆盖的路径。
