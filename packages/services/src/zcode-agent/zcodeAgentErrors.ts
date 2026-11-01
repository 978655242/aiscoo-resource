// XCODE: 仅统一本产品展示文案，保留内部标识、协议与既有数据。
// XCODE: 仅能力缺失提示消费品牌，稳定错误码继续决定跨 RPC 分类。
import { brandProductText } from "@zcode/shared/aiscoo-brand";

// 原始 -32602 文案来自旧 Agent schema，跨 RPC 后 UI 不能靠易变字符串识别能力缺失。
// ChannelClient 会保留 error.code，因此用稳定 code 驱动设置页停止 status-only 轮询。
export const ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE =
  "ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED";

export class ZCodeAgentMcpStatusModeUnsupportedError extends Error {
  readonly code = ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE;

  constructor() {
    // XCODE: 展示品牌不改变 code 驱动的能力缺失识别。
    super(brandProductText("The connected XWork Agent does not support MCP status-only refresh"));
    this.name = "ZCodeAgentMcpStatusModeUnsupportedError";
  }
}

export function isZCodeAgentMcpStatusModeUnsupportedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return (error as { code?: unknown }).code === ZCODE_AGENT_MCP_STATUS_MODE_UNSUPPORTED_ERROR_CODE;
}

/** XCODE: 仅精确 session 的可信持久确认决定附件清理；缺失/畸形确认仍属未知。 */
export function readSharedImportCommitStatus(
  error: unknown,
  sessionId: string | undefined,
): boolean | null {
  if (
    !sessionId ||
    typeof error !== "object" ||
    error === null ||
    !Object.hasOwn(error, "data") ||
    !("data" in error)
  )
    return null;
  const data = error.data;
  if (
    typeof data !== "object" ||
    data === null ||
    !Object.hasOwn(data, "sharedImportCommit") ||
    !("sharedImportCommit" in data)
  )
    return null;
  const commit = data.sharedImportCommit;
  if (
    typeof commit !== "object" ||
    commit === null ||
    Reflect.ownKeys(commit).length !== 2 ||
    !Object.hasOwn(commit, "sessionId") ||
    !Object.hasOwn(commit, "committed") ||
    !("sessionId" in commit) ||
    !("committed" in commit) ||
    commit.sessionId !== sessionId ||
    typeof commit.committed !== "boolean"
  )
    return null;
  return commit.committed;
}
