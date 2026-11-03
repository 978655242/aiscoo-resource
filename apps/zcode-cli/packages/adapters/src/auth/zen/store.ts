import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import { normalizeAiscooAdminOrigin } from "@zcode/shared";
import type { ZenCredentialStore, ZenSecureKeyStore } from "./contract.js";

const keyBytes = 32;
const ivBytes = 12;
const cipherAlgorithm = "aes-256-gcm";

// XCODE: 系统安全库错误不降级成不存在；CLI 的随机 key 与桌面密钥完全独立。
// 条目按凭据目录区分：不同数据根（隔离环境或多个 CLI 安装）不得共享或互相覆盖加密 key。
export function zenKeychainAccount(directory: string): string {
  const scope = createHash("sha256").update(resolve(directory)).digest("hex").slice(0, 32);
  return `credential-encryption-key:${scope}`;
}

// XCODE: 原生钥匙串模块的加载由入口层提供：普通 Node bundle 直接从 node_modules 加载，
// SEA 单文件包从内嵌资源解包后加载。adapter 不感知打包形态。
type KeyringModule = typeof import("@napi-rs/keyring");
let keyringModuleLoader: () => Promise<KeyringModule> = () => import("@napi-rs/keyring");
export function setZenKeyringModuleLoader(loader: () => Promise<KeyringModule>): void {
  keyringModuleLoader = loader;
}

export async function createZenSystemKeyStore(directory: string): Promise<ZenSecureKeyStore> {
  const { AsyncEntry } = await keyringModuleLoader();
  const entry = new AsyncEntry("XWork CLI Zen", zenKeychainAccount(directory), {
    linux: { store: "secret-service" },
  });
  return { read: () => entry.getPassword(), write: (secret) => entry.setPassword(secret) };
}

export function createZenCredentialStore<T>(options: {
  directory: string;
  keyStore: ZenSecureKeyStore;
}): ZenCredentialStore<T> {
  const keyLock = join(options.directory, "key");
  async function loadKey(): Promise<Buffer> {
    const secret = await options.keyStore.read();
    if (!secret || !/^[A-Za-z0-9_-]{43}$/.test(secret))
      throw new Error("ZEN_SECURE_STORAGE_UNAVAILABLE");
    const key = Buffer.from(secret, "base64url");
    if (key.length !== keyBytes) throw new Error("ZEN_SECURE_STORAGE_UNAVAILABLE");
    return key;
  }
  function file(origin: string): string {
    const hash = createHash("sha256").update(normalizeAiscooAdminOrigin(origin)).digest("hex");
    return join(options.directory, `${hash}.json`);
  }
  async function read(origin: string): Promise<{ revision: string; value: T } | null> {
    let raw: string;
    try {
      raw = await readFile(file(origin), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const record = JSON.parse(raw);
    if (record.version !== 1 || typeof record.revision !== "string")
      throw new Error("ZEN_CREDENTIAL_RECORD_INVALID");
    const decipher = createDecipheriv(
      cipherAlgorithm,
      await loadKey(),
      Buffer.from(record.iv, "base64url"),
    );
    decipher.setAAD(Buffer.from(`${normalizeAiscooAdminOrigin(origin)}:xwork-cli:${record.revision}`));
    decipher.setAuthTag(Buffer.from(record.tag, "base64url"));
    const text = Buffer.concat([
      decipher.update(Buffer.from(record.data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return { revision: record.revision, value: JSON.parse(text) as T };
  }
  return {
    async assertAvailable() {
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      await withFileLock(keyLock, async () => {
        // 仅首次缺失时生成；已有加密记录但 key 丢失不得用新 key 掩盖恢复错误。
        if ((await options.keyStore.read()) === null) {
          const { readdir } = await import("node:fs/promises");
          if ((await readdir(options.directory)).some((name) => name.endsWith(".json")))
            throw new Error("ZEN_SECURE_STORAGE_UNAVAILABLE");
          await options.keyStore.write(randomBytes(keyBytes).toString("base64url"));
        }
        await loadKey();
      });
    },
    read,
    async compareAndSwap(origin, expectedRevision, next) {
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      return withFileLock(file(origin), async () => {
        const current = await read(origin);
        if ((current?.revision ?? null) !== expectedRevision) return false;
        if (next === null) {
          if (current) await unlink(file(origin));
          return true;
        }
        const revision = randomUUID();
        const iv = randomBytes(ivBytes);
        const cipher = createCipheriv(cipherAlgorithm, await loadKey(), iv);
        cipher.setAAD(Buffer.from(`${normalizeAiscooAdminOrigin(origin)}:xwork-cli:${revision}`));
        const data = Buffer.concat([cipher.update(JSON.stringify(next), "utf8"), cipher.final()]);
        await atomicWritePrivateTextFile(
          file(origin),
          JSON.stringify({
            version: 1,
            revision,
            iv: iv.toString("base64url"),
            tag: cipher.getAuthTag().toString("base64url"),
            data: data.toString("base64url"),
          }),
        );
        return true;
      });
    },
    async withLease(origin, action) {
      await mkdir(options.directory, { recursive: true, mode: 0o700 });
      return withFileLock(`${file(origin)}.refresh`, action);
    },
  };
}
