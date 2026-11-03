import {
  nativeUserResourcePath,
  type NativeResourceDirectoryPolicy,
} from "@zcode/shared/native-resource-directories/node";
import { lstat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { isPathWithin } from "./directoryContent.js";

/**
 * XCODE: collector 不进入软链目录，但 mkdir/原子写会跟随祖先；写入前逐级拒绝现存链接。
 * HOME 是可信锚，允许系统路径别名；检查覆盖 .zcode、commands 根、目标祖先及最终文件。
 * 此检查不创建目录，也不声称消除检查完成后恶意并发换链的 TOCTOU。
 */
export async function assertCommandSyncDestination(
  homeDirectory: string,
  targetPath: string,
  nativeDirectories?: NativeResourceDirectoryPolicy,
): Promise<void> {
  const home = resolve(homeDirectory);
  const root = nativeUserResourcePath(home, nativeDirectories, "commands");
  const target = resolve(targetPath);
  if (!isPathWithin(root, target)) {
    throw new Error(`target command is outside the command root: ${targetPath}`);
  }
  const segments = relative(home, target).split(sep);
  let current = home;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      // XCODE: 只有尚未创建才可继续；权限、非目录等错误不能伪装成空路径。
      if (error instanceof Error && "code" in error && error.code === "ENOENT") continue;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`target command path contains a symlink: ${current}`);
    }
    if (index < segments.length - 1 && !info.isDirectory()) {
      throw new Error(`target command ancestor is not a directory: ${current}`);
    }
  }
}
