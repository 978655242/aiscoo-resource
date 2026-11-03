/* eslint-disable max-lines -- 模型供应商 schema、迁移和运行时投影 helper 需要共享同一套类型边界，暂时集中在单文件避免契约分散。 */
import { z } from "zod";

// XCODE: 产品模型身份与网关适配器名称分离，旧 ID 只在读取边界迁移。
export const AISCOO_MODEL_PROVIDER_IDS = {
  "anthropic-messages": "account:aiscoo-anthropic-messages",
  "openai-chat-completions": "account:aiscoo-openai-chat-completions",
  "openai-responses": "account:aiscoo-openai-responses",
} as const;

export const NEW_API_MODEL_PROVIDER_IDS = AISCOO_MODEL_PROVIDER_IDS;

/** 只迁移已发布的三个精确身份，不猜测自配 Provider、模型或协议。 */
export function normalizeAiscooModelProviderId(providerId: string): string {
  switch (providerId) {
    case "account:new-api-anthropic-messages":
      return AISCOO_MODEL_PROVIDER_IDS["anthropic-messages"];
    case "account:new-api-openai-chat-completions":
      return AISCOO_MODEL_PROVIDER_IDS["openai-chat-completions"];
    case "account:new-api-openai-responses":
      return AISCOO_MODEL_PROVIDER_IDS["openai-responses"];
    default:
      return providerId;
  }
}

/** typed selection 同样经过共享迁移，保留模型、options 和额外历史事实。 */
export function normalizeAiscooModelSelection<T extends { readonly providerId: string }>(
  selection: T,
): T {
  const providerId = normalizeAiscooModelProviderId(selection.providerId);
  return providerId === selection.providerId ? selection : { ...selection, providerId };
}

/** 新旧键冲突时规范键的完整条目优先，不改写调用者持有的快照。 */
export function normalizeAiscooModelProviderRecord<T>(
  record: Readonly<Record<string, T>>,
): Record<string, T> {
  const entries = Object.entries(record);
  const normalized = new Map(
    entries.map(([providerId, value]) => [normalizeAiscooModelProviderId(providerId), value]),
  );
  for (const [providerId, value] of entries) {
    if (normalizeAiscooModelProviderId(providerId) === providerId) {
      normalized.set(providerId, value);
    }
  }
  return Object.fromEntries(normalized);
}

/** 只规范完整引用的 Provider 片段，保留模型名中的斜线、字面量 $ 与后缀。 */
export function normalizeAiscooModelReference(value: string): string {
  const separator = value.indexOf("/");
  return separator > 0
    ? `${normalizeAiscooModelProviderId(value.slice(0, separator))}${value.slice(separator)}`
    : value;
}

/** 工作流恢复只转换模型引用的值，保留脚本绑定键、事件事实和未知身份。 */
export function normalizeAiscooStoredModelReferences<
  T extends {
    readonly subagentModel?: string;
    readonly modelBindings?: Readonly<Record<string, string>>;
  },
>(value: T): T {
  const subagentModel =
    value.subagentModel === undefined
      ? undefined
      : normalizeAiscooModelReference(value.subagentModel);
  let changed = subagentModel !== value.subagentModel;
  const modelBindings =
    value.modelBindings === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(value.modelBindings).map(([name, model]) => {
            const normalized = normalizeAiscooModelReference(model);
            changed ||= normalized !== model;
            return [name, normalized];
          }),
        );
  return changed
    ? {
        ...value,
        ...(subagentModel === undefined ? {} : { subagentModel }),
        ...(modelBindings === undefined ? {} : { modelBindings }),
      }
    : value;
}

export function isNewApiModelProviderId(id: string): boolean {
  return Object.values(NEW_API_MODEL_PROVIDER_IDS).some((value) => value === id);
}

export const newApiCatalogIssueSchema = z
  .object({
    source: z.literal("new-api"),
    modelId: z.string().min(1),
    displayName: z.string(),
    code: z.string().min(1),
  })
  .strict();
export type NewApiCatalogIssue = z.infer<typeof newApiCatalogIssueSchema>;

export const newApiRegistryOwnerSchema = z
  .object({
    origin: z.string().url(),
    userId: z.string().regex(/^[1-9]\d*$/),
    sid: z.string().min(1),
    authGeneration: z.number().int().nonnegative(),
  })
  .strict();
export const BUILTIN_PROVIDER_TEMPLATE_IDS = {
  zai: "zai-api",
  bigmodel: "bigmodel-api",
} as const;

export const BUILTIN_MODEL_PROVIDER_IDS = {
  zaiIndividualCodingPlan: "account:zai-individual-coding-plan",
  zaiTeamCodingPlan: "account:zai-team-coding-plan",
  zaiStartPlan: "account:zai-start-plan",
  bigmodelIndividualCodingPlan: "account:bigmodel-individual-coding-plan",
  bigmodelTeamCodingPlan: "account:bigmodel-team-coding-plan",
  bigmodelStartPlan: "account:bigmodel-start-plan",
} as const;

export type BuiltinOAuthProviderId = keyof typeof BUILTIN_MODEL_PROVIDER_IDS;

export type BuiltinModelProviderId = (typeof BUILTIN_MODEL_PROVIDER_IDS)[BuiltinOAuthProviderId];

export function isBuiltinModelProviderId(id: string): id is BuiltinModelProviderId {
  return (
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

export function isZaiCodingPlanProviderId(id: string): boolean {
  return (
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiTeamCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan
  );
}

export function isBigModelStartPlanProviderId(id: string): boolean {
  return id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan;
}

export function isStartPlanModelProviderId(id: string): boolean {
  return (
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiStartPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

/**
 * 个人版 Coding Plan（不含 Start Plan 与 Team Plan）。
 * Start Plan 用 disconnected 展示领取/付费卡，Team Plan 有独立文案，
 * "服务端明确无权益"只对个人版需要区分成"未开通"。
 */
export function isIndividualCodingPlanModelProviderId(id: string): boolean {
  return (
    id === BUILTIN_MODEL_PROVIDER_IDS.zaiIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan
  );
}

export function isCodingPlanModelProviderId(id: string): boolean {
  return (
    isZaiCodingPlanProviderId(id) ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelIndividualCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelTeamCodingPlan ||
    id === BUILTIN_MODEL_PROVIDER_IDS.bigmodelStartPlan
  );
}

/** 一个正式 Model 的连通性测试结果。 */
export type ModelConnectivityResult =
  | { readonly success: true }
  | {
      readonly success: false;
      readonly error: {
        readonly message: string;
        /** 设置连接测试边界已确认的资格失败；其他执行错误保留原消息。 */
        readonly code?: "provider-unavailable" | "model-unavailable";
      };
    };
