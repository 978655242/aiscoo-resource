// 构建器和启动脚本直接读取的唯一品牌数据路径。
import brand from "./brand.json" with { type: "json" };

export const PRODUCT_BRAND = Object.freeze({
  ...brand,
  palette: Object.freeze(brand.palette),
});
export const PRODUCT_NAME = PRODUCT_BRAND.productName;
export const PRODUCT_WORDMARK = PRODUCT_BRAND.wordmark;

const PROTECTED_REFERENCE =
  /[a-z][a-z\d+.-]*:\/\/[^\s<>"']+|(?:~\/|\/[\w.-]+\/|[a-z]:[\\/])[^\s<>"']*|`[^`]*`/giu;
const LEGACY_PRODUCT_NAME = /\b(?:XWork|XCode|ZCode)\b/gu;

/** @param {string} template Product-owned text, before user values are interpolated. */
export function brandProductText(template) {
  let end = 0;
  let result = "";
  for (const reference of template.matchAll(PROTECTED_REFERENCE)) {
    const start = reference.index;
    result += template.slice(end, start).replace(LEGACY_PRODUCT_NAME, PRODUCT_NAME);
    result += reference[0];
    end = start + reference[0].length;
  }
  return result + template.slice(end).replace(LEGACY_PRODUCT_NAME, PRODUCT_NAME);
}

/**
 * @template {Record<string, string>} T
 * @param {T} messages
 * @returns {T}
 */
export function brandMessageCatalog(messages) {
  return /** @type {T} */ (
    Object.fromEntries(
      Object.entries(messages).map(([key, value]) => [key, brandProductText(value)]),
    )
  );
}
