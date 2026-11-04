// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { createElement, type ComponentProps, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthProviderMeta } from "@zcode/shared";
import { GeneralSectionContent } from "@/settingsPageHelpers.js";
import { LoginPanel } from "@/WelcomeScreen.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { AiscooLegalLinks, AiscooLegalSettings } from "./index.js";

const mocks = vi.hoisted(() => ({
  getProviders: vi.fn<() => Promise<OAuthProviderMeta[]>>(),
  getActiveProvider: vi.fn(async () => null),
  startOAuth: vi.fn(),
  startOAuthWithPolling: vi.fn(),
  openExternal: vi.fn(),
  registerOAuthState: vi.fn(),
  setOAuthPollingActive: vi.fn(),
}));

vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({
    openExternal: mocks.openExternal,
    registerOAuthState: mocks.registerOAuthState,
  }),
}));
vi.mock("@/store/StoreProvider.js", () => ({
  useZCodeStore: (selector: (state: unknown) => unknown) =>
    selector({
      user: null,
      oauthError: null,
      oauthSuccessSeq: 0,
      lastOAuthSuccessProvider: null,
      loginEntryRequest: null,
      setOAuthError: () => {},
      clearLoginEntryRequest: () => {},
      markLoginEntryAttemptStatus: () => {},
      setOAuthPollingActive: mocks.setOAuthPollingActive,
    }),
}));
vi.mock("@/logger.js", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/settings/ProactiveSuggestionsSetting.js", () => ({
  ProactiveSuggestionsSetting: () => null,
}));
vi.mock("@/settings/DynamicWorkflowModeSetting.js", () => ({
  DynamicWorkflowModeSetting: () => null,
}));

const origin = "http://127.0.0.1:3001";
const legalLinks = {
  userAgreementUrl: `${origin}/user-agreement`,
  privacyPolicyUrl: `${origin}/privacy-policy`,
};
const native: OAuthProviderMeta = {
  id: "new-api",
  displayName: "Aiscoo",
  enabled: true,
  order: 0,
  legalLinks,
};
const services = { oauthService: mocks } as unknown as ComponentProps<
  typeof ServiceProvider
>["services"];
const save = async () => {};
const generalProps: ComponentProps<typeof GeneralSectionContent> = {
  isDesktop: true,
  localePreference: "system",
  notificationEnabled: true,
  notificationSoundEnabled: true,
  closeToTrayOnWindows: false,
  receivePreviewUpdates: false,
  autoDownloadAndInstallUpdates: false,
  dataBaseDir: "",
  terminalInheritSystemProfile: true,
  terminalFontFamily: "",
  nativeSearchEnhancementsEnabled: true,
  defaultHomeDir: "",
  setLocalePreference: () => {},
  setNotificationEnabled: () => {},
  setNotificationSoundEnabled: () => {},
  messageStreamShowReasoning: true,
  messageStreamShowTodos: true,
  toolGroupingExploreEnabled: true,
  toolGroupingTerminalEnabled: true,
  toolGroupingChangesEnabled: true,
  zcodeInteractionBehavior: "queue",
  onDataBaseDirChange: save,
  onSelectDataBaseDir: async () => null,
  onTerminalInheritSystemProfileChange: save,
  onTerminalFontFamilyChange: save,
  onNativeSearchEnhancementsEnabledChange: save,
  onToolSearchModeChange: save,
  onCloseToTrayOnWindowsChange: save,
  onReceivePreviewUpdatesChange: save,
  onAutoDownloadAndInstallUpdatesChange: save,
  onMessageStreamShowReasoningChange: save,
  onMessageStreamShowTodosChange: save,
  onToolGroupingExploreEnabledChange: save,
  onToolGroupingTerminalEnabledChange: save,
  onToolGroupingChangesEnabledChange: save,
  onZCodeInteractionBehaviorChange: save,
  onOpenOnboardingDialog: () => {},
};

