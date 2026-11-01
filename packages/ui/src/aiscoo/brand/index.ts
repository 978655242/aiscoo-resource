import { createElement, type ReactElement } from "react";
import { useDraftComposerCentering } from "./useDraftComposerCentering.js";
import "./brand.css";
import { NEW_API_PROVIDER_ID } from "@zcode/shared";
import { brandMessageCatalog, PRODUCT_NAME, PRODUCT_WORDMARK } from "@zcode/shared/aiscoo-brand";
import { useZCodeIntl, ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import type {
  AiscooBrandProps,
  AiscooAnimatedWordmarkProps,
  AiscooStartupBadgeProps,
  AiscooStartupLogoProps,
} from "./contract.js";
import markLightUrl from "./assets/mark-light.svg";
import markDarkUrl from "./assets/mark-dark.svg";
import wordmarkLightUrl from "./assets/wordmark-light.svg";
import wordmarkDarkUrl from "./assets/wordmark-dark.svg";
import wordmarkAnimatedLightUrl from "./assets/wordmark-animated-light.svg";
import wordmarkAnimatedDarkUrl from "./assets/wordmark-animated-dark.svg";
import appLightUrl from "./assets/app-light.svg";
import appDarkUrl from "./assets/app-dark.svg";
import startupLightUrl from "./assets/startup-light.svg";
import startupDarkUrl from "./assets/startup-dark.svg";
import markLightSvg from "./assets/mark-light.svg?raw";
import markDarkSvg from "./assets/mark-dark.svg?raw";

export type * from "./contract.js";

export const AISCOO_ASSET_URLS = {
  mark: { light: markLightUrl, dark: markDarkUrl },
  wordmark: { light: wordmarkLightUrl, dark: wordmarkDarkUrl },
  wordmarkAnimated: { light: wordmarkAnimatedLightUrl, dark: wordmarkAnimatedDarkUrl },
  app: { light: appLightUrl, dark: appDarkUrl },
  startup: { light: startupLightUrl, dark: startupDarkUrl },
} as const;

type BrandAsset = keyof typeof AISCOO_ASSET_URLS;
const ASSET_SIZES: Record<BrandAsset, readonly [number, number]> = {
  mark: [172, 172],
  wordmark: [581.15, 200],
  wordmarkAnimated: [615.58, 200],
  app: [1024, 1024],
  startup: [172, 172],
};

function assetImages(asset: BrandAsset, tone: AiscooBrandProps["tone"]): ReactElement[] {
  const [width, height] = ASSET_SIZES[asset];
  return (tone === "light" || tone === "dark" ? [tone] : (["light", "dark"] as const)).map(
    (theme) =>
      createElement("image", {
        key: theme,
        href: AISCOO_ASSET_URLS[asset][theme],
        width,
        height,
        preserveAspectRatio: "xMidYMid meet",
        className:
          tone === "theme" || tone === undefined
            ? theme === "light"
              ? "aiscoo-brand-tone-light"
              : "aiscoo-brand-tone-dark"
            : undefined,
      }),
  );
}

function BrandGraphic({
  asset,
  className,
  tone = "theme",
  children,
  ...attributes
}: AiscooBrandProps & {
  asset: BrandAsset;
  children?: ReactElement;
  "data-aiscoo-brand"?: string;
  "data-v4-draft-logo"?: string;
}): ReactElement {
  const [width, height] = ASSET_SIZES[asset];
  return createElement(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
      className: ["shrink-0 select-none", className].filter(Boolean).join(" "),
      "aria-hidden": true,
      focusable: false,
      "data-aiscoo-brand": asset,
      ...attributes,
    },
    children,
    ...assetImages(asset, tone),
  );
}

export function AiscooMark(props: AiscooBrandProps): ReactElement {
  return createElement(BrandGraphic, { ...props, asset: "mark" });
}

export function AiscooWordmark(props: AiscooBrandProps): ReactElement {
  return createElement(BrandGraphic, { ...props, asset: "wordmark" });
}

/** 保留旧入口测试钩子，图形来自独立应用资源，供应商 ZAI 标志不再充当产品图标。 */
export function AiscooAppLogo({ className, tone = "theme" }: AiscooBrandProps): ReactElement {
  return createElement(
    "span",
    {
      className: ["inline-flex shrink-0 items-center justify-center", className]
        .filter(Boolean)
        .join(" "),
      "aria-hidden": true,
      "data-aiscoo-brand": "app",
    },
    ...(tone === "theme" ? (["light", "dark"] as const) : [tone]).map((theme) =>
      createElement("img", {
        key: theme,
        src: AISCOO_ASSET_URLS.app[theme],
        alt: "",
        "aria-hidden": true,
        draggable: false,
        "data-app-logo": "zcode",
        className: [
          "size-full select-none object-contain",
          tone === "theme"
            ? theme === "light"
              ? "aiscoo-brand-tone-light"
              : "aiscoo-brand-tone-dark"
            : "",
        ]
          .filter(Boolean)
          .join(" "),
      }),
    ),
  );
}

