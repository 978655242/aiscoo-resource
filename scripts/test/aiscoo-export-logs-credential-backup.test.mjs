import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { build } from "esbuild";

// 凭据恢复会生成 `credentials.json.corrupt-<id>[.<uuid>].bak|.tmp`，内容是整份密文（含其他 origin 与
// 官方云旧密文）。日志导出必须像排除 credentials.json 本身一样排除它们。
const entry = new URL("../../packages/desktop/src/main/exportLogs.ts", import.meta.url);

async function loadExportLogs() {
  const result = await build({
    entryPoints: [entry.pathname],
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [
      {
        name: "stub-main-collaborators",
        setup(b) {
          b.onResolve(
            { filter: /^(yazl|@zcode\/services\/node|\.\/about\.js|\.\/logger\.js)$/ },
            (args) => ({
              path: args.path,
              namespace: "stub",
            }),
          );
          b.onLoad({ filter: /.*/, namespace: "stub" }, (args) => ({
            loader: "js",
            contents:
              args.path === "yazl"
                ? `export class ZipFile {}`
                : args.path === "@zcode/services/node"
                  ? `export const createFeedbackDiagnosticArchive = () => {}; export const getAppConfigDir = () => "";
                   export const getExportLogDir = () => ""; export const getExportLogStageDir = () => "";
                   export const getFeedbackLogArchiveDir = () => "";`
                  : args.path === "./about.js"
                    ? `export const createAboutSnapshot = () => ({}); export const formatAboutDetail = () => ""; export const readBuildMetadata = () => ({});`
                    : `export const logger = { info() {}, warn() {}, error() {}, debug() {} };`,
          }));
        },
      },
    ],
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`
  );
}

test("credential files, recovery backups and leftover temp files are never archived", async () => {
  const { collectLogArchiveFiles } = await loadExportLogs();
  const dir = await mkdtemp(join(tmpdir(), "xwork-export-logs-"));
  try {
    const id = "0123456789abcdef01234567";
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    const excluded = [
      "credentials.json",
      ".credentials.json",
      `credentials.json.corrupt-${id}.bak`,
      `credentials.json.corrupt-${id}.${uuid}.bak`,
      `credentials.json.corrupt-${id}.${uuid}.tmp`,
      `CREDENTIALS.JSON.CORRUPT-${id}.BAK`,
    ];
    const kept = [
      "app.log",
      "credentials-help.log",
      "mycredentials.json.log",
      `other.json.corrupt-${id}.bak`,
    ];
    await mkdir(join(dir, "sub"), { recursive: true });
    for (const name of [...excluded, ...kept]) await writeFile(join(dir, name), "x");
    await writeFile(join(dir, "sub", `credentials.json.corrupt-${id}.bak`), "x");

    const archived = (await collectLogArchiveFiles(dir)).map(
      (file) => file.archivePath ?? file.relativePath,
    );
    for (const name of excluded) assert.equal(archived.includes(name), false, `excluded: ${name}`);
    assert.equal(archived.includes(`sub/credentials.json.corrupt-${id}.bak`), false);
    for (const name of kept) assert.equal(archived.includes(name), true, `kept: ${name}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
