import { afterEach, expect, it, vi } from "vitest";
import {
  AccountProviderService,
  ModelConfigRules,
  ProviderConfigMap,
  ProviderRegistryService,
  ProviderTemplateMap,
  type ProviderConfigSnapshot,
} from "../../provider/src/index.js";
import { createNewApiProviderAnchors } from "../../provider-node/src/new-api-provider-anchors.js";
import { ChannelClient, ChannelServer, createQueuePair, Emitter, Event } from "@zcode/rpc";
import type { NewApiOwner } from "@zcode/shared";
import { createNewApiAccountProviderResolver } from "../../services/src/new-api/newApiAccountProviderResolution.js";
import { createNewApiAccountRequestAuthResolver } from "../../services/src/model-provider/accountProviderRequestAuthService.js";
import {
  catalog,
  entitlements,
  builtinModelRules,
  owner as fixtureOwner,
} from "../../services/test/newApiRegistryFixtures.js";
import {
  BROWSER_ACCOUNT_CHANNEL,
  createBrowserAccountBridge,
  type BrowserAccountSessionEvent,
} from "../src/aiscoo-browser-account/index.js";

const owner: NewApiOwner = { ...fixtureOwner, origin: "https://browser-account.example.test" };
const providerId = "account:aiscoo-openai-chat-completions";
const browserCatalog = {
  ...catalog,
  models: [
    {
      ...catalog.models[0]!,
      api_type: "openai-chat-completions" as const,
    },
  ],
};
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const dispose of cleanups.splice(0).reverse()) dispose();
});

function browserPeer(label: string, account: NewApiOwner = owner) {
  const control = `synthetic-${label}-browser-control`;
  const relay = { token: `sk-synthetic-${label}-browser-relay`, expiresAt: Date.now() + 60_000 };
  const changes = new Emitter<BrowserAccountSessionEvent>();
  const [browserProtocol, hostProtocol] = createQueuePair();
  const browser = new ChannelServer(browserProtocol, "browser");
  const host = new ChannelClient(hostProtocol);
  const call = vi.fn(async (command: string, arg?: unknown): Promise<unknown> => {
    if (command === "restore")
      return {
        owner: account,
        session: {
          status: "authenticated",
          userInfo: { id: account.userId, username: "synthetic", displayName: "Synthetic" },
        },
      };
    expect(arg).toEqual({ owner: account });
    if (command === "control") return { owner: account, accessToken: control };
    if (command === "relay") return relay;
    throw new Error("Unexpected browser command");
  });
  browser.registerChannel(BROWSER_ACCOUNT_CHANNEL, {
    call: <T>(_ctx: string, command: string, arg?: unknown) => call(command, arg) as Promise<T>,
    listen<T>(_ctx: string, event: string) {
      expect(event).toBe("session");
      return changes.event as Event<T>;
    },
  });
  cleanups.push(() => {
    host.dispose();
    browser.dispose();
    changes.dispose();
  });
  return { host, changes, call, control, relay };
}

async function fixture() {
  const config: ProviderConfigSnapshot = {
    revision: "browser-config-1",
    zcodeBuiltinRevision: "builtin-1",
    personalRevision: "personal-1",
    zcodeBuiltinProviders: createNewApiProviderAnchors(owner.origin),
    zcodeBuiltinProviderTemplates: ProviderTemplateMap.empty(),
    personalProviders: ProviderConfigMap.empty(),
    zcodeBuiltinModelRules: builtinModelRules(),
    personalModels: ModelConfigRules.empty(),
  };
  const configSource = { read: async () => config, onDidChange: () => () => {} };
  let accountSource: AccountProviderService;
  const hook = vi.fn(() => accountSource.invalidateNative(true));
  const bridge = createBrowserAccountBridge(owner.origin, { onOwnerChanged: hook });
  const client = {
    getEntitlements: vi.fn(async (_token: string) => entitlements),
    getModels: vi.fn(async (_token: string) => browserCatalog),
  };
  accountSource = new AccountProviderService({
    configSource,
    resolve: createNewApiAccountProviderResolver({ account: bridge.authority, client }),
  });
  const registry = new ProviderRegistryService({ configSource, accountSource });
  const first = browserPeer("a");
  cleanups.push(() => {
    registry.dispose();
    bridge.dispose();
    accountSource.dispose();
  });
  const attachment = bridge.attach(first.host);
  await attachment.ready;
  await registry.start();
  const snapshot = await accountSource.read();
  const provider = registry.getProvider(providerId)!;
  const model = registry.getModel(providerId, "real-model")!;
  const access = provider.config.access;
  if (access.type !== "new-api-account") throw new Error("Expected Native Registry access");
  const request = Object.freeze({
    providerId: provider.providerId,
    modelId: model.modelId,
    reason: "model-request" as const,
    accountAccess: Object.freeze({
      ...access,
      owner: provider.accountOwner,
      authorizationRevision: provider.accountAuthorizationRevision,
    }),
  });
  const unexpectedOfficial = vi.fn(async (): Promise<never> => {
    throw new Error("Unexpected official auth");
  });
  const auth = createNewApiAccountRequestAuthResolver({
    account: bridge.authority,
    accountSource,
    official: {
      resolveAccessCurrent: unexpectedOfficial,
      assertCurrent: unexpectedOfficial,
      resolveCurrent: unexpectedOfficial,
    },
  });
  return {
    bridge,
    hook,
    client,
    accountSource,
    registry,
    first,
    attachment,
    snapshot,
    provider,
    model,
    request,
    auth,
    unexpectedOfficial,
  };
}

