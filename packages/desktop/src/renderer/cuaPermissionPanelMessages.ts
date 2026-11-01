import type { CuaPermissionKind, Locale } from "@zcode/shared";
// XCODE: 仅投影权限页面静态词典，运行时返回的真实 Helper 主体不参与转换。
import { brandMessageCatalog } from "@zcode/shared/aiscoo-brand";

export interface CuaPermissionPanelMessages {
  documentTitle: string;
  dragTitle: string;
  hintPrefix: string;
  permissionLabel: string;
  hintSuffix: string;
  completion: string;
}

const MESSAGES: Record<
  Locale,
  Omit<CuaPermissionPanelMessages, "permissionLabel"> & Record<CuaPermissionKind, string>
> = {
  // XCODE: 权限页面复用原有语言资源，原生辅助程序身份不变。
  "zh-CN": brandMessageCatalog({
    documentTitle: "XWork Computer Use 权限",
    dragTitle: "拖动我到上面的权限列表",
    hintPrefix: "把左边的图标拖进上方的",
    hintSuffix: "列表",
    completion: "松手即完成授权，无需再点开关",
    accessibility: "辅助功能",
    screen_recording: "屏幕录制",
  }),
  "en-US": brandMessageCatalog({
    documentTitle: "XWork Computer Use Permissions",
    dragTitle: "Drag me to the permission list above",
    hintPrefix: "Drag the icon on the left into the ",
    hintSuffix: " list above",
    completion: "Release to grant access—no need to toggle the switch",
    accessibility: "Accessibility",
    screen_recording: "Screen Recording",
  }),
};

export function resolveCuaPermissionPanelMessages(
  locale: Locale,
  permission: CuaPermissionKind,
): CuaPermissionPanelMessages {
  const messages = MESSAGES[locale];
  return {
    documentTitle: messages.documentTitle,
    dragTitle: messages.dragTitle,
    hintPrefix: messages.hintPrefix,
    permissionLabel: messages[permission],
    hintSuffix: messages.hintSuffix,
    completion: messages.completion,
  };
}
