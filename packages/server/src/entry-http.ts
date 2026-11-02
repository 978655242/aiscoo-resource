import {
  createServerHostServices,
  // XCODE: Server 产品入口也固定账号策略，未启用浏览器 profile 不读取旧官方身份。
  createAiscooAccountPolicy,
  createTopicResourcePeers,
  getAppConfigDir,
} from "@zcode/services/node";
import {
  materializeBundledZCodeBuiltinProviderConfig,
  readBundledZCodeBuiltinProviderConfig,
} from "./bundledZCodeBuiltinProviderConfig.js";
import { createHttpServer, resolveHttpServerId } from "./http.js";
// XCODE: 可选本机浏览器账号使用同一服务装配，不创建 Host 持久凭据。
import { Event, type IChannelClient } from "@zcode/rpc";
import { IOAuthService } from "@zcode/services";
import type { NewApiOwner } from "@zcode/shared";
import {
  createBrowserAccountBridge,
  resolveBrowserAccountProfile,
} from "./aiscoo-browser-account/index.js";

async function main(): Promise<void> {
  // XCODE: 配置错误在存储/服务初始化前失败；普通入口仍使用原环境配置。
  const browserProfile = resolveBrowserAccountProfile(process.env);
  let browserBridge: ReturnType<typeof createBrowserAccountBridge> | undefined;
  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  const topicResourcePeers = createTopicResourcePeers();
  const serverId = resolveHttpServerId();
  // XCODE: Host 与逐连接 OAuth 复用同一产品策略，服务覆盖不能绕过账号准入。
  const accountPolicy = createAiscooAccountPolicy({ adminBaseUrl: browserProfile?.origin });
  const { services, workspaceIdentityMapper, migrationFailedPathCount } =
    await createServerHostServices({
      topicResourceRelayChannel: (request) => topicResourcePeers.getChannel(request),
      sourceServerId: serverId,
      zcodeBuiltinProviderConfigFilePath,
      providerProvisioningTargetEnabled: Boolean(authToken),
      // XCODE: 无浏览器凭据权威时不认领 Host 历史会话，也不创建桌面 native owner。
      accountPolicy,
      // XCODE: 相同 Native 目录和请求 resolver 只更换凭据来源。
      ...(browserProfile
        ? {
            newApiAccountAuthority: {
              origin: browserProfile.origin,
              create(onOwnerChanged: (owner: NewApiOwner | null) => Promise<void>) {
                browserBridge = createBrowserAccountBridge(browserProfile.origin, {
                  onOwnerChanged,
                });
                return browserBridge.authority;
              },
            },
          }
        : {}),
    });

  createHttpServer(services, port, {
    serverId,
    workspaceIdentityMapper,
    migrationFailedPathCount,
    virtualProjects: true,
    topicResourcePeers,
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
    // XCODE: 本机模式限制监听与来源；不新建浏览器网络 session。
    ...(browserProfile
      ? {
          host: "127.0.0.1",
          acceptRequest: browserProfile.acceptRequest,
          attachBrowserPeer: (client: IChannelClient) => {
            const attachment = browserBridge!.attach(client);
            return {
              ready: attachment.ready,
              // XCODE: OAuth 固定回发起标签，PKCE 和取消不能借用其他连接。
              serviceOverrides: new Map([
                [IOAuthService.channelName, accountPolicy.wrapOAuth(attachment.oauth)],
              ]),
              onDidClose: Event.map(attachment.onDidInvalidate, (reason) => ({
                code: 1008,
                reason: {
                  "owner-changed": "Browser account changed",
                  "account-mismatch": "Browser account does not match",
                  unavailable: "Browser account is unavailable",
                }[reason],
              })),
              dispose: () => attachment.dispose(),
            };
          },
        }
      : {}),
  });
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});
