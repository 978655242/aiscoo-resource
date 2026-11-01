import { createRoot } from "react-dom/client";
import { WorkspaceSidebarFooter } from "@/WorkspaceSidebarFooter.js";
import { createAiscooAccountLoginRoot } from "@/aiscoo/account-login/logout-presentation.js";
import { RewardsProvider, useOpenRewards } from "@/rewards/RewardsProvider.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { applyTheme } from "@/useTheme.js";
import type { RootProps } from "@/root/types.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "dark" ? "zai-dark" : "zai-light";
const locale = params.get("locale") === "en-US" ? "en-US" : "zh-CN";
const guest = params.get("guest") === "1";
applyTheme(theme);

// 使用产品真实的 Root 包装与共享菜单，账号、平台及独立奖励动作由测试提供。
function Scene() {
  return (
    <RewardsProvider desktop={false}>
      <Menu />
    </RewardsProvider>
  );
}

function Menu() {
  const openRewards = useOpenRewards();
  return (
    <div className="flex h-screen w-64 max-w-full flex-col justify-end bg-sidebar">
      <WorkspaceSidebarFooter
        theme={theme}
        localeMenuValue={locale}
        onLocaleChange={() => {}}
        onThemeChange={() => {}}
        onLogin={guest ? () => {} : undefined}
        onLogout={guest ? undefined : () => {}}
        isDesktop={params.get("mobile") !== "1"}
        user={guest ? null : { id: "42", username: "Alex", displayName: "Alex" }}
      />
      <button
        type="button"
        data-testid="independent-rewards-action"
        onClick={() => void openRewards?.()}
      >
        Open rewards independently
      </button>
    </div>
  );
}

const ProductScene = createAiscooAccountLoginRoot(Scene);
const platform = {
  openExternal: async () => {
    window.rewardsCalls += 1;
  },
} as RootProps["platform"];
declare global {
  interface Window {
    rewardsCalls: number;
  }
}
const app =
  params.get("product") === "1" ? (
    <ProductScene
      platform={platform}
      services={{ oauthService: {} } as RootProps["services"]}
      isDesktop={false}
    />
  ) : (
    <PlatformProvider platform={platform}>
      <Scene />
    </PlatformProvider>
  );
createRoot(document.getElementById("root")!).render(
  <ZCodeIntlProvider initialLocale={locale}>
    <TooltipProvider>{app}</TooltipProvider>
  </ZCodeIntlProvider>,
);
