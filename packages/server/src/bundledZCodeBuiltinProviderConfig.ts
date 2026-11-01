// XCODE: 仅统一本产品展示文案，保留内部标识、协议与既有数据。
import { materializeZCodeBuiltinProviderConfig } from "@zcode/services/node";
// XCODE: 仅构建缺失提示消费共享品牌，内嵌配置与物化路径不改写。
import { brandProductText } from "@zcode/shared/aiscoo-brand";

declare const __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: string | undefined;

export interface MaterializeBundledZCodeBuiltinProviderConfigOptions {
  readonly environmentConfigRoot: string;
  readonly content: string;
}

/** 返回构建时嵌入远端 Server 的 ZCode Built-in Provider Config。 */
export function readBundledZCodeBuiltinProviderConfig(): string {
  if (typeof __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__ !== "string") {
    // XCODE: 只投影本地错误提示，构建常量名称保持兼容。
    throw new Error(brandProductText("当前构建未嵌入 XWork Built-in Provider Config"));
  }
  return __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__;
}

/**
 * 将 ZCode Built-in Config 原子物化到所属环境的固定资源副本。
 * 升级前退出旧进程；不保留按内容 hash 增长的历史文件。
 */
export async function materializeBundledZCodeBuiltinProviderConfig(
  options: MaterializeBundledZCodeBuiltinProviderConfigOptions,
): Promise<string> {
  return materializeZCodeBuiltinProviderConfig(options);
}
