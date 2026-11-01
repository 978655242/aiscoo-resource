import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { resolveAiscooDesktopIdentity } from "@zcode/shared/aiscoo-desktop-identity";
import { atomicWritePrivateTextFile, withFileLock } from "@zcode/shared/node";
import type { AiscooDesktopStorageInitialization } from "./contract.js";

let cliBaseDir: string | undefined;

function bindingFilePath(settingsFile: string): string {
  const name = basename(settingsFile);
  const suffix =
    name === "setting.json" ? "" : `-${createHash("sha256").update(name).digest("hex")}`;
  // XCODE: 原 v2 迁移只排除 setting.json.*；自定义设置文件也必须用此前缀，摘要隔离同目录记录。
  return join(dirname(settingsFile), `setting.json.aiscoo-cli-root${suffix}.json`);
}

function isAbsoluteRoot(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    isAbsolute(value)
  );
}

/** 只记录首次恢复的 App 根，不搬动数据库；损坏或不可写时必须阻止 Host 打开另一空库。 */
export async function initializeAiscooDesktopStorage(
  options: AiscooDesktopStorageInitialization,
): Promise<string | undefined> {
  if (!resolveAiscooDesktopIdentity()) return undefined;
  if (cliBaseDir !== undefined) return cliBaseDir;
  const bindingFile = bindingFilePath(options.settingsFile);
  try {
    const root = await withFileLock(bindingFile, async () => {
      let contents: string | undefined;
      try {
        // XCODE: 必须在锁内重读，多个 Main/初始化调用只能接受首个已提交的绑定。
        contents = await readFile(bindingFile, "utf8");
      } catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
      if (contents !== undefined) {
        const record: unknown = JSON.parse(contents);
        if (
          !record ||
          typeof record !== "object" ||
          !("version" in record) ||
          record.version !== 1 ||
          !("cliBaseDir" in record) ||
          !isAbsoluteRoot(record.cliBaseDir)
        ) {
          throw new Error("Expected version 1 and a non-empty absolute cliBaseDir");
        }
        return record.cliBaseDir;
      }
      if (!isAbsoluteRoot(options.dataBaseDir)) {
        throw new Error("The restored App data directory must be a non-empty absolute path");
      }
      await atomicWritePrivateTextFile(
        bindingFile,
        `${JSON.stringify({ version: 1, cliBaseDir: options.dataBaseDir }, null, 2)}\n`,
      );
      return options.dataBaseDir;
    });
    cliBaseDir = root;
    return root;
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Aiscoo CLI root binding failed (${bindingFile}): ${detail}`, { cause });
  }
}

export function isAiscooDesktopStorageReady(): boolean {
  return !resolveAiscooDesktopIdentity() || cliBaseDir !== undefined;
}

export function getAiscooDesktopCliBaseDir(): string | undefined {
  if (!resolveAiscooDesktopIdentity()) return undefined;
  if (cliBaseDir === undefined) throw new Error("Aiscoo CLI root binding is not initialized");
  return cliBaseDir;
}
