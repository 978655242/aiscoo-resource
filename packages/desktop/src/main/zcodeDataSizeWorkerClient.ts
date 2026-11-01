// XCODE: 自有静态模板使用共享品牌，用户插值和兼容标识保持不变。
import { PRODUCT_NAME } from "@zcode/shared/aiscoo-brand";
import { Worker } from "node:worker_threads";

import {
  isZCodeDataSizeScanResult,
  type ZCodeDataSizeScanRequest,
  type ZCodeDataSizeScanResult,
} from "./zcodeDataSizeScanner.js";

export function scanZCodeDataDirectoryInWorker(
  request: ZCodeDataSizeScanRequest,
  signal: AbortSignal,
): Promise<ZCodeDataSizeScanResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./zcodeDataSizeWorker.js", import.meta.url), {
      workerData: request,
    });
    let settled = false;

    const finish = (run: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", abort);
      run();
    };
    const abort = () => {
      void worker.terminate();
      // XCODE: Worker 错误使用产品展示名，消息协议保持不变。
      finish(() =>
        reject(new DOMException(`${PRODUCT_NAME} data size scan aborted`, "AbortError")),
      );
    };

    worker.once("message", (message: unknown) => {
      const response = message as { ok?: unknown; result?: unknown; error?: unknown };
      if (response.ok === true && isZCodeDataSizeScanResult(response.result)) {
        finish(() => resolve(response.result as ZCodeDataSizeScanResult));
        return;
      }
      finish(() =>
        reject(
          new Error(
            response.ok === false && typeof response.error === "string"
              ? response.error
              : `Invalid ${PRODUCT_NAME} data size worker response`,
          ),
        ),
      );
    });
    worker.once("error", (error) => finish(() => reject(error)));
    worker.once("exit", (code) => {
      if (code !== 0) {
        finish(() =>
          reject(new Error(`${PRODUCT_NAME} data size worker exited with code ${code}`)),
        );
      }
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    worker.unref();
  });
}
