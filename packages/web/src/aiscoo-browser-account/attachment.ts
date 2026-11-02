import { Emitter, type IChannelServer, type IServerChannel } from "@zcode/rpc";
import type { NewApiOwner } from "@zcode/shared";
import type { IOAuthService } from "@zcode/services";
import type { BrowserNewApiAccount } from "./contract.js";

// 显式列出可反向调用的公开操作，不能将含凭据的账号对象直接交给反射 RPC。
const oauthMethods = [
  "getProviders",
  "getActiveProvider",
  "restoreSession",
  "startOAuth",
  "startOAuthWithPolling",
  "pollPendingOAuth",
  "handleCallback",
  "refreshToken",
  "logout",
  "logoutAll",
  "cancelPending",
] as const satisfies readonly (keyof IOAuthService)[];

export function registerBrowserAccountChannel(
  server: IChannelServer,
  account: BrowserNewApiAccount,
) {
  const changes = new Emitter<{ owner: NewApiOwner | null }>();
  const readStorageIdentity = () => {
    try {
      return account.getStorageIdentity();
    } catch {
      return undefined;
    }
  };
  let storageIdentity = readStorageIdentity();
  const subscription = account.oauth.onDidChangeSession(() => {
    const owner = account.getOwner();
    storageIdentity = readStorageIdentity();
    changes.fire({ owner });
  });
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && !event.key.startsWith("aiscoo:browser-new-api:")) return;
    const nextIdentity = readStorageIdentity();
    // token 轮换和其他 origin 的写入不改变本页 stamp，不能打断仍有效的页面与草稿。
    if (nextIdentity !== undefined && nextIdentity === storageIdentity) return;
    // 先同步失效旧投影并沿现有 session 事件通知 Host，再重载；新 callback 不能被旧 owner 阻挡。
    account.getOwner();
    window.location.reload();
  };
  window.addEventListener("storage", onStorage);
  const channel = {
    listen(_context: string, event: string) {
      if (event !== "session") throw new Error("AISCOO_BROWSER_RPC_INVALID");
      return changes.event;
    },
    async call(_context: string, command: string, arg: unknown) {
      if (command === "restore") {
        const session = await account.oauth.restoreCachedSessionState();
        return { owner: account.getOwner(), session };
      }
      if (command === "invalidateCredential") {
        const owner = (arg as { owner?: NewApiOwner } | undefined)?.owner;
        if (
          !arg ||
          typeof arg !== "object" ||
          Object.keys(arg).join() !== "owner" ||
          !owner ||
          Object.keys(owner).sort().join() !== "authGeneration,origin,sid,userId" ||
          typeof owner.origin !== "string" ||
          typeof owner.userId !== "string" ||
          !/^[1-9]\d*$/.test(owner.userId) ||
          typeof owner.sid !== "string" ||
          !owner.sid ||
          owner.sid.trim() !== owner.sid ||
          !Number.isSafeInteger(owner.authGeneration) ||
          owner.authGeneration <= 0
        )
          throw new Error("AISCOO_BROWSER_RPC_INVALID");
        account.invalidateCredential(owner);
        return;
      }
      if (command === "control" || command === "relay") {
        const owner = (arg as { owner?: NewApiOwner } | undefined)?.owner;
        if (!owner) throw new Error("AISCOO_BROWSER_RPC_INVALID");
        return command === "control"
          ? account.getControlCredential(owner)
          : account.getRelayCredential(owner);
      }
      if (command !== "oauth" || !arg || typeof arg !== "object")
        throw new Error("AISCOO_BROWSER_RPC_INVALID");
      const { method, args } = arg as { method: string; args: unknown[] };
      if (!oauthMethods.includes(method as (typeof oauthMethods)[number]) || !Array.isArray(args)) {
        throw new Error("AISCOO_BROWSER_RPC_INVALID");
      }
      const operation = account.oauth[method as (typeof oauthMethods)[number]] as (
        ...params: unknown[]
      ) => Promise<unknown>;
      return operation.apply(account.oauth, args);
    },
  };
  server.registerChannel("aiscoo/browser-account", channel as IServerChannel);
  return {
    dispose() {
      window.removeEventListener("storage", onStorage);
      subscription.dispose();
      changes.dispose();
    },
  };
}
