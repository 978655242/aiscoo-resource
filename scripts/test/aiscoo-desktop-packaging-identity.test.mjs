import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { replaceAppAsarFromStaging } from "../../packages/desktop/scripts/app-asar-repack.mjs";
import test from "node:test";
import { promisify } from "node:util";

import {
  desktopDevelopmentKeychainName,
  desktopProductIdentities,
  resolveDesktopArtifactSuffix,
  resolveDesktopProductIdentity,
} from "../../packages/desktop/scripts/desktop-product-identity.mjs";
import {
  DEV_ELECTRON_APP_BUNDLE_ID,
  DEV_ELECTRON_APP_NAME,
  DEV_ELECTRON_BUNDLE_FORMAT,
  DEV_ELECTRON_PROTOCOL_SCHEME,
  patchDevElectronInfoPlist,
} from "../../packages/desktop/scripts/devElectronAppBundle.mjs";

const requireFromDesktop = createRequire(
  new URL("../../packages/desktop/package.json", import.meta.url),
);
const { getAiscooDesktopIdentity } = await import(
  requireFromDesktop.resolve("@zcode/shared/aiscoo-desktop-identity")
);
const execFileAsync = promisify(execFile);
const repositoryRoot = new URL("../../", import.meta.url);

const electronPlist = `<plist version="1.0"><dict>
<key>CFBundleDisplayName</key><string>Electron</string>
<key>CFBundleIdentifier</key><string>com.github.Electron</string>
<key>CFBundleName</key><string>Electron</string>
<key>CFBundleIconFile</key><string>electron.icns</string>
</dict></plist>`;

function protocolDeclaration(name, scheme) {
  return `<dict><key>CFBundleURLName</key><string>${name}</string>
<key>CFBundleURLSchemes</key><array><string>${scheme}</string></array></dict>`;
}

function withProtocols(declarations) {
  return electronPlist.replace(
    "</dict></plist>",
    `<key>CFBundleURLTypes</key><array>${declarations.join("")}</array></dict></plist>`,
  );
}

test("Aiscoo packaging projects the shared profiles while retaining flavor and keychain contracts", () => {
  for (const flavor of ["production", "preview"]) {
    const identity = desktopProductIdentities[flavor];
    const profile = getAiscooDesktopIdentity(flavor);
    for (const [key, value] of Object.entries(profile)) {
      assert.equal(identity[key], value, `${flavor}.${key}`);
    }
    assert.equal(identity.flavor, flavor);
    assert.equal(identity.cuaHelperInstallVariant, flavor === "preview" ? "preview" : null);
    assert.ok(Object.isFrozen(identity));
  }
  assert.equal(desktopProductIdentities.production.macKeychainName, "XWork");
  assert.equal(desktopProductIdentities.preview.macKeychainName, "XWork Preview");
  assert.equal(desktopDevelopmentKeychainName, "XWork Dev");
  assert.equal(
    resolveDesktopProductIdentity({ ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: "1" }),
    desktopProductIdentities.preview,
  );
  assert.equal(resolveDesktopArtifactSuffix({ ZCODE_ENV: "production" }), "");
  assert.equal(resolveDesktopArtifactSuffix({ ZCODE_ENV: "test" }), "_TEST");
});

test("Dev bundle uses the development profile and invalidates the legacy bundle cache", () => {
  const identity = getAiscooDesktopIdentity("development");
  assert.equal(DEV_ELECTRON_APP_NAME, identity.productName);
  assert.equal(DEV_ELECTRON_APP_BUNDLE_ID, identity.appId);
  assert.equal(DEV_ELECTRON_PROTOCOL_SCHEME, identity.scheme);
  assert.ok(DEV_ELECTRON_BUNDLE_FORMAT > 4);
  const patched = patchDevElectronInfoPlist(electronPlist, "http://localhost:5174");
  assert.match(
    patched,
    /<key>CFBundleIdentifier<\/key>\s*<string>dev\.aiscoo\.app\.dev<\/string>/u,
  );
  assert.match(patched, /<key>CFBundleURLSchemes<\/key>\s*<array>\s*<string>aiscoo-dev<\/string>/u);
  assert.equal(patchDevElectronInfoPlist(patched, "http://localhost:5174"), patched);
});

