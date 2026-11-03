import { createHash, randomBytes } from "node:crypto";
import { normalizeAiscooAdminOrigin, ZEN_CLI_CLIENT_ID } from "@zcode/shared";
import { createZenAuthorizationListener } from "./listener.js";

// XCODE: state/verifier 与 listener 在同一 adapter 内生成，调用者不能遗漏 CSRF 绑定。
export async function createZenAuthorization(origin: string) {
  const canonical = normalizeAiscooAdminOrigin(origin);
  const state = randomBytes(32).toString("base64url");
  const verifier = randomBytes(32).toString("base64url");
  const listener = await createZenAuthorizationListener(state);
  const url = new URL("/api/xcode/v1/auth/authorize", canonical);
  url.search = new URLSearchParams({
    client_id: ZEN_CLI_CLIENT_ID,
    response_type: "code",
    redirect_uri: listener.redirectUri,
    state,
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  return { listener, verifier, authorizeUrl: url.toString() };
}
