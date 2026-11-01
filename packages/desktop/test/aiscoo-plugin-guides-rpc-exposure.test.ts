import { RemoteServiceAccess } from "@zcode/client";
import { ChannelClient, ChannelServer, createQueuePair, Emitter } from "@zcode/rpc";
import {
  IPluginGuideService,
  IProviderProvisioningTargetService,
  ISourceServerManagementService,
  ITerminalService,
  ServiceCollection,
} from "@zcode/services";
import type { PluginGuideSnapshot, PluginGuideTarget } from "@zcode/shared/aiscoo-plugin-guides";
import { describe, expect, it, vi } from "vitest";
import { exposeWindowHostAttachmentServices } from "../src/host/windowHostAttachmentRpcPolicy.js";

const target: PluginGuideTarget = {
  workspacePath: "/repo",
  workspaceIdentity: "remote:guide-workspace",
  remoteSessionId: "guide-attachment",
  pluginName: "example-plugin",
  marketplace: "example-marketplace",
  locale: "zh-CN",
};

describe("XWork plugin guide attachment RPC", () => {
  it.each(["web-remote-replayable", "desktop-continuous"] as const)(
    "%s reads the same Host snapshot, forwards guide commands and delivers changes",
    async (clientMode) => {
      let current: PluginGuideSnapshot = {
        key: "guide-target",
        target,
        sequence: 0,
        phase: "idle",
        document: null,
        messages: [],
        previewMarkdown: "",
        previewReply: "",
        stale: false,
      };
      const changes = new Emitter<PluginGuideSnapshot>();
      const owner = {
        read: vi.fn(async () => current),
        generate: vi.fn(async () => current),
        cancel: vi.fn(async () => {}),
        retrySave: vi.fn(async () => current),
        onDidChange: changes.event,
      } satisfies IPluginGuideService;
      const services = new ServiceCollection().register(IPluginGuideService, owner);
      const [serverProtocol, clientProtocol] = createQueuePair();
      const server = new ChannelServer(serverProtocol, "host", 20);
      const client = new ChannelClient(clientProtocol);

      try {
        exposeWindowHostAttachmentServices({ server, services, clientMode });
        const guide = new RemoteServiceAccess(client).pluginGuideService;
        await expect(guide.read(target)).resolves.toEqual(current);
        expect(owner.read).toHaveBeenCalledWith(target);

        const changed = vi.fn();
        const subscription = guide.onDidChange(changed);
        try {
          // 同队列读回包确认订阅已到 attachment Host，无须定时等待。
          await guide.read(target);
          current = { ...current, sequence: 1, phase: "generating", operationId: "guide-op" };
          changes.fire(current);
          await expect(guide.read(target)).resolves.toEqual(current);
          expect(changed).toHaveBeenCalledExactlyOnceWith(current);

          const input = { target, operationId: "guide-op", question: "如何开始？" };
          await expect(guide.generate(input)).resolves.toEqual(current);
          expect(owner.generate).toHaveBeenCalledExactlyOnceWith(input);
          await guide.cancel({ target, operationId: "guide-op" });
          expect(owner.cancel).toHaveBeenCalledExactlyOnceWith({ target, operationId: "guide-op" });
          await expect(guide.retrySave(target)).resolves.toEqual(current);
          expect(owner.retrySave).toHaveBeenCalledExactlyOnceWith(target);
        } finally {
          subscription.dispose();
        }
        await guide.read(target);
        changes.fire({ ...current, sequence: 2 });
        await guide.read(target);
        expect(changed).toHaveBeenCalledOnce();
      } finally {
        client.dispose();
        server.dispose();
        changes.dispose();
      }
    },
  );

  it.each(["web-remote-replayable", "desktop-continuous"] as const)(
    "%s exposes Terminal while preserving provisioning and source management boundaries",
    async (clientMode) => {
      const terminalCreate = vi.fn(async () => "terminal");
      const provisioningApply = vi.fn(async () => "provisioning");
      const sourceSnapshot = vi.fn(async () => "source");
      const services = new ServiceCollection()
        .register(ITerminalService, { create: terminalCreate } as never)
        .register(IProviderProvisioningTargetService, { apply: provisioningApply } as never)
        .register(ISourceServerManagementService, { getSnapshot: sourceSnapshot } as never);
      const [serverProtocol, clientProtocol] = createQueuePair();
      const server = new ChannelServer(serverProtocol, "host", 20);
      const client = new ChannelClient(clientProtocol);

      try {
        exposeWindowHostAttachmentServices({ server, services, clientMode });
        // XCODE: 新上游及远控规格已开放配对 attachment 的 Terminal；产品说明扩展不得恢复旧限制。
        await expect(
          client.getChannel(ITerminalService.channelName).call("create", []),
        ).resolves.toBe("terminal");
        expect(terminalCreate).toHaveBeenCalledExactlyOnceWith();
        for (const [descriptor, method, handler, result] of [
          [IProviderProvisioningTargetService, "apply", provisioningApply, "provisioning"],
          [ISourceServerManagementService, "getSnapshot", sourceSnapshot, "source"],
        ] as const) {
          const call = client.getChannel(descriptor.channelName).call(method, []);
          if (clientMode === "web-remote-replayable") {
            await expect(call).rejects.toThrow(
              `Channel name '${descriptor.channelName}' timed out`,
            );
            expect(handler).not.toHaveBeenCalled();
          } else {
            await expect(call).resolves.toBe(result);
            expect(handler).toHaveBeenCalledOnce();
          }
        }
      } finally {
        client.dispose();
        server.dispose();
      }
    },
  );
});
