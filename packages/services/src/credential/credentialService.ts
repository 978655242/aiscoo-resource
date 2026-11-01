// XCODE: 仅统一本产品展示文案，保留内部标识、协议与既有数据。
import { readFile } from "node:fs/promises";
// XCODE: 凭据错误仅投影静态提示前缀，文件路径与凭据内容保持原样。
import { brandProductText } from "@zcode/shared/aiscoo-brand";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { atomicWritePrivateTextFile, backupCorruptFile, withFileLock } from "@zcode/shared/node";
import {
  credentialKeySchema,
  credentialRecordSchema,
  credentialValueSchema,
  formatZodError,
  CREDENTIAL_DECRYPT_ERROR_CODE,
  isCredentialDecryptError,
} from "@zcode/shared";
import type { ICredentialService } from "./credential.js";
import {
  createCredentialCipherProvider,
  type CredentialCipherProvider,
} from "./providers/credentialCipherProvider.js";
import { createServiceLogger } from "../logger/serviceLogger.js";
import { getAppConfigDir } from "../paths.js";

/**
 * 凭据存储路径
 *
 * 当前持久化格式仍是 JSON，但 value 会在写入前加密，读取时自动解密。
 * 后续可切换到 Electron safeStorage（钥匙串）托管密钥（Aiscoo 已于 2026-11-01 决定不采用，见 new-api-integration §4.2），
 * 届时 host process 需要向 main 进程请求 encrypt/decrypt。
 */
const logger = createServiceLogger("credentialService");

function getCredentialsDir() {
  return getAppConfigDir();
}

function getCredentialsFile() {
  return join(getCredentialsDir(), "credentials.json");
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

async function readAll(credentialsFile = getCredentialsFile()): Promise<Record<string, string>> {
  let raw: string;
  try {
    raw = await readFile(credentialsFile, "utf-8");
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return {};
    }
    // XCODE: 用户文件路径在模板投影完成后拼接，避免改写路径中的旧品牌文字。
    throw new Error(`${brandProductText("Unable to read XWork credentials:")} ${credentialsFile}`, {
      cause: error,
    });
  }

  try {
    const rawValue = JSON.parse(raw);
    const result = credentialRecordSchema.safeParse(rawValue);
    if (!result.success) {
      throw new Error(formatZodError(result.error));
    }
    return result.data;
  } catch {
    // 把损坏 JSON/schema 当成空 store 后继续 save 会清空其他 OAuth 与登录凭据。
    // 保留损坏文件证据并向上传递错误，禁止自动覆盖。
    const backupPath = await backupCorruptFile(credentialsFile).catch(() => undefined);
    // 服务层日志必须统一经过分级 logger，确保生产环境的损坏凭据告警
    // 进入相同的落盘/采集策略，同时不记录凭据内容。
    logger.warn(undefined, "read failed; refusing to overwrite corrupt credential store", {
      backupPath,
      credentialsFile,
    });
    // XCODE: 提示统一品牌，凭据恢复错误码继续用于原有分类。
    throw Object.assign(
      new Error(brandProductText("XWork credentials require manual storage recovery")),
      {
        code: CREDENTIAL_DECRYPT_ERROR_CODE,
      },
    );
  }
}

async function writeAll(credentialsFile: string, data: Record<string, string>): Promise<void> {
  // 凭据路径之前在模块加载时就绑定到 homedir()，
  // Windows 测试里即使切换 HOME 也会继续写真实用户目录，导致隔离失效。
  await atomicWritePrivateTextFile(credentialsFile, `${JSON.stringify(data, null, 2)}\n`);
}

