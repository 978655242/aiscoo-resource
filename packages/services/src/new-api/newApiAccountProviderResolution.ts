import { createHash } from "node:crypto";
import {
  NewApiAccountAccessConfig,
  ZhipuAccountAccessConfig,
  ProviderConfig,
  ProviderConfigMap,
  type AccountProviderResolver,
  type AccountProviderStates,
  type AccountModelPresentation,
} from "@zcode/provider";
import {
  NEW_API_MODEL_PROVIDER_IDS,
  type NewApiCatalog,
  type NewApiEntitlements,
  type NewApiOwner,
  type NewApiCatalogIssue,
} from "@zcode/shared";
import type { NewApiAccountService } from "./newApiAccountService.js";
import type { NewApiClient } from "./newApiClient.js";

export function resolveNewApiAccountProviders(input: {
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
    throw new Error("Native authorization revision mismatch");
  const entitled =
    owner !== null && entitlements?.status === "active" && entitlements.subscription !== null;
  const modelPresentation: Record<
    string,
    Record<string, AccountModelPresentation[string][string]>
  > = {};
  const catalogIssues: NewApiCatalogIssue[] = [];
  const seen = new Set<string>();
  const ids: Record<string, string[]> = {};
  for (const id of Object.values(NEW_API_MODEL_PROVIDER_IDS)) {
    ids[id] = [];
    modelPresentation[id] = Object.create(null);
  }
  for (const model of owner ? (catalog?.models ?? []) : []) {
    if (seen.has(model.model_id)) throw new Error("Native duplicate catalog model");
    seen.add(model.model_id);
    if (!model.api_type || !model.enabled) {
      catalogIssues.push({
        source: "new-api",
        modelId: model.model_id,
        displayName: model.display_name,
        code:
          model.disabled_reason?.trim() ||
          (!model.enabled ? "XCODE_MODEL_DISABLED" : "XCODE_MODEL_CONFIG_MISSING"),
      });
      continue;
    }
    const providerId = NEW_API_MODEL_PROVIDER_IDS[model.api_type];
    ids[providerId]!.push(model.model_id);
    modelPresentation[providerId]![model.model_id] = {
      displayName: model.display_name,
      ...(model.icon ? { icon: model.icon } : {}),
    };
  }
  const connectionKey = owner
    ? createHash("sha256").update(JSON.stringify(owner)).digest("hex")
    : undefined;
  const states: Record<string, AccountProviderStates[string]> = {};
  const providers = new ProviderConfigMap(
    Object.values(NEW_API_MODEL_PROVIDER_IDS).map((providerId) => {
      states[providerId] = {
        availability: entitled ? "available" : "unavailable",
        entitled,
        current: owner !== null,
        ...(connectionKey ? { connectionKey } : {}),
      };
      return [
        providerId,
        new ProviderConfig({
          access: new NewApiAccountAccessConfig({ entitled }),
          builtinModelIds: ids[providerId],
        }),
      ] as const;
    }),
  );
  const resolved = {
    providers,
    states,
    owner,
    modelPresentation,
    catalogIssues,
    catalogRevision: catalog?.catalog_revision,
    authorizationRevision: entitlements?.authorization_revision,
  };
  return {
    ...resolved,
    revision: `account:sha256:${createHash("sha256")
      .update(JSON.stringify([input.configRevision, resolved]))
      .digest("hex")}`,
  };
}

/** Native ordinary inference and official hidden services share the existing account source, never credentials. */
export function createNewApiAccountProviderResolver(options: {
  account: Pick<NewApiAccountService, "getOwner" | "isCurrent" | "withControlSession">;
  client: Pick<NewApiClient, "getEntitlements" | "getModels">;
  resolveOfficial?: AccountProviderResolver;
}): AccountProviderResolver {
  return async (input) => {
    const official = options.resolveOfficial ? await options.resolveOfficial(input) : undefined;
    const owner = options.account.getOwner();
    const native = owner
      ? await options.account.withControlSession(async (token, capturedOwner) => {
          const [entitlements, catalog] = await Promise.all([
            options.client.getEntitlements(token),
            options.client.getModels(token),
          ]);
          if (!options.account.isCurrent(capturedOwner)) throw new Error("XCODE_STALE_OWNER");
          return resolveNewApiAccountProviders({
            owner: capturedOwner,
            entitlements,
            catalog,
            configRevision: input.configRevision,
          });
        })
      : resolveNewApiAccountProviders({ owner: null, configRevision: input.configRevision });
    // Old official Plan refs remain visible for history/settings but cannot execute ordinary inference.
    const old = input.configuredProviders
      .entries()
      .filter(([, config]) => config.access?.type === "zhipu-account")
      .map(
        ([id, config]) =>
          [
            id,
            config.access?.type === "zhipu-account" && config.access.mode === "off-peak"
              ? (official?.providers.get(id) ??
                new ProviderConfig({ access: new ZhipuAccountAccessConfig({ entitled: false }) }))
              : new ProviderConfig({
                  access: new ZhipuAccountAccessConfig({ entitled: false }),
                  builtinModelIds: [],
                }),
          ] as const,
      );
    const resolved = {
      ...native,
      providers: new ProviderConfigMap(old).overlay(native.providers),
      states: {
        ...Object.fromEntries(
          old.map<[string, AccountProviderStates[string]]>(([id]) => [
            id,
            official?.states[id] && input.configuredProviders.get(id)?.visibility === "hidden"
              ? official.states[id]
              : { availability: "unavailable", entitled: false, current: false },
          ]),
        ),
        ...native.states,
      },
    };
    return {
      ...resolved,
      revision: `account:sha256:${createHash("sha256")
        .update(JSON.stringify([input.configRevision, resolved]))
        .digest("hex")}`,
    };
  };
}
