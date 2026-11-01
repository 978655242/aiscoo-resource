# Aiscoo 启动归属恢复

Root 冷启动恢复 Composer 归属时不代表用户点了 New Task。通过 Root 的可选 `restoreDraftContext` 接点注入本模块，保留上游 Root 默认行为。

状态仍由现有 workspace UI store 持有。首次水合只设置项目/分组，并沿用 draft runtime 失效代次；不切会话、不递增焦点代次、不写本地存储或更改模型、权限、提交状态。

已选会话、显式新建、已初始化归属优先；迟到或重复调用无状态通知。所有读写复用稳定 workspace identity 分桶，远端 attachment ID 不参与身份。

`createAiscooRoot` 从 `@zcode/ui/aiscoo-startup-context` 公开子路径接入，由桌面与 Web 入口传入原 Root 组件后组合。原 `@zcode/ui` 根导出及其隔离边界保持不变。Pane 恢复、attachment 校验、手机 replayable 隔离及 Host/CLI 事实所有者均沿用原路径。
