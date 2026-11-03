import { describe, expect, it } from "vitest";
import type { AiscooAdminOwner } from "@zcode/shared";
import { restoreZen } from "./contract.example.js";
import type { ZenAccountContract } from "./contract.js";

// 契约测试只 import contract 与 example，不依赖具体实现；由 tests/zen-contract.test.ts 纳入 CLI 测试入口。
describe("cli-zen-account contract", () => {
  const owner: AiscooAdminOwner = { origin: "https://zen.example.com", userId: "1", sid: "s", authGeneration: 1 };
  const account = (restored: boolean): ZenAccountContract => ({
    getOwner: () => (restored ? owner : null),
    restore: async () =>
      restored ? { providerId: "zen", user: { id: "1", username: "u", display_name: "U", avatar_url: null } } : null,
    login: async () => {
      throw new Error("unused");
    },
    logout: async () => ({ localCleared: true, serverRevoked: true }),
    withControlSession: async () => {
      throw new Error("unused");
    },
    getRelayCredential: async () => ({ token: "sk", expiresAt: 0 }),
    onDidChange: () => () => {},
    dispose: () => {},
  });
  it("exposes the owner only after a successful restore", async () => {
    expect(await restoreZen(account(true))).toEqual(owner);
    expect(await restoreZen(account(false))).toBeNull();
  });
});
