// XCODE: 自定义模型没有后端下发的图标，按模型 ID 的厂商关键词映射到与 Aiscoo 管理端
// 相同的 @lobehub/icons 名称（取值对齐 aiscoo-admin model/pricing_default.go 的 defaultVendorIcons
// 及当前后端供应商配置），使官方与自定义模型图标一致。
const MODEL_LOBE_ICON_RULES: readonly (readonly [RegExp, string])[] = [
  [/claude|anthropic/i, "Claude.Color"],
  [/gpt|codex|openai|(^|\/)o\d/i, "OpenAI"],
  [/deepseek/i, "DeepSeek.Color"],
  [/minimax|abab/i, "Minimax.Color"],
  [/kimi|moonshot/i, "Moonshot"],
  [/grok/i, "XAI"],
  [/mimo/i, "XiaomiMiMo"],
  [/qwen|qwq/i, "Qwen.Color"],
  [/gemini/i, "Gemini.Color"],
  [/glm|zai/i, "ZAI"],
];

/** 未识别的模型返回 undefined，由调用方回落 provider logo。 */
export function resolveModelLobeIcon(modelId: string): string | undefined {
  return MODEL_LOBE_ICON_RULES.find(([pattern]) => pattern.test(modelId))?.[1];
}
