// @vitest-environment jsdom
import { readFile } from "node:fs/promises";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { IBroadcastService } from "@zcode/services";
import { createZCodeStore } from "@/store/index.js";

let html: string;

beforeAll(async () => {
  html = await readFile("packages/desktop/src/renderer/index.html", "utf8");
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

function renderStartupShell(theme: string | null, systemDark: boolean, storageFails = false) {
  localStorage.clear();
  if (theme !== null) localStorage.setItem("zcode-theme", theme);
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn((query: string) => ({
      matches: query === "(prefers-color-scheme: dark)" && systemDark,
      media: query,
    })),
  });
  if (storageFails) {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage unavailable");
    });
  }
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.documentElement.className = "";
  document.head.innerHTML = parsed.head.innerHTML;
  document.body.innerHTML = parsed.body.innerHTML;
  const bootstrap = document.head.querySelector("script:not([type])");
  expect(bootstrap?.textContent).toBeTruthy();
  window.eval(bootstrap!.textContent!);
}

describe("desktop startup shell theme", () => {
  it.each([
    { saved: "zai-dark", systemDark: false, expected: "dark", zai: true },
    { saved: "zai-light", systemDark: true, expected: "light", zai: true },
    { saved: "dark", systemDark: false, expected: "dark", zai: true },
    { saved: "light", systemDark: true, expected: "light", zai: true },
    { saved: "system", systemDark: true, expected: "dark", zai: true },
    { saved: "system", systemDark: false, expected: "light", zai: true },
    { saved: null, systemDark: false, expected: "dark", zai: true },
    { saved: "", systemDark: false, expected: "dark", zai: true },
    { saved: "unknown", systemDark: true, expected: "light", zai: false },
  ])(
    "uses $expected for saved=$saved and systemDark=$systemDark before React loads",
    ({ saved, systemDark, expected, zai }) => {
      renderStartupShell(saved, systemDark);
      expect(document.documentElement.classList.contains("dark")).toBe(expected === "dark");
      expect(document.documentElement.classList.contains("theme-zai-dark")).toBe(
        zai && expected === "dark",
      );
      expect(document.documentElement.classList.contains("theme-zai-light")).toBe(
        zai && expected === "light",
      );
      const activeLogo = document.querySelector<HTMLImageElement>(
        `img[data-startup-asset="startup-${expected}"]`,
      );
      const inactiveLogo = document.querySelector<HTMLImageElement>(
        `img[data-startup-asset="startup-${expected === "dark" ? "light" : "dark"}"]`,
      );
      expect(activeLogo).not.toBeNull();
      expect(inactiveLogo).not.toBeNull();
      expect(getComputedStyle(activeLogo!).display).not.toBe("none");
      expect(getComputedStyle(inactiveLogo!).display).toBe("none");
      const styles = Array.from(document.styleSheets[0].cssRules) as CSSStyleRule[];
      const selector = expected === "dark" ? "html.dark #loading" : "#loading";
      const background = styles.find((rule) => rule.selectorText === selector)?.style.background;
      expect(background).toBe(
        expected === "dark"
          ? "var(--color-background, #161616)"
          : "var(--color-background, #f8f8f8)",
      );
      expect(localStorage.getItem("zcode-theme")).toBe(saved);
    },
  );

  it("falls back to dark for the shell when theme storage cannot be read", () => {
    renderStartupShell(null, false, true);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.classList.contains("theme-zai-dark")).toBe(true);
  });

  it("keeps an unknown preference consistent through the real store handover", () => {
    renderStartupShell("unknown", true);
    const shellClasses = document.documentElement.className;
    const service: IBroadcastService = {
      send: vi.fn(async () => {}),
      acquireClaim: async () => ({ status: "unavailable" }),
      commitClaim: async () => {},
      releaseClaim: async () => {},
      tryClaim: async () => false,
      onMessage: () => ({ dispose: () => {} }),
    };
    const store = createZCodeStore(service);
    expect(store.getState().theme).toBe("unknown");
    expect(document.documentElement.className).toBe(shellClasses);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.classList.contains("theme-zai-light")).toBe(false);
    expect(document.documentElement.classList.contains("theme-zai-dark")).toBe(false);
    expect(localStorage.getItem("zcode-theme")).toBe("unknown");
  });

  it("loads all four desktop brand assets through Vite's module graph", () => {
    const modules = Array.from(
      new DOMParser()
        .parseFromString(html, "text/html")
        .querySelectorAll("script[type=module]:not([src])"),
      (script) => script.textContent ?? "",
    );
    const module = modules.find((script) => script.includes("startup-light.svg?url"));
    expect(module).toBeTruthy();
    // 资源加载失败时不得阻断启动壳的完成逻辑。
    expect(modules.find((script) => script.includes("tryFinishStartupAnimation"))).not.toBe(module);
    for (const name of ["startup-light", "startup-dark", "mark-light", "mark-dark"]) {
      expect(module).toContain(`../../../ui/src/aiscoo/brand/assets/${name}.svg?url`);
      expect(html).toContain(`data-startup-asset="${name}"`);
    }
  });
});
