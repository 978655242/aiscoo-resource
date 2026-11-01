import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type ViteDevServer } from "vite";

const webRoot = resolve(import.meta.dirname, "..");
const assetRoot = resolve(webRoot, "../ui/src/aiscoo/brand/assets");
const logos = [
  { variant: "motion", theme: "light", file: "wordmark-animated-light.svg" },
  { variant: "motion", theme: "dark", file: "wordmark-animated-dark.svg" },
  { variant: "still", theme: "light", file: "wordmark-light.svg" },
  { variant: "still", theme: "dark", file: "wordmark-dark.svg" },
] as const;

let server: ViteDevServer;
let httpServer: Server;
let origin: string;
let html: string;

beforeAll(async () => {
  server = await createServer({
    root: webRoot,
    configFile: resolve(webRoot, "vite.config.ts"),
    logLevel: "silent",
    server: { middlewareMode: true, hmr: false, watch: { ignored: ["**/*"] } },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  // Vite 的 listen(0) 会回退默认端口；使用独立 HTTP 容器让系统原子分配空闲端口。
  httpServer = createHttpServer(server.middlewares);
  await new Promise<void>((done) => httpServer.listen(0, "127.0.0.1", done));
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("Vite did not bind a TCP port");
  origin = `http://127.0.0.1:${address.port}`;
  const response = await fetch(`${origin}/`);
  expect(response.status).toBe(200);
  html = await response.text();
});

afterAll(async () => {
  await server?.close();
  if (httpServer?.listening) {
    await new Promise<void>((done, fail) =>
      httpServer.close((error) => (error ? fail(error) : done())),
    );
  }
});

describe("Web startup logo assets", () => {
  it("centers a responsive full-width wordmark without distorting its proportions", () => {
    const dom = new JSDOM(html, { url: origin });
    try {
      const { document } = dom.window;
      const shell = document.querySelector<HTMLElement>(".zcode-boot-loading__logo-shell");
      const image = document.querySelector<HTMLImageElement>(".zcode-boot-loading__logo");
      expect(shell).not.toBeNull();
      expect(image).not.toBeNull();
      expect(dom.window.getComputedStyle(shell!).width).toBe("320px");
      expect(dom.window.getComputedStyle(shell!).maxWidth).toBe("calc(100vw - 48px)");
      expect(dom.window.getComputedStyle(image!).width).toBe("100%");
      expect(dom.window.getComputedStyle(image!).height).toBe("auto");
      expect(dom.window.getComputedStyle(image!).objectFit).toBe("contain");
    } finally {
      dom.window.close();
    }
  });

  it.each(logos)(
    "inlines $file as the actual SVG in the initial HTML",
    async ({ variant, theme, file }) => {
      const images = Array.from(html.matchAll(/<img\b[^>]*>/g), ([tag]) => tag);
      const image = images.find(
        (tag) => tag.includes(`aiscoo-boot-${variant}`) && tag.includes(`aiscoo-boot-${theme}`),
      );
      expect(image).toBeDefined();
      const src = image?.match(/\bsrc="([^"]+)"/)?.[1];
      expect(src).toMatch(/^data:image\/svg\+xml;base64,/);

      // 直接读取首屏 HTML 中的 src，不依赖任何脚本或网络为图片补地址。
      const response = await fetch(src!);
      expect(response.headers.get("content-type")).toMatch(/^image\/svg\+xml(?:;|$)/i);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(
        await readFile(resolve(assetRoot, file)),
      );
    },
  );

  it.each([
    { saved: "zai-light", systemDark: true, expected: "light" },
    { saved: "zai-dark", systemDark: false, expected: "dark" },
    { saved: "system", systemDark: false, expected: "light" },
    { saved: "system", systemDark: true, expected: "dark" },
    { saved: null, systemDark: false, expected: "dark" },
  ])("保留应用主题 $saved 的首屏 Logo 与减少动态效果", ({ saved, systemDark, expected }) => {
    const dom = new JSDOM(html, { url: origin, runScripts: "outside-only" });
    try {
      const { document } = dom.window;
      if (saved !== null) dom.window.localStorage.setItem("zcode-theme", saved);
      Object.defineProperty(dom.window, "matchMedia", {
        value: () => ({ matches: systemDark }),
      });
      const themeBootstrap = document.head.querySelector("script:not([type])");
      expect(themeBootstrap?.textContent).toBeTruthy();
      dom.window.eval(themeBootstrap!.textContent!);
      expect(document.documentElement.getAttribute("data-zcode-bootstrap-theme")).toBe(expected);

      const images = [...document.querySelectorAll<HTMLImageElement>(".zcode-boot-loading img")];
      expect(images).toHaveLength(4);
      const visible = () =>
        images.filter((image) => dom.window.getComputedStyle(image).display !== "none");
      expect(visible().map((image) => image.className)).toEqual([
        expect.stringContaining(`aiscoo-boot-motion aiscoo-boot-${expected}`),
      ]);

      // JSDOM 不求值媒体查询；按减少动态效果实际启用的 CSS 规则计算最终可见图片。
      let reducedMotionRules = 0;
      for (const sheet of [...document.styleSheets]) {
        for (const rule of [...sheet.cssRules]) {
          if (
            rule instanceof dom.window.CSSMediaRule &&
            rule.conditionText.includes("prefers-reduced-motion: reduce")
          ) {
            for (const inner of [...rule.cssRules]) {
              sheet.insertRule(inner.cssText, sheet.cssRules.length);
              reducedMotionRules++;
            }
          }
        }
      }
      expect(reducedMotionRules).toBeGreaterThan(0);
      expect(visible().map((image) => image.className)).toEqual([
        expect.stringContaining(`aiscoo-boot-still aiscoo-boot-${expected}`),
      ]);
      expect(dom.window.localStorage.getItem("zcode-theme")).toBe(saved);
    } finally {
      dom.window.close();
    }
  });
});