test("Dev plist replaces old and duplicate protocol declarations without retaining zcode", () => {
  const rendererUrl = "http://localhost:5174/?label=A&B";
  for (const original of [
    withProtocols([protocolDeclaration("ZCode", "zcode")]),
    withProtocols([
      protocolDeclaration("ZCode", "zcode"),
      protocolDeclaration("Aiscoo", "aiscoo"),
      protocolDeclaration("Aiscoo Preview", "aiscoo-preview"),
      protocolDeclaration("Aiscoo Dev", "aiscoo-dev"),
    ]),
    withProtocols([]),
    electronPlist.replace("</dict></plist>", "<key>CFBundleURLTypes</key><array/></dict></plist>"),
  ]) {
    const patched = patchDevElectronInfoPlist(original, rendererUrl);
    assert.equal((patched.match(/<key>CFBundleURLTypes<\/key>/gu) ?? []).length, 1);
    const schemes = [
      ...patched.matchAll(/<key>CFBundleURLSchemes<\/key>\s*<array>([\s\S]*?)<\/array>/gu),
    ].flatMap(([, values]) =>
      [...values.matchAll(/<string>([^<]+)<\/string>/gu)].map(([, value]) => value),
    );
    assert.deepEqual(schemes, ["aiscoo-dev"]);
    assert.match(patched, /label=A&amp;B/u);
    assert.equal(patchDevElectronInfoPlist(patched, rendererUrl), patched);
  }
});

