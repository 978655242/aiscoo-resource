// XCODE: 自有静态展示模板读取共享品牌；用户内容与稳定标识保持原样。
import { PRODUCT_NAME } from "@zcode/shared/aiscoo-brand";
// XCODE: 仅统一本产品展示文案，保留内部标识、协议与既有数据。
import type { BrowserBackendDescriptor } from "@zcode/contracts";

export function createManagedCdpDescriptor(
  browserId: string,
  generation: number,
): BrowserBackendDescriptor {
  return {
    id: browserId,
    generation,
    type: "cdp",
    name: `${PRODUCT_NAME} Headless Chromium`,
    capabilities: {
      browser: [],
      tab: [],
    },
    apiSupportOverrides: {
      "BrowserUser.openTabs": false,
      "BrowserUser.history": false,
      "PlaywrightAPI.waitForEvent": false,
      "PlaywrightDownload.path": false,
      "PlaywrightFileChooser.setFiles": false,
      "PlaywrightLocator.downloadMedia": false,
      "PlaywrightLocator.evaluate": false,
      "CUAAPI.downloadMedia": false,
      "DomCUAAPI.downloadMedia": false,
    },
    metadata: {
      provider: "zcode-cli",
      launchMode: "managed",
      headless: "true",
    },
  };
}
