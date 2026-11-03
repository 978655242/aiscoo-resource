import type { ModelSelection } from "@zcode/contracts";
import { normalizeAiscooModelSelection } from "@zcode/shared/model-provider-types";

export function cloneModelSelection(selection: ModelSelection): ModelSelection {
  // XCODE: typed 运行时入口绕过 schema；复制时统一迁移旧身份，保留模型和档位。
  selection = normalizeAiscooModelSelection(selection);
  return {
    providerId: selection.providerId,
    modelId: selection.modelId,
    ...(selection.options ? { options: { ...selection.options } } : {}),
  };
}