interface CredentialServiceDependencies {
  cipherProvider?: CredentialCipherProvider;
  // XCODE: 本机 Web 必须指定独立文件，避免公共 RPC 读写桌面共享 OAuth 凭据。
  credentialsFile?: string;
  /** Host 私有的持久化成功通知；不进入 Renderer/RPC 凭据接口。 */
  onDidMutate?: (event: { operation: "save" | "delete"; key: string }) => void;
}
// XCODE: Renderer 的任意 key RPC 不能读取、覆盖或删除 Host 私有身份。
function assertPublicCredentialKey(key: string): void {
  if (key.startsWith("new-api:") || key.startsWith("official-cloud:")) {
    throw Object.assign(new Error("Private credentials are not available through RPC"), {
      code: "XCODE_CREDENTIAL_SCOPE_DENIED",
    });
  }
}

function assertHostCredentialKey(key: string): void {
  credentialKeySchema.parse(key);
  if (!key.startsWith("new-api:") && !key.startsWith("official-cloud:")) {
    throw new Error("Invalid private credential namespace");
  }
}

export interface HostCredentialStoreDependencies {
  credentialsFile?: string;
  cipherProvider?: CredentialCipherProvider;
}

// XCODE: 此 standalone Host port 不注册为 RPC，私有密文与旧官方密文使用不同 key。
export async function readHostCredentialRecords<T>(
  read: (load: (key: string) => string | null) => T,
  dependencies: HostCredentialStoreDependencies = {},
): Promise<T> {
  const records = await readAll(dependencies.credentialsFile ?? getCredentialsFile());
  let cipher = dependencies.cipherProvider;
  return read((key) => {
    assertHostCredentialKey(key);
    const encrypted = records[key];
    if (encrypted === undefined) return null;
    if (!encrypted.startsWith("enc:v1:")) {
      throw Object.assign(new Error("Private credentials require encrypted storage recovery"), {
        code: CREDENTIAL_DECRYPT_ERROR_CODE,
      });
    }
    // XCODE: 2026-11-01 起私有记录与上游同一 cipher，不依赖 Main 下发的 OS 密钥。
    cipher ??= createCredentialCipherProvider();
    return cipher.decrypt(encrypted);
  });
}

// XCODE: 同SID跨窗口的 refresh 必须覆盖HTTP与CAS，不能丢弃服务端最后轮换的secret。
export async function withHostCredentialRefreshLease<T>(
  key: string,
  run: () => Promise<T>,
  dependencies: HostCredentialStoreDependencies = {},
): Promise<T> {
  assertHostCredentialKey(key);
  const credentialsFile = dependencies.credentialsFile ?? getCredentialsFile();
  const ownerKey = createHash("sha256").update(key).digest("hex");
  return withFileLock(`${credentialsFile}.refresh-${ownerKey}`, run);
}

export async function updateHostCredentialRecords<T>(
  keys: readonly string[],
  mutate: (records: ReadonlyMap<string, string | null>) => {
    changes: ReadonlyMap<string, string | null>;
    result: T;
  },
  dependencies: HostCredentialStoreDependencies = {},
): Promise<T> {
  for (const key of keys) assertHostCredentialKey(key);
  const credentialsFile = dependencies.credentialsFile ?? getCredentialsFile();
  return withFileLock(credentialsFile, async () => {
    const records = await readAll(credentialsFile);
    const cipher = dependencies.cipherProvider ?? createCredentialCipherProvider();
    const selected = new Map<string, string | null>();
    for (const key of keys) {
      const encrypted = records[key];
      if (encrypted !== undefined && !encrypted.startsWith("enc:v1:")) {
        throw Object.assign(new Error("Private credentials require encrypted storage recovery"), {
          code: CREDENTIAL_DECRYPT_ERROR_CODE,
        });
      }
      selected.set(key, encrypted === undefined ? null : cipher.decrypt(encrypted));
    }
    const { changes, result } = mutate(selected);
    for (const [key, value] of changes) {
      if (!selected.has(key)) throw new Error("Undeclared private credential mutation");
      if (value === null) {
        delete records[key];
      } else {
        records[key] = cipher.encrypt(credentialValueSchema.parse(value));
      }
    }
    if (changes.size > 0) await writeAll(credentialsFile, records);
    return result;
  });
}

