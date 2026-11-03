import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";
import {
  addPendingSettingsSectionListener,
  consumePendingSettingsModelProviderTarget,
  setPendingSettingsSectionIntent,
} from "@/lib/settingsNavigation.js";
import * as currentBrand from "@zcode/ui/aiscoo-brand";
import * as implementationBrand from "../src/aiscoo/brand/index.js";
import * as currentSharedBrand from "@zcode/shared/aiscoo-brand";
import * as currentStartup from "@zcode/ui/aiscoo-startup-context";
import * as currentPluginView from "../src/aiscoo/plugin-guides/index.js";
import * as currentGuides from "@zcode/shared/aiscoo-plugin-guides";
import { IPluginGuideService as currentService } from "@zcode/services/aiscoo-plugin-guides";
import { zcodeProtocolMethods, zcodeProtocolNotifications } from "@zcode/shared";
import type { ProductBrand } from "@zcode/shared/aiscoo-brand";

const requireFromUi = createRequire(new URL("../package.json", import.meta.url));

// 老消费者可以继续构造不包含新法律字段的完整类型。
const oldBrand: ProductBrand = {
  productName: "Aiscoo",
  wordmark: "aiscoo",
  developmentName: "Aiscoo Dev",
  previewName: "Aiscoo Preview",
  desktopName: "Aiscoo Desktop App",
  sourceDirectory: "docs/brand/aiscoo",
  desktopIcon: { theme: "dark", markScale: 1 },
  palette: {
    lightForeground: "#000",
    lightBackground: "#fff",
    darkForeground: "#fff",
    darkBackground: "#000",
  },
};

describe("Aiscoo naming compatibility", () => {
  it("keeps stored and live model settings navigation canonical without guessing custom IDs", () => {
    const records = new Map<string, string>();
    const events = new EventTarget();
    vi.stubGlobal("window", {
      sessionStorage: {
        getItem: (key: string) => records.get(key) ?? null,
        setItem: (key: string, value: string) => records.set(key, value),
        removeItem: (key: string) => records.delete(key),
      },
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      dispatchEvent: events.dispatchEvent.bind(events),
    });
    const received: string[] = [];
    let dispose = () => {};
    try {
      for (const api of ["anthropic-messages", "openai-chat-completions", "openai-responses"]) {
        const legacyId = `account:new-api-${api}`;
        const canonicalId = `account:aiscoo-${api}`;
        setPendingSettingsSectionIntent("modelProvider", { modelProviderId: legacyId });
        expect(records.get("zcode-settings-model-provider-id-intent")).toBe(canonicalId);
        expect(consumePendingSettingsModelProviderTarget()).toEqual({ providerId: canonicalId });
        records.set("zcode-settings-model-provider-id-intent", legacyId);
        expect(consumePendingSettingsModelProviderTarget()).toEqual({ providerId: canonicalId });
        expect(consumePendingSettingsModelProviderTarget()).toBeUndefined();
        dispose = addPendingSettingsSectionListener((_section, detail) => {
          if (detail?.modelProviderId) received.push(detail.modelProviderId);
        });
        setPendingSettingsSectionIntent("modelProvider", { modelProviderId: legacyId });
        expect(received.at(-1)).toBe(canonicalId);
        expect(consumePendingSettingsModelProviderTarget()).toBeUndefined();
        dispose();
      }
      const customId = "account:new-api-openai-chat-completions-custom";
      setPendingSettingsSectionIntent("modelProvider", { modelProviderId: customId });
      expect(consumePendingSettingsModelProviderTarget()).toEqual({ providerId: customId });
    } finally {
      dispose();
      vi.unstubAllGlobals();
    }
  });

  it("publishes one Aiscoo entry per package and no retired xwork subpath", async () => {
    const manifests = {
      "@zcode/shared": "../../shared/package.json",
      "@zcode/ui": "../package.json",
      "@zcode/services": "../../services/package.json",
    } as const;
    const expected = {
      "@zcode/shared": {
        "./aiscoo-brand": "./src/aiscoo-brand/runtime.js",
        "./aiscoo-plugin-guides": "./src/aiscoo-plugin-guides/index.ts",
      },
      "@zcode/ui": {
        "./aiscoo-brand": "./src/aiscoo/brand/index.ts",
        "./aiscoo-account-avatar": "./src/aiscoo/account-avatar/index.ts",
        "./aiscoo-startup-context": "./src/aiscoo/startup-context/index.ts",
      },
      "@zcode/services": { "./aiscoo-plugin-guides": "./src/aiscoo-plugin-guides/index.ts" },
    } as const;
    for (const [packageName, file] of Object.entries(manifests)) {
      const pkg = JSON.parse(await readFile(new URL(file, import.meta.url), "utf8")) as {
        exports: Record<string, string>;
      };
      expect(Object.keys(pkg.exports).filter((key) => key.startsWith("./xwork"))).toEqual([]);
      for (const [subpath, target] of Object.entries(
        expected[packageName as keyof typeof expected],
      )) {
        expect(pkg.exports[subpath]).toBe(target);
        expect(requireFromUi.resolve(`${packageName}/${subpath.slice(2)}`)).toBeTruthy();
      }
    }
    for (const retired of [
      "@zcode/shared/xwork-brand",
      "@zcode/shared/xwork-plugin-guides",
      "@zcode/ui/xwork-brand",
      "@zcode/ui/xwork-startup-context",
      "@zcode/ui/xwork-account-avatar",
      "@zcode/services/xwork-plugin-guides",
    ]) {
      expect(() => requireFromUi.resolve(retired), retired).toThrow();
    }
  });

  it("keeps one brand implementation and the optional-legal-field type", () => {
    expect(currentBrand.AiscooMark).toBe(implementationBrand.AiscooMark);
    expect(currentBrand.AiscooIntlProvider).toBe(implementationBrand.AiscooIntlProvider);
    expect(currentSharedBrand.PRODUCT_BRAND.productName).toBe("Aiscoo");
    expect(oldBrand.productName).toBe("Aiscoo");
  });

  it("keeps guide schema, service channel and startup entry on the Aiscoo names", () => {
    expect(currentGuides.pluginGuideTargetSchema).toBeDefined();
    expect(typeof currentStartup.createAiscooRoot).toBe("function");
    expect(typeof currentStartup.restoreDraftContext).toBe("function");
    expect(currentPluginView.AiscooPluginStoreDetailView).toBeDefined();
    // 持久化的 RPC 通道名不属于兼容残留，改名会让已安装的 Host 与 Renderer 失联。
    expect(currentService.channelName).toBe("xwork-plugin-guides");
  });

  it("keeps old and new protocol names on the same wire methods", () => {
    expect(zcodeProtocolMethods.xworkPluginGuideSource).toBe("xwork/plugins/guideSource");
    expect(zcodeProtocolMethods.aiscooPluginGuideSource).toBe(
      zcodeProtocolMethods.xworkPluginGuideSource,
    );
    expect(zcodeProtocolMethods.xworkWorkspaceStreamText).toBe("xwork/workspace/streamText");
    expect(zcodeProtocolMethods.aiscooWorkspaceStreamText).toBe(
      zcodeProtocolMethods.xworkWorkspaceStreamText,
    );
    expect(zcodeProtocolNotifications.xworkWorkspaceTextDelta).toBe("xwork/workspace/textDelta");
    expect(zcodeProtocolNotifications.aiscooWorkspaceTextDelta).toBe(
      zcodeProtocolNotifications.xworkWorkspaceTextDelta,
    );
  });
});
