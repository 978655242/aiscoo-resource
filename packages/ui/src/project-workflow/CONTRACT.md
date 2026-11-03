# Project workflow

完成卡与 run 侧板使用同一个保存控制器，workflowRunSavedStore 是已保存工作流投影的唯一缓存。Agent 保存 run 的脚本，Host projectService 裁决目标项目与 cwd；调用方不能通过相同路径推断设备或归属。

保存成功才发布缓存结果，失败保留原状态。再次运行复用 saved-workflow launcher，默认目标从原会话解析，显式选项目则使用选择结果；不改写既有会话 cwd。查询与失效继续使用既有 generation/key，侧板提炼请求发给父会话。

`resolveSaveDirectory(scope)` 复用相同目标 Agent 的 `listSavedWorkflows` 返回实际目录，用于保存预览。UI 不读 process.env，也不拼 `.zcode` 或产品目录；结果尚未取得时只展示工作流文件名。scope、目标服务变化或弹层关闭时丢弃迟到结果。项目/全局中枢同样监听各自 list 的 `dir`，保存、执行和监听由同一 Host 的策略决定。

模块保持只读/灰度门、窄屏、主题及文案。桌面/手机继续使用宿主既有命令和 continuous/replayable 边界。
