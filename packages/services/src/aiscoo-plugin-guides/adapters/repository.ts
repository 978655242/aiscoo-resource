import { createHash } from "node:crypto";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  PLUGIN_GUIDE_TEMPLATE_VERSION,
  parsePluginGuideResponse,
  pluginGuideDocumentSchema,
  type PluginGuideDocument,
  type PluginGuideSource,
  type PluginGuideTarget,
} from "@zcode/shared/aiscoo-plugin-guides";
import { atomicWriteText, withAtomicFileLock } from "../../fs/atomicFileUtils.js";
import type { PluginGuideRepository } from "../contract.js";

const aliasSchema = z.object({ documentKey: z.string().regex(/^[a-f0-9]{64}$/u) }).strict();
const hash = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
export function createPluginGuideFileRepository(root: string): PluginGuideRepository {
  const documentKey = (
    source: Pick<PluginGuideSource, "sourceIdentity" | "pluginId">,
    locale: PluginGuideTarget["locale"],
  ) => hash([source.sourceIdentity, source.pluginId, locale, PLUGIN_GUIDE_TEMPLATE_VERSION]);
  const documentPath = (key: string) => join(root, "documents", `${key}.json`);
  const aliasPath = (target: PluginGuideTarget) =>
    join(
      root,
      "aliases",
      `${hash([target.workspaceIdentity?.trim() || target.workspacePath, target.marketplace, target.pluginName, target.locale])}.json`,
    );
  async function readJson(path: string): Promise<unknown | null> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024)
        throw new Error("Invalid plugin guide cache file");
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    }
  }
  async function load(key: string): Promise<PluginGuideDocument | null> {
    const raw = await readJson(documentPath(key));
    if (raw === null) return null;
    const document = pluginGuideDocumentSchema.parse(raw);
    parsePluginGuideResponse(
      `<reply>Saved guide</reply><guide>${document.markdown}</guide>`,
      document.locale,
    );
    return document;
  }
  return {
    async read(source, locale) {
      const document = await load(documentKey(source, locale));
      if (
        document &&
        (document.sourceIdentity !== source.sourceIdentity ||
          document.pluginId !== source.pluginId ||
          document.locale !== locale)
      )
        throw new Error("Plugin guide cache identity mismatch");
      return document;
    },
    async readFallback(target) {
      const raw = await readJson(aliasPath(target));
      if (raw === null) return null;
      const alias = aliasSchema.parse(raw);
      const document = await load(alias.documentKey);
      if (
        document &&
        (document.pluginId !== `${target.pluginName}@${target.marketplace}` ||
          document.locale !== target.locale)
      )
        throw new Error("Plugin guide alias identity mismatch");
      return document;
    },
    async save(target, input) {
      const document = pluginGuideDocumentSchema.parse(input);
      if (
        document.pluginId !== `${target.pluginName}@${target.marketplace}` ||
        document.locale !== target.locale
      )
        throw new Error("Cannot save a guide for a different plugin");
      const key = documentKey(document, document.locale);
      // The caller holds the document lock across read/generate/save; do not acquire it twice.
      await atomicWriteText(documentPath(key), JSON.stringify(document), { useFileLock: false });
      await atomicWriteText(aliasPath(target), JSON.stringify({ documentKey: key }));
    },
    async withLock(source, locale, run) {
      await mkdir(join(root, "documents"), { recursive: true });
      return withAtomicFileLock(documentPath(documentKey(source, locale)), run, {
        lockMaxWaitMs: 180_000,
      });
    },
  };
}
