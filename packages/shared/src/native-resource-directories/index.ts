import type {
  NativeResourceDirectoryPolicy,
  NativeResourceDirectoryResolutionOptions,
} from "./contract.js";

export type {
  NativeResourceDirectoryOptions,
  NativeResourceDirectoryPolicy,
  NativeResourceDirectoryResolutionOptions,
} from "./contract.js";

export const NATIVE_RESOURCE_DIRECTORY_ENV = "ZCODE_NATIVE_RESOURCE_DIR_NAME";
export const DEFAULT_NATIVE_RESOURCE_DIRECTORY_NAME = ".zcode";
export const DEFAULT_NATIVE_RESOURCE_DIRECTORY_POLICY: NativeResourceDirectoryPolicy =
  Object.freeze({ directoryName: DEFAULT_NATIVE_RESOURCE_DIRECTORY_NAME });

const INVALID_DIRECTORY_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/u;

export class NativeResourceDirectoryError extends Error {
  readonly code = "INVALID_NATIVE_RESOURCE_DIR_NAME";

  constructor() {
    super(
      `${NATIVE_RESOURCE_DIRECTORY_ENV} must be a single valid hidden directory name without path separators or a trailing dot`,
    );
    this.name = "NativeResourceDirectoryError";
  }
}

export function getNativeResourceDirectoryName(policy?: NativeResourceDirectoryPolicy): string {
  const name = policy?.directoryName ?? DEFAULT_NATIVE_RESOURCE_DIRECTORY_NAME;
  if (
    !name.startsWith(".") ||
    name === "." ||
    name === ".." ||
    INVALID_DIRECTORY_CHARACTERS.test(name) ||
    /[. ]$/u.test(name)
  ) {
    throw new NativeResourceDirectoryError();
  }
  return name;
}

/** 入口统一解析；纯函数不读取进程环境，也不改变运行时 storage 根。 */
export function resolveNativeResourceDirectoryPolicy(
  options: NativeResourceDirectoryResolutionOptions = {},
): NativeResourceDirectoryPolicy {
  const directoryName =
    options.env?.[NATIVE_RESOURCE_DIRECTORY_ENV]?.trim() ||
    options.productDirectoryName?.trim() ||
    DEFAULT_NATIVE_RESOURCE_DIRECTORY_NAME;
  return Object.freeze({ directoryName: getNativeResourceDirectoryName({ directoryName }) });
}
