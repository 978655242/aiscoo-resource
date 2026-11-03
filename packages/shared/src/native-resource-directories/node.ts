import { join } from "node:path";
import type { NativeResourceDirectoryPolicy } from "./contract.js";
import { getNativeResourceDirectoryName } from "./index.js";

export * from "./index.js";

export function nativeUserResourcePath(
  homeDirectory: string,
  policy?: NativeResourceDirectoryPolicy,
  ...segments: string[]
): string {
  return join(homeDirectory, getNativeResourceDirectoryName(policy), ...segments);
}

export function nativeProjectResourcePath(
  workingDirectory: string,
  policy?: NativeResourceDirectoryPolicy,
  ...segments: string[]
): string {
  return join(workingDirectory, getNativeResourceDirectoryName(policy), ...segments);
}

export function nativeUserConfigPath(
  homeDirectory: string,
  policy?: NativeResourceDirectoryPolicy,
): string {
  return nativeUserResourcePath(homeDirectory, policy, "cli", "config.json");
}

export function nativeProjectConfigPath(
  workingDirectory: string,
  policy?: NativeResourceDirectoryPolicy,
): string {
  return nativeProjectResourcePath(workingDirectory, policy, "config.json");
}
