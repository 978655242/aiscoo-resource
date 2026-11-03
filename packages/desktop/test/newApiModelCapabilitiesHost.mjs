import {
  AccountProviderService,
  ProviderRegistryService,
  ProviderConfigMap,
  ProviderTemplateMap,
  ModelConfigRules,
  ModelConfig,
  ProviderConfig,
  ProviderApiConfig,
  ApiKeyAccessConfig,
  ProviderSettingsFacade,
} from "@zcode/provider";
import { createNewApiProviderAnchors, createNodeModelSelectionFacade } from "@zcode/provider-node";
import { AISCOO_MODEL_PROVIDER_IDS } from "@zcode/shared";
import { resolveNewApiAccountProviders } from "../../services/src/new-api/newApiAccountProviderResolution.ts";
import {
  owner,
  catalog,
  entitlements,
  modelConfig,
} from "../../services/test/newApiRegistryFixtures.ts";

export async function createCapabilityHost(ipcMain, getWindow) {
  let valuesA = ["disabled", "low", "high", "max"];
  let catalogReads = 0;
  const entries = () => [
    ["capability-a", "Capability A", valuesA, 64],
    ["capability-b", "Capability B", ["disabled", "high"], 32],
    ["capability-single", "Capability single", ["disabled"], 16],
  ];
  const rules = () =>
    new ModelConfigRules(
      entries().map(([modelId, _name, values, max]) => ({
        type: "provider-model",
        providerId: AISCOO_MODEL_PROVIDER_IDS["openai-chat-completions"],
        modelId,
        config: ModelConfig.fromData({
          ...modelConfig,
          optionSpecs: {
            reasoningLevel: {
              values,
              map: 'reasoningLevel == "disabled" ? {"thinking":{"type":"disabled"},"reasoning_effort":null} : {"thinking":{"type":"enabled"},"reasoning_effort":reasoningLevel}',
            },
            maxOutputTokens: { max, map: '{"max_tokens":maxOutputTokens}' },
          },
        }),
      })),
    );
  const config = {
    revision: "config-1",
    zcodeBuiltinRevision: "builtin-1",
    personalRevision: "personal-1",
    zcodeBuiltinProviders: createNewApiProviderAnchors(owner.origin),
    zcodeBuiltinProviderTemplates: ProviderTemplateMap.empty(),
    personalProviders: new ProviderConfigMap([
      {
        providerId: "custom",
        providerName: "Fixture custom",
        config: new ProviderConfig({
          group: "standard-personal",
          access: new ApiKeyAccessConfig({ apiKey: "sk-isolated-custom" }),
          api: new ProviderApiConfig({
            type: "openai-chat-completions",
            baseUrl: "https://fixture.invalid/v1",
          }),
          personalModelIds: ["custom-model"],
        }),
      },
    ]),
    zcodeBuiltinModelRules: rules(),
    personalModels: new ModelConfigRules([
      {
        type: "provider-model",
        providerId: "custom",
        modelId: "custom-model",
        config: ModelConfig.fromData({
          ...modelConfig,
          optionSpecs: {
            ...modelConfig.optionSpecs,
            reasoningLevel: { values: ["neutral", "custom-deep"], map: "{}" },
          },
        }),
      },
    ]),
  };
  const configSource = { read: async () => config, onDidChange: () => () => {} };
  const account = new AccountProviderService({
    configSource,
    resolve: async ({ configRevision }) => {
      catalogReads++;
      return resolveNewApiAccountProviders({
        owner,
        entitlements,
        configRevision,
        catalog: {
          ...catalog,
          catalog_revision: `capabilities-${catalogReads}`,
          models: [
            ...entries().map(([model_id, display_name]) => ({
              ...catalog.models[0],
              model_id,
              display_name,
              api_type: "openai-chat-completions",
            })),
            ...catalog.models.slice(1),
          ],
        },
      });
    },
  });
  const registry = new ProviderRegistryService({ configSource, accountSource: account });
  try {
    await registry.start();
    const facade = createNodeModelSelectionFacade(registry);
    const settings = new ProviderSettingsFacade(registry);
    ipcMain.handle("capability-view", (_event, input) =>
      facade.getView(undefined, undefined, input),
    );
    ipcMain.handle("capability-settings", () => settings.getView());
    ipcMain.handle("capability-metrics", () => ({
      catalogReads,
      appliedRevision: registry.getSnapshot().sourceRevisions.account,
    }));
    ipcMain.handle("capability-stage", (_event, next) => {
      valuesA = next;
    });
    ipcMain.handle("capability-refresh", async () => {
      // 配置更新通过同一 Built-in revision fence，目录只提供授权和展示。
      config.zcodeBuiltinModelRules = rules();
      config.zcodeBuiltinRevision = `builtin-${catalogReads + 1}`;
      config.revision = `config-${catalogReads + 1}`;
      await account.refresh("model-settings-refresh");
      await registry.refresh("model-settings-refresh");
      return facade.getView();
    });
    registry.onDidChange(() => getWindow()?.webContents.send("capability-changed"));
    return {
      dispose() {
        registry.dispose();
        account.dispose();
      },
    };
  } catch (error) {
    registry.dispose();
    account.dispose();
    throw error;
  }
}
