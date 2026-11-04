import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// XCODE: 真实同源 fixture server 保持与内联 harness 完全相同的路由与计数语义。
export async function createHandoffFixtureServer() {
  // XCODE: 后端已迁名 aiscoo-admin；测试来源可显式覆盖，缺源在监听前失败，不能把 404 计为首帧证据。
  const sourceRoot = process.env.XCODE_AISCOO_ADMIN_SOURCE_DIR?.trim();
  const bootstrapPath = resolve(
    sourceRoot || fileURLToPath(new URL("../../../../aiscoo-admin/", import.meta.url)),
    "web/public/xcode-plan-display.js",
  );
  const bootstrapSource = await readFile(bootstrapPath, "utf8").catch((cause) => {
    throw new Error(
      `Native handoff bootstrap unavailable: ${bootstrapPath}; set XCODE_AISCOO_ADMIN_SOURCE_DIR`,
      { cause },
    );
  });
  const counters = { css: 0, bootstrap: 0, foreign: 0, private: 0 };
  const foreign = createServer((_request, response) => {
    counters.foreign++;
    response.end("foreign");
  });
  const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const originFor = (server) => {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}`;
  };
  await listen(foreign);
  const foreignOrigin = originFor(foreign);
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    if (url.pathname === "/xcode/plans" && url.searchParams.has("handoff")) {
      counters.private++;
      response.writeHead(303, {
        Location: "/xcode/plans",
        "Set-Cookie": "xcode_plan=readonly; HttpOnly; SameSite=Strict; Path=/api/xcode/v1/web",
      });
      response.end();
    } else if (url.pathname === "/xcode/plans") {
      counters.private++;
      response.setHeader("Content-Type", "text/html");
      response.end(
        `<html class="dark" lang="en-US" style="color-scheme:dark;--ui-font-size:14px"><head><script src="/xcode-plan-display.js"></script><link rel="stylesheet" href="/assets/plan.css"></head><body>Assigned plan<img src="${foreignOrigin}/collect?handoff=short-code"></body></html>`,
      );
    } else if (url.pathname === "/xcode-plan-display.js") {
      response.setHeader("Content-Type", "text/javascript");
      // XCODE: 只计真实脚本成功结束的响应；读取失败已在 fixture 启动前暴露。
      response.once("finish", () => {
        counters.bootstrap++;
      });
      response.end(bootstrapSource);
    } else if (url.pathname === "/api/xcode/v1/web/view") {
      counters.private++;
      response.setHeader("Content-Type", "application/json");
      response.end(JSON.stringify({ plan: "Assigned plan" }));
    } else if (url.pathname === "/assets/plan.css") {
      counters.css++;
      response.setHeader("Content-Type", "text/css");
      response.end("body { color: rgb(1, 2, 3); }");
    } else if (url.pathname === "/redirect-private") {
      response.writeHead(302, { Location: "/xcode/plans?handoff=ordinary-redirect" });
      response.end();
    } else if (["/", "/custom", "/coding-plan"].includes(url.pathname)) {
      response.setHeader("Content-Type", "text/html");
      response.end("<html><body>Ordinary browsing</body></html>");
    } else {
      response.writeHead(404);
      response.end();
    }
  });
  server.on("upgrade", (request, socket) => {
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (path === "/xcode/plans" || path.startsWith("/api/xcode/v1/web/")) counters.private++;
    socket.end(
      "HTTP/1.1 303 See Other\r\nLocation: /xcode/plans\r\nSet-Cookie: xcode_plan=readonly; HttpOnly; SameSite=Strict; Path=/api/xcode/v1/web\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  await listen(server);
  const origin = originFor(server);
  return {
    origin,
    foreignOrigin,
    counters,
    close: () =>
      Promise.all([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => foreign.close(resolve)),
      ]),
  };
}
