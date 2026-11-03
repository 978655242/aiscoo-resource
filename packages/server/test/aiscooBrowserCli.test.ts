import { expect, it } from "vitest";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AccountProviderService,
  ProviderConfigMap,
  ProviderRegistryService,
  ProviderTemplateMap,
  projectModelSelectionProviderView,
} from "../../provider/src/index.js";
import {
  createNodeProviderConfigRuntime,
  serializeZCodeBuiltinRelease,
} from "../../provider-node/src/index.js";
import { ChannelClient, ChannelServer, createQueuePair, Emitter, type Event } from "@zcode/rpc";
import { createZCodeAgentService } from "../../services/src/zcode-agent/zcodeAgentService.js";
import { createAiscooAdminAccountProviderResolver } from "../../services/src/aiscoo-admin/aiscooAdminAccountProviderResolution.js";
import { createAiscooAdminAccountRequestAuthResolver } from "../../services/src/aiscoo-admin-request-auth/index.js";
import { AiscooAdminClient } from "../../services/src/aiscoo-admin/aiscooAdminClient.js";
import {
  catalog,
  entitlements,
  builtinModelRules,
  owner as fixtureOwner,
} from "../../services/test/aiscooAdminRegistryFixtures.js";
import {
  BROWSER_ACCOUNT_CHANNEL,
  createBrowserAccountBridge,
  type BrowserAccountSessionEvent,
} from "../src/aiscoo-browser-account/index.js";

