import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveEntitledAccountProviderAccess,
  resolveAccountProviderInspectionAccess,
} from "../../ui/src/lib/accountProviderAccess.js";
import {
  buildNativeCodingPlanUsageSource,
  resolveSidebarCurrentCodingPlanUsageSource,
} from "../../ui/src/lib/codingPlanUsageSources.js";
import { buildRegistryModelSelectGroups } from "../../ui/src/lib/modelSelectionGroups.js";
import {
  ProviderConfigMap,
  ProviderConfigResolver,
  ModelConfigRules,
  projectModelSelectionProviderView,
} from "@zcode/provider";
import { createNewApiProviderAnchors } from "@zcode/provider-node";
import { NewApiEntitlementsSchema, ZCODE_AGENT_PROVIDER } from "@zcode/shared";
import { resolveNewApiAccountProviders } from "../src/new-api/newApiAccountProviderResolution.js";
import { owner, catalog, entitlements } from "./newApiRegistryFixtures.js";
import { mapNewApiQuota } from "../src/new-api/newApiUsageMapper.js";
import { formatQuotaRemainingPercentage } from "../../ui/src/lib/codingPlanQuotaPresentation.js";
import { mapNewApiEntitlement } from "../src/new-api/newApiUsageMapper.js";
import { resolveCodingPlanUsageRemainingState } from "../../ui/src/lib/codingPlanUsageSources.js";
import { buildOfficialOffPeakModelSelectionView } from "../src/model-provider/offPeakModelSelectionView.js";
import { OFF_PEAK_PROVIDER_IDS } from "@zcode/shared";

const native = {
  type: "new-api-account",
  accountType: "new-api",
  mode: "private-subscription",
  entitled: true,
} as const;
const view = (access: unknown) =>
  ({
    revision: "native:1",
    providers: [
      {
        providerId: "account:new-api-anthropic-messages",
        providerName: "Native",
        effectiveConfig: { access },
        accountState: { availability: "available", connectionKey: "opaque-native-owner" },
      },
    ],
  }) as Parameters<typeof resolveEntitledAccountProviderAccess>[0];

test("Native managed account access is inspected without mapping to an official family", () => {
  const result = resolveEntitledAccountProviderAccess(
    view(native),
    "account:new-api-anthropic-messages",
  );
  assert.deepEqual(result?.access, native);
  assert.equal(result?.label, "Native");
});

test("Native inspection does not grant execution rights for an expired subscription", () => {
  const expired = { ...native, entitled: false };
  assert.equal(
    resolveEntitledAccountProviderAccess(view(expired), "account:new-api-anthropic-messages"),
    null,
  );
  assert.deepEqual(
    resolveAccountProviderInspectionAccess(view(expired), "account:new-api-anthropic-messages")
      ?.access,
    expired,
  );
});

test("Native usage remains account scoped for expired access and a custom selected model", () => {
  const source = buildNativeCodingPlanUsageSource(view({ ...native, entitled: false }));
  assert.equal(source?.label, "New API");
  const selected = resolveSidebarCurrentCodingPlanUsageSource({
    selectedProviderId: "personal:custom",
    accountAccesses: {},
    teamSources: [],
    nativeSource: source,
  });
  assert.equal(selected?.providerId, "account:new-api-anthropic-messages");
  assert.ok(selected?.audience === "individual");
  assert.equal(selected.accountAccess.type, "new-api-account");
});

test("Native usage source follows the projected transport when anthropic-messages is absent", () => {
  const chat = "account:new-api-openai-chat-completions";
  const only = (providerId: string, connectionKey?: string) =>
    ({
      revision: "native:1",
      providers: [
        {
          providerId,
          providerName: "Native",
          effectiveConfig: { access: native },
          accountState: { availability: "available", connectionKey },
        },
      ],
    }) as Parameters<typeof buildNativeCodingPlanUsageSource>[0];
  assert.equal(buildNativeCodingPlanUsageSource(only(chat, "owner"))?.providerId, chat);
  assert.equal(buildNativeCodingPlanUsageSource(only(chat, "owner"), chat)?.providerId, chat);
  // 没有 Host owner 的静态 anchor 仍不能成为额度来源。
  assert.equal(buildNativeCodingPlanUsageSource(only(chat)), null);
});