// XCODE: 为下游私有事务开放现有文件操作，调用方负责同一文件锁；不注册到 RPC。
export const hostCredentialStoragePort = {
  path: getCredentialsFile,
  read: readAll,
  write: writeAll,
  assertKey: assertHostCredentialKey,
};

/** Host 私有缓存恢复能力，不进入 Renderer 的 ICredentialService 契约。 */
export interface LocalCredentialService extends ICredentialService {
  recoverUnreadable(key: string, assertCurrent: () => void): Promise<string | null>;
  save(key: string, value: string, assertCurrent?: () => void): Promise<void>;
  delete(key: string, assertCurrent?: () => void): Promise<void>;
}

export function createCredentialService(
  dependencies: CredentialServiceDependencies = {},
): LocalCredentialService {
  const cipherProvider = dependencies.cipherProvider ?? createCredentialCipherProvider();

  return {
    async recoverUnreadable(key, assertCurrent) {
      const validatedKey = credentialKeySchema.parse(key);
      assertPublicCredentialKey(validatedKey);
      const credentialsFile = dependencies.credentialsFile ?? getCredentialsFile();
      let deleted = false;
      const value = await withFileLock(credentialsFile, async () => {
        assertCurrent();
        const creds = await readAll(credentialsFile);
        assertCurrent();
        const rawValue = creds[validatedKey];
        if (rawValue === undefined) return null;
        try {
          return cipherProvider.decrypt(rawValue);
        } catch (error) {
          if (!isCredentialDecryptError(error)) throw error;
        }
        // 缓存复核与删除必须共用跨进程锁；分别 load/delete 会误删另一窗口已修复的记录。
        // 此处仅处理调用方明确标记的派生缓存，不能因缓存损坏清理有效 OAuth 登录。
        assertCurrent();
        delete creds[validatedKey];
        await writeAll(credentialsFile, creds);
        deleted = true;
        return null;
      });
      if (deleted) dependencies.onDidMutate?.({ operation: "delete", key: validatedKey });
      return value;
    },

    async load(key: string): Promise<string | null> {
      const validatedKey = credentialKeySchema.parse(key);
      assertPublicCredentialKey(validatedKey);
      const creds = await readAll(dependencies.credentialsFile ?? getCredentialsFile());
      const rawValue = creds[validatedKey];
      if (rawValue === undefined) {
        return null;
      }

      return cipherProvider.decrypt(rawValue);
    },

    async save(key: string, value: string, assertCurrent?: () => void): Promise<void> {
      const validatedKey = credentialKeySchema.parse(key);
      assertPublicCredentialKey(validatedKey);
      const validatedValue = credentialValueSchema.parse(value);
      const encryptedValue = cipherProvider.encrypt(validatedValue);
      const credentialsFile = dependencies.credentialsFile ?? getCredentialsFile();
      // desktop host 与 CLI adapter 是独立进程，进程内排队不能阻止 whole-file
      // read-modify-write 丢更新；共享目录锁必须覆盖读取、变更和原子替换全过程。
      await withFileLock(credentialsFile, async () => {
        const creds = await readAll(credentialsFile);
        // 请求可能在等待文件锁时失效，不能只依赖调用方进入 IO 前的代次检查。
        assertCurrent?.();
        creds[validatedKey] = encryptedValue;
        await writeAll(credentialsFile, creds);
      });
      dependencies.onDidMutate?.({ operation: "save", key: validatedKey });
    },

    async delete(key: string, assertCurrent?: () => void): Promise<void> {
      const validatedKey = credentialKeySchema.parse(key);
      assertPublicCredentialKey(validatedKey);
      const credentialsFile = dependencies.credentialsFile ?? getCredentialsFile();
      await withFileLock(credentialsFile, async () => {
        const creds = await readAll(credentialsFile);
        assertCurrent?.();
        delete creds[validatedKey];
        await writeAll(credentialsFile, creds);
      });
      dependencies.onDidMutate?.({ operation: "delete", key: validatedKey });
    },
  };
}
