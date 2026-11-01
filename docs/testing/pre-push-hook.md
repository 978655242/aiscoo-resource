# Pre-push Hook

Husky 的 `.husky/pre-push` 使用当前 PATH 中的 Node / pnpm，执行 `pnpm verify:pre-push`。
不强制依赖 mise，也不自动安装工具、stash 工作区或跳过失败检查。

```text
Git push ref 输入 → 清理 Git local env → 分支策略 → 工作区与目标检查
  → 远程目标清单 → lint → 过时文档措辞 → schema → 架构工具回归 → 架构检查 → 受影响工程测试
  → Aiscoo 原生回归 → Aiscoo 独立 Vitest 回归
```

- 已暂存、未暂存或未跟踪修改均阻止 push；忽略 Git 已忽略的文件。每个非删除 ref 先解析为 commit，再与 HEAD 比较；附注标签剥离为 commit，删除 ref 无需测试，多 ref 逐项校验。
- hook 通过 `ZCODE_PRE_PUSH_STDIN` 传递 ref 和 SHA。架构检查依次使用显式参数/环境、CI、remote SHA、upstream merge-base、默认分支 merge-base、HEAD；Aiscoo 默认候选优先 `origin/release`，再保留上游候选，见 `scripts/architecture/git-base.mjs`。
- 工程 affected 的显式基线优先于 remote SHA；首次推送及没有有效 upstream 的手动 push 使用 `origin/release` 的 merge-base。缺少集成分支、无共同祖先、无效显式基线、脏工作区或非 HEAD 目标均严格失败，不自动 stash 或使用镜像 main 替代产品基线。见[比较基线](../ci/affected-unit-test-baseline.md)。
- Git local env 先清理，避免临时 Git 仓库误操作当前仓库。分支策略禁止直推 `release`，同步 PR 通过 merge commit 合入；规则见 [Aiscoo 分支规范](../aiscoo/BRANCHING.md)。
- 文档措辞检查扫描 `docs/` 与 `apps/zcode-cli/docs/`，历史 `docs/plans/`、`docs/v4-refactor/` 不在范围；远程目标检查在私有 harness 存在时核对真实队列与公开清单。检查失败均阻止 push，不改写目标文件。

## 测试边界

App 单测已按[上游测试规格](unit-test-quality.md)退役；根 `test`、`test:unit`、`test:unit:affected`、`test:coverage` 和 lint-staged App 测试入口不再提供。上游工程 Vitest 使用显式清单，不扫描 App 业务测试；CLI/CUA/E2E 保留各自入口。

- 工程 Vitest：`pnpm test:engineering <文件>`，精确清单在 `scripts/engineering-test-files.json`；增量使用 `pnpm test:engineering:affected --base <任务起点>` 或 `--scope push`，可用 `--dry-run` 预览。选中整个套件时报告跳过并退出 0，不把跳过当通过。
- 工程执行工具使用 `pnpm test:engineering-tools`，架构工具使用 `pnpm test:architecture`，schema 使用 `pnpm db:schema:check`；Node 工程测试按受影响文件使用 `node --test`。CLI 按 `apps/zcode-cli/AGENTS.md` 执行，CUA 使用当前包脚本。
- Aiscoo 扩展保留独立 `pnpm test:aiscoo <文件>` 的显式清单和 `pnpm test:unit:node` 原生回归，覆盖 New API、品牌、插件指南及必要隔离边界。它们不进入上游 engineering 选择范围，不能用工程门禁通过替代下游回归结果。
- 桌面、手机远控和浏览器验收沿用既有入口及生命周期；实际执行证据单独登记。未执行、零收集、平台跳过或环境失败均不代表测试通过。

## Aiscoo 回归存储隔离

<!-- XCODE: 保留数据库、迁移备份和真实用户数据的原有隔离约束。 -->

Vitest 父进程的 `globalSetup` 分配临时数据根，`vitest.setup.ts` 在导入服务前为每份测试注入独立 HOME，并清理继承的 `ZCODE_DATA_BASE_DIR`；原生 runner 为子进程设置独立 HOME、USERPROFILE 和数据根。临时数据库与备份都归测试父进程所有，不落入调用者的 `~/.zcode`。

Vitest global teardown 早于 pool 关闭，因此正常完成或测试失败后由父进程 `beforeExit` 异步回收，不能在持库 worker 中删除目录。强退可能留下临时根，但不得改删用户数据。真实 IO 测试使用 forks 串行执行，保留原断言和时间限制；正常结束同时核对退出码、取消/超时与清理结果。

```text
父进程分配临时根 → worker 私有 HOME → 数据库与备份 → worker 退出 → 父进程回收
```

CLI 测试使用显式 `ZCODE_CUA_REPO` 定位 producer checkout，缓存和参数传递沿用现有 Turbo 配置，不记录本机路径，不改变 producer pin。
