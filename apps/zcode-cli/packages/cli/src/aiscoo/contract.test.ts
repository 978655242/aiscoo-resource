import { describe, expect, it } from "vitest";
import { loginThenRefresh } from "./contract.example.js";
import type { AiscooZenCommandDeps } from "./contract.js";

// 契约测试只 import contract 与 example，不依赖实现；由 tests/aiscoo-contract.test.ts 纳入 CLI 测试入口。
describe("cli-aiscoo contract", () => {
  it("passes cancellation through and refreshes models after login", async () => {
    const calls: string[] = [];
    const controller = new AbortController();
    const zen: AiscooZenCommandDeps = {
      loginZen: async (options) => {
        calls.push(options.signal === controller.signal ? "login:signal" : "login:no-signal");
        return { user: { display_name: "", username: "u" }, modelStatus: { available: true, reason: null } };
      },
      logoutZen: async () => ({ localCleared: true, serverRevoked: true }),
      refreshAccountModels: async () => {
        calls.push("refresh");
      },
    };
    expect(await loginThenRefresh(zen, controller.signal)).toEqual({ account: "u", ready: true });
    expect(calls).toEqual(["login:signal", "refresh"]);
  });
});
