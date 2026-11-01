import { brandProductText } from "@zcode/shared/aiscoo-brand";
import type { BrandCliCopy } from "./contract.js";

export { PRODUCT_NAME, PRODUCT_WORDMARK, brandProductText } from "./contract.js";

/** 原词典保持可直接使用；仅在下游 i18n 装配点接入产品展示。 */
export const brandCliCopy: BrandCliCopy = (copy) => {
  // 原 help 的唯一动态参数是 version：先投影空参数模板，再以切片插入真实值。
  // 不能对 help(version) 的成品做 replace，否则用户提供的版本字符串也会被改写。
  const sourceHelp = copy.cli.help("");
  const versionOffset = sourceHelp.indexOf("\n");
  const prefix = brandProductText(sourceHelp.slice(0, versionOffset));
  const suffix = brandProductText(sourceHelp.slice(versionOffset));
  return {
    ...copy,
    cli: { ...copy.cli, help: (version) => `${prefix}${version}${suffix}` },
    tui: {
      ...copy.tui,
      terminal: {
        ...copy.tui.terminal,
        starting: brandProductText(copy.tui.terminal.starting),
      },
    },
  };
};
