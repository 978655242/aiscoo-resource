import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const scriptPath = fileURLToPath(new URL("./publish-macos-update.mjs", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const version = "3.18.0";
const buildId = "test-build";
const zipName = `Aiscoo-${version}-mac-arm64.zip`;
const objectKey = `releases/aiscoo/${version}/macos/arm64/${buildId}/${zipName}`;
const zipBytes = Buffer.from("PK\u0003\u0004synthetic macOS update fixture\n".repeat(1024));
const token = "synthetic-root-pat-with-ops-write";
const digest = (bytes) => createHash("sha512").update(bytes).digest("base64");
let harnessRoot;
let fakeBin;
let preloadPath;
let tlsOptions;
let certificatePath;

before(async () => {
  harnessRoot = await mkdtemp(join(tmpdir(), "aiscoo-publish-regression-"));
  fakeBin = join(harnessRoot, "bin");
  await mkdir(fakeBin);
  const aliyunPath = join(fakeBin, "aliyun");
  await writeFile(
    aliyunPath,
    `#!${process.execPath}
import { appendFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const args = process.argv.slice(2);
await appendFile(process.env.FAKE_ALIYUN_LOG, JSON.stringify(args) + "\\n");
if (JSON.stringify(args.slice(0, 3)) !== JSON.stringify(["--auto-plugin-install", "false", "ossutil"])) {
  process.stderr.write("unexpected aliyun invocation\\n");
  process.exit(1);
}
const child = spawn("ossutil", args.slice(3), { stdio: "inherit" });
child.on("error", () => process.exit(1));
child.on("exit", (code) => process.exit(code ?? 1));
`,
  );
  const ossutilPath = join(fakeBin, "ossutil");
  await writeFile(
    ossutilPath,
    `#!${process.execPath}
import { appendFile, readFile, writeFile } from "node:fs/promises";
const args = process.argv.slice(2);
const scenario = process.env.FAKE_OSS_SCENARIO;
await appendFile(process.env.FAKE_OSS_LOG, JSON.stringify(args) + "\\n");
if (scenario === "403" || scenario === "network") {
  process.stderr.write(scenario === "403" ? "HTTP 403 AccessDenied\\n" : "connect ECONNRESET\\n");
  process.exit(1);
}
if (args[0] === "stat") {
  process.stderr.write("HTTP 404 NoSuchKey\\n");
  process.exit(1);
}
if (args[0] !== "api" || args[1] !== "put-object" || args.includes("--meta")) {
  process.stderr.write("unsupported ossutil 2.3.0 invocation\\n");
  process.exit(1);
}
const option = (name) => args.find((arg) => arg.startsWith(name + "="))?.slice(name.length + 1) ?? args[args.indexOf(name) + 1];
if (!option("--body").startsWith("file://")) process.exit(1);
const bytes = await readFile(option("--body").slice("file://".length));
if (scenario === "race") await writeFile(process.env.FAKE_BUCKET_OBJECT, "concurrent publisher");
try {
  await writeFile(process.env.FAKE_BUCKET_OBJECT, bytes, { flag: option("--forbid-overwrite") === "true" ? "wx" : "w" });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  process.stderr.write("HTTP 409 FileAlreadyExists\\n");
  process.exit(1);
}
`,
  );
  await Promise.all([chmod(aliyunPath, 0o700), chmod(ossutilPath, 0o700)]);
  preloadPath = join(harnessRoot, "guard.mjs");
  await writeFile(
    preloadPath,
    `import childProcess from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
const dryRunGuard = process.env.FAKE_GUARD_DRY_RUN === "1";
const streamGuard = process.env.FAKE_GUARD_STREAM === "1";
if (dryRunGuard) {
  process.env = new Proxy(process.env, {
    get(target, key) {
      if (key === "AISCOO_ADMIN_ACCESS_TOKEN") throw new Error("dry-run read admin token");
      return Reflect.get(target, key);
    },
  });
  childProcess.execFile = () => { throw new Error("dry-run started CLI"); };
  net.Socket.prototype.connect = () => { throw new Error("dry-run opened network socket"); };
}
if (streamGuard) {
  for (const [owner, name] of [[fsPromises, "readFile"], [fs, "readFile"], [fs, "readFileSync"]]) {
    const original = owner[name];
    owner[name] = function(path, ...args) {
      if (String(path).endsWith(".zip")) throw new Error("zip was buffered by readFile");
      return original.call(this, path, ...args);
    };
  }
}
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  if (dryRunGuard) throw new Error("dry-run called fetch");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(new URL(input).hostname)) {
    throw new Error("test forbids external HTTP");
  }
  return originalFetch(input, init);
};
syncBuiltinESMExports();
`,
  );
  certificatePath = join(harnessRoot, "localhost.crt");
  const keyPath = join(harnessRoot, "localhost.key");
  await exec("openssl", [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-noenc",
    "-keyout",
    keyPath,
    "-out",
    certificatePath,
    "-subj",
    "/CN=localhost",
    "-addext",
    "subjectAltName=DNS:localhost,IP:127.0.0.1",
    "-days",
    "2",
  ]);
  tlsOptions = { key: await readFile(keyPath), cert: await readFile(certificatePath) };
});

after(async () => {
  if (harnessRoot) await rm(harnessRoot, { recursive: true, force: true });
});

async function listen(server, t) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return server.address().port;
}

async function fixture(t, { download = "good", scenario = "", existing = false } = {}) {
  const root = await mkdtemp(join(harnessRoot, "case-"));
  const artifactDir = join(root, "artifacts");
  await mkdir(artifactDir);
  const zipPath = join(artifactDir, zipName);
  const feedPath = join(artifactDir, "latest-mac.yml");
  const bucketObject = join(root, "bucket-object");
  const callsPath = join(root, "ossutil.jsonl");
  const aliyunCallsPath = join(root, "aliyun.jsonl");
  const feed = {
    version,
    files: [{ url: zipName, sha512: digest(zipBytes), size: zipBytes.length }],
    path: zipName,
    sha512: digest(zipBytes),
    releaseDate: "2026-11-01T00:00:00Z",
    minimumSystemVersion: "22.0.0",
    releaseNotesByLocale: { "zh-CN": "合成更新说明", "en-US": "Synthetic update" },
  };
  await Promise.all([writeFile(zipPath, zipBytes), writeFile(feedPath, JSON.stringify(feed))]);
  if (existing) await writeFile(bucketObject, "previous publication");
  const requests = [];
  const events = [];
  const publicServer = createHttpsServer(tlsOptions, (request, response) => {
    requests.push({ target: "download", method: request.method, url: request.url });
    events.push("download:start");
    if (download === "403") {
      response.writeHead(403).end();
      return;
    }
    if (download === "network") {
      request.socket.destroy();
      return;
    }
    if (download === "redirect") {
      response.writeHead(302, { location: "/unexpected-redirect" }).end();
      return;
    }
    let bytes = Buffer.from(zipBytes);
    if (download === "tampered") bytes[bytes.length - 1] ^= 1;
    if (download === "size") bytes = bytes.subarray(0, bytes.length - 1);
    if (download === "header") response.setHeader("content-length", bytes.length + 1);
    if (download === "truncated") {
      response.writeHead(200, { "content-length": bytes.length });
      response.write(bytes.subarray(0, 128));
      setImmediate(() => response.destroy());
      return;
    }
    response.writeHead(200, { "content-type": "application/zip" });
    response.write(bytes.subarray(0, 128));
    setImmediate(() => {
      events.push("download:complete");
      response.end(bytes.subarray(128));
    });
  });
  const downloadPort = await listen(publicServer, t);
  const adminServer = createHttpServer(async (request, response) => {
    let bytes = "";
    for await (const chunk of request) bytes += chunk;
    requests.push({
      target: "admin",
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(bytes || "{}"),
    });
    events.push("admin:register");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ success: true, data: { id: 7, status: 3, rollout_percentage: 0 } }),
    );
  });
  const adminPort = await listen(adminServer, t);
  const env = {
    PATH: `${fakeBin}${delimiter}${dirname(process.execPath)}`,
    HOME: root,
    NODE_EXTRA_CA_CERTS: certificatePath,
    AISCOO_RELEASE_OSS_BUCKET: "synthetic-releases",
    AISCOO_RELEASE_OSS_HOST: `127.0.0.1:${downloadPort}`,
    AISCOO_ADMIN_BASE_URL: `http://127.0.0.1:${adminPort}`,
    AISCOO_ADMIN_ACCESS_TOKEN: token,
    FAKE_OSS_LOG: callsPath,
    FAKE_ALIYUN_LOG: aliyunCallsPath,
    FAKE_BUCKET_OBJECT: bucketObject,
    FAKE_OSS_SCENARIO: scenario,
  };
  const readCalls = async (path) => {
    try {
      return (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  };
  return {
    env,
    feed,
    feedPath,
    zipPath,
    bucketObject,
    requests,
    events,
    calls: () => readCalls(callsPath),
    aliyunCalls: () => readCalls(aliyunCallsPath),
    saveFeed: () => writeFile(feedPath, JSON.stringify(feed)),
    async run({ execute = true, args = [], overrides = {} } = {}) {
      const commandArgs = ["--import", preloadPath, scriptPath, artifactDir, "--build-id", buildId];
      if (execute) commandArgs.push("--execute");
      commandArgs.push(...args);
      try {
        const result = await exec(process.execPath, commandArgs, {
          cwd: repoRoot,
          env: { ...env, ...overrides },
          timeout: 15000,
        });
        return { ...result, code: 0, output: result.stdout + result.stderr };
      } catch (error) {
        return { code: error.code, output: (error.stdout ?? "") + (error.stderr ?? "") };
      }
    },
  };
}

function assertFailure(result, reason) {
  assert.notEqual(result.code, 0, result.output);
  if (reason) assert.match(result.output, reason);
  assert.ok(!result.output.includes(token), "token must never appear in output");
}

test("dry-run streams the zip without token access, CLI execution or network", async (t) => {
  const context = await fixture(t);
  const result = await context.run({
    execute: false,
    overrides: { FAKE_GUARD_DRY_RUN: "1", FAKE_GUARD_STREAM: "1" },
  });
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /预演结束/);
  assert.deepEqual(await context.calls(), []);
  assert.deepEqual(await context.aliyunCalls(), []);
  assert.deepEqual(context.requests, []);
  assert.ok(!result.output.includes(token));
});

