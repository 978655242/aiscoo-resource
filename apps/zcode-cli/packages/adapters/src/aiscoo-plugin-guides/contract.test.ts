import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPluginGuideSource } from "./index.js";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { withPluginSourceRoot } from "../plugins/index.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(source?: unknown) {
  const storageRoot = await mkdtemp(join(tmpdir(), "aiscoo-guide-source-"));
  roots.push(storageRoot);
  const root = join(storageRoot, "plugin");
  await mkdir(join(root, ".zcode-plugin"), { recursive: true });
  await writeFile(
    join(root, ".zcode-plugin/plugin.json"),
    JSON.stringify({
      name: "sample",
      version: "9.0.0",
      userConfig: { apiKey: { default: "secret-value" } },
      mcpServers: { search: { env: { TOKEN: "secret-env" } } },
    }),
  );
  await writeFile(join(root, "README.md"), "Use the sample plugin.");
  await mkdir(join(storageRoot, "marketplaces/market"), { recursive: true });
  await writeFile(
    join(storageRoot, "marketplaces/market/marketplace.json"),
    JSON.stringify({
      name: "market",
      plugins: [
        { name: "sample", version: "1.0.0", source: source ?? { source: "directory", path: root } },
      ],
    }),
  );
  return { root, storageRoot, marketplace: "market", name: "sample" };
}