it("browser QueuePair authority authorizes a real CLI model HTTP request through the existing Registry", async () => {
  // macOS 的 Unix socket 路径受长度限制，隔离根使用短路径避免嵌套临时目录超限。
  const dir = await mkdtemp(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "bc-"));
  const control = "synthetic-cli-browser-control";
  const relay = "sk-synthetic-cli-browser-relay";
  const commands: string[] = [];
  const requests: Array<{ path: string; model?: string; relayAuthorized: boolean }> = [];
  const errors: unknown[] = [];
  const browserCatalog = {
    ...catalog,
    models: [
      {
        ...catalog.models[0]!,
        api_type: "openai-chat-completions" as const,
      },
    ],
  };
  const peer = createServer(async (request, response) => {
    try {
      response.setHeader("content-type", "application/json");
      if (request.url === "/api/xcode/v1/entitlements" || request.url === "/api/xcode/v1/models") {
        expect(request.headers.authorization === `Bearer ${control}`).toBe(true);
        response.end(
          JSON.stringify({
            success: true,
            data: request.url.endsWith("/models") ? browserCatalog : entitlements,
          }),
        );
        return;
      }
      expect(request.url).toBe("/v1/chat/completions");
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      const body = JSON.parse(raw);
      requests.push({
        path: request.url!,
        model: body.model,
        relayAuthorized: request.headers.authorization === `Bearer ${relay}`,
      });
      expect(requests[requests.length - 1]!.relayAuthorized).toBe(true);
      expect(body.model).toBe("real-model");
      response.end(
        JSON.stringify({
          id: "browser-cli-fixture",
          object: "chat.completion",
          created: 1,
          model: "real-model",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "browser-cli-ok" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        }),
      );
    } catch (error) {
      errors.push(error);
      response.statusCode = 500;
      response.end("{}");
    }
  });
  peer.listen(0, "127.0.0.1");
  await once(peer, "listening");
  const address = peer.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback server");
  const owner = { ...fixtureOwner, origin: `http://127.0.0.1:${address.port}` };
  const builtinPath = join(dir, "builtin.json");
  const personalPath = join(dir, "personal.json");
  const workspacePath = join(dir, "workspace");
  await mkdir(workspacePath);
  await writeFile(
    builtinPath,
    serializeZCodeBuiltinRelease({
      schemaVersion: 1,
      revision: 1,
      config: {
        providers: ProviderConfigMap.empty(),
        providerTemplates: ProviderTemplateMap.empty(),
        modelConfigRules: builtinModelRules(),
      },
    }),
  );
  const config = createNodeProviderConfigRuntime({
    zcodeBuiltinFilePath: builtinPath,
    personalFilePath: personalPath,
    aiscooAdminOrigin: owner.origin,
    watch: false,
    personalPollingIntervalMs: false,
  });
  let accountSource: AccountProviderService | undefined;
  const bridge = createBrowserAccountBridge(owner.origin, {
    onOwnerChanged: () => accountSource?.invalidateNative(true),
  });
  const changes = new Emitter<BrowserAccountSessionEvent>();
  const [browserProtocol, hostProtocol] = createQueuePair();
  const browser = new ChannelServer(browserProtocol, "browser");
  const host = new ChannelClient(hostProtocol);
  browser.registerChannel(BROWSER_ACCOUNT_CHANNEL, {
    async call<T>(_ctx: string, command: string, arg?: { owner: typeof owner }): Promise<T> {
      commands.push(command);
      if (command === "restore")
        return {
          owner,
          session: {
            status: "authenticated",
            userInfo: { id: owner.userId, username: "synthetic", displayName: "Synthetic" },
          },
        } as T;
      expect(arg?.owner).toEqual(owner);
      if (command === "control") return { owner, accessToken: control } as T;
      if (command === "relay") return { token: relay, expiresAt: Date.now() + 60_000 } as T;
      throw new Error("Unexpected browser command");
    },
    listen<T>() {
      return changes.event as Event<T>;
    },
  });
  let registry: ProviderRegistryService | undefined;
  let agent: ReturnType<typeof createZCodeAgentService> | undefined;
  try {
    await bridge.attach(host).ready;
    await config.start();
    accountSource = new AccountProviderService({
      configSource: config.configService,
      resolve: createAiscooAdminAccountProviderResolver({
        account: bridge.authority,
        client: new AiscooAdminClient(owner.origin),
      }),
    });
    registry = new ProviderRegistryService({ configSource: config.configService, accountSource });
    await registry.start();
    const selection = {
      providerId: "account:aiscoo-openai-chat-completions",
      modelId: "real-model",
      options: { reasoningLevel: "none" },
    };
    expect(registry.validateSelection(selection).ok).toBe(true);
    expect(registry.getProvider(selection.providerId)?.config.api.baseUrl).toBe(
      `${owner.origin}/v1`,
    );
    const unexpectedOfficial = async (): Promise<never> => {
      throw new Error("Unexpected official credential authority");
    };
    const auth = createAiscooAdminAccountRequestAuthResolver({
      account: bridge.authority,
      accountSource,
      official: {
        resolveCurrent: unexpectedOfficial,
        resolveAccessCurrent: unexpectedOfficial,
        assertCurrent: unexpectedOfficial,
      },
    });
    const isolatedEnv = {
      HOME: dir,
      USERPROFILE: dir,
      ZCODE_DATA_BASE_DIR: dir,
      TMPDIR: dir,
      XDG_CONFIG_HOME: join(dir, "config"),
      XDG_CACHE_HOME: join(dir, "cache"),
      XDG_DATA_HOME: join(dir, "data"),
      XDG_STATE_HOME: join(dir, "state"),
      AISCOO_ADMIN_BASE_URL: owner.origin,
      ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: builtinPath,
      ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: personalPath,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    };
    agent = createZCodeAgentService({
      commandResolver: () => ({
        command: process.execPath,
        args: [
          fileURLToPath(
            new URL("../../../apps/zcode-cli/packages/cli/dist/zcode.cjs", import.meta.url),
          ),
          "app-server",
          "--stdio",
        ],
        cwd: workspacePath,
        env: isolatedEnv,
      }),
      requestTimeoutMs: 20_000,
      accountProviderConfigSource: accountSource,
      accountRequestAuthService: auth,
      modelSelectionReadinessSource: {
        getView: async () => ({
          revision: 1,
          providers: registry!.listProviders().map(projectModelSelectionProviderView),
        }),
      },
    });
    const result = await agent.generateWorkspaceText({
      workspacePath,
      selection,
      prompt: "Return the synthetic fixture",
      querySource: "browser-cli-isolated-test",
      maxOutputTokens: 32,
      requestTimeoutMs: 20_000,
    });
    expect(result).toMatchObject({
      text: "browser-cli-ok",
      selection,
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    });
    expect(requests).toEqual([
      { path: "/v1/chat/completions", model: "real-model", relayAuthorized: true },
    ]);
    expect(commands).toContain("relay");
    expect(errors).toEqual([]);
    // 凭据只经连接交付；检查真实 CLI 和 Host 产生的文件，防止配置或日志落盘。
    for (const entry of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const text = await readFile(join(entry.parentPath, entry.name), "utf8");
      expect(text.includes(control) || text.includes(relay)).toBe(false);
    }
    console.info(
      JSON.stringify({
        evidence: "real-cli-browser-account",
        endpoint: `${owner.origin}/v1/chat/completions`,
        modelKey: `${selection.providerId}/${selection.modelId}`,
        result,
        relayAuthorized: true,
        secretsPersisted: false,
      }),
    );
  } finally {
    await agent?.disposeAllAndWait();
    registry?.dispose();
    bridge.dispose();
    accountSource?.dispose();
    config.dispose();
    host.dispose();
    browser.dispose();
    changes.dispose();
    peer.closeAllConnections();
    await new Promise<void>((resolve) => peer.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
}, 40_000);
