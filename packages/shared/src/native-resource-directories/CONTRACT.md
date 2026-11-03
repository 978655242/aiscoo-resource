# Native Resource Directories

唯一事实是入口解析后固定的只读目录策略。通用默认 `.zcode`，产品可提供默认值，非空 `ZCODE_NATIVE_RESOURCE_DIR_NAME` 优先。非法名称在文件 IO 之前失败；环境读取属于入口，模块纯解析不读取 process.env。

- `resolveNativeResourceDirectoryPolicy` 验证并冻结策略；`getNativeResourceDirectoryName` 保持无策略时的上游默认，并校验直接注入的策略。
- Node 公共入口提供用户／项目资源与 config.json 路径解析，使用调用方的真实 HOME 和 workspacePath。
- 策略只影响原生配置与资源目录段。`.agents`、App 数据根、DB、日志、插件库存／缓存、执行产物、CUA／Server 安装和显式绝对路径不归本模块修改。
- 不持有缓存、文件、网络、迁移或业务状态；不新增写入路径或 fallback。变更在 Host／Agent 完整重启后生效。
- 规格见 `apps/zcode-cli/docs/design/v2/native-resource-directories.md`。Aiscoo 默认值由其独立产品 profile 提供。
