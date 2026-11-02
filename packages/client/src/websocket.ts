import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelClient,
  type IMessagePassingProtocol,
  type IChannelServer,
  ChannelServer,
  type ISocket,
} from "@zcode/rpc";
import type { IServiceAccessor } from "@zcode/services";
import { RemoteServiceAccess } from "./remoteServiceAccess.js";

export interface WebSocketConnectionCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

interface WebSocketConnectionOptions {
  // XCODE: 由调用方取消当前连接及待决 RPC；未注入时保持原有生命周期。
  signal?: AbortSignal;
  onClose?: (event: WebSocketConnectionCloseEvent) => void;
  onOpenSocket?: (socket: WebSocket) => void;
  // XCODE: 可选反向服务只注册调用方声明的 channel，默认仍为单向客户端。
  registerChannels?: (server: IChannelServer) => void;
}

function wrapBrowserWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (e) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(e.data as ArrayBuffer)));
  });
  ws.addEventListener("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.addEventListener("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };
}

export function connectViaWebSocket(
  wsUrl: string,
  options?: WebSocketConnectionOptions,
): Promise<IServiceAccessor> {
  return new Promise((resolve, reject) => {
    // XCODE: 可选取消端口贯穿建连与正向 RPC，避免接入拒绝后初始化永久等待。
    const signal = options?.signal;
    if (signal?.aborted) {
      reject(new DOMException("WebSocket connection aborted", "AbortError"));
      return;
    }
    const ws = new WebSocket(wsUrl);
    let settled = false;
    const abort = () => {
      ws.close();
      if (!settled) reject(new DOMException("WebSocket connection aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });

    ws.addEventListener("error", () => {
      if (!settled) {
        reject(new Error(`WebSocket connection failed: ${wsUrl}`));
      }
    });
    ws.addEventListener("close", (event) => {
      signal?.removeEventListener("abort", abort);
      options?.onClose?.({
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });

      if (!settled) {
        reject(
          new Error(
            event.reason
              ? `WebSocket closed before ready: ${event.reason}`
              : `WebSocket closed before ready (${event.code})`,
          ),
        );
      }
    });

    ws.addEventListener("open", () => {
      // XCODE: 已取消的建连不能因迟到 open 重新注册服务。
      if (signal?.aborted) {
        abort();
        return;
      }
      settled = true;
      options?.onOpenSocket?.(ws);
      const socket = wrapBrowserWebSocket(ws);
      const protocol = new SocketProtocol(socket);
      // XCODE: 取消权仍归调用方，复用既有 ChannelClient.dispose 拒绝待决请求。
      const services = connectViaProtocol(protocol, signal ? { signal } : undefined);
      // XCODE: ChannelClient 必须先监听 Initialize，再注册反向服务并开放 ready。
      if (options?.registerChannels) {
        const server = new ChannelServer(protocol, "browser", 1000, true);
        options.registerChannels(server);
        socket.onClose(() => server.dispose());
        server.ready();
      }
      resolve(services);
    });
  });
}

export function connectViaProtocol(
  protocol: IMessagePassingProtocol,
  options: { windowProjectDirectory?: boolean; signal?: AbortSignal } = {},
): IServiceAccessor {
  const client = new ChannelClient(protocol);
  // bridge 只释放传输时，旧 RPC 会永久等待，发送前已 claim 的草稿也无法进入失败恢复。
  // 生命周期由调用方持有；终结时复用 ChannelClient 的统一拒绝，包括等待 Initialize 的请求。
  const dispose = () => client.dispose();
  if (options.signal?.aborted) dispose();
  else options.signal?.addEventListener("abort", dispose, { once: true });
  return new RemoteServiceAccess(client, options);
}
