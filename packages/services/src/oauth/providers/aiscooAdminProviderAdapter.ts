import { createHash, randomBytes } from "node:crypto";
import {
  AISCOO_ADMIN_PROVIDER_ID,
  AISCOO_ADMIN_CLIENT_ID,
  parseAiscooAdminAuthorizationCallback,
  type AiscooAdminSessionBundle,
  type OAuthProviderMeta,
} from "@zcode/shared";
import { AiscooAdminClient, AiscooAdminClientError } from "../../aiscoo-admin/aiscooAdminClient.js";

// XCODE: 私有目的 adapter 不实现官方 OAuthTokenSet 接口，避免通过 Renderer 暴露主账号密钥。
export class AiscooAdminProviderAdapter {
  readonly providerId = AISCOO_ADMIN_PROVIDER_ID;
  // XCODE: 公开页面由已验证的同一 origin 生成，不访问会话或创建授权。
  get meta(): OAuthProviderMeta {
    return {
      id: AISCOO_ADMIN_PROVIDER_ID,
      displayName: "Aiscoo",
      enabled: true,
      order: 0,
      legalLinks: {
        userAgreementUrl: new URL("/user-agreement", this.client.origin).href,
        privacyPolicyUrl: new URL("/privacy-policy", this.client.origin).href,
      },
    };
  }
  readonly redirectUri: string;

  constructor(readonly client: AiscooAdminClient) {
    // XCODE: authorize、callback和token复用client绑定值，避免跨渠道回跳或换码不一致。
    this.redirectUri = client.redirectUri;
  }

  createAuthorization(): { state: string; codeVerifier: string; authorizeUrl: string } {
    const state = randomBytes(32).toString("base64url");
    const codeVerifier = randomBytes(32).toString("base64url");
    const url = new URL("/api/xcode/v1/auth/authorize", this.client.origin);
    url.search = new URLSearchParams({
      client_id: AISCOO_ADMIN_CLIENT_ID,
      response_type: "code",
      redirect_uri: this.redirectUri,
      state,
      code_challenge: createHash("sha256").update(codeVerifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return { state, codeVerifier, authorizeUrl: url.toString() };
  }

  parseCallback(raw: string): { state: string; code: string } {
    const parsed = parseAiscooAdminAuthorizationCallback(raw, this.redirectUri);
    if (!parsed) throw new AiscooAdminClientError("XCODE_AUTH_REQUEST_INVALID", 400);
    return parsed;
  }

  exchangeCode(code: string, codeVerifier: string): Promise<AiscooAdminSessionBundle> {
    return this.client.exchangeAuthorizationCode({ code, codeVerifier });
  }

  refresh(session: AiscooAdminSessionBundle): Promise<AiscooAdminSessionBundle> {
    return this.client.refreshSession({
      sessionId: session.session_id,
      refreshToken: session.refresh_token,
    });
  }

  logout(session: AiscooAdminSessionBundle): Promise<void> {
    return this.client.logoutSession({
      sessionId: session.session_id,
      refreshToken: session.refresh_token,
    });
  }
}