it.each(["session", "detach"] as const)(
  "browser authority feeds Chat Registry/request auth and revokes on %s",
  async (invalidation) => {
    const {
      bridge,
      client,
      accountSource,
      registry,
      first,
      attachment,
      snapshot,
      provider,
      model,
      request,
      auth,
      unexpectedOfficial,
    } = await fixture();
    expect(bridge.authority.getOwner()).toEqual(owner);
    expect(snapshot.owner).toEqual(owner);
    expect(client.getEntitlements).toHaveBeenCalledExactlyOnceWith(first.control);
    expect(client.getModels).toHaveBeenCalledExactlyOnceWith(first.control);
    expect(model).toMatchObject({ modelId: "real-model", displayName: "Real" });
    expect(provider.config.api.baseUrl).toBe(`${owner.origin}/v1`);
    expect(Object.isFrozen(provider)).toBe(true);
    await expect(auth.resolveCurrent(request)).resolves.toEqual({ apiKey: first.relay.token });
    expect(first.call.mock.calls.map(([command]) => command)).toEqual([
      "restore",
      "control",
      "relay",
    ]);
    for (const secret of [first.control, first.relay.token])
      expect(JSON.stringify(snapshot)).not.toContain(secret);
    const relayStarted = Promise.withResolvers<void>();
    const delayedRelay = Promise.withResolvers<typeof first.relay>();
    first.call.mockImplementationOnce(() => {
      relayStarted.resolve();
      return delayedRelay.promise;
    });
    const inFlight = auth.resolveCurrent(request);
    const rejected = expect(inFlight).rejects.toThrow("XCODE_STALE_OWNER");
    await relayStarted.promise;
    if (invalidation === "session") {
      const signedOut = Event.toPromise(bridge.authority.oauth.onDidChangeSession);
      first.changes.fire({ owner: null });
      expect(await signedOut).toBe("signed-out");
    } else attachment.dispose();
    expect(bridge.authority.getOwner()).toBeNull();
    expect((await accountSource.read()).owner).toBeNull();
    delayedRelay.resolve(first.relay);
    await rejected;
    await registry.refresh("browser-owner-invalidated");
    expect(registry.getModel(providerId, model.modelId)).toBeUndefined();
    expect(
      registry.validateSelection({
        providerId,
        modelId: model.modelId,
        options: { reasoningLevel: "none" },
      }),
    ).toMatchObject({ ok: false, code: "provider-not-found" });
    await expect(auth.resolveCurrent(request)).rejects.toThrow(
      "Account request credential is unavailable",
    );
    expect(first.call.mock.calls.filter(([command]) => command === "relay")).toHaveLength(2);
    expect(unexpectedOfficial).not.toHaveBeenCalled();
  },
);

