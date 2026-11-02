# Aiscoo macOS 应用内更新：真实安装验收

日期：2026-11-01。客户端基线 `26540050`，后端基线 `d22a9f2cd`。本轮由用户明确授权“做真实升级验收”。

**真实安装链路通过；Apple 新提交的公证尚在处理中，因此暂不作为正式分发放行。**

## 1. 验收环境与边界

- macOS arm64，Electron 44.7.0，Node 24.14.0。完整构建两份 production 形态安装包，构建时打开 `ZCODE_AUTO_UPDATE=1`，账号与更新 origin 编译为专用回环后端。
- 两版分别为 `3.17.1` 与 `3.17.2`。根 `package.json` 版本只在验收工作树临时改变，结束后恢复，不发布版本号或 tag。这是 2026-11-01 验收当时的做法；2026-11-02 起仓库根版本正式升为 `3.17.2`，规则见 [应用内更新](aiscoo-auto-update.md) 第 1 节。验收包与正式发布包不是同一份产物，验收包不能作为正式发布。
- 两版均使用同一个专用验收 bundle ID、Developer ID 团队和 designated requirement。改 Info.plist 与外部 `app-update.yml` 后重新签名，保留 `ElectronAsarIntegrity`，不修改已签的 ASAR。
- `LSEnvironment` 固定相同的独立 userData、sessionData、业务根、CLI 库、日志及设置路径；ShipIt 经 LaunchServices 自动重启后继续使用这些路径。系统 HOME 保持原样。独立 bundle ID 与 `updaterCacheDirName` 用于隔离 ShipIt 和下载缓存。
- 后端用当前真实 Go 代码、新 SQLite 库和合成 root 账号，仅监听回环；真实 `/Applications/Aiscoo.app`、线上服务、官网下载链接和正式版本登记均未替换。云端只上传本次验收 ZIP 到独立构建路径，验收完成后已把该对象恢复为 private，匿名请求返回 403。

## 2. 真实检查、下载、安装与重启

| 场景               | 证据                                                                                                                         | 结果 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---- |
| 旧包真实启动       | 已签 app 的 package.json 和运行日志均为 `3.17.1`；启动请求只发往本机 manifest                                                | 通过 |
| 后端登记与通道提升 | HTTPS GET 完整 sha512 / size 匹配后，正常 RootAuth 登记 status=3，再 PATCH status=1；stable 在提升前 404、提升后返回目标版本 | 通过 |
| 实际发现更新       | `21:18:03` 旧进程日志 `new version available: 3.17.2`，真实窗口显示“发现新版本”与“下载更新”                                  | 通过 |
| 实际下载           | 点击真实 renderer 的“下载更新”；进度 15.3%→100%，共 247,365,740 字节；下载后出现“已准备就绪 / 重启以更新”                    | 通过 |
| 原生安装           | `21:19:20` 点击“重启以更新”，先完成 Host 清理，再由 Squirrel.Mac 请求 ZIP、校验并替换 app；未 stub 安装器或手工覆盖安装目录  | 通过 |
| 自动重启           | 旧 Main PID 55460 退出，新 Main PID 60737 在 `21:19:32` 启动，日志 `current version: 3.17.2`                                 | 通过 |
| 已是最新           | 新版自动请求同一 manifest，日志 `already up to date (local=3.17.2, remote=3.17.2)`                                           | 通过 |
| 再次冷启动         | 正常退出后重新从安装目录启动，新 PID 66162 仍为 `3.17.2`，再次检查已是最新                                                   | 通过 |
| 安装后签名         | `codesign --verify --deep --strict` 通过，designated requirement 与两版预期相同                                              | 通过 |
| 安装内容           | 安装后 Main SHA-256 与目标新包完全一致                                                                                       | 通过 |

原生 `ShipIt_stderr.log` 在 `21:19:26` 记录 `Installation completed successfully`，在 `21:19:31` 记录 `Successfully launched application`、`ShipIt status 0`，与磁盘内容和新进程版本一致。

目标 ZIP sha512（base64）：

```text
PPaApIPR0zKeWwqS+OjdiYPNeOdD/XCpqG/Z4FDchPyiCbahpru22iXuad5+jgEQnsAuv4LclrduA0ECJ5tkjg==
```

安装前 Main SHA-256：`885ab07985a9a562c0eac4291329b473d5a036c63e205afdd75a72f7774ecbc0`。

目标及安装后 Main SHA-256：`3405c054b109976c5bedffb5c9b131f2515cc6b19005126ebd6524bc1f904466`。