test("local zip tampering stops before any upload or registration", async (t) => {
  const context = await fixture(t);
  const changed = Buffer.from(zipBytes);
  changed[0] ^= 1;
  await writeFile(context.zipPath, changed);
  assertFailure(await context.run(), /sha512/);
  assert.deepEqual(await context.calls(), []);
  assert.deepEqual(context.requests, []);
});

test("execute streams locally, uploads atomically, downloads every byte, then reuses the root PAT", async (t) => {
  const context = await fixture(t);
  const result = await context.run({ overrides: { FAKE_GUARD_STREAM: "1" } });
  assert.equal(result.code, 0, result.output);
  const [args] = await context.calls();
  assert.deepEqual(args, [
    "api",
    "put-object",
    "--bucket",
    "synthetic-releases",
    "--key",
    objectKey,
    "--body",
    `file://${context.zipPath}`,
    "--region",
    "cn-hangzhou",
    "--endpoint",
    "oss-cn-hangzhou.aliyuncs.com",
    "--forbid-overwrite=true",
    "--object-acl",
    "public-read",
    "--cache-control",
    "public, max-age=31536000, immutable",
  ]);
  assert.deepEqual(await context.aliyunCalls(), [
    ["--auto-plugin-install", "false", "ossutil", ...args],
  ]);
  assert.deepEqual(await readFile(context.bucketObject), zipBytes);
  assert.deepEqual(
    context.requests.map(({ target, method }) => [target, method]),
    [
      ["download", "GET"],
      ["admin", "POST"],
    ],
  );
  assert.equal(context.requests[0].url, `/${objectKey}`);
  const registration = context.requests[1];
  assert.equal(registration.url, "/api/v1/admin/releases");
  assert.equal(registration.authorization, `Bearer ${token}`);
  assert.equal(registration.body.status, 3);
  assert.deepEqual(registration.body.files, [
    {
      url: `https://${context.env.AISCOO_RELEASE_OSS_HOST}/${objectKey}`,
      sha512: digest(zipBytes),
      size: zipBytes.length,
    },
  ]);
  assert.deepEqual(context.events, ["download:start", "download:complete", "admin:register"]);
  assert.ok(!result.output.includes(token));
});

