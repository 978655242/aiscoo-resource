import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { AiscooIntlProvider as ZCodeIntlProvider } from "@/aiscoo/brand/index.js";
import { ZCodeAboutLogo, ZCodeWordmarkLogo } from "@/components/ui/ZCodeAboutLogo.js";
import { WindowsTopLeftLogo } from "@/WindowsTopLeftLogo.js";
import { normalizeZCodeUiError } from "@/lib/zcodeUiError.js";
import { ConversationProjectionStore } from "@/v4/conversationProjectionStore.js";
import type { ConversationTransport } from "@/v4/transport.js";
import { copyHighspeedCardImage } from "@/highspeed/highspeedShare.js";
import { resolveSkillDisplayDescription } from "@/lib/builtinSkillI18n.js";
import { ConversationDraftEmptyState } from "@/v4/ConversationDraftEmptyState.js";
import { OccupationOnboardingVisual } from "@/onboarding/OccupationOnboardingVisual.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { StoreContext } from "@/store/StoreProvider.js";
import { createStore } from "zustand/vanilla";

function CatalogSample() {
  const { intl } = useZCodeIntl();
  return createElement(
    "p",
    null,
    intl.formatMessage({ id: "welcome.title" }),
    " | ",
    intl.formatMessage({ id: "archives.deleteTask" }, { title: "XWork ZCode ~/XWork" }),
    " | ",
    intl.formatMessage({ id: "globalNotice.highspeed.copySummary" }, { duration: "XWork" }),
    " | ",
    intl.formatMessage({ id: "login.oauth.button.zai" }),
    " | ",
    intl.formatMessage({ id: "login.oauth.button.bigmodel" }),
  );
}

