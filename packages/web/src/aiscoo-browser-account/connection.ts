import { connectViaWebSocket } from "@zcode/client";
import { registerBrowserAccountChannel } from "./attachment.js";
import type {
  BrowserAccountConnectionFailure,
  BrowserAccountWebConnection,
  BrowserAccountWebConnectionOptions,
} from "./contract.js";

/** 传输 open 不等于账号接入成功；关闭必须终止等待中的初始化 RPC。 */
export function createBrowserAccountWebConnection({
  account,
  onFailure,
}: BrowserAccountWebConnectionOptions): BrowserAccountWebConnection {
  const lifetime = new AbortController();
  let closed = false;
  let started = false;
  let socket: WebSocket | undefined;
  let channel: { dispose(): void } | undefined;

  function finish(failure?: BrowserAccountConnectionFailure) {
    if (closed) return;
    closed = true;
    channel?.dispose();
    lifetime.abort();
    socket?.close();
    if (failure) onFailure(failure);
  }

  return {
    get closed() {
      return closed;
    },
    async connect(wsUrl) {
      if (started || closed) throw new Error("AISCOO_BROWSER_CONNECTION_CLOSED");
      started = true;
      try {
        const services = await connectViaWebSocket(wsUrl, {
          signal: lifetime.signal,
          onOpenSocket: (opened) => {
            if (closed) opened.close();
            else socket = opened;
          },
          onClose: (event) => {
            let reason: BrowserAccountConnectionFailure["reason"] = "disconnected";
            // 只接受 Server 的精确策略关闭；账号不匹配、已换号和旧版占用不能混为断线。
            if (event.code === 1008) {
              switch (event.reason) {
                case "Browser account does not match":
                  reason = "account-mismatch";
                  break;
                case "Browser account changed":
                  reason = "account-changed";
                  break;
                case "Browser account is already attached":
                  reason = "account-in-use";
                  break;
              }
            }
            finish({ reason });
          },
          registerChannels: (server) => {
            if (!closed) channel = registerBrowserAccountChannel(server, account);
          },
        });
        if (closed) throw new Error("AISCOO_BROWSER_CONNECTION_CLOSED");
        // 既有元数据请求会等待服务端恢复/接入；不能把已被拒绝的 socket 交给 Root。
        await services.oauthService.getProviders();
        if (closed) throw new Error("AISCOO_BROWSER_CONNECTION_CLOSED");
        return services;
      } catch (error) {
        finish({ reason: "disconnected" });
        throw error;
      }
    },
    dispose() {
      finish();
    },
  };
}
