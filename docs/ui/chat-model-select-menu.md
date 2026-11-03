# Chat Model Select Menu

> **当前状态**：聊天侧已经迁移到 V4 composer。

## 目标

聊天输入框复用 `ModelConfigSelect`，模型选择交互使用简单菜单承载，减少搜索型 Command 列表在小范围模型切换里的操作成本。

## 当前实现

- `packages/ui/src/ModelConfigSelect.tsx`
  - 使用现有 `DropdownMenu` 组件渲染模型菜单，保持 `bg-menu`、紧凑行高和键盘菜单语义。
  - 多个 provider 时，一级菜单展示 provider；悬停或键盘展开二级菜单后展示该 provider 下的 model。
  - Z.ai / BigModel family 在分组标题展示当前连接方式短徽标，例如 `Start`、`Individual`、`Team`、
    `API`；连接方式徽标使用无边框的弱表面圆形 pill，模型项本身不重复徽标。连接方式只在设置页切换，输入框菜单只消费当前 selection。
  - 只有一个 provider 时，一级菜单直接展示 model 列表，不额外包一层 provider。
  - 选中 model 使用 `DropdownMenuRadioItem` 保留单选状态；受当前运行任务限制的 model 使用禁用语义和锁定提示，不触发切换。
  - XCODE：模型菜单的模型名后不显示“视觉 / Vision”能力徽标；该徽标只保留在模型设置的模型列表行。图片输入能力仍由 provider registry 的 `inputFormat` 决定附件校验，与展示无关。
  - `Ctrl+M` 只唤起模型菜单，不按顺序循环切换模型；模型切换必须由用户在菜单中明确选择。
  - trigger 文案切换时复用 toolbar rolling label 动效，和 mode / thought level 控件保持一致；系统开启 reduced motion 时直接静态替换。
  - XCODE：composer 供应商列表首项为 `Aiscoo Zen`（由 `brandProductText` 投影产品显示名；`new-api-account` 官方模型合并组，key `composer-official`，无徽标）。标题图标与设置页官方订阅入口共用 `ZCodeAboutLogo` 兼容导出，其实际实现为 `AiscooMark`：同源浅深 SVG 的静态 `ai` 胶囊眼标志，尺寸为 `size-4`；品牌几何及动态入口的 10 秒笑眼弹跳规则见 [Aiscoo 图标与显示名](../aiscoo/branding/icon-spec.md)。其余自配供应商沿用上游，每个供应商一行，key `registry-provider:<providerId>`，名称 `providerName.trim() || providerId`，按 access 显示 `API` 徽标；选中供应商后模型列表只显示该供应商模型。图标统一使用与 aiscoo-admin 管理端同源的 @lobehub/icons：官方模型取 `/xcode/v1/models` 下发的 `icon`（模型 icon 优先，空则取供应商 icon）；自定义模型没有后端图标，按模型 ID 厂商关键词映射到同一套名称（`resolveModelLobeIcon`，如 Claude→`Claude.Color`、DeepSeek→`DeepSeek.Color`、GLM→`ZAI`，取值对齐后端 `defaultVendorIcons` 与当前供应商配置）；供应商标题图标按 `providerName` 与 `providerId` 走同一映射，与该供应商模型图标一致，未识别时回落供应商配置 logo。客户端用同版本 `@lobehub/icons-static-svg` 按名称懒加载，`X.Color` 有彩色资源时用彩色，否则用跟随主题前景色的单色；名称未知或未识别时回落 provider logo，再回落 `Package` 图标。trigger 只显示所选模型的图标与模型名，不显示供应商名或前缀；title 同为模型名。其他复用 `ModelConfigSelect` 的入口（子代理、定时任务、工作流设置）保留原供应商分组与身份文案。
  - XCODE：composer 菜单按内容加宽（最小 16rem，最大 28rem 且不超过视口），模型名不截断；高度不超过 28rem 与可用空间，超出时滚动，`管理模型` 固定在底部。trigger 与其外层不再收缩截断，完整显示模型名；空间不足时由下述压缩规则直接收为图标。
  - composer trigger 按实际剩余空间执行累积压缩：Computer Use 正方形 → mode 正方形 → Plan 正方形 → think 图标＋小绿条 → think 正方形（小绿条隐藏）→ model 正方形。每档够用即停，放宽时逆序恢复。模型名称显示时保持完整单行与下拉箭头，最后一档只保留 28px 的模型图标按钮并隐藏箭头。具体规则见 [CUA composer 布局契约](../superpowers/specs/2026-08-18-cua-composer-entry-design.md)；其中「隐藏 provider-text」一档因 composer 不再显示供应商而不会出现。桌面分屏、普通 Web 和手机 Web 共用此规则。
  - 模型项同样把模型 ID 当作不透明字符串；`openrouter/ox-alpha` 或更多层级的 `/` 不参与能力判定或名称拆分，选择值继续使用完整 ID。
  - 模型切换 pending 时，loading spinner 放在文案后面，避免模型名左侧宽度变化造成视觉跳动。
  - “管理模型”入口继续由调用方控制，只改变承载组件，不改变 settings 导航链路。
- `packages/ui/src/v4/composer/V4ComposerToolbar.tsx`
  - 只负责把聊天 toolbar 的模型分组、锁定状态和切换回调传入 `ModelConfigSelect`。
- `packages/ui/src/v4/ConversationComposer.tsx`
  - 模式、模型、思考深度三个配置 picker 共享 composer-local 的打开状态；任一时刻最多一个
    picker 展开。点击另一个 trigger 时，旧 picker 必须先退出可见状态，后点击的 picker
    保持打开。
  - 关闭旧 picker 的迟到回调只能清理它自己，不能把已经接管的兄弟 picker 一并关闭。
  - picker owner 只在当前 `workspaceKey + sessionId/draft scope` 内有效；scope 切换时必须
    同步清空。`ConversationComposer` React 实例可以跨 task/draft 复用，但打开状态不得跨 scope
    保留或自动弹出。

## 兼容边界

- 桌面端和 Web 端共用同一个 React 组件，菜单交互不引入平台专属逻辑。
- picker 互斥只属于单个 composer 实例，不进入全局 store，也不跨 pane、window 或
  desktop continuous / web-remote replayable 边界同步。
- 手机 Web 端继续避免关闭菜单后强制恢复输入框焦点，防止触控设备拉起系统键盘遮挡菜单；模型 trigger 不保留手机专用的固定宽度、文字截断或 provider 裁剪逻辑，统一依赖 composer 的可用空间裁决。
- ZCode Agent 的 provider 模型菜单按 runtime endpoint format 过滤，当前目录可以包含
  Anthropic-compatible、OpenAI-compatible Chat Completions 和 OpenAI Responses 模型；Bot `/model`
  入口复用同一 provider 能力边界。
- 已有 session 的选择通过 V4 `switchModelConfig` 写 CLI；草稿选择由 `useDraftConfigControl` 写
  `draftConfigRef`、workspace default 和预热 session。远程恢复必须保持 workspaceIdentity /
  remoteSessionId，不经过 legacy task model write。
