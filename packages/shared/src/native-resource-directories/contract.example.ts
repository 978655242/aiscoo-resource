import { resolveNativeResourceDirectoryPolicy } from "./index.js";

export const nativeResourceDirectoryExample = resolveNativeResourceDirectoryPolicy({
  productDirectoryName: ".aiscoo",
  env: { ZCODE_NATIVE_RESOURCE_DIR_NAME: ".aiscoo-work" },
});
