// XCODE: Aiscoo 专属回归；上游 App 业务套件已退役，仅保留下游差异的断言。
import { describe, expect, it, vi } from "vitest";
import type { AiscooAdminOwner } from "@zcode/shared";
import { createPluginUiAccountBindings } from "./instanceAccounts.js";
const instance = {
  runtimeId: "agent",
  generation: 1,
  token: "one",
  appIdentity: "a".repeat(64),
};
const params = {
  workspacePath: "/w",
  sessionId: "s",
  pluginId: "p",
  serverName: "server",
  scopeId: "view",
  resourceUri: "ui://app",
  ownerWebContentsId: 1,
};
describe("Aiscoo plugin UI Native owner", () => {
  it.each([
    { userId: "bob", sid: "sid-b", authGeneration: 2 },
    { userId: "alice", sid: "sid-a-new", authGeneration: 2 },
  ])("fences Native owner changes to $userId/$sid", async (next) => {
    let account: AiscooAdminOwner = {
      origin: "http://127.0.0.1:3001",
      userId: "alice",
      sid: "sid-a",
      authGeneration: 1,
    };
    const gate = Promise.withResolvers<typeof instance>();
    const entered = Promise.withResolvers<void>();
    const currentInstance = { ...instance, token: "current" };
    const open = vi.fn<Parameters<typeof createPluginUiAccountBindings>[0]["open"]>(
      async () => currentInstance,
    );
    open.mockImplementationOnce(() => {
      entered.resolve();
      return gate.promise;
    });
    const close = vi.fn(async () => {});
    const owner = createPluginUiAccountBindings({
      readAccount: async () => account,
      open,
      close,
    });
    const stale = owner.open(params);
    const rejected = expect(stale).rejects.toThrow("account changed");
    await entered.promise;
    account = { ...account, ...next };
    owner.invalidate();
    expect(await owner.open(params)).toEqual(currentInstance);
    expect(open.mock.calls[1]).not.toEqual(open.mock.calls[0]);
    gate.resolve(instance);
    await rejected;
    expect(close).toHaveBeenCalledExactlyOnceWith({ ...params, instance });
    owner.invalidate();
    expect(close).toHaveBeenLastCalledWith({
      ...params,
      instance: currentInstance,
    });
  });
});
