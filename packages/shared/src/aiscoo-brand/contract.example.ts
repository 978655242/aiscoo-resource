import { PRODUCT_BRAND, PRODUCT_NAME, brandMessageCatalog, type ProductBrand } from "./contract.js";

// 旧消费者构造的基础 ProductBrand 不需要新字段；实际产品配置则提供法定主体。
export const compatibleLegacyBrand: ProductBrand = {
  productName: "Example",
  wordmark: "example",
  developmentName: "Example Dev",
  previewName: "Example Preview",
  desktopName: "Example Desktop",
  sourceDirectory: "example",
  desktopIcon: { theme: "dark", markScale: 1 },
  palette: { lightForeground: "", lightBackground: "", darkForeground: "", darkBackground: "" },
};
export const legalOperatorName: string = PRODUCT_BRAND.legalOperatorName;

export const brandedMessages = brandMessageCatalog({
  welcome: "Welcome to XWork, {workspaceName}",
});
export const applicationTitle = PRODUCT_NAME;
