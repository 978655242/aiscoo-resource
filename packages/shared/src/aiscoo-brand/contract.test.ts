import { describe, expect, it } from "vitest";
import {
  PRODUCT_BRAND,
  PRODUCT_NAME,
  PRODUCT_WORDMARK,
  brandMessageCatalog,
  brandProductText,
} from "./contract.js";

describe("Aiscoo product branding contract", () => {
  it("exposes one package entrypoint backed by the same brand owner", async () => {
    const current = await import("@zcode/shared/aiscoo-brand");
    expect(current.PRODUCT_BRAND).toBe(PRODUCT_BRAND);
    expect(current.PRODUCT_BRAND.legalOperatorName).toBe("杭州艾思酷国际贸易有限公司");
    expect(current.brandProductText).toBe(brandProductText);
  });

  it("provides display variants without declaring a new storage identity", () => {
    expect(PRODUCT_NAME).toBe("Aiscoo");
    expect(PRODUCT_WORDMARK).toBe("aiscoo");
    expect(PRODUCT_BRAND.developmentName).toBe("Aiscoo Dev");
    expect(PRODUCT_BRAND.previewName).toBe("Aiscoo Preview");
    expect(PRODUCT_BRAND).not.toHaveProperty("appId");
    expect(PRODUCT_BRAND).not.toHaveProperty("userDataPath");
    expect(Object.isFrozen(PRODUCT_BRAND)).toBe(true);
  });

  it("projects only product-owned text while preserving technical references", () => {
    expect(
      brandProductText(
        "Open XWork or ZCode Preview. https://example.test/ZCode XCode `XWork CLI Zen` ~/Library/ZCode/state /tmp/ZCode/data C:\\Users\\ZCode\\data zcode://open @zcode/shared ZCODE_DATA_DIR",
      ),
    ).toBe(
      "Open Aiscoo or Aiscoo Preview. https://example.test/ZCode Aiscoo `XWork CLI Zen` ~/Library/ZCode/state /tmp/ZCode/data C:\\Users\\ZCode\\data zcode://open @zcode/shared ZCODE_DATA_DIR",
    );
  });

  it("keeps translation keys and interpolation values out of branding", () => {
    const source = { "XWork.welcome": "Welcome to XWork, {name}", provider: "ZAI / BigModel" };
    const messages = brandMessageCatalog(source);
    expect(messages["XWork.welcome"].replace("{name}", "ZCode workspace")).toBe(
      "Welcome to Aiscoo, ZCode workspace",
    );
    expect(messages.provider).toBe("ZAI / BigModel");
    expect(source["XWork.welcome"]).toBe("Welcome to XWork, {name}");
    expect(brandProductText(messages["XWork.welcome"])).toBe(messages["XWork.welcome"]);
  });
});