describe("read-only plugin guide materials", () => {
  it("reads uninstalled documents, only projects configuration names and never installs", async () => {
    const input = await fixture();
    const result = await readPluginGuideSource({ ...input, mode: "documents" });
    expect(result.version).toBe("1.0.0");
    expect(result.documents.find((document) => document.path === "README.md")?.text).toBe(
      "Use the sample plugin.",
    );
    expect(JSON.stringify(result)).toContain("apiKey");
    expect(JSON.stringify(result)).not.toMatch(/secret-value|secret-env/);
    await expect(readFile(join(input.storageRoot, "installed_plugins.json"))).rejects.toThrow();
  });

  it("uses offline cached remote identity without downloading or exposing URL credentials", async () => {
    const input = await fixture({
      source: "url",
      type: "zip",
      url: "https://user:password@127.0.0.1:1/plugin.zip?token=secret",
      headers: { Authorization: "private" },
      sha256: "a".repeat(64),
    });
    const first = await readPluginGuideSource({ ...input, mode: "identity" });
    const second = await readPluginGuideSource({ ...input, mode: "identity" });
    expect(first).toEqual(second);
    expect(first.documents).toEqual([]);
    expect(first.sourceRevision).toMatch(/^sha256:/);
    expect(JSON.stringify(first)).not.toMatch(/password|secret|private|127\.0\.0\.1/);
  });

  it("detects local same-version edits and keeps identity and document fingerprints equal", async () => {
    const input = await fixture();
    const before = await readPluginGuideSource({ ...input, mode: "identity" });
    await writeFile(join(input.root, "README.md"), "Changed instructions");
    const after = await readPluginGuideSource({ ...input, mode: "identity" });
    const documents = await readPluginGuideSource({ ...input, mode: "documents" });
    expect(after.sourceRevision).toBe(before.sourceRevision);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    expect(after.fingerprint).toBe(documents.fingerprint);
    expect(after.documents).toEqual([]);
  });

  it("does not follow symlinks, manifest traversal or configuration files", async () => {
    const input = await fixture();
    await writeFile(join(input.storageRoot, "outside.md"), "OUTSIDE-SECRET");
    await mkdir(join(input.root, "commands"));
    await symlink(join(input.storageRoot, "outside.md"), join(input.root, "commands/escape.md"));
    await writeFile(join(input.root, ".env"), "ENV-SECRET");
    await writeFile(
      join(input.root, ".zcode-plugin/plugin.json"),
      JSON.stringify({ name: "sample", commands: ["../outside.md"] }),
    );
    const result = await readPluginGuideSource({ ...input, mode: "documents" });
    expect(JSON.stringify(result)).not.toMatch(/OUTSIDE-SECRET|ENV-SECRET/);
    expect(result.diagnostics.join(" ")).toMatch(/symbolic|outside/i);
  });

  it("reports an explicit incomplete-material diagnostic for source budget overflow", async () => {
    const input = await fixture();
    await writeFile(join(input.root, "README.md"), "x".repeat(300_000));
    const result = await readPluginGuideSource({ ...input, mode: "documents" });
    expect(result.diagnostics.join(" ")).toMatch(/budget|limit/i);
    expect(result.documents.some((document) => document.path === "README.md")).toBe(false);
  });

  it("uses the installed revision even when the marketplace advertises a later version", async () => {
    const input = await fixture();
    await writeFile(
      join(input.storageRoot, "installed_plugins.json"),
      JSON.stringify({
        version: 1,
        plugins: [
          {
            id: "sample@market",
            name: "sample",
            marketplace: "market",
            version: "0.8.0",
            installPath: input.root,
            installedAt: new Date(0).toISOString(),
            scope: "user",
          },
        ],
      }),
    );
    expect((await readPluginGuideSource({ ...input, mode: "identity" })).version).toBe("0.8.0");
  });

  it.each([false, true])(
    "cleans a verified downloaded source after its reader settles (reject=%s)",
    async (reject) => {
      const input = await fixture();
      const zip = Buffer.from(
        "UEsDBBQAAAAAACVaW10I6EwnFQAAABUAAAAJAAAAUkVBRE1FLm1kR3VpZGUgY2xlYW51cCBmaXh0dXJlUEsBAhQDFAAAAAAAJVpbXQjoTCcVAAAAFQAAAAkAAAAAAAAAAAAAAIABAAAAAFJFQURNRS5tZFBLBQYAAAAAAQABADcAAAA8AAAAAAA=",
        "base64",
      );
      const server = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/zip" });
        response.end(zip);
      });
      const listening = Promise.withResolvers<void>();
      server.once("error", listening.reject);
      server.listen(0, "127.0.0.1", listening.resolve);
      await listening.promise;
      const address = server.address();
      if (!address || typeof address === "string")
        throw new Error("Missing loopback fixture address");
      let resolvedRoot = "";
      try {
        const result = withPluginSourceRoot(
          {
            storageRoot: input.storageRoot,
            marketplace: "market",
            entry: {
              name: "sample",
              raw: {},
              source: {
                source: "url",
                type: "zip",
                url: `http://127.0.0.1:${address.port}/sample.zip`,
                sha256: createHash("sha256").update(zip).digest("hex"),
              },
            },
          },
          async (root) => {
            resolvedRoot = root;
            expect(await readFile(join(root, "README.md"), "utf8")).toBe("Guide cleanup fixture");
            if (reject) throw new Error("Reader failed");
            return "read";
          },
        );
        if (reject) await expect(result).rejects.toThrow("Reader failed");
        else await expect(result).resolves.toBe("read");
        expect(resolvedRoot).not.toBe("");
        await expect(access(resolvedRoot)).rejects.toThrow();
      } finally {
        const closed = Promise.withResolvers<void>();
        server.close((error) => (error ? closed.reject(error) : closed.resolve()));
        await closed.promise;
      }
    },
  );

  it("detects a cached catalog refresh for an unpinned remote source without materializing it", async () => {
    const input = await fixture({
      source: "git",
      url: "https://example.invalid/sample.git",
      ref: "main",
    });
    const known = {
      id: "market",
      name: "market",
      source: { source: "directory", path: "/cached-catalog" },
      addedAt: new Date(0).toISOString(),
      pluginCount: 1,
    };
    const saveKnown = (lastUpdated: string) =>
      writeFile(
        join(input.storageRoot, "known_marketplaces.json"),
        JSON.stringify({ version: 1, marketplaces: [{ ...known, lastUpdated }] }),
      );
    await saveKnown("2026-10-26T00:00:00.000Z");
    const before = await readPluginGuideSource({ ...input, mode: "identity" });
    await saveKnown("2026-10-27T00:00:00.000Z");
    const after = await readPluginGuideSource({ ...input, mode: "identity" });
    expect(after.sourceIdentity).toBe(before.sourceIdentity);
    expect(after.sourceRevision).not.toBe(before.sourceRevision);
    expect(after.fingerprintKind).toBe("revision");
    expect(after.documents).toEqual([]);
  });
});
