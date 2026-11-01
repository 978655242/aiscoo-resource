// XCODE: 自有静态模板使用共享品牌，用户插值和兼容标识保持不变。
import { PRODUCT_NAME } from "@zcode/shared/aiscoo-brand";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { parseZenAuthorizationCallback } from "@zcode/shared";
import type { ZenAuthorizationListener } from "./contract.js";

const callbackPath = "/oauth/callback";
const maxRequestLength = 2048;

// XCODE: 独立 CLI 的回环端口只接收当前登录结果，无关请求不消耗 pending flow。
export async function createZenAuthorizationListener(
  state: string,
): Promise<ZenAuthorizationListener> {
  let redirectUri = "";
  let settled = false;
  let resolveResult!: (value: { code: string; state: string }) => void;
  let rejectResult!: (error: Error) => void;
  const result = new Promise<{ code: string; state: string }>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // 监听建立后、wait 调用前也可能关闭；为该窗口注册拒绝处理，wait 仍观察原 promise。
  void result.catch(() => undefined);
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    if (request.method !== "GET") {
      response.writeHead(405).end();
      return;
    }
    const raw = request.url ?? "";
    if (!raw.startsWith(`${callbackPath}?`)) {
      response.writeHead(404).end();
      return;
    }
    if (raw.length > maxRequestLength) {
      response.writeHead(400).end();
      return;
    }
    const callback = parseZenAuthorizationCallback(
      `${redirectUri}${raw.slice(callbackPath.length)}`,
      redirectUri,
      state,
    );
    if (!callback) {
      response.writeHead(400).end("Invalid authorization callback.");
      return;
    }
    if (settled) {
      response.writeHead(409).end();
      return;
    }
    settled = true;
    response.writeHead(200).end(`Authorization received. Return to ${PRODUCT_NAME} CLI.`);
    resolveResult(callback);
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}${callbackPath}`;
  return {
    redirectUri,
    async wait(signal) {
      const abort = () => {
        if (!settled) {
          settled = true;
          rejectResult(new Error("Zen authorization canceled"));
        }
      };
      if (signal?.aborted) abort();
      signal?.addEventListener("abort", abort, { once: true });
      try {
        return await result;
      } finally {
        signal?.removeEventListener("abort", abort);
      }
    },
    async close() {
      if (!settled) {
        settled = true;
        rejectResult(new Error("Zen authorization closed"));
      }
      server.closeAllConnections();
      if (server.listening)
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
    },
  };
}
