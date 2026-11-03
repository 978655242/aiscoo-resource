import { createHash } from "node:crypto";
import type { AiscooAdminOwner } from "@zcode/shared";
import type {
  OfficialCloudConnectionHost,
  OfficialCloudCredentialSnapshot,
} from "./officialCloudConnectionService.js";
import { ownerChanged } from "./officialCloudConnectionRecords.js";

interface Dependencies {
  account: { getOwner(): AiscooAdminOwner | null; isCurrent(owner: AiscooAdminOwner): boolean };
  getEpoch(): number;
  current(owner: AiscooAdminOwner, capturedEpoch?: number): boolean;
  resolveCredentials: OfficialCloudConnectionHost["resolveCredentials"];
  isCurrent: OfficialCloudConnectionHost["isCurrent"];
  invocationScope(credentials: OfficialCloudCredentialSnapshot): string;
}

/** XCODE: Fence 只捕获 Host 的单一 owner 生命周期，不另存身份或凭据状态。 */
export function createOfficialCloudRequestFences(
  dependencies: Dependencies,
): Pick<OfficialCloudConnectionHost, "captureOwnerFence" | "captureRequestFence"> {
  const { account, getEpoch, current, resolveCredentials, isCurrent, invocationScope } =
    dependencies;
  return {
    // XCODE: origin 等异步校验开始前冻结 owner；此边界不读取任何秘密。
    captureOwnerFence() {
      const owner = account.getOwner();
      const capturedEpoch = getEpoch();
      return {
        isCurrent: () =>
          getEpoch() === capturedEpoch &&
          (owner ? current(owner, capturedEpoch) : account.getOwner() === null),
      };
    },
    async captureRequestFence() {
      const owner = account.getOwner();
      const capturedEpoch = getEpoch();
      const credentials = await resolveCredentials();
      if (
        getEpoch() !== capturedEpoch ||
        (owner ? !current(owner, capturedEpoch) : account.getOwner() !== null)
      )
        throw ownerChanged();
      credentials?.assertCurrentSync?.();
      return {
        token: credentials?.jwt ?? null,
        // XCODE: 公开分享匿名读取也属于捕获的 Native owner，不能绕过 worker 准入。
        scope: credentials
          ? invocationScope(credentials)
          : createHash("sha256").update(JSON.stringify(owner)).digest("hex"),
        // XCODE: SQLite 同步提交回调不能 await；官方变更入口在异步 IO 前递增 epoch。
        assertCurrentSync: () => {
          if (
            getEpoch() !== capturedEpoch ||
            (owner ? !current(owner, capturedEpoch) : account.getOwner() !== null)
          )
            throw ownerChanged();
          credentials?.assertCurrentSync?.();
        },
        isCurrent: async () => {
          if (getEpoch() !== capturedEpoch) return false;
          if (owner ? !account.isCurrent(owner) : account.getOwner() !== null) return false;
          if (credentials) return isCurrent(credentials);
          const latest = await resolveCredentials();
          return (
            latest === null &&
            getEpoch() === capturedEpoch &&
            (owner ? current(owner, capturedEpoch) : account.getOwner() === null)
          );
        },
      };
    },
  };
}
