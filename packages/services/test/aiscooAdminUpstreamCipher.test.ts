import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AiscooAdminSessionBundle } from "@zcode/shared";
import { createCredentialCipherProvider } from "../src/credential/providers/credentialCipherProvider.js";
import {
  AiscooAdminSessionRepo,
  type AiscooAdminStoredSession,
} from "../src/aiscoo-admin/aiscooAdminSessionRepo.js";

// 2026-11-01 决定：Aiscoo 私有凭据与上游一致，使用上游 cipher，不依赖 Main 下发的 OS 密钥。
// 本文件不注入 cipherProvider，也不设置 XCODE_PRIVATE_CREDENTIAL_SECRET，保护的是“默认行为”。
const origin = "https://native.example";
const now = 1_800_000_000_000;

function session(id = "1", sid = "sid-1"): AiscooAdminStoredSession {
  const payload = Buffer.from(
    JSON.stringify({
      iss: "new-api",
      aud: ["new-api-xcode"],
      token_use: "xcode_access",
      sub: id,
      sid,
      exp: (now + 60_000) / 1000,
      uv: 1,
      sv: 1,
      nbf: now / 1000 - 5,
      iat: now / 1000,
      scopes: ["profile:read", "wallet:read", "usage:read"],
      jti: randomUUID(),
    }),
  ).toString("base64url");
  const bundle: AiscooAdminSessionBundle = {
    schema_version: 1,
    server_time: now,
    access_token: `${Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url")}.${payload}.${Buffer.alloc(32, 1).toString("base64url")}`,
    access_expires_at: now + 60_000,
    refresh_token: "refresh-1",
    refresh_expires_at: now + 600_000,
    token_type: "Bearer",
    session_id: sid,
    user: { id, username: `user-${id}`, display_name: `User ${id}`, avatar_url: null },
    relay_credential: { token: `sk-relay-${sid}`, expires_at: now + 600_000 },
  };
  return { schemaVersion: 1, origin, bundle };
}

async function withTemporaryCredentials<T>(
  run: (credentialsFile: string) => Promise<T>,
  env: Record<string, string | undefined> = {},
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "xcode-upstream-cipher-"));
  const saved: Record<string, string | undefined> = {};
  const keys = ["ZCODE_CREDENTIAL_SECRET", "XCODE_PRIVATE_CREDENTIAL_SECRET"];
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run(join(dir, "credentials.json"));
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await rm(dir, { recursive: true, force: true });
  }
}

test("default repo reads and writes private sessions without any OS-provided key", async () => {
  await withTemporaryCredentials(async (credentialsFile) => {
    const repo = new AiscooAdminSessionRepo(origin, { credentialsFile });
    // 旧实现在这里抛 XCODE_SECURE_STORAGE_UNAVAILABLE：Host 没拿到 Main 的 safeStorage 密钥。
    assert.doesNotThrow(() => repo.assertStorageAvailable?.());
    await repo.commit(session());
    const loaded = await repo.loadActive();
    assert.equal(loaded?.bundle.user.id, "1");
    assert.equal(loaded?.bundle.relay_credential.token, "sk-relay-sid-1");
  });
});

test("private records are encrypted with the upstream cipher and its default secret", async () => {
  await withTemporaryCredentials(async (credentialsFile) => {
    await new AiscooAdminSessionRepo(origin, { credentialsFile }).commit(session());
    const stored: Record<string, string> = JSON.parse(await readFile(credentialsFile, "utf8"));
    const prefix = `new-api:${createHash("sha256").update(origin).digest("hex")}:`;
    const keys = Object.keys(stored).filter((key) => key.startsWith(prefix));
    assert.equal(keys.length, 2, "one session record and one active pointer");
    // 密文必须能被上游 cipher 的默认密钥来源解开，即与 ICredentialService 的公共路径同一把密钥。
    const upstream = createCredentialCipherProvider();
    for (const key of keys) {
      assert.match(stored[key]!, /^enc:v1:/);
      assert.doesNotThrow(() => upstream.decrypt(stored[key]!));
    }
    assert.equal(JSON.parse(upstream.decrypt(stored[`${prefix}active`]!)).userId, "1");
  });
});

test("an explicit ZCODE_CREDENTIAL_SECRET is honored exactly like upstream", async () => {
  const secret = randomBytes(32).toString("hex");
  await withTemporaryCredentials(
    async (credentialsFile) => {
      await new AiscooAdminSessionRepo(origin, { credentialsFile }).commit(session());
      const stored: Record<string, string> = JSON.parse(await readFile(credentialsFile, "utf8"));
      const active = Object.keys(stored).find((key) => key.endsWith(":active"))!;
      const withSecret = createCredentialCipherProvider({
        env: { ZCODE_CREDENTIAL_SECRET: secret },
      });
      assert.equal(JSON.parse(withSecret.decrypt(stored[active]!)).sid, "sid-1");
      const wrong = createCredentialCipherProvider({
        env: { ZCODE_CREDENTIAL_SECRET: "another-secret" },
      });
      assert.throws(() => wrong.decrypt(stored[active]!), {
        code: "ZCODE_CREDENTIAL_DECRYPT_FAILED",
      });
    },
    { ZCODE_CREDENTIAL_SECRET: secret },
  );
});

test("records written with the retired Main-provided key need recovery instead of failing storage", async () => {
  await withTemporaryCredentials(async (credentialsFile) => {
    const retired = createCredentialCipherProvider({
      env: { ZCODE_CREDENTIAL_SECRET: randomBytes(32).toString("base64url") },
    });
    const prefix = `new-api:${createHash("sha256").update(origin).digest("hex")}:`;
    await writeFile(
      credentialsFile,
      JSON.stringify({
        [`${prefix}active`]: retired.encrypt(JSON.stringify({ userId: "1", sid: "sid-1" })),
      }),
    );
    const repo = new AiscooAdminSessionRepo(origin, { credentialsFile });
    // 旧密钥文件不再使用：旧记录按“解密失败”进入重新登录流程，而不是“安全存储不可用”。
    await assert.rejects(repo.loadActive(), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "ZCODE_CREDENTIAL_DECRYPT_FAILED");
      return true;
    });
  });
});
