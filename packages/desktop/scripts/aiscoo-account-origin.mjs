/**
 * 构建期解析随正式包编译的 Aiscoo 账号源（AISCOO_ADMIN_BASE_URL）。
 *
 * tsup 会先打包配置文件，因此这里不能导入 @zcode/shared 里的 TypeScript 校验器。
 * 校验规则必须与 normalizeNewApiOrigin（packages/shared/src/new-api.ts）逐项一致，
 * 由 packages/desktop/test/aiscooPackagedAccountOrigin.test.ts 的对照矩阵固定，防止两份实现漂移。
 */
export const AISCOO_ADMIN_BASE_URL_ENV = "AISCOO_ADMIN_BASE_URL";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * 返回规范化 origin；非法时抛出不含原始值的错误（输入可能带用户名、口令或路径）。
 * @param {string} raw
 * @returns {string}
 */
export function normalizeAiscooAccountOrigin(raw) {
  const invalid = () =>
    new Error(
      `${AISCOO_ADMIN_BASE_URL_ENV} is invalid: expected an exact https origin (http only for loopback), without credentials, path, query or fragment`,
    );
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw invalid();
  }
  // URL 会把缩写、整数和十六进制 IPv4 归一成 loopback，所以主机名取自原始字符串而不是解析结果。
  const authority = raw.match(/^https?:\/\/([^/?#]+)\/?$/i)?.[1];
  const hostname = authority?.replace(/:\d+$/, "").toLowerCase();
  if (
    !authority ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    (url.protocol === "http:" && !LOOPBACK_HOSTS.has(hostname ?? ""))
  ) {
    throw invalid();
  }
  return url.origin;
}

/**
 * 按渠道决定编译进包的账号源。
 * - development：开发运行读取环境变量，不编译。
 * - preview：可选；设置了就严格校验并编译，未设置则留空。
 * - production：必填；缺失或非法直接让构建失败，避免产出一个运行时才提示“配置不可用”的包。
 * @param {{ env: Record<string, string | undefined>, channel: "production" | "preview" | "development" }} options
 * @returns {string} 规范化 origin；不编译时返回空串
 */
export function resolveBuildAiscooAccountOrigin({ env, channel }) {
  if (channel === "development") return "";
  const raw = env[AISCOO_ADMIN_BASE_URL_ENV]?.trim() ?? "";
  if (!raw) {
    if (channel === "production") {
      throw new Error(
        `${AISCOO_ADMIN_BASE_URL_ENV} is required to build the production channel: the packaged app cannot read it from the user's environment`,
      );
    }
    return "";
  }
  return normalizeAiscooAccountOrigin(raw);
}
