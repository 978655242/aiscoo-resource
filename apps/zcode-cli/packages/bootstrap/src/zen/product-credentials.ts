import {
  createSharedZCodeCredentialStore,
  type SharedZCodeCredentialStore,
} from "@zcode/adapters/auth";

const IDENTITY = /^account-provider:(.+):identity$/;
const SOURCE = /^account-provider:(.+):auth-source$/;
const MANUAL_KEY = /^account-provider:coding-plan:(.+):account:[^:]+:api-key$/;
const unsupported = () => new Error("AISCOO_ACCOUNT_LOGIN_UNSUPPORTED");
const isOfficial = (key: string) => key.startsWith("oauth:") || key === "zcodejwttoken";

// 底层 validateCredentialKey 会 trim；策略必须先使用同一 canonical key，避免空白绕过。
function canonicalKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length === 0) throw new Error("Credential key must not be empty");
  return trimmed;
}

function writableKeys(keys: readonly string[]): string[] {
  const canonical = keys.map(canonicalKey);
  if (canonical.some(isOfficial)) throw unsupported();
  return canonical;
}

function writableEntries(entries: Readonly<Record<string, string>>): Record<string, string> {
  const keys = writableKeys(Object.keys(entries));
  return Object.fromEntries(Object.values(entries).map((value, index) => [keys[index]!, value]));
}

/**
 * 仅包装独立 CLI 的既有 store；不解密、删除或迁移官方登录条目。
 * account-provider 只承认明确的 manual 来源，避免旧 OAuth 派生 key 自动恢复。
 */
export function createAiscooProductCredentialStore(
  env: Readonly<Record<string, string | undefined>>,
  injected?: SharedZCodeCredentialStore,
): SharedZCodeCredentialStore {
  const store = injected ?? createSharedZCodeCredentialStore({ env: { ...env } });
  async function loadCanonical(key: string): Promise<string | null> {
    if (isOfficial(key)) return null;
    const provider =
      key.match(IDENTITY)?.[1] ?? key.match(SOURCE)?.[1] ?? key.match(MANUAL_KEY)?.[1];
    if (provider && (await store.load(`account-provider:${provider}:auth-source`)) !== "manual")
      return null;
    return store.load(key);
  }
  return {
    filePath: store.filePath,
    async load(key) {
      return loadCanonical(canonicalKey(key));
    },
    async loadMany(keys) {
      // 修复原因：旧实现遇到官方 key 就整批抛错，上游批量读取一旦混入官方 key（如并发写入使
      // auth-source 变为 oauth），同批 Zen 与自配凭据会一起失效。读取改为与 load 一致：
      // 先全部规范化（空 key 仍在任何 IO 前失败），官方 key 逐项返回 null 且不读 backing。
      const canonical = keys.map(canonicalKey);
      return Object.fromEntries(
        await Promise.all(canonical.map(async (key) => [key, await loadCanonical(key)])),
      );
    },
    onDidChange: store.onDidChange?.bind(store),
    clearZaiLoginCredentials: async () => {
      throw unsupported();
    },
    saveZaiLoginCredentials: async () => {
      throw unsupported();
    },
    async save(key, value) {
      const [canonical] = writableKeys([key]);
      await store.save(canonical!, value);
    },
    async saveMany(entries) {
      const canonical = writableEntries(entries);
      await store.saveMany(canonical);
    },
    async saveReplacing(key, value, replaced) {
      const [canonical, ...canonicalReplaced] = writableKeys([key, ...replaced]);
      await store.saveReplacing(canonical!, value, canonicalReplaced);
    },
    async delete(key) {
      const [canonical] = writableKeys([key]);
      await store.delete(canonical!);
    },
    async deleteIfValue(key, value) {
      const [canonical] = writableKeys([key]);
      return store.deleteIfValue(canonical!, value);
    },
    async deleteIfValues(values) {
      const canonical = writableEntries(values);
      return store.deleteIfValues(canonical);
    },
    async deleteManyIfValue(key, value, deleted) {
      const [canonical, ...canonicalDeleted] = writableKeys([key, ...deleted]);
      return store.deleteManyIfValue(canonical!, value, canonicalDeleted);
    },
  };
}
