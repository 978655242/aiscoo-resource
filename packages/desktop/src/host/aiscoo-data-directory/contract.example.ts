import type { ServiceCollection } from "@zcode/services";
import { registerAiscooDataDirectoryServices } from "./index.js";

export function exampleAiscooDataDirectory(
  services: ServiceCollection,
  defaultDataBaseDir: string,
) {
  registerAiscooDataDirectoryServices(services, defaultDataBaseDir);
  return services;
}