// 目录/revision 由 Host 唯一账号事实派生；同 owner 标签的增减不能使已选模型失效。
it("keeps the owner, catalog revisions and selection while matching B remains after A closes", async () => {
  const {
    bridge,
    hook,
    client,
    accountSource,
    registry,
    first,
    attachment,
    snapshot,
    model,
    request,
    auth,
    unexpectedOfficial,
  } = await fixture();
  const registrySnapshot = registry.getSnapshot();
  const acceptedOwner = bridge.authority.getOwner();
  const selected = { providerId, modelId: model.modelId, options: { reasoningLevel: "none" } };
  const selection = registry.validateSelection(selected);
  expect(selection.ok).toBe(true);
  const second = browserPeer("b");
  const secondAttachment = bridge.attach(second.host);
  await secondAttachment.ready;
  expect(await accountSource.read()).toBe(snapshot);
  expect(registry.getSnapshot()).toBe(registrySnapshot);
  expect(hook).toHaveBeenCalledTimes(1);
  await expect(auth.resolveCurrent(request)).resolves.toEqual({ apiKey: second.relay.token });
  attachment.dispose();
  attachment.dispose();
  expect(bridge.authority.getOwner()).toBe(acceptedOwner);
  expect(await accountSource.read()).toBe(snapshot);
  expect(registry.getSnapshot()).toBe(registrySnapshot);
  expect(registry.getSnapshot()?.sourceRevisions).toEqual(registrySnapshot?.sourceRevisions);
  expect(registry.getModel(providerId, model.modelId)).toBe(model);
  expect(registry.validateSelection(selected)).toEqual(selection);
  expect(hook).toHaveBeenCalledExactlyOnceWith(owner);
  await expect(bridge.authority.withControlSession(async (token) => token)).resolves.toBe(
    second.control,
  );
  await expect(auth.resolveCurrent(request)).resolves.toEqual({ apiKey: second.relay.token });
  expect(client.getEntitlements).toHaveBeenCalledTimes(1);
  expect(client.getModels).toHaveBeenCalledTimes(1);
  expect(first.call.mock.calls.map(([command]) => command)).toEqual(["restore", "control"]);
  for (const secret of [first.control, first.relay.token, second.control, second.relay.token])
    expect(JSON.stringify(await accountSource.read())).not.toContain(secret);
  secondAttachment.dispose();
  expect(bridge.authority.getOwner()).toBeNull();
  expect(hook.mock.calls).toEqual([[owner], [null]]);
  expect((await accountSource.read()).owner).toBeNull();
  await registry.refresh("last-browser-detached");
  expect(registry.getModel(providerId, model.modelId)).toBeUndefined();
  expect(registry.validateSelection(selected).ok).toBe(false);
  await expect(auth.resolveCurrent(request)).rejects.toThrow(
    "Account request credential is unavailable",
  );
  expect(unexpectedOfficial).not.toHaveBeenCalled();
});

it("rejects A's late request credential after A closes even when B keeps the same Registry owner", async () => {
  const { bridge, accountSource, registry, first, attachment, snapshot, request, auth } =
    await fixture();
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<typeof first.relay>();
  first.call.mockImplementationOnce(() => {
    entered.resolve();
    return response.promise;
  });
  const inFlight = auth.resolveCurrent(request);
  const rejected = expect(inFlight).rejects.toThrow("XCODE_STALE_OWNER");
  await entered.promise;
  const second = browserPeer("b");
  await bridge.attach(second.host).ready;
  attachment.dispose();
  response.resolve(first.relay);
  await rejected;
  expect(await accountSource.read()).toBe(snapshot);
  expect(
    registry.validateSelection({
      providerId,
      modelId: request.modelId,
      options: { reasoningLevel: "none" },
    }).ok,
  ).toBe(true);
  expect(second.call.mock.calls.map(([command]) => command)).toEqual(["restore"]);
  await expect(auth.resolveCurrent(request)).resolves.toEqual({ apiKey: second.relay.token });
});

it.each([
  { label: "another user", account: { ...owner, userId: "2" } },
  { label: "another SID for the same user", account: { ...owner, sid: "other-sid" } },
  {
    label: "another generation for the same user and SID",
    account: { ...owner, authGeneration: owner.authGeneration + 1 },
  },
])("rejects C with $label without exposing or invalidating A's Registry", async ({ account }) => {
  const { bridge, hook, accountSource, registry, snapshot, request, auth, first } = await fixture();
  const registrySnapshot = registry.getSnapshot();
  const third = browserPeer("c", account);
  const thirdAttachment = bridge.attach(third.host);
  await expect(thirdAttachment.ready).rejects.toThrow("XCODE_BROWSER_ACCOUNT_MISMATCH");
  await expect(thirdAttachment.oauth.restoreCachedSessionState()).rejects.toThrow(
    "XCODE_BROWSER_ACCOUNT_MISMATCH",
  );
  third.changes.fire({ owner: account });
  thirdAttachment.dispose();
  expect(await accountSource.read()).toBe(snapshot);
  expect(registry.getSnapshot()).toBe(registrySnapshot);
  expect(
    registry.validateSelection({
      providerId,
      modelId: request.modelId,
      options: { reasoningLevel: "none" },
    }).ok,
  ).toBe(true);
  expect(hook).toHaveBeenCalledExactlyOnceWith(owner);
  await expect(auth.resolveCurrent(request)).resolves.toEqual({ apiKey: first.relay.token });
  expect(third.call).toHaveBeenCalledExactlyOnceWith("restore", undefined);
});

