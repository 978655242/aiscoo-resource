import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";

// XCODE: 静态 dist fixture 保持原响应语义；state/counters 由 smoke 与 debugger 共享读写。
export function createUpgradeFixtureServer({ webRoot, counters }) {
  const contentTypes = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".css": "text/css",
    ".svg": "image/svg+xml",
    ".woff2": "font/woff2",
    ".png": "image/png",
  };
  const state = { viewer: null, responseMode: "ready" };
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (request.method !== "GET") {
        counters.writes++;
        response.writeHead(405).end();
        return;
      }
      if (url.pathname === "/xcode/plans" && url.searchParams.has("handoff")) {
        response
          .writeHead(303, {
            Location: "/xcode/plans",
            "Set-Cookie":
              "xcode_plan=fixture-readonly; HttpOnly; SameSite=Strict; Path=/api/xcode/v1/web",
          })
          .end();
        return;
      }
      if (url.pathname === "/api/xcode/v1/web/view") {
        response.setHeader("Content-Type", "application/json");
        if (state.responseMode === "error") {
          response
            .writeHead(503)
            .end(JSON.stringify({ success: false, code: "XCODE_BACKEND_UNAVAILABLE" }));
          return;
        }
        if (state.responseMode === "loading")
          await new Promise((resolve) => setTimeout(resolve, 300));
        response.end(JSON.stringify({ success: true, data: state.viewer }));
        return;
      }
      const path =
        url.pathname === "/xcode/plans"
          ? "index.html"
          : decodeURIComponent(url.pathname).replace(/^\/+/, "");
      const file = resolve(webRoot, "dist", path);
      assert.ok(file.startsWith(resolve(webRoot, "dist") + "/"));
      response.setHeader("Content-Type", contentTypes[extname(file)] || "application/octet-stream");
      response.end(await readFile(file));
    } catch {
      response.writeHead(404).end();
    }
  });
  return {
    state,
    start: async () => {
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
