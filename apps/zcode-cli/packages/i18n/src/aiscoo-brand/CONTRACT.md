# cli-aiscoo-brand

下游 CLI/TUI 的只读品牌装配。品牌事实由 `@zcode/shared/aiscoo-brand` 拥有，本模块只负责在原词典进入 CLI 时投影自有静态模板。

- `brandCliCopy(copy)` 返回新 copy，不改原语言资源或公共 i18n key。
- help 只含一个 version 插值；模板先转换，再插入真实 version，用户值不转换。
- TUI 启动文案是静态模板；其他带用户错误、路径和消息的 formatter 原样保留。
- 无 IO、业务状态、事件或持久化；命令 `zcode`、协议、URL 与数据目录继续兼容。
