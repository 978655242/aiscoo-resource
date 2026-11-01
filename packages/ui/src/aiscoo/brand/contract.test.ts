import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AISCOO_ASSET_URLS,
  AiscooAppLogo,
  AiscooEmptyStateLogo,
  AiscooMark,
  AiscooStartupLogo,
  AiscooWordmark,
  aiscooMarkSvgDataUri,
} from "./index.js";
import { aiscooBrandComponents, aiscooBrandExample } from "./contract.example.js";

function render(element: Parameters<typeof renderToStaticMarkup>[0]) {
  return renderToStaticMarkup(element).replaceAll("&#x27;", "'");
}

describe("Aiscoo 品牌展示契约", () => {
  it("公开原稿 mark 与完整字标，主题图片互斥且保持透明画布比例", () => {
    const mark = render(createElement(AiscooMark, { className: "size-5" }));
    const wordmark = render(aiscooBrandExample());
    expect(mark).toContain('data-aiscoo-brand="mark"');
    expect(mark).toContain('viewBox="0 0 172 172"');
    expect(mark).toContain(AISCOO_ASSET_URLS.mark.light);
    expect(mark).toContain(AISCOO_ASSET_URLS.mark.dark);
    expect(mark).toContain("aiscoo-brand-tone-light");
    expect(mark).toContain("aiscoo-brand-tone-dark");
    expect(wordmark).toContain('data-aiscoo-brand="wordmark"');
    expect(wordmark).toContain('viewBox="0 0 581.15 200"');
    expect(wordmark).toContain('aria-hidden="true"');
    expect(aiscooBrandComponents).toEqual({ Mark: AiscooMark, Wordmark: AiscooWordmark });
  });

  it("固定深色容器只加载白色原稿，应用图标保留原有测试钩子", () => {
    const mark = render(createElement(AiscooMark, { tone: "dark" }));
    expect(mark).toContain(AISCOO_ASSET_URLS.mark.dark);
    expect(mark).not.toContain(AISCOO_ASSET_URLS.mark.light);
    const app = render(createElement(AiscooAppLogo, { className: "size-10" }));
    expect(app).toContain('data-app-logo="zcode"');
    expect(app).toContain(AISCOO_ASSET_URLS.app.light);
    expect(app).toContain(AISCOO_ASSET_URLS.app.dark);
    expect(app).not.toContain("provider-icons");
  });

  it("启动动画尊重减少动态效果，静态模式不加载动画资源", () => {
    const animated = render(createElement(AiscooStartupLogo));
    const still = render(createElement(AiscooStartupLogo, { animated: false }));
    expect(animated).toContain('class="motion-reduce:hidden"');
    expect(animated).toContain('class="hidden motion-reduce:block"');
    expect(animated).not.toContain("<style");
    expect(animated).toContain('attributeName="opacity"');
    expect(animated).toContain(AISCOO_ASSET_URLS.startup.dark);
    expect(still).not.toContain("<animate");
    expect(still).not.toContain(AISCOO_ASSET_URLS.startup.dark);
    expect(still).toContain(AISCOO_ASSET_URLS.mark.dark);
  });

  it("初始对话完整字标按主题使用原稿动效与静态回退，并保持清晰可读", () => {
    const hero = render(createElement(AiscooEmptyStateLogo));
    expect(hero).toContain('data-aiscoo-brand="empty-state"');
    expect(hero).toContain('data-aiscoo-brand="wordmark-animated"');
    expect(hero).toContain(AISCOO_ASSET_URLS.wordmarkAnimated.light);
    expect(hero).toContain(AISCOO_ASSET_URLS.wordmarkAnimated.dark);
    expect(hero).toContain('viewBox="0 0 615.58 200"');
    expect(hero).toContain("motion-reduce:hidden");
    expect(hero).toContain("motion-reduce:block");
    expect(hero).not.toContain("opacity-[0.");
    expect(hero).not.toContain('data-v4-draft-logo="dark"');
    const still = render(createElement(AiscooEmptyStateLogo, { animated: false }));
    expect(still).toContain(AISCOO_ASSET_URLS.wordmark.light);
    expect(still).not.toContain(AISCOO_ASSET_URLS.wordmarkAnimated.light);
  });

  it("导出图保留 ai 原稿眼睛，导出 SVG 自包含", () => {
    for (const tone of ["light", "dark"] as const) {
      const uri = aiscooMarkSvgDataUri(tone);
      expect(uri).toMatch(/^data:image\/svg\+xml;charset=utf-8,/u);
      const svg = decodeURIComponent(uri.split(",").slice(1).join(","));
      expect(svg).toContain('class="eyes"');
      expect(svg).toContain('class="eye"');
      expect(svg).not.toContain('<rect width="172"');
      expect(svg).not.toContain("docs/");
    }
  });
});