test("explicit region, endpoint and profile are forwarded without selecting another profile", async (t) => {
  const context = await fixture(t);
  const result = await context.run({
    args: ["--withdrawn", "--rollout", "25", "--allow-device", "synthetic-device"],
    overrides: {
      AISCOO_RELEASE_OSS_REGION: "cn-shanghai",
      AISCOO_RELEASE_OSS_ENDPOINT: "oss-cn-shanghai.aliyuncs.com",
      AISCOO_RELEASE_OSS_PROFILE: "synthetic-profile",
    },
  });
  assert.equal(result.code, 0, result.output);
  const [args] = await context.calls();
  assert.equal(args[args.indexOf("--region") + 1], "cn-shanghai");
  assert.equal(args[args.indexOf("--endpoint") + 1], "oss-cn-shanghai.aliyuncs.com");
  assert.deepEqual(args.slice(-2), ["--profile", "synthetic-profile"]);
  const registration = context.requests.find(({ target }) => target === "admin");
  assert.equal(registration.body.status, 0);
  assert.equal(registration.body.rollout_percentage, 25);
  assert.deepEqual(registration.body.device_mid_allowlist, ["synthetic-device"]);
});

for (const scenario of ["existing", "race"]) {
  test(`atomic upload refuses ${scenario} objects without modifying bytes or registering`, async (t) => {
    const context = await fixture(t, { existing: scenario === "existing", scenario });
    assertFailure(await context.run(), /上传|覆盖|409/);
    assert.equal((await context.calls()).length, 1);
    assert.deepEqual(context.requests, []);
    assert.equal(
      await readFile(context.bucketObject, "utf8"),
      scenario === "existing" ? "previous publication" : "concurrent publisher",
    );
  });
}

