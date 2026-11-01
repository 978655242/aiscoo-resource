import type { ZCodeCopy } from "../types.js";

/** 下游展示装配：只处理自有静态模板；版本、错误、路径和账号等插值原样保留。 */
export type BrandCliCopy = (copy: ZCodeCopy) => ZCodeCopy;
export { PRODUCT_NAME, PRODUCT_WORDMARK, brandProductText } from "@zcode/shared/aiscoo-brand";
