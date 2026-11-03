import assert from "node:assert/strict";
import test from "node:test";
import { createCredentialService } from "../src/credential/credentialService.js";

test("Host private namespaces are denied for every public credential operation", async () => {
  const service = createCredentialService();
  for (const key of ["new-api:origin:active", "official-cloud:origin:user"]) {
    const denied = (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "XCODE_CREDENTIAL_SCOPE_DENIED";
    await assert.rejects(service.load(key), denied);
    await assert.rejects(service.save(key, "attacker-replacement"), denied);
    await assert.rejects(service.delete(key), denied);
    await assert.rejects(
      service.recoverUnreadable(key, () => {}),
      denied,
    );
  }
});
