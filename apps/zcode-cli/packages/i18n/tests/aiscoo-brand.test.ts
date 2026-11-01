import { describe, expect, it } from "vitest";
import { getZCodeCopy, PRODUCT_NAME } from "../src/index.js";
import { verifyCliBrandContract } from "../src/aiscoo-brand/contract.test.js";

describe("downstream CLI brand assembly", () => {
  it("projects only static templates before dynamic interpolation", () => {
    expect(verifyCliBrandContract).not.toThrow();
  });

  it("uses the shared product name while keeping CLI commands and provider attribution", () => {
    expect(PRODUCT_NAME).toBe("Aiscoo");
    for (const locale of ["en-US", "zh-CN"]) {
      const copy = getZCodeCopy(locale);
      expect(copy.cli.help("1.2.3")).toContain("Aiscoo 1.2.3");
      expect(copy.cli.help("1.2.3")).toContain("zcode [command] [options]");
      expect(copy.cli.help("1.2.3")).toContain("Z.AI");
    }
  });
});