/** 动画与静态稿分别显示；系统减少动态效果时 SVG 动画层不参与绘制。 */
export function AiscooStartupLogo({
  className,
  tone = "theme",
  animated = true,
}: AiscooStartupLogoProps): ReactElement {
  if (!animated) return createElement(AiscooMark, { className, tone });
  return createElement(
    "svg",
    {
      xmlns: "http://www.w3.org/2000/svg",
      width: 172,
      height: 172,
      viewBox: "0 0 172 172",
      className: ["shrink-0 select-none", className].filter(Boolean).join(" "),
      "aria-hidden": true,
      focusable: false,
      "data-aiscoo-brand": "startup",
    },
    // 静默启动要求页面无文本节点；复用样式类切换动效，避免内嵌 CSS 进入文本内容。
    createElement(
      "g",
      { className: "motion-reduce:hidden" },
      createElement("animate", {
        attributeName: "opacity",
        begin: "3s",
        dur: "1.8s",
        repeatCount: "indefinite",
        values: "1;0.85;1",
      }),
      ...assetImages("startup", tone),
    ),
    createElement("g", { className: "hidden motion-reduce:block" }, ...assetImages("mark", tone)),
  );
}

export function AiscooStartupLogoBadge({
  animated = true,
  size = "default",
}: AiscooStartupBadgeProps): ReactElement {
  return createElement(
    "div",
    {
      "data-desktop-logo-badge": size === "titlebar" ? "true" : undefined,
      className: `relative flex shrink-0 items-center justify-center ${size === "titlebar" ? "size-5" : "size-24"}`,
    },
    createElement(AiscooStartupLogo, { className: "size-full", animated }),
  );
}

export function AiscooAnimatedWordmark({
  className,
  tone = "theme",
  animated = true,
}: AiscooAnimatedWordmarkProps): ReactElement {
  if (!animated) return createElement(AiscooWordmark, { className, tone });
  return createElement(
    "span",
    { className: ["inline-flex shrink-0 select-none", className].filter(Boolean).join(" ") },
    createElement(BrandGraphic, {
      asset: "wordmarkAnimated",
      tone,
      "data-aiscoo-brand": "wordmark-animated",
      className: "h-auto w-full motion-reduce:hidden",
    }),
    createElement(AiscooWordmark, {
      tone,
      className: "hidden h-auto w-full motion-reduce:block",
    }),
  );
}

export function AiscooLoginHeader(): ReactElement {
  const { intl } = useZCodeIntl();
  return createElement(
    "header",
    { className: "flex flex-col items-center gap-3 text-center" },
    createElement(
      "div",
      {
        className: "mb-1 flex w-full items-center justify-center",
        "aria-label": PRODUCT_NAME,
        role: "img",
      },
      createElement(AiscooAnimatedWordmark, { className: "h-auto w-60 max-w-full" }),
    ),
    createElement(
      "p",
      { className: "text-ui-base/relaxed text-foreground-subtle" },
      intl.formatMessage({ id: "login.description" }),
    ),
  );
}

export function AiscooEmptyStateLogo(props: AiscooAnimatedWordmarkProps): ReactElement {
  const ref = useDraftComposerCentering();
  return createElement(
    "span",
    { ref, "data-aiscoo-brand": "empty-state", className: "flex w-full justify-center" },
    createElement(AiscooAnimatedWordmark, props),
  );
}

/** 自有导出 SVG 必须内嵌原稿：canvas 解码时不会依赖外部图片或网络。 */
export function aiscooMarkSvgDataUri(tone: "light" | "dark"): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(tone === "dark" ? markDarkSvg : markLightSvg)}`;
}

function aiscooMessageCatalog(messages: Record<string, string>): Record<string, string> {
  const catalog = brandMessageCatalog(messages);
  if (messages["login.description"] === "连接账号，开始使用 XWork") {
    catalog["login.description"] = "连接账号，开始使用";
  }
  // 产品主登录按钮不展示后端名称；其他供应商模板与身份保持不变。
  if (messages["login.oauth.button.native"] === "登录 New API") {
    catalog["login.oauth.button.native"] = "登录";
  } else if (messages["login.oauth.button.native"] === "Sign in to New API") {
    catalog["login.oauth.button.native"] = "Sign in";
  }
  // 产品只有 Aiscoo 账号：服务包装过滤后没有可用渠道即表示账号服务未配置，
  // 在产品词典里替换通用“无提供方”文案，上游登录页不需要感知产品策略。
  const unavailable = messages["aiscoo.login.configUnavailable"];
  if (unavailable) catalog["login.oauth.noProviders"] = unavailable;
  // 缺模型时不应向用户暴露 New API 后端术语；只替换 Aiscoo 产品词典中的展示文案。
  const noNativeModel = messages["aiscoo.chat.error.noNativeModel"];
  if (noNativeModel) catalog["chat.error.noNativeModel"] = noNativeModel;
  return catalog;
}

/** OAuth 身份继续由原服务拥有；这里只提供等待提示的静态品牌投影。 */
export function resolveAiscooOAuthWaitingDisplayNames(): Readonly<Record<string, string>> {
  return { [NEW_API_PROVIDER_ID]: PRODUCT_WORDMARK };
}

/** 产品入口显式投影词典，原 Provider 仍拥有同一套语言偏好、广播与插值状态。 */
export function AiscooIntlProvider(
  props: import("./contract.js").AiscooIntlProviderProps,
): ReactElement {
  return createElement(ZCodeIntlProvider, { ...props, catalogTransform: aiscooMessageCatalog });
}

export { PRODUCT_NAME };
