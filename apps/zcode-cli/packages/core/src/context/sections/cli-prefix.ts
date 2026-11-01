// XCODE: 仅统一本产品展示文案，保留内部标识、协议与既有数据。
// ============================================================
// CLI Prefix Section Builder
// ============================================================

import { PRODUCT_NAME } from "@zcode/shared/aiscoo-brand";
import type { ContextSection } from "../types.js";
import { estimateTokens } from "../utils.js";

const CLI_PREFIX_PROMPT = `You are ${PRODUCT_NAME}, an interactive agent`;

export function buildCliPrefixSection(): ContextSection {
  const content = CLI_PREFIX_PROMPT;

  return {
    name: "CLI Prefix",
    source: "cli_prefix",
    injectionTarget: "system",
    cacheHint: "stable",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}
