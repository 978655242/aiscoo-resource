# profile-avatar

为账户头像提供可选的 fallback 展示插槽。调用方仍拥有用户资料、真实头像图片和未登录状态，本模块只选择登录用户的 fallback 节点。

无 Provider、无登录用户或渲染函数返回 null / undefined 时返回调用方原有 fallback，不改变上游默认行为。Provider 渲染函数不能修改用户资料；不保存身份、不发事件、不访问 IO。WorkspaceSidebarFooter 是共享消费点；产品入口负责装配独立默认头像实现。

账户菜单可通过 `AccountMenuVisibilityProvider` 可选控制奖励入口展示。无 Provider 时默认允许展示，登录判断仍由共享菜单持有。此策略仅影响菜单项，不改变奖励打开动作或营销入口，也不持有账号或会话状态。
