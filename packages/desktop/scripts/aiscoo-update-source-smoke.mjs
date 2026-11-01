// Aiscoo 应用内更新源回归（规则见 docs/aiscoo/specs/aiscoo-auto-update.md）。
// 在隔离 Electron 进程里驱动真实 initAutoUpdater，模拟打包态：
// - trusted-aiscoo：受信的 Aiscoo origin 被请求，且带上游协议的 platform/channel/device_mid；
// - untrusted-backend：未受信的非官方 origin 仍被改回官方入口（上游安全边界不变）。
// 上游 auto-update-source-security-smoke.mjs 覆盖其余场景，这里不修改它。
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { build } from "esbuild";
import { _electron } from "playwright-core";

const desktopDir = resolve(import.meta.dirname, "..");
const repoRoot = resolve(desktopDir, "../..");
const require = createRequire(resolve(desktopDir, "package.json"));
await mkdir(resolve(desktopDir, ".e2e-artifacts"), { recursive: true });
const artifactDir = await mkdtemp(resolve(desktopDir, ".e2e-artifacts/aiscoo-update-source-"));
const entryPath = resolve(artifactDir, "main.cjs");
const cases = [
  { name: "trusted-aiscoo", trustAiscoo: true, expected: "aiscoo" },
  { name: "untrusted-backend", trustAiscoo: false, expected: "official" },
];

await build({
  stdin: {
    resolveDir: desktopDir,
    sourcefile: "aiscoo-update-source-fixture.mjs",
    contents: `
import { app } from 'electron';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import pkg from 'electron-updater';
import { initAutoUpdater } from './src/main/autoUpdater.ts';
import { setAiscooSmokeOfficialOrigin } from 'aiscoo-smoke-origin';
const scenario = JSON.parse(process.env.AISCOO_UPDATE_SCENARIO);
const root = process.env.AISCOO_UPDATE_ROOT;
app.setPath('userData', root);
Object.defineProperty(app, 'isPackaged', { value: true });
process.env.ZCODE_AUTO_UPDATE_DEV = '1';
process.env.ZCODE_AUTO_UPDATE_DEV_VERSION = '3.17.0';
const { autoUpdater } = pkg;
autoUpdater.forceDevUpdateConfig = true;
const requests = [];
async function listen(label) {
  const server = createServer((req, res) => {
    requests.push({ label, url: req.url, headers: req.headers });
    res.writeHead(200, { 'Content-Type': 'application/x-yaml' });
    res.end('version: 0.0.1\\nfiles: []\\n');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, origin: 'http://127.0.0.1:' + server.address().port };
}
(async () => {
  await app.whenReady();
  const official = await listen('official');
  const aiscoo = await listen('aiscoo');
  setAiscooSmokeOfficialOrigin(official.origin);
  const configPath = resolve(root, 'app-update.yml');
  await writeFile(configPath, 'provider: generic\\nurl: ' + official.origin + '\\nupdaterCacheDirName: aiscoo-update-smoke\\n');
  autoUpdater.updateConfigPath = configPath;
  const completed = new Promise((done, fail) => {
    autoUpdater.once('update-not-available', done);
    autoUpdater.once('error', fail);
  });
  await initAutoUpdater({
    deviceMid: '00000000-0000-4000-8000-000000000000',
    resolveEndpointOrigin: () => aiscoo.origin,
    ...(scenario.trustAiscoo ? { trustedEndpointOrigins: [aiscoo.origin] } : {}),
  });
  await completed;
  const result = { scenario: scenario.name, requests };
  await writeFile(resolve(root, 'result.json'), JSON.stringify(result, null, 2));
  official.server.close(); aiscoo.server.close(); app.exit(0);
})().catch(error => { console.error(error); app.exit(1); });
`,
  },
  outfile: entryPath,
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron", "electron-updater", "semver"],
  plugins: [
    {
      // 用本机 HTTP 服务代替官方入口，观察回退目标；其余 shared 导出保持真实实现。
      name: "aiscoo-smoke-official-origin",
      setup(api) {
        api.onResolve({ filter: /^aiscoo-smoke-origin$/ }, () => ({
          path: "origin",
          namespace: "aiscoo-origin",
        }));
        api.onLoad({ filter: /.*/, namespace: "aiscoo-origin" }, () => ({
          contents:
            "export let origin; export function setAiscooSmokeOfficialOrigin(value) { origin = value; }",
        }));
        api.onResolve({ filter: /^@zcode\/shared$/ }, () => ({
          path: "shared",
          namespace: "aiscoo-shared",
        }));
        api.onLoad({ filter: /.*/, namespace: "aiscoo-shared" }, () => ({
          contents:
            "export * from " +
            JSON.stringify(resolve(repoRoot, "packages/shared/src/index.ts")) +
            '; export { origin as DEFAULT_ZCODE_ENDPOINT_ORIGIN } from "aiscoo-smoke-origin";',
          resolveDir: desktopDir,
        }));
      },
    },
    {
      name: "isolated-logger",
      setup(api) {
        api.onResolve({ filter: /^\.\/logger\.js$/ }, (args) =>
          args.importer.endsWith("/autoUpdater.ts")
            ? { path: "logger", namespace: "smoke" }
            : undefined,
        );
        api.onLoad({ filter: /.*/, namespace: "smoke" }, () => ({
          contents:
            "export const logger = { info: console.log, warn: console.warn, error: console.error };",
        }));
      },
    },
  ],
});

for (const scenario of cases) {
  const root = resolve(artifactDir, scenario.name);
  await mkdir(root);
  const env = {
    ...process.env,
    AISCOO_UPDATE_SCENARIO: JSON.stringify(scenario),
    AISCOO_UPDATE_ROOT: root,
    NODE_PATH: resolve(repoRoot, "node_modules"),
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const electronApp = await _electron.launch({
    executablePath: require("electron"),
    args: [entryPath],
    env,
  });
  let output = "";
  const child = electronApp.process();
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  try {
    // app.exit 关闭调试连接；以进程退出作为完成信号，不靠固定延时判断网络结果。
    if (child.exitCode === null) await onceExit(child);
    const result = JSON.parse(await readFile(resolve(root, "result.json"), "utf8"));
    assert.deepEqual(
      result.requests.map((item) => item.label),
      [scenario.expected],
      scenario.name,
    );
    const [request] = result.requests;
    const url = new URL(request.url, "http://127.0.0.1");
    assert.equal(url.pathname, "/api/v1/releases/electron/manifest");
    assert.match(url.searchParams.get("platform") ?? "", /^[a-z]+-[a-z0-9_]+$/);
    assert.equal(url.searchParams.get("channel"), "1");
    assert.equal(url.searchParams.get("device_mid"), "00000000-0000-4000-8000-000000000000");
    assert.equal(request.headers["x-release-channel"], "1");
    assert.equal(request.headers["x-platform"], url.searchParams.get("platform"));
    console.log(`PASS ${scenario.name}`);
  } finally {
    await writeFile(resolve(root, "runtime.log"), output);
    await electronApp.close().catch(() => {});
  }
}
console.log(`Evidence: ${artifactDir}`);

function onceExit(child) {
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Electron Aiscoo update scenario timed out"));
    }, 30_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolveExit();
      else reject(new Error(`Electron exited ${code}`));
    });
  });
}
