import assert from "node:assert/strict";
import { DesktopCommandIds } from "@zcode/shared";
import { executeDesktopCommand } from "../src/main/desktopCommandHandlers.ts";

// XCODE: 桌面缩放档位真实命令路径与 guest zoom 同步保持原顺序。
export async function runUpgradeZoomMatrix({ win, temporary, mount, measure, close, result }) {
  const settingService = { get: async () => ({ desktopZoomLevel: 0 }), update: async () => {} };
  const command = async (command) =>
    executeDesktopCommand({
      command,
      senderWindow: win,
      logger: console,
      settingService,
      credentialsDir: temporary,
      currentApplicationLocale: "zh-CN",
      updateZCodeStdioTapDevMenuState: () => {},
      onZCodeEndpointChanged: () => {},
      onRelaunchApp: async () => {},
    });
  const guest = await mount({
    theme: "zai-dark",
    locale: "zh-CN",
    font: 14,
    audience: "personal",
  });
  for (const level of [-3, 0, 5]) {
    await command(DesktopCommandIds.ResetZoom);
    for (let n = 0; n < Math.abs(level); n++)
      await command(level < 0 ? DesktopCommandIds.ZoomOut : DesktopCommandIds.ZoomIn);
    assert.ok(Math.abs(guest.getZoomFactor() - 1.1 ** level) < 1e-9);
    const measured = await measure(guest);
    assert.ok(measured.scrollWidth <= measured.clientWidth + 1);
    result.push({
      zoomLevel: level,
      zoom: guest.getZoomFactor(),
      innerWidth: measured.innerWidth,
      cards: measured.cards,
    });
  }
  await command(DesktopCommandIds.ResetZoom);
  await close(guest);
}
