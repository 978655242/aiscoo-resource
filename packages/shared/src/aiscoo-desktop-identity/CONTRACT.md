# Aiscoo Desktop Identity

唯一所有者是只读渠道配置，没有缓存、持久化、网络 IO 或事件。构建工具和 Main/Host/Renderer 使用同一 profile，平台只负责注册和转发，不复制登录事实。

- production: dev.aiscoo.app / aiscoo；development: dev.aiscoo.app.dev / aiscoo-dev；preview: dev.aiscoo.app.preview / aiscoo-preview。
- getAiscooDesktopIdentity 只接受明确渠道；配置及返回值冻结，调用幂等。
- resolveAiscooDesktopIdentity 从可选编译期 `__AISCOO_DESKTOP_CHANNEL__` 读取渠道；未注入返回 null，通用上游调用方保持原有默认值。环境变量不能在运行时改变已打包渠道。
- 新显示名称与数据名使用 Aiscoo；macKeychainName 保留历史 XWork 值。这不承诺新签名身份自动获得旧钥匙串访问权。
- oauthRedirectUri 与 scheme 成对生成并保持精确 URI；模块不扩展回调白名单、解析授权凭据、生成授权码或处理 pending。
- `AISCOO_DESKTOP_DEFAULT_DATA_BASE_DIR_ENV` 只定义 Main 向本地 Host 传递渠道默认 App 根的环境变量名；取值由 Main 写入，本模块不读取。
- `nativeResourceDirectoryName` 为三个 Aiscoo 渠道提供 `.aiscoo` 产品默认。启动装配按独立原生资源策略处理环境覆盖；该字段不改变 `dataName`、固定 CLI 根、App 数据目录或 HOME。

装配点：Desktop tsup/Vite 固化渠道、packaging 和 Dev bundle 选定 profile、Main 协议注册/解析、Host New API redirect 注入。上游默认 zcode 不由本模块改写。数据迁移由独立命令完成，不在读取身份配置时发生。
