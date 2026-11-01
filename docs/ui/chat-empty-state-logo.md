# New Task Empty State Logo

## 背景

New Task 的草稿空态在问候语上方展示完整小写 `aiscoo` 字标。现行实现为 `packages/ui/src/v4/ConversationDraftEmptyState.tsx`；品牌资源、胶囊眼几何与动效以 [Aiscoo 图标与显示名](../aiscoo/branding/icon-spec.md) 为准。

## 当前实现

- `ConversationDraftEmptyState` 通过 `AiscooEmptyStateLogo` 复用 `AiscooAnimatedWordmark`，消费 `packages/ui/src/aiscoo/brand/assets/wordmark-animated-{light,dark}.svg`。完整字标与 `ai` 标志使用同源浅深 SVG；浅色主题显示深色图形，深色主题显示白色图形。
- 字标独立参与文档流，位于问候语上方，正常不透明度，与问候语间距为 `gap-6`。默认宽 `w-80`（320px），手机远控紧凑模式为 `w-56`（224px），均以 `max-w-full` 和自动高度保持原稿比例；外层水平留白 `px-4`，不裁切、不拉伸，不叠到文字背后，也不使用水印遮罩或渐隐。
- 动效由 SVG 承载 10 秒自动循环：探头、胶囊眼转向和短眨眼、看 `i` 圆点跳动、厚圆拱笑眼与整头弹跳、恢复中性眼并收起。系统启用 `prefers-reduced-motion` 时切换为同主题完整静态字标；UI 不增加动画状态或计时器。
- 桌面初始对话以输入框中心对齐可用区域中部，`useDraftComposerCentering` 按字标、问候语和输入框的实际高度补偿顶部留白，最小保留 52px；空间不足时自然滚动。手机紧凑模式与浮窗沿用现有布局。字标层使用 `aria-hidden` 与 `pointer-events-none`，不参与朗读，也不拦截输入。
- 问候语使用默认无衬线字体、`font-medium` 与 `foreground`；桌面字号按标题自身可用宽度在 20–30px 内调整，紧凑模式固定 20px。时间分段与国际化规则见 [Chat Empty Time Greeting](chat-empty-time-greeting.md)。
