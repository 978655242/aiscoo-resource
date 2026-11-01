import { describe, expect, it } from "vitest";
import { resolveDraftComposerTopSpace } from "@/aiscoo/brand/useDraftComposerCentering.js";

describe("Aiscoo 初始输入框居中", () => {
  it.each([
    { viewportHeight: 927, leadingHeight: 280.96 },
    { viewportHeight: 927, leadingHeight: 346.96 },
    { viewportHeight: 742, leadingHeight: 287.12 },
    { viewportHeight: 702, leadingHeight: 280.96 },
  ])("按实际前置内容高度居中 $viewportHeight / $leadingHeight", (geometry) => {
    const topSpace = resolveDraftComposerTopSpace(geometry);
    expect(topSpace + geometry.leadingHeight).toBeCloseTo(geometry.viewportHeight / 2);
  });

  it("提示横幅出现时整体上移，消失时恢复，输入框中心不变", () => {
    const normal = resolveDraftComposerTopSpace({ viewportHeight: 927, leadingHeight: 280.96 });
    const withBanner = resolveDraftComposerTopSpace({ viewportHeight: 927, leadingHeight: 346.96 });
    expect(normal - withBanner).toBeCloseTo(66);
    expect(resolveDraftComposerTopSpace({ viewportHeight: 927, leadingHeight: 280.96 })).toBe(
      normal,
    );
  });

  it("小窗口保留顶部安全距离，不向上裁切品牌内容", () => {
    expect(resolveDraftComposerTopSpace({ viewportHeight: 542, leadingHeight: 346.96 })).toBe(52);
  });
});