describe("Aiscoo 下游品牌接线", () => {
  it.each(["zh-CN", "en-US"] as const)("%s 仅投影命中的自有内置技能模板", (locale) => {
    for (const name of ["control-browser", "web-gui-tester", "plugin-creator"]) {
      const text = resolveSkillDisplayDescription(
        {
          name,
          scope: "plugin",
          pluginName: name === "plugin-creator" ? name : "browser-use",
          path: "/plugins/builtin",
          description: "third party XWork ZCode",
        },
        locale,
      );
      expect(text).toContain("Aiscoo");
      expect(text).not.toContain("XWork");
    }
    const historical = resolveSkillDisplayDescription(
      {
        name: "restore-legacy-sessions",
        scope: "plugin",
        pluginName: "restore-legacy-sessions",
        path: "/plugins/builtin",
        description: "fallback",
      },
      locale,
    );
    expect(historical).toContain(locale === "zh-CN" ? "ACP 时代 ZCode" : "ACP-era ZCode");
    expect(historical).toContain(locale === "zh-CN" ? "新的 Aiscoo" : "new Aiscoo");
    const fallback = {
      name: "control-browser",
      scope: "user" as const,
      path: "/users/skills",
      description: "XWork ZCode third-party description",
    };
    expect(resolveSkillDisplayDescription(fallback, locale)).toBe(fallback.description);
    const unknown = {
      ...fallback,
      name: "external",
      scope: "plugin" as const,
      pluginName: "superpowers",
    };
    expect(resolveSkillDisplayDescription(unknown, locale)).toBe(unknown.description);
  });
  it.each(["zh-CN", "en-US"] as const)("%s 先投影自有词典再插入用户内容", (locale) => {
    const html = renderToStaticMarkup(
      createElement(ZCodeIntlProvider, {
        initialLocale: locale,
        children: createElement(CatalogSample),
      }),
    );
    expect(html).toContain("Welcome to Aiscoo");
    expect(html).toContain("XWork ZCode ~/XWork");
    expect(html).toContain("https://zcode.z.ai");
    expect(html).toContain(locale === "zh-CN" ? "下载 Aiscoo" : "Download Aiscoo");
    expect(html).toContain("Z.ai");
    expect(html).toContain("BigModel");
  });

  it.each([false, true])(
    "初始对话字标在问候语前独立占位（手机紧凑模式 %s）",
    (compactForRemoteControl) => {
      const html = renderToStaticMarkup(
        createElement(ZCodeIntlProvider, {
          initialLocale: "zh-CN",
          children: createElement(ConversationDraftEmptyState, {
            compactForRemoteControl,
          }),
        }),
      );
      expect(html).toContain('data-v4-draft-brand="true"');
      expect(html).toContain('data-aiscoo-brand="wordmark-animated"');
      expect(html.indexOf('data-v4-draft-brand="true"')).toBeLessThan(
        html.indexOf('data-v4-draft-greeting="true"'),
      );
      expect(html).not.toContain("absolute left-1/2 top-1/2");
      expect(html).not.toContain("opacity-[0.06]");
      expect(html).not.toContain("-translate-y-1/2");
    },
  );

  it("新版职业引导通过既有启动徽标展示 Aiscoo，迁移页无需恢复旧欢迎组件", () => {
    const html = renderToStaticMarkup(
      createElement(PlatformProvider, {
        platform: {} as never,
        children: createElement(ZCodeIntlProvider, {
          initialLocale: "en-US",
          // 此 SSR 回归只需已有主题投影；完整 StoreProvider 初始化会写浏览器 DOM。
          children: createElement(StoreContext.Provider, {
            value: createStore(() => ({ theme: "zai-light" })) as never,
            children: createElement(OccupationOnboardingVisual),
          }),
        }),
      }),
    );
    expect(html).toContain('data-aiscoo-brand="mark"');
    expect(html).not.toContain('data-aiscoo-brand="startup"');
    expect(html).toContain("Simple, Fast");
    expect(html).not.toContain("Welcome to ZCode");
  });

  it("旧组件入口集中使用 ai 和完整 aiscoo 字标，窗口可读品牌统一", () => {
    expect(renderToStaticMarkup(createElement(ZCodeAboutLogo))).toContain(
      'data-aiscoo-brand="mark"',
    );
    expect(renderToStaticMarkup(createElement(ZCodeWordmarkLogo))).toContain(
      'data-aiscoo-brand="wordmark"',
    );
    const windowLogo = renderToStaticMarkup(createElement(WindowsTopLeftLogo));
    expect(windowLogo).toContain('aria-label="Aiscoo"');
    expect(windowLogo).not.toContain("xcode-mark");
  });

  it("高速导出图内嵌原稿，无旧 Z 字形与品牌，标签插值不转换", async () => {
    let result: Blob | undefined;
    await copyHighspeedCardImage(
      {
        outputTokens: 120_000,
        durationMs: 600_000,
        regularTps: 20,
        highspeedTps: 100,
      },
      async (blob) => {
        result = blob;
      },
    );
    const svg = await result!.text();
    expect(svg).toContain("Aiscoo &amp; Coding Plan Exclusive Benefits");
    expect(svg).toContain('href="data:image/svg+xml;charset=utf-8,');
    expect(svg).not.toContain(">Z</text>");
    expect(svg).not.toContain("ZCode");
    const embedded = svg.match(/href="(data:image\/svg\+xml;charset=utf-8,[^"]+)"/u)?.[1];
    expect(decodeURIComponent(embedded!)).toContain('class="eyes"');
  });

  it.each(["Aiscoo", "XWork", "XCode", "ZCode"])("%s session 包装不会遮住真实错误", (brand) => {
    expect(
      normalizeZCodeUiError({
        message: `${brand} session failed`,
        data: { message: "Provider quota exceeded" },
      }).message,
    ).toBe("Provider quota exceeded");
  });

  it.each(
    ["Aiscoo", "XWork", "XCode", "ZCode"].flatMap((brand) => [
      `${brand} agent transport closed`,
      `${brand} Protocol client disposed`,
      `${brand} Protocol client is disposed`,
      `${brand} Agent runtime is not running`,
    ]),
  )("%s 保留同一条有界重订阅路径", async (message) => {
    vi.useFakeTimers();
    const subscribe = vi
      .fn()
      .mockRejectedValueOnce(new Error(message))
      .mockResolvedValue({
        ack: {
          subscriptionId: "sub-new",
          mode: "snapshot",
          logEpoch: "epoch-1",
        },
      });
    const transport = {
      subscribe,
      activate: vi.fn(),
      unsubscribe: vi.fn(async () => {}),
      onFrame: () => () => {},
      onAssemblyFault: () => () => {},
      onRuntimeRestart: () => () => {},
    } as unknown as ConversationTransport;
    const store = new ConversationProjectionStore("conversation/s1", transport);
    try {
      await store.connect();
      expect(store.getState().status).toBe("connecting");
      await vi.advanceTimersByTimeAsync(1_000);
      expect(subscribe).toHaveBeenCalledTimes(2);
      expect(store.getState().status).toBe("live");
      expect(store.getState().lastError).toBeNull();
    } finally {
      await store.close();
      vi.useRealTimers();
    }
  });
});