for (const scenario of ["403", "network"]) {
  test(`OSS ${scenario} errors stop immediately and are never treated as missing objects`, async (t) => {
    const context = await fixture(t, { scenario });
    assertFailure(await context.run(), /上传/);
    assert.equal((await context.calls()).length, 1);
    assert.deepEqual(context.requests, []);
  });
}

for (const download of ["tampered", "size", "header", "truncated", "403", "network", "redirect"]) {
  test(`public download ${download} failure prevents release registration`, async (t) => {
    const context = await fixture(t, { download });
    assertFailure(await context.run(), /公开下载/);
    assert.deepEqual(
      context.requests.map(({ target, method }) => [target, method]),
      [["download", "GET"]],
    );
    assert.ok(!context.events.includes("admin:register"));
  });
}

test("missing execute token fails before invoking the cloud CLI", async (t) => {
  const context = await fixture(t);
  assertFailure(
    await context.run({ overrides: { AISCOO_ADMIN_ACCESS_TOKEN: "" } }),
    /AISCOO_ADMIN_ACCESS_TOKEN/,
  );
  assert.deepEqual(await context.calls(), []);
  assert.deepEqual(context.requests, []);
});

for (const value of [
  "../escape.zip",
  "/tmp/escape.zip",
  "nested/update.zip",
  "nested\\update.zip",
  "https://example.test/update.zip",
  "%2e%2e%2fescape.zip",
  "update.zip?x=1",
  "update.zip#fragment",
  "-update.zip",
  "update.zip\n",
  "update.zip\r",
  7,
]) {
  test(`feed files URL must be a safe zip basename: ${JSON.stringify(value)}`, async (t) => {
    const context = await fixture(t);
    context.feed.files[0].url = value;
    await context.saveFeed();
    assertFailure(await context.run(), /basename/);
    assert.deepEqual(await context.calls(), []);
    assert.deepEqual(context.requests, []);
  });
}

for (const value of ["../escape.zip", "other.zip"]) {
  test(`top-level feed path must match the zip basename: ${value}`, async (t) => {
    const context = await fixture(t);
    context.feed.path = value;
    await context.saveFeed();
    assertFailure(await context.run(), /path|basename/);
    assert.deepEqual(await context.calls(), []);
  });
}

for (const value of ["../3.18.0", "3.18.0/path", "01.18.0", "3.18.0\n", "3.18.0\r"]) {
  test(`feed version cannot escape its object prefix: ${JSON.stringify(value)}`, async (t) => {
    const context = await fixture(t);
    context.feed.version = value;
    await context.saveFeed();
    assertFailure(await context.run(), /version/);
    assert.deepEqual(await context.calls(), []);
  });
}

test("invalid file size and sha512 metadata fail without side effects", async (t) => {
  for (const field of ["size", "sha512"]) {
    await t.test(field, async (subtest) => {
      const context = await fixture(subtest);
      context.feed.files[0][field] = field === "size" ? String(zipBytes.length) : "bad-base64";
      await context.saveFeed();
      assertFailure(await context.run(), /sha512|size/);
      assert.deepEqual(await context.calls(), []);
      assert.deepEqual(context.requests, []);
    });
  }
});
