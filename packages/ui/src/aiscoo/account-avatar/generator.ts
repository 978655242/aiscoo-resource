import multiavatar from "@multiavatar/multiavatar/esm";

const avatarCache = new Map<string, string>();
const CACHE_LIMIT = 128;

export function getAccountAvatarDataUri(userId: string): string | null {
  const id = userId.trim();
  // 其他 provider 的不透明 ID 不能被当作 New API 用户，且数字 ID 不转换为浮点数。
  if (!/^[1-9]\d*$/u.test(id)) return null;
  const seed = `aiscoo:new-api:multiavatar:v1:${id}`;
  const cached = avatarCache.get(seed);
  if (cached) return cached;
  try {
    const svg = multiavatar(seed);
    if (!svg) return null;
    const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    if (avatarCache.size >= CACHE_LIMIT) avatarCache.delete(avatarCache.keys().next().value!);
    avatarCache.set(seed, uri);
    return uri;
  } catch {
    return null;
  }
}
