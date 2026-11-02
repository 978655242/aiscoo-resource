import { createContext, useContext, type ReactNode } from "react";

// 无策略时遵循共享菜单的原行为；此上下文只决定入口展示，不持有奖励状态。
const AccountMenuRewardsVisibilityContext = createContext(true);

export function AccountMenuVisibilityProvider({
  children,
  showRewards,
}: {
  children: ReactNode;
  showRewards: boolean;
}) {
  return (
    <AccountMenuRewardsVisibilityContext value={showRewards}>
      {children}
    </AccountMenuRewardsVisibilityContext>
  );
}

export const useAccountMenuRewardsVisible = () => useContext(AccountMenuRewardsVisibilityContext);
