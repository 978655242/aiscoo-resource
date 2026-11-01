import type { OffPeakOwnerFence } from "@zcode/services/node";
// XCODE: Aiscoo 渠道无官方执行权益，缺配置也必须保持空 owner admission。
import { resolveAiscooDesktopIdentity } from "@zcode/shared/aiscoo-desktop-identity";

const officialCloudDisabled = Boolean(resolveAiscooDesktopIdentity());
let nativeOwnerKeys: readonly string[] | undefined =
  officialCloudDisabled || process.env.AISCOO_ADMIN_BASE_URL?.trim() ? [] : undefined;
let nativeAdmissionGeneration = 0;
const nativeOwnerEpochs = new Map<string, number>();

export function requiresOffPeakOwnerAdmission(): boolean {
  return nativeOwnerKeys !== undefined;
}

export function updateOffPeakOwnerAdmission(ownerKeys: readonly string[] | undefined): void {
  if (nativeOwnerKeys !== undefined && ownerKeys !== undefined) {
    // XCODE: 历史 Main 消息不能为已关闭的官方能力重新授予执行身份。
    const nextKeys = officialCloudDisabled ? [] : [...new Set(ownerKeys)];
    for (const key of new Set([...nativeOwnerKeys, ...nextKeys])) {
      if (nativeOwnerKeys.includes(key) !== nextKeys.includes(key)) {
        nativeOwnerEpochs.set(key, (nativeOwnerEpochs.get(key) ?? 0) + 1);
      }
    }
    nativeOwnerKeys = nextKeys;
    nativeAdmissionGeneration++;
  }
}

export function captureOffPeakOwnerFence(ownerKey?: string | null): OffPeakOwnerFence {
  const generation = nativeAdmissionGeneration;
  const ownerEpoch = ownerKey ? nativeOwnerEpochs.get(ownerKey) : undefined;
  const assertCurrentSync = (): void => {
    const current = ownerKey
      ? nativeOwnerKeys?.includes(ownerKey) && nativeOwnerEpochs.get(ownerKey) === ownerEpoch
      : generation === nativeAdmissionGeneration;
    if (!current || (nativeOwnerKeys !== undefined && ownerKey === null)) {
      throw new Error("off-peak owner admission changed");
    }
  };
  return Object.assign(async () => assertCurrentSync(), {
    assertCurrentSync,
    ...(ownerKey ? { ownerKey } : { ownerKeys: nativeOwnerKeys }),
  });
}
