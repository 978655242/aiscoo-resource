import { describe, expect, it } from "vitest";
import * as current from "@zcode/ui/aiscoo-brand";
import * as implementation from "../src/aiscoo/brand/index.js";

describe("Aiscoo brand entrypoint", () => {
  it("publishes the brand implementation through the one package entrypoint", () => {
    expect(current.AiscooIntlProvider).toBe(implementation.AiscooIntlProvider);
    expect(current.AiscooAppLogo).toBe(implementation.AiscooAppLogo);
  });
});
