/**
 * MCP 用户目录模块 - 类型和常量定义
 */

import type { CliMcpSource, McpFileFormat } from "@zcode/shared";
// XCODE: 描述符也消费 Main 的启动策略，不能把 stable source 标签当作实际目录。
import { getDesktopNativeResourceDirectories } from "../../aiscoo-desktop-identity/index.js";

/**
 * MCP 配置键名类型
 * - mcpServers: 通用 JSON 目录格式（.agents/mcp.json）
 * - mcp.servers: zcode CLI config.json 格式
 */
export type McpConfigKeyName = "mcpServers" | "mcp" | "mcp_servers" | "mcp.servers";

/**
 * OpenCode MCP 配置格式
 * OpenCode 使用特殊的配置格式：
 * - 键名是 "mcp" 而不是 "mcpServers"
 * - command 是数组格式 ["npx", "-y", "server"] 而不是分开的 command + args
 * - 必须有 type 字段 ("local" 或 "remote")
 */
export interface OpenCodeMcpServerConfig {
  type: "local" | "remote";
  command?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
}

export interface McpSourceDescriptor {
  source: CliMcpSource;
  configDirSegments: string[];
  fileName: string;
  format: McpFileFormat;
  configKeyName: McpConfigKeyName;
}

export const MCP_SOURCE_DESCRIPTORS: McpSourceDescriptor[] = [
  {
    source: "zcodeagentmcp",
    // XCODE: 延迟到资源入口已初始化之后读取，同一描述符的 load/save 保持一致。
    get configDirSegments() {
      return [getDesktopNativeResourceDirectories().directoryName, "cli"];
    },
    fileName: "config.json",
    format: "json",
    configKeyName: "mcp.servers",
  },
];

export function getSourceDescriptor(source: CliMcpSource): McpSourceDescriptor {
  const descriptor = MCP_SOURCE_DESCRIPTORS.find((item) => item.source === source);
  if (!descriptor) {
    throw new Error(`Unsupported MCP source: ${source}`);
  }
  return descriptor;
}
