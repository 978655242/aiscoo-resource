import assert from "node:assert/strict";
import test from "node:test";
import { AiscooAdminAccountService } from "../src/aiscoo-admin/aiscooAdminAccountService.js";
import { AiscooAdminClient } from "../src/aiscoo-admin/aiscooAdminClient.js";
import type { AiscooAdminSessionRepo } from "../src/aiscoo-admin/aiscooAdminSessionRepo.js";
import { AiscooAdminProviderAdapter } from "../src/oauth/providers/aiscooAdminProviderAdapter.js";

for (const origin of [
  "https://legal.example:8443",
  "http://127.0.0.1:3001",
  "http://[::1]:43001",
]) {
  test(`public legal metadata uses configured origin without session or network: ${origin}`, async () => {
    const client = new AiscooAdminClient(`${origin}/`, {
      fetch: async () => {
        throw new Error("Public metadata must not request authorization or a web handoff");
      },
    });
    const service = new AiscooAdminAccountService({
      adapter: new AiscooAdminProviderAdapter(client),
      repo: new Proxy({} as AiscooAdminSessionRepo, {
        get() {
          throw new Error("Public metadata must not read credentials");
        },
      }),
    });

    assert.equal(await service.oauth.getActiveProvider(), null);
    const providers = await service.oauth.getProviders();
    assert.deepEqual(providers, [
      {
        id: "new-api",
        displayName: "Aiscoo",
        enabled: true,
        order: 0,
        legalLinks: {
          userAgreementUrl: `${origin}/user-agreement`,
          privacyPolicyUrl: `${origin}/privacy-policy`,
        },
      },
    ]);
    for (const url of Object.values(providers[0]!.legalLinks!)) {
      const parsed = new URL(url);
      assert.equal(parsed.origin, origin);
      assert.equal(parsed.search, "");
      assert.equal(parsed.hash, "");
      assert.equal(parsed.username, "");
      assert.equal(parsed.password, "");
    }
  });
}
