import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  PLUGIN_GUIDE_MAX_SOURCE_BYTES,
  PLUGIN_GUIDE_MAX_SOURCE_FILES,
  pluginGuideSourceSchema,
  type PluginGuideSource,
} from "@zcode/shared/aiscoo-plugin-guides";
import {
  ensureMarketplaceManifestAvailable,
  listInstalledPluginRecords,
  loadKnownMarketplacesSync,
  loadMarketplaceManifestSync,
  resolveInstalledPluginRoot,
  withPluginSourceRoot,
} from "../plugins/marketplace.js";
import { isRecord } from "../plugins/helpers.js";
import type { ReadPluginGuideSourceInput } from "./contract.js";

const MANIFESTS = [
  ".zcode-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
];
const MAX_DIRECTORY_ENTRIES = 4096;
const MAX_DEPTH = 16;
const digest = (value: unknown) =>
  `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;

/** No network for identity reads; materialization and its temporary lifetime remain in the marketplace resolver. */
export async function readPluginGuideSource(
  input: ReadPluginGuideSourceInput,
): Promise<PluginGuideSource> {
  if (
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(input.name) ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(input.marketplace)
  ) {
    throw new Error("Invalid plugin or marketplace identity");
  }
  const installed = listInstalledPluginRecords(input.storageRoot).find(
    (record) => record.marketplace === input.marketplace && record.name === input.name,
  );
  let manifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
  if (!manifest && !installed && input.mode === "documents") {
    await (input.withWriteLock ?? ((write) => write()))(() =>
      ensureMarketplaceManifestAvailable({
        marketplace: input.marketplace,
        storageRoot: input.storageRoot,
      }),
    );
    manifest = loadMarketplaceManifestSync(input.storageRoot, input.marketplace);
  }
  const entry = manifest?.plugins.find((candidate) => candidate.name === input.name);
  if (!entry && !installed)
    throw new Error("Plugin is not present in the authoritative cached marketplace");
  const marketplace = loadKnownMarketplacesSync(input.storageRoot).find(
    (record) => record.id === input.marketplace,
  );
  const source = installed?.source ?? entry?.source;
  const version = installed?.version ?? entry?.version;
  const sourceIdentity = digest({
    marketplace: input.marketplace,
    marketplaceSource: sourceCoordinates(marketplace?.source),
    plugin: input.name,
    source: sourceCoordinates(source),
    ...(source === "filesystem" || source === "sea" ? { cache: entry?.cachePath } : {}),
  });
  const pinned =
    isRecord(source) &&
    ["sha", "sha256", "commit"].some(
      (key) => typeof source[key] === "string" && source[key].length > 0,
    );
  const sourceRevision = digest({
    version,
    source: sourceRevisionCoordinates(source),
    ...(!installed && !pinned
      ? { catalogRevision: marketplace?.cacheTransactionId ?? marketplace?.lastUpdated }
      : {}),
  });
  const base = {
    pluginId: `${input.name}@${input.marketplace}`,
    sourceIdentity,
    sourceRevision,
    ...(version ? { version } : {}),
  };
  const read = async (root: string): Promise<PluginGuideSource> => {
    const material = await readMaterials(root);
    const fingerprint = digest(material.documents);
    return pluginGuideSourceSchema.parse({
      ...base,
      ...(!version && material.version ? { version: material.version } : {}),
      fingerprint,
      fingerprintKind: "content",
      documents: input.mode === "documents" ? material.documents : [],
      diagnostics: material.diagnostics,
    });
  };
  if (installed) return read(resolveInstalledPluginRoot(input.storageRoot, installed));
  const local =
    source === undefined ||
    typeof source === "string" ||
    (isRecord(source) && source.source === "directory");
  if (input.mode === "identity" && !local) {
    return pluginGuideSourceSchema.parse({
      ...base,
      fingerprint: sourceRevision,
      fingerprintKind: "revision",
      documents: [],
      diagnostics: [
        "Remote source identity uses cached metadata; content is inspected only when generating a guide.",
      ],
    });
  }
  return withPluginSourceRoot(
    { entry: entry!, marketplace: input.marketplace, storageRoot: input.storageRoot },
    read,
  );
}

function sourceCoordinates(source: unknown): unknown {
  if (typeof source === "string") return source;
  if (!isRecord(source)) return null;
  const result: Record<string, string> = {};
  for (const key of ["source", "type", "repo", "path", "package"] as const) {
    if (typeof source[key] === "string") result[key] = source[key];
  }
  if (typeof source.url === "string") {
    try {
      const url = new URL(source.url);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      result.url = url.toString();
    } catch {
      // SCP-style Git addresses are hashed, never returned as display text.
      result.url = source.url.replace(/^[^@]+@/u, "").replace(/[?#].*$/u, "");
    }
  }
  return result;
}

function sourceRevisionCoordinates(source: unknown): unknown {
  if (!isRecord(source)) return null;
  return Object.fromEntries(
    ["ref", "sha", "sha256", "commit"].flatMap((key) =>
      typeof source[key] === "string" ? [[key, source[key]]] : [],
    ),
  );
}

async function readMaterials(rootPath: string) {
  if ((await lstat(rootPath)).isSymbolicLink())
    throw new Error("Plugin material root must not be a symbolic link");
  const root = await realpath(rootPath);
  const documents: PluginGuideSource["documents"] = [];
  const diagnostics: string[] = [];
  const seen = new Set<string>();
  let bytes = 0;
  let directoryEntries = 0;
  let version: string | undefined;
  const diagnose = (text: string) => {
    if (diagnostics.length < 99) diagnostics.push(text);
    else if (diagnostics.length === 99)
      diagnostics.push("Additional source diagnostics omitted; materials are incomplete.");
  };
  const listDirectory = async (absolute: string): Promise<string[]> => {
    const entries: string[] = [];
    for await (const entry of await opendir(absolute)) {
      if (++directoryEntries > MAX_DIRECTORY_ENTRIES) {
        diagnose("Source directory entry budget exceeded; materials are incomplete.");
        break;
      }
      entries.push(entry.name);
    }
    return entries.sort((a, b) => a.localeCompare(b, "en"));
  };
  const safePath = async (path: string): Promise<string | undefined> => {
    const absolute = resolve(root, path);
    const rel = relative(root, absolute);
    if (
      isAbsolute(path) ||
      path.split(/[/\\]/u).includes("..") ||
      rel === ".." ||
      rel.startsWith(`..${sep}`)
    ) {
      diagnose("A declared material path is outside the plugin root and was excluded.");
      return;
    }
    let current = root;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) {
          diagnose("A symbolic link material was excluded; materials may be incomplete.");
          return;
        }
      } catch (error) {
        if (isRecord(error) && error.code === "ENOENT") return;
        throw new Error("Plugin material metadata could not be read");
      }
    }
    const canonical = await realpath(absolute);
    if (canonical !== absolute || (await realpath(rootPath)) !== root)
      throw new Error("Plugin material path changed during reading");
    return absolute;
  };
  const readText = async (path: string): Promise<string | undefined> => {
    const absolute = await safePath(path);
    if (!absolute) return;
    const metadata = await lstat(absolute);
    if (!metadata.isFile()) return;
    if (metadata.size > PLUGIN_GUIDE_MAX_SOURCE_BYTES - bytes) {
      diagnose(
        "Source byte budget exceeded; the oversized document was excluded and materials are incomplete.",
      );
      return;
    }
    const handle = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const opened = await handle.stat();
      if (
        !opened.isFile() ||
        opened.dev !== metadata.dev ||
        opened.ino !== metadata.ino ||
        (await realpath(absolute)) !== absolute
      )
        throw new Error("Plugin material changed during reading");
      const buffer = Buffer.alloc(
        Math.min(PLUGIN_GUIDE_MAX_SOURCE_BYTES - bytes + 1, opened.size + 1),
      );
      let length = 0;
      while (length < buffer.length) {
        const chunk = await handle.read(buffer, length, buffer.length - length, null);
        if (!chunk.bytesRead) break;
        length += chunk.bytesRead;
      }
      if (length > opened.size || length > PLUGIN_GUIDE_MAX_SOURCE_BYTES - bytes) {
        diagnose("Source byte budget exceeded or document changed; materials are incomplete.");
        return;
      }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length));
      if (text.includes("\0")) {
        diagnose("A binary document was excluded; materials are incomplete.");
        return;
      }
      return text;
    } finally {
      await handle.close();
    }
  };
  const add = (path: string, text: string) => {
    if (
      documents.length >= PLUGIN_GUIDE_MAX_SOURCE_FILES ||
      bytes + Buffer.byteLength(text) > PLUGIN_GUIDE_MAX_SOURCE_BYTES
    ) {
      diagnose("Source file or byte budget exceeded; materials are incomplete.");
      return;
    }
    documents.push({ path: path.split(sep).join("/"), text });
    bytes += Buffer.byteLength(text);
  };
  let pluginManifest: Record<string, unknown> = {};
  for (const path of MANIFESTS) {
    const text = await readText(path);
    if (text === undefined) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed)) throw new Error("Invalid manifest");
      pluginManifest = parsed;
      if (typeof parsed.version === "string") version = parsed.version.slice(0, 256);
      add("manifest-capabilities.json", JSON.stringify(sanitizeManifest(parsed), null, 2));
    } catch {
      diagnose("Plugin manifest could not be parsed; capability information is incomplete.");
    }
    break;
  }
  const walk = async (
    path: string,
    kind: "readme" | "skill" | "markdown",
    depth = 0,
  ): Promise<void> => {
    if (seen.has(path)) return;
    seen.add(path);
    if (
      documents.length >= PLUGIN_GUIDE_MAX_SOURCE_FILES ||
      bytes >= PLUGIN_GUIDE_MAX_SOURCE_BYTES
    ) {
      diagnose("Source file or byte budget exceeded; materials are incomplete.");
      return;
    }
    if (depth > MAX_DEPTH || directoryEntries >= MAX_DIRECTORY_ENTRIES) {
      diagnose("Source directory traversal budget exceeded; materials are incomplete.");
      return;
    }
    const absolute = await safePath(path);
    if (!absolute) return;
    const stat = await lstat(absolute);
    if (stat.isDirectory()) {
      for (const entry of await listDirectory(absolute)) {
        if (entry.startsWith(".") || entry === "node_modules") continue;
        await walk(join(path, entry), kind, depth + 1);
      }
    } else if (
      stat.isFile() &&
      (kind === "readme"
        ? /(^|[/\\])README(?:(?:\.[a-z-]+)?\.(?:md|markdown))?$/iu.test(path)
        : kind === "skill"
          ? /(^|[/\\])SKILL\.md$/iu.test(path)
          : /\.(?:md|markdown)$/iu.test(path))
    ) {
      const text = await readText(path);
      if (text !== undefined) add(path, text);
    }
  };
  for (const entry of await listDirectory(root)) {
    if (/^README(?:(?:\.[a-z-]+)?\.(?:md|markdown))?$/iu.test(entry) || entry === "SKILL.md")
      await walk(entry, entry === "SKILL.md" ? "skill" : "readme");
  }
  for (const [key, kind] of [
    ["skills", "skill"],
    ["commands", "markdown"],
    ["agents", "markdown"],
  ] as const) {
    await walk(key, kind);
    const declared = pluginManifest[key];
    for (const path of typeof declared === "string"
      ? [declared]
      : Array.isArray(declared)
        ? declared
        : []) {
      if (typeof path === "string") await walk(path, kind);
    }
    if (isRecord(declared))
      diagnose(
        `Embedded ${key} definitions contribute names only; their executable/configuration values are excluded.`,
      );
  }
  documents.sort((a, b) => a.path.localeCompare(b.path, "en"));
  if (!documents.length)
    diagnose("No supported plugin documents were available; materials are incomplete.");
  return { documents, diagnostics, version };
}

/** Only names and declarative capability kinds cross this boundary; never config values or commands. */
function sanitizeManifest(manifest: Record<string, unknown>): Record<string, unknown> {
  const names = (value: unknown) =>
    isRecord(value)
      ? Object.keys(value)
          .filter((name) => /^[\w.:-]{1,128}$/u.test(name))
          .sort()
      : [];
  return {
    ...(typeof manifest.name === "string" ? { name: manifest.name.slice(0, 256) } : {}),
    ...(typeof manifest.version === "string" ? { version: manifest.version.slice(0, 256) } : {}),
    capabilities: ["skills", "commands", "agents", "hooks", "mcpServers", "ui"].filter(
      (key) => manifest[key] !== undefined,
    ),
    mcpServerNames: names(manifest.mcpServers),
    hookEventNames: names(
      isRecord(manifest.hooks) ? (manifest.hooks.hooks ?? manifest.hooks) : undefined,
    ),
    configurationNames: names(manifest.userConfig),
    commandNames: names(manifest.commands),
    agentNames: names(manifest.agents),
  };
}