function mount(children: ReactNode, locale: "zh-CN" | "en-US" = "zh-CN") {
  return render(
    createElement(ServiceProvider, {
      services,
      children: createElement(ZCodeIntlProvider, { initialLocale: locale, children }),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getProviders.mockResolvedValue([native]);
  mocks.getActiveProvider.mockResolvedValue(null);
});
afterEach(cleanup);

describe("Aiscoo public legal links", () => {
  it.each(["zh-CN", "en-US"] as const)(
    "opens exact public URLs while signed out in %s without starting authorization",
    async (locale) => {
      mount(
        createElement(LoginPanel, {
          active: true,
          onComplete: vi.fn(),
          footer: (providers) => createElement(AiscooLegalLinks, { providers, placement: "login" }),
        }),
        locale,
      );
      const agreement = await screen.findByRole("link", {
        name: locale === "zh-CN" ? "用户协议" : "User Agreement",
      });
      const privacy = screen.getByRole("link", {
        name: locale === "zh-CN" ? "隐私政策" : "Privacy Policy",
      });
      expect(screen.getByText("杭州艾思酷国际贸易有限公司")).toBeTruthy();
      expect(screen.queryByRole("checkbox")).toBeNull();
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(agreement.getAttribute("href")).toBe(legalLinks.userAgreementUrl);
      expect(privacy.getAttribute("href")).toBe(legalLinks.privacyPolicyUrl);
      const login = screen.getByTestId("oauth-login-button-new-api");
      expect(
        login.compareDocumentPosition(agreement) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      fireEvent.click(agreement);
      fireEvent.click(privacy);
      expect(mocks.openExternal.mock.calls).toEqual([
        [legalLinks.userAgreementUrl],
        [legalLinks.privacyPolicyUrl],
      ]);
      expect(mocks.startOAuth).not.toHaveBeenCalled();
      expect(mocks.startOAuthWithPolling).not.toHaveBeenCalled();
      expect(mocks.registerOAuthState).not.toHaveBeenCalled();
      expect(mocks.setOAuthPollingActive).not.toHaveBeenCalled();
    },
  );

  it("keeps legal information at the bottom of desktop General settings without requiring a user", async () => {
    mount(
      createElement(GeneralSectionContent, {
        ...generalProps,
        footer: createElement(AiscooLegalSettings),
      }),
    );
    const region = await screen.findByRole("region", { name: "法律信息" });
    expect(region.parentElement?.lastElementChild).toBe(region);
    expect(within(region).getByText("杭州艾思酷国际贸易有限公司")).toBeTruthy();
    fireEvent.click(within(region).getByRole("link", { name: "隐私政策" }));
    expect(mocks.openExternal).toHaveBeenCalledWith(legalLinks.privacyPolicyUrl);
    expect(mocks.startOAuth).not.toHaveBeenCalled();
  });

  it("leaves the default login and General UI unchanged when no extension is supplied", async () => {
    mount(createElement(LoginPanel, { active: true, onComplete: vi.fn() }));
    await screen.findByTestId("oauth-login-button-new-api");
    expect(screen.queryByRole("link", { name: "用户协议" })).toBeNull();
    cleanup();
    mocks.getProviders.mockClear();
    mount(createElement(GeneralSectionContent, { ...generalProps, isDesktop: false }));
    expect(screen.queryByRole("region", { name: "法律信息" })).toBeNull();
    expect(mocks.getProviders).not.toHaveBeenCalled();
  });

  it("reads desktop legal information from the base host even in a remote workspace", async () => {
    const remoteGetProviders = vi.fn(async () => [{ ...native, legalLinks: undefined }]);
    const remoteServices = {
      oauthService: { ...mocks, getProviders: remoteGetProviders },
    } as unknown as typeof services;
    useRemoteWorkspaceSessionStore.getState().registerBaseServices(services);
    try {
      render(
        createElement(ServiceProvider, {
          services: remoteServices,
          children: createElement(ZCodeIntlProvider, {
            initialLocale: "zh-CN",
            children: createElement(AiscooLegalSettings),
          }),
        }),
      );
      expect(await screen.findByRole("link", { name: "用户协议" })).toBeTruthy();
      expect(mocks.getProviders).toHaveBeenCalled();
      expect(remoteGetProviders).not.toHaveBeenCalled();
    } finally {
      useRemoteWorkspaceSessionStore.setState({ baseServices: null });
    }
  });

  it.each([
    { providers: [] },
    { providers: [{ id: "zai", displayName: "Z.ai", enabled: true, order: 0, legalLinks }] },
    { providers: [{ ...native, legalLinks: undefined }] },
    { providers: [{ ...native, enabled: false }] },
  ])("renders no fallback links for absent or disabled private metadata %#", ({ providers }) => {
    mount(createElement(AiscooLegalLinks, { providers, placement: "login" }));
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it.each([
    { ...legalLinks, privacyPolicyUrl: "https://other.example/privacy-policy" },
    { ...legalLinks, userAgreementUrl: `${origin}/user-agreement?state=private-flow` },
    { ...legalLinks, privacyPolicyUrl: `${origin}/privacy-policy?handoff=private-code` },
    { ...legalLinks, privacyPolicyUrl: `${origin}/privacy-policy?token=private-token` },
    { ...legalLinks, privacyPolicyUrl: `${origin}/privacy-policy#token=private-token` },
    { ...legalLinks, privacyPolicyUrl: `${origin}/api/xcode/v1/web-handoffs` },
    { ...legalLinks, userAgreementUrl: "javascript:alert(1)" },
    {
      userAgreementUrl: "http://public.example/user-agreement",
      privacyPolicyUrl: "http://public.example/privacy-policy",
    },
    {
      userAgreementUrl: "https://user:password@legal.example/user-agreement",
      privacyPolicyUrl: "https://user:password@legal.example/privacy-policy",
    },
    { ...legalLinks, privacyPolicyUrl: "" },
  ])("rejects unsafe or credential-bearing metadata %#", (links) => {
    mount(
      createElement(AiscooLegalLinks, {
        providers: [{ ...native, legalLinks: links }],
        placement: "settings",
      }),
    );
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it.each(["https://legal.example:8443", "http://[::1]:43001"])(
    "accepts a complete public page pair from %s",
    (configuredOrigin) => {
      mount(
        createElement(AiscooLegalLinks, {
          providers: [
            {
              ...native,
              legalLinks: {
                userAgreementUrl: `${configuredOrigin}/user-agreement`,
                privacyPolicyUrl: `${configuredOrigin}/privacy-policy`,
              },
            },
          ],
          placement: "login",
        }),
      );
      expect(screen.getAllByRole("link")).toHaveLength(2);
    },
  );

  it("removes stale legal information when the rendered provider is no longer configured", async () => {
    const view = mount(
      createElement(AiscooLegalLinks, { providers: [native], placement: "login" }),
    );
    expect(screen.getAllByRole("link")).toHaveLength(2);
    view.rerender(
      createElement(ServiceProvider, {
        services,
        children: createElement(ZCodeIntlProvider, {
          children: createElement(AiscooLegalLinks, { providers: [], placement: "login" }),
        }),
      }),
    );
    await waitFor(() => expect(screen.queryAllByRole("link")).toHaveLength(0));
  });
});