test("Native model menus omit catalog issues and keep selectable models", () => {
  const account = resolveNewApiAccountProviders({ owner, catalog, entitlements });
  const resolution = new ProviderConfigResolver().resolve({
    zcodeBuiltinProviders: createNewApiProviderAnchors(owner.origin),
    personalProviders: ProviderConfigMap.empty(),
    personalModels: ModelConfigRules.empty(),
    zcodeBuiltinModelRules: ModelConfigRules.empty(),
    accountProviders: account.providers,
    accountModelConfigs: account.modelConfigs,
    accountStates: account.states,
  });
  const groups = buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, {
    revision: 1,
    providers: resolution.registryProviders.map(projectModelSelectionProviderView),
    catalogIssues: account.catalogIssues,
  });
  assert.deepEqual(
    groups.flatMap((group) => group.items.map((item) => item.name)),
    ["Real"],
  );
  assert.ok(groups.every((group) => group.items.length > 0));
  assert.deepEqual(
    buildRegistryModelSelectGroups(ZCODE_AGENT_PROVIDER, {
      revision: 2,
      providers: resolution.registryProviders.map((provider) => ({
        ...projectModelSelectionProviderView(provider),
        models: [],
      })),
      catalogIssues: account.catalogIssues,
    }),
    [],
  );
});

test("Native compact quota reads the actual period and never displays unlimited as zero", () => {
  const finite = NewApiEntitlementsSchema.parse({
    ...entitlements,
    quota: {
      scope: "zen-subscription",
      unit: "quota",
      unlimited: false,
      total: "100",
      used: "25",
      remaining: "75",
      used_percentage: 25,
      reset_period: "monthly",
      reset_custom_seconds: "0",
      last_reset_time: 1800000000000,
      next_reset_time: 1802592000000,
      reset_time_zone: "America/New_York",
      reset_utc_offset_seconds: -14400,
    },
  });
  const quota = mapNewApiQuota(finite);
  assert.equal(quota?.limits[0]?.native?.period, "monthly");
  assert.equal(formatQuotaRemainingPercentage("en-US", quota?.limits[0] ?? null), "75%");
  const unlimited = NewApiEntitlementsSchema.parse({
    ...finite,
    quota: {
      ...finite.quota,
      unlimited: true,
      total: null,
      remaining: null,
      used_percentage: null,
    },
  });
  const limit = mapNewApiQuota(unlimited)?.limits[0] ?? null;
  assert.equal(formatQuotaRemainingPercentage("en-US", limit), "Unlimited");
  assert.equal(formatQuotaRemainingPercentage("zh-CN", limit), "无限制");
  assert.equal(formatQuotaRemainingPercentage("en-US", null), "--");
});

test("Expired Native quota remains inspectable without becoming an active Coding Plan", () => {
  const providerId = "account:new-api-anthropic-messages";
  const access = { ...native, entitled: false };
  const snapshot = mapNewApiEntitlement(
    {
      ...entitlements,
      status: "expired",
      quota: {
        scope: "zen-subscription",
        unit: "quota",
        unlimited: false,
        total: "100",
        used: "25",
        remaining: "75",
        used_percentage: 25,
        reset_period: "monthly",
        reset_custom_seconds: "0",
        last_reset_time: 1800000000000,
        next_reset_time: 1802592000000,
        reset_time_zone: "America/New_York",
        reset_utc_offset_seconds: -14400,
      },
    },
    providerId,
  );
  const state = resolveCodingPlanUsageRemainingState({
    availableProviders: [{ providerId, accountAccess: access, label: "New API" }],
    entitlements: [{ providerId, accountAccess: access, snapshot, loading: false, error: null }],
    modelProvidersLoading: false,
    selectedProviderId: providerId,
  });
  assert.ok(state);
  assert.equal(state.hasAnyActiveCodingPlan, false);
  assert.equal(state.visibleSnapshot?.authorizationStatus, "expired");
  assert.equal(
    formatQuotaRemainingPercentage("en-US", state.visibleSnapshot?.quota?.limits[0] ?? null),
    "75%",
  );
});

test("official off-peak selectors admit only matching entitled official access, never Native or absent access", () => {
  const providerId = OFF_PEAK_PROVIDER_IDS.bigmodel;
  const config = { visibility: "hidden" as const };
  const officialView: Parameters<typeof buildOfficialOffPeakModelSelectionView>[0] = {
    revision: 1,
    providers: [
      { providerId, config, models: [] },
      { providerId, config: { ...config, access: null }, models: [] },
      { providerId, config: { ...config, access: native }, models: [] },
      {
        providerId,
        config: {
          ...config,
          access: { type: "zhipu-account", accountType: "zai", entitled: true },
        },
        models: [],
      },
      {
        providerId,
        config: {
          ...config,
          access: { type: "zhipu-account", accountType: "bigmodel", entitled: false },
        },
        models: [],
      },
      {
        providerId,
        config: {
          ...config,
          access: { type: "zhipu-account", accountType: "bigmodel", entitled: true },
        },
        models: [],
      },
    ],
  };
  assert.deepEqual(buildOfficialOffPeakModelSelectionView(officialView, "bigmodel").providers, [
    officialView.providers[5],
  ]);
});
