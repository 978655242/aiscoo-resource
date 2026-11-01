import { describe, expect, it } from "vitest";
import { resolveAiscooUpdateEndpointOrigin } from "../src/aiscoo-desktop-identity/index.js";

// 规则见 docs/aiscoo/specs/aiscoo-auto-update.md：Aiscoo 包只向自己的账号服务查询更新，
// 取不到合法 origin 时关闭更新，绝不回退官方 ZCode 更新源。
describe("Aiscoo in-app update endpoint", () => {
  it("uses the account service origin for an Aiscoo build", () => {
    expect(
      resolveAiscooUpdateEndpointOrigin({
        hasAiscooChannel: true,
        accountOrigin: "https://account.example.test:8443",
      }),
    ).toBe("https://account.example.test:8443");
  });

  it("keeps the upstream update source for builds without the Aiscoo channel", () => {
    expect(
      resolveAiscooUpdateEndpointOrigin({
        hasAiscooChannel: false,
        accountOrigin: "https://account.example.test",
      }),
    ).toBeUndefined();
  });

  it.each([undefined, "", "   "])(
    "an Aiscoo build without an account origin (%j) disables updates instead of using the official feed",
    (accountOrigin) => {
      expect(
        resolveAiscooUpdateEndpointOrigin({ hasAiscooChannel: true, accountOrigin }),
      ).toBeNull();
    },
  );

  it.each([
    "http://account.example.test",
    "https://account.example.test/api",
    "https://user:pass@account.example.test",
    "https://account.example.test?x=1",
    "not a url",
  ])("an Aiscoo build with an invalid account origin %j disables updates", (accountOrigin) => {
    expect(resolveAiscooUpdateEndpointOrigin({ hasAiscooChannel: true, accountOrigin })).toBeNull();
  });

  it("accepts a loopback HTTP origin for local development", () => {
    expect(
      resolveAiscooUpdateEndpointOrigin({
        hasAiscooChannel: true,
        accountOrigin: "http://127.0.0.1:3000",
      }),
    ).toBe("http://127.0.0.1:3000");
  });
});