it.each([
  { label: "logout", account: null },
  { label: "same-user SID change", account: { ...owner, sid: "replaced-native-sid" } },
])("revokes B's pending request and selected model on A's $label", async ({ account }) => {
  const { bridge, hook, accountSource, registry, first, request, auth } = await fixture();
  const second = browserPeer("b");
  const secondAttachment = bridge.attach(second.host);
  await secondAttachment.ready;
  const invalidated: string[] = [];
  secondAttachment.onDidInvalidate((reason) => invalidated.push(reason));
  const entered = Promise.withResolvers<void>();
  const response = Promise.withResolvers<typeof second.relay>();
  second.call.mockImplementationOnce(() => {
    entered.resolve();
    return response.promise;
  });
  const reading = auth.resolveCurrent(request);
  const rejected = expect(reading).rejects.toThrow("XCODE_STALE_OWNER");
  await entered.promise;
  const revoked = Event.toPromise(secondAttachment.onDidInvalidate);
  first.changes.fire({ owner: account });
  // 真实队列异步交付 session；以 Host 的撤销事件确认已处理，不用等待时长猜测同步。
  expect(await revoked).toBe("owner-changed");
  expect(bridge.authority.getOwner()).toEqual(account);
  expect((await accountSource.read()).owner).toBeNull();
  expect(invalidated).toEqual(["owner-changed"]);
  second.changes.fire({ owner });
  response.resolve(second.relay);
  await rejected;
  expect(bridge.authority.getOwner()).toEqual(account);
  expect(hook.mock.calls).toEqual([[owner], [account]]);
  await registry.refresh("browser-owner-replaced");
  expect(registry.getModel(providerId, request.modelId)).toBeUndefined();
  expect(
    registry.validateSelection({
      providerId,
      modelId: request.modelId,
      options: { reasoningLevel: "none" },
    }),
  ).toMatchObject({ ok: false, code: "provider-not-found" });
  await expect(auth.resolveCurrent(request)).rejects.toThrow(
    "Account request credential is unavailable",
  );
  expect(second.call.mock.calls.map(([command]) => command)).toEqual(["restore", "relay"]);
});

it("keeps Native cross-Host and non-model request auth restrictions", async () => {
  const { first, request, auth, unexpectedOfficial } = await fixture();
  expect(() => auth.resolveAccessCurrent(request.accountAccess)).toThrow(
    "XCODE_PRIVATE_REMOTE_UNSUPPORTED",
  );
  await expect(auth.resolveCurrent({ ...request, reason: "off-peak" })).rejects.toThrow(
    "XCODE_PRIVATE_OFF_PEAK_UNSUPPORTED",
  );
  await expect(auth.resolveCurrent({ ...request, reason: "usage" })).rejects.toThrow(
    "XCODE_PRIVATE_USAGE_AUTH_UNSUPPORTED",
  );
  await expect(auth.resolveCurrent({ ...request, modelId: undefined })).rejects.toThrow(
    "Account request credential is unavailable",
  );
  await expect(auth.resolveCurrent({ ...request, modelId: "missing" })).rejects.toThrow(
    "Account request credential is unavailable",
  );
  await expect(
    auth.resolveCurrent({
      ...request,
      accountAccess: { ...request.accountAccess, authorizationRevision: "stale-authorization" },
    }),
  ).rejects.toThrow("Account request credential is unavailable");
  expect(first.call.mock.calls.map(([command]) => command)).toEqual(["restore", "control"]);
  expect(unexpectedOfficial).not.toHaveBeenCalled();
});

it.each(["authorization", "model"] as const)(
  "does not release a pending relay credential when %s changes during the model request",
  async (change) => {
    const { client, accountSource, first, request, auth } = await fixture();
    const entered = Promise.withResolvers<void>();
    const response = Promise.withResolvers<typeof first.relay>();
    first.call.mockImplementationOnce(() => {
      entered.resolve();
      return response.promise;
    });
    const reading = auth.resolveCurrent(request);
    const rejected = expect(reading).rejects.toThrow("Account request credential is unavailable");
    await entered.promise;
    if (change === "authorization") {
      client.getEntitlements.mockResolvedValue({
        ...entitlements,
        authorization_revision: "next-authorization",
      });
      client.getModels.mockResolvedValue({
        ...browserCatalog,
        authorization_revision: "next-authorization",
      });
    } else client.getModels.mockResolvedValue({ ...browserCatalog, models: [] });
    await accountSource.refresh("native-request-fact-changed");
    response.resolve(first.relay);
    await rejected;
    expect(first.call.mock.calls.map(([command]) => command)).toEqual([
      "restore",
      "control",
      "relay",
      "control",
    ]);
  },
);