test("macOS PTY helper remains executable after the real archive repack and final hook", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "aiscoo-pty-packaging-"));
  try {
    const sourceDir = join(root, "source");
    const helperRelative = "node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper";
    await mkdir(join(sourceDir, "node_modules/node-pty/prebuilds/darwin-arm64"), {
      recursive: true,
    });
    // XCODE: asar 解包会丢失 helper 的执行位，最终 hook 必须恢复真实进程可执行能力。
    await writeFile(join(sourceDir, helperRelative), "#!/bin/sh\nexit 0\n", { mode: 0o644 });
    const archive = join(root, "app.asar");
    const asarCli = join(
      dirname(requireFromDesktop.resolve("@electron/asar/package.json")),
      "bin/asar.js",
    );
    await replaceAppAsarFromStaging({
      sourceDir,
      appAsarPath: archive,
      targetPlatformKey: "darwin-arm64",
      runAsarCommand: (args) => execFileSync(process.execPath, [asarCli, ...args]),
    });
    const config = (await import("../../packages/desktop/electron-builder.config.js")).default;
    const assets = await import("../../packages/desktop/scripts/node-pty-package-assets.mjs");
    assert.ok(config.afterPack.toString().includes("ensurePackagedNodePtyHelperExecutable"));
    await assets.ensurePackagedNodePtyHelperExecutable({
      resourcesDir: root,
      platformKey: "darwin-arm64",
    });
    const helper = join(`${archive}.unpacked`, helperRelative);
    assert.ok((await stat(helper)).mode & 0o111);
    await execFileAsync(helper, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("PTY helper repair runs after every afterPack step that rewrites app.asar", async () => {
  const config = (await import("../../packages/desktop/electron-builder.config.js")).default;
  const source = config.afterPack.toString();
  const labels = (name) => [...source.matchAll(new RegExp(`"afterPack:${name}"`, "gu"))];
  const position = (name) => {
    const found = labels(name);
    assert.equal(found.length, 1, `afterPack:${name} must appear exactly once`);
    return found[0].index;
  };
  // XCODE: 这两步会解包并重打包 app.asar，helper 的执行位只能在它们之后恢复。
  const repair = position("ensurePackagedNodePtyHelperExecutable");
  for (const rewrite of [
    "injectHoistedRuntimeModulesIntoAsar",
    "stripPackagedSourcemapReferences",
  ]) {
    assert.ok(position(rewrite) < repair, `${rewrite} must run before the helper repair`);
  }
  assert.ok(
    repair < position("assertPackagedNodePtyPrebuild"),
    "the helper repair must run before the packaged prebuild assertion",
  );
});

for (const [label, environment, channel] of [
  ["production", { ZCODE_ENV: "production" }, "production"],
  ["test preview", { ZCODE_ENV: "test" }, "preview"],
  ["production preview", { ZCODE_ENV: "production", ZCODE_PREVIEW_IDENTITY: "1" }, "preview"],
]) {
  test(`electron-builder ${label} uses matching app, protocol, executable and desktop identities`, async () => {
    // XCODE: 在独立进程导入真实配置，覆盖环境选择与 Builder 的 desktop 生成逻辑，不执行打包或签名 hook。
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
        import config from "./packages/desktop/electron-builder.config.js";
        import { createRequire } from "node:module";
        const require = createRequire(new URL("./packages/desktop/package.json", import.meta.url));
        const { AppInfo } = require("app-builder-lib/out/appInfo.js");
        const { LinuxTargetHelper } = require("app-builder-lib/out/targets/LinuxTargetHelper.js");
        const info = { metadata: { name: "@zcode/desktop", version: "1.2.3", ...config.extraMetadata }, config };
        const appInfo = new AppInfo(info, undefined, config.linux);
        const helper = new LinuxTargetHelper({
          config, info, appInfo, executableName: config.linux.executableName,
          platformSpecificBuildOptions: config.linux, fileAssociations: [],
        });
        const desktopEntry = await helper.computeDesktopEntry(config.linux);
        process.stdout.write(JSON.stringify({
          appId: config.appId, productName: config.productName, protocols: config.protocols,
          windowsExecutableName: config.win.executableName, linuxExecutableName: config.linux.executableName,
          packages: [config.deb.packageName, config.rpm.packageName, config.pacman.packageName],
          desktopName: config.extraMetadata.desktopName,
          desktopFileName: helper.getDesktopFileName() + ".desktop", desktopEntry,
        }));
      `,
      ],
      {
        cwd: repositoryRoot,
        env: {
          ...process.env,
          ZCODE_ENV: "production",
          ZCODE_PREVIEW_IDENTITY: "0",
          ZCODE_ENABLE_MAC_SIGN: "0",
          ZCODE_ENABLE_WINDOWS_SIGN: "0",
          ZCODE_TARGET_OS: "linux",
          ZCODE_TARGET_ARCH: "x64",
          ...environment,
        },
        maxBuffer: 1024 * 1024,
      },
    );
    const config = JSON.parse(stdout.trimEnd().split("\n").at(-1));
    const identity = getAiscooDesktopIdentity(channel);
    assert.equal(config.appId, identity.appId);
    assert.equal(config.productName, identity.productName);
    assert.deepEqual(config.protocols, [
      { name: identity.productName, schemes: [identity.scheme] },
    ]);
    assert.equal(config.windowsExecutableName, identity.windowsExecutableName);
    assert.equal(config.linuxExecutableName, identity.linuxExecutableName);
    assert.deepEqual(config.packages, Array(3).fill(identity.linuxPackageName));
    assert.equal(config.desktopName, identity.desktopFileName);
    assert.equal(config.desktopFileName, identity.desktopFileName);
    assert.ok(config.desktopEntry.includes(`Name=${identity.productName}\n`));
    assert.ok(config.desktopEntry.includes(`Icon=${identity.linuxExecutableName}\n`));
    assert.ok(
      config.desktopEntry.includes(
        `StartupWMClass=${identity.desktopFileName.replace(/\.desktop$/u, "")}\n`,
      ),
    );
    assert.ok(config.desktopEntry.includes(`MimeType=x-scheme-handler/${identity.scheme};\n`));
    assert.ok(config.desktopEntry.includes(`/${identity.linuxExecutableName}`));
    assert.ok(!config.desktopEntry.includes("x-scheme-handler/zcode"));
  });
}