## 3. 数据与凭据验收

- 私有业务根的验收标记在更新前后 SHA-256 一致，设置仍存在且语言保持 `zh-CN`；自动重启和再次冷启动的初始工作区仍位于私有根。这只证明本轮标记与设置保留，不声称已有登录账号、项目或历史消息的迁移已经验收。
- 验收运行期间仍有其他 ZCode 会话。真实 ZCode 设置和会话库元数据发生变化，正式 Aiscoo 设置文件 mtime 也在升级前变化（大小相同），本轮未确定全部并发写入者；未恢复、覆盖或读取这些文件的业务内容。测试进程日志、打开文件和启动 URL 显示其使用私有目录，正式 Aiscoo CLI 数据库元数据保持不变。
- 专用合成 root 通过正常登录与密码 step-up 创建 `ops:read` / `ops:write` PAT；PAT 调用 GET releases 与 PATCH status=1 均 HTTP 200；经正常 step-up 撤销后列表中不存在，复用该 PAT 返回 401。未直接写数据库或跳过权限检查。
- `aiscoo://` 默认处理程序在验收前后仍为正式 `/Applications/Aiscoo.app`。临时验收包的 LaunchServices 注册在退出后注销。

## 4. 本轮发现并修复的发布问题

原发布脚本使用 `ossutil cp --meta`，本机 2.x 不支持；并且 `stat` 预检会把权限/网络失败视为不存在，也无法原子禁止覆盖。修复为官方 `aliyun ... ossutil api put-object`，由服务端 `--forbid-overwrite=true` 拒绝同名覆盖，使用 `--cache-control`，并流式计算本地与公开 GET 的完整 sha512 / size。

首次真实上传后匿名 GET 403，原因是对象继承 private 桶权限。脚本未登记版本，符合失败关闭规则。对照既有正式 DMG 的对象 ACL 后，修复为仅将发布对象设为 `public-read`，不改变桶 ACL。该验收对象的权限单独修改后，完整公开 GET 校验、登记及安装全部完成；验收结束撤回公开读取。

工程回归 `node --test scripts/aiscoo/publish-macos-update.test.mjs` 为 38/38，通过项覆盖 dry-run 无出站、路径/哈希校验、原子拒绝覆盖、权限/网络失败停止、公开 GET 内容校验、对象 ACL 和登记顺序。类型检查通过；Lint 为 308 条已有 warning、0 error；改动文件格式和架构检查通过。

## 5. 公证与正式分发放行

两份新提交使用专用钥匙串的现有公证 profile，没有读取钥匙串口令或导出私钥：

| 包              | Apple submission ID                    | 当前结论      |
| --------------- | -------------------------------------- | ------------- |
| 旧验收包 3.17.1 | `df4d9f04-f295-4450-8956-54008e78f03d` | `In Progress` |
| 新验收包 3.17.2 | `b95c77df-cb0a-4298-aa38-7bcaa3f45e56` | `In Progress` |

公证等待曾因 `NSURLErrorDomain -1009` 网络暂断退出；重新 `notarytool info` 成功，Apple 状态仍在处理，未收到 Invalid/Rejected。真实安装使用有效 Developer ID 签名包，但在 Apple 接受前没有 staple 票据，`spctl` 仍显示 `Unnotarized Developer ID`。**不能据安装成功宣称公证或 Gatekeeper 通过。**

待 Apple 接受后须补：两份 DMG 和 app 的 staple / validate、Gatekeeper 验证、运行 `build-macos-update-feed.sh` 从最终 stapled app 生成可正式分发的 ZIP。公证状态与签名 CDHash 关联，不得重签后复用旧票据；不能覆盖已上传的本次验收 ZIP，应使用新的构建目录。

本轮未上线 manifest 后端，官网用户仍使用原公证 DMG。既有 3.17.1 下载包没有打开更新开关，首次迁移到可更新版本仍须手动安装。

登录前主菜单仅能检查并提示发现更新，干净欢迎页没有标题栏更新按钮。本轮通过既有平台 `openUpdateStatusWindow` 接口打开真实更新窗口，再点击 renderer 的下载与重启按钮，完整覆盖真实安装器；不把此结果描述为已经验证登录前全部菜单可达性。

原始脱敏证据保存在本地 `.tmp/real-update-20261101/evidence/`，含升级时序、窗口截图、包内版本/哈希、PAT 验证和 Apple 状态。合成凭据与数据库不作为交付内容。
