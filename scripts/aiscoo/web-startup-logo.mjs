import { readFile } from "node:fs/promises";

const assetRoot = new URL("../../packages/ui/src/aiscoo/brand/assets/", import.meta.url);
const assetPattern =
  /\.\.\/ui\/src\/aiscoo\/brand\/assets\/wordmark-(?:animated-)?(?:light|dark)\.svg/g;

/** 在 HTML 生成时内联品牌原稿，保留无需脚本的首屏图片。 */
/** @returns {import("vite").Plugin} */
export function aiscooStartupLogoPlugin() {
  return {
    name: "aiscoo:web-startup-logo",
    transformIndexHtml: {
      order: "pre",
      async handler(html) {
        const paths = [...new Set(html.match(assetPattern) ?? [])];
        const assets = await Promise.all(
          paths.map(async (path) => {
            const file = path.slice(path.lastIndexOf("/") + 1);
            const source = await readFile(new URL(file, assetRoot));
            return [path, `data:image/svg+xml;base64,${source.toString("base64")}`];
          }),
        );
        for (const [path, url] of assets) html = html.replaceAll(path, url);
        return html;
      },
    },
  };
}
