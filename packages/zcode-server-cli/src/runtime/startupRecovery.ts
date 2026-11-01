// XCODE: 自有静态文案只插入共享产品名，内部协议和存储身份保留。
import { PRODUCT_NAME } from "@zcode/shared/aiscoo-brand";
// XCODE: 仅统一本产品展示文案，保留内部标识、协议与既有数据。
import { readFile } from "node:fs/promises";
import type { ReleaseManager } from "./releaseManager.js";

export async function recoverSupervisorStartup(
  releaseManager: ReleaseManager,
  uninstalledFile: string,
  serverRoot: string,
  onRecoveryFailure: (error: unknown) => Promise<void>,
): Promise<void> {
  await readFile(uninstalledFile, "utf8")
    .then(() => {
      throw new Error(`${PRODUCT_NAME} Server has been uninstalled: ${serverRoot}`);
    })
    .catch((error: unknown) => {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    });
  try {
    await releaseManager.recoverInterruptedUpdate();
  } catch (error: unknown) {
    await onRecoveryFailure(error);
    throw error;
  }
}
