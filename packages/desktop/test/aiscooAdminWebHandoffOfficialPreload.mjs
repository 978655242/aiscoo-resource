import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// XCODE: 源码 Main 没有产物 .cjs；只为真实官方 preload 编译临时产物，不替换其 bridge 行为。
export async function buildOfficialPlanPreload(origin) {
  const officialPreload = await build({
    entryPoints: [fileURLToPath(new URL("../src/preload/codingPlanWebview.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    external: ["electron"],
    define: {
      "process.env": JSON.stringify({
        ZCODE_ENDPOINT_ORIGIN: origin,
        VITE_ZCODE_E2E_STORE_BRIDGE: "1",
      }),
    },
  });
  return officialPreload.outputFiles[0].text;
}
