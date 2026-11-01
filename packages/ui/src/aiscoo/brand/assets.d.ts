/** XCODE: 自有 SVG 在分享导出时以内嵌原稿消费，Vite raw 导入仍是纯字符串。 */
declare module "*.svg?raw" {
  const source: string;
  export default source;
}
