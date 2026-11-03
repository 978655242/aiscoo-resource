import { createHash } from "node:crypto";
import {
  NewApiAccountAccessConfig,
  ProviderConfig,
  ProviderConfigMap,
  type AccountProviderStates,
  type AccountModelPresentation,
} from "@zcode/provider";
import {
  NEW_API_MODEL_PROVIDER_IDS,
  type NewApiOwner,
  type NewApiEntitlements,
  type NewApiCatalog,
  type NewApiCatalogIssue,
} from "@zcode/shared";

// XCODE: CLI 套餐目录只投影 canonical 的成员与展示字段，不能合成个人 API Key 或自动迁移旧模型。
export function resolveZenAccountProviders(input: {
  owner: NewApiOwner | null;
  entitlements?: NewApiEntitlements;
  catalog?: NewApiCatalog;
  configRevision?: string;
}) {
  const { owner, entitlements, catalog } = input;
  if (
    catalog &&
    entitlements &&
    catalog.authorization_revision !== entitlements.authorization_revision
  )
    throw new Error("XCODE_AUTHORIZATION_REVISION_MISMATCH");
  const entitled =
    owner !== null && entitlements?.status === "active" && entitlements.subscription !== null;
  const modelPresentation: Record<string, Record<string, AccountModelPresentation[string][string]>> = {};
  const catalogIssues: NewApiCatalogIssue[] = [];
  const ids: Record<string, string[]> = {};
  const seen = new Set<string>();
  for (const id of Object.values(NEW_API_MODEL_PROVIDER_IDS)) {
    ids[id] = [];
    modelPresentation[id] = Object.create(null);
  }
  for (const model of owner ? (catalog?.models ?? []) : []) {
    if (seen.has(model.model_id)) throw new Error("XCODE_DUPLICATE_CATALOG_MODEL");
    seen.add(model.model_id);
    if (!model.api_type || !model.enabled) {
      catalogIssues.push({
        source: "new-api",
        modelId: model.model_id,
        displayName: model.display_name,
        code: model.disabled_reason?.trim() || (!model.enabled ? "XCODE_MODEL_DISABLED" : "XCODE_MODEL_CONFIG_MISSING"),
      });
      continue;
    }
    const id = NEW_API_MODEL_PROVIDER_IDS[model.api_type];
    ids[id]!.push(model.model_id);
    modelPresentation[id]![model.model_id] = {
      displayName: model.display_name,
      ...(model.icon ? { icon: model.icon } : {}),
    };
  }
  const connectionKey = owner
    ? createHash("sha256").update(JSON.stringify(owner)).digest("hex")
    : undefined;
  const states: Record<string, AccountProviderStates[string]> = {};
  const providers = new ProviderConfigMap(
    Object.values(NEW_API_MODEL_PROVIDER_IDS).map((id) => {
      states[id] = {
        availability: entitled ? "available" : "unavailable",
        entitled,
        current: owner !== null,
        ...(connectionKey ? { connectionKey } : {}),
      };
      return [
        id,
        new ProviderConfig({
          access: new NewApiAccountAccessConfig({ entitled }),
          builtinModelIds: ids[id],
        }),
      ] as const;
    }),
  );
  const snapshot = {
    providers,
    states,
    owner,
    modelPresentation,
    catalogIssues,
    catalogRevision: catalog?.catalog_revision,
    authorizationRevision: entitlements?.authorization_revision,
  };
  return {
    ...snapshot,
    revision: `account:sha256:${createHash("sha256")
      .update(JSON.stringify([input.configRevision, snapshot]))
      .digest("hex")}`,
  };
}
