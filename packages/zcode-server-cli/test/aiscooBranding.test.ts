import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { runServerCli } from "../src/cli.js";
import { resolveServerLayout } from "../src/runtime/paths.js";
import { writeStableLauncher } from "../src/runtime/stableLauncher.js";
import {
  createDaemonServiceDescriptor,
  createServiceDescriptor,
} from "../src/platform/serviceManager.js";
import * as serviceManager from "../src/platform/serviceManager.js";
import * as controlClient from "../src/ipc/controlClient.js";
import { createStoppedServerStatus } from "../src/contracts.js";
import { ensureServerInstallOwnership } from "../src/runtime/installationOwnership.js";
import { runProxyStdio } from "../src/server-core/proxyStdio.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function layout() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "aiscoo-server-brand-")));
  roots.push(root);
  return resolveServerLayout(join(root, "server"));
}

describe("Aiscoo Server CLI display", () => {
  it("keeps status and version machine identity intact", async () => {
    const paths = await layout();
    let output = "";
    const io = {
      stdout: {
        write: (value: string) => {
          output += value;
        },
      },
    };
    expect(await runServerCli(["status", "--server-root", paths.serverRoot], io)).toBe(0);
    expect(JSON.parse(output).state).toBe("stopped");
    output = "";
    expect(await runServerCli(["--version", "--json"], io)).toBe(0);
    expect(JSON.parse(output).product).toBe("zcode-server");
  });

  it("brands generated service descriptions and launcher errors, preserving service names and commands", async () => {
    const paths = await layout();
    const descriptor = createDaemonServiceDescriptor({ platform: "linux", layout: paths });
    expect(descriptor.content).toContain("Description=Aiscoo Server");
    expect(descriptor.name).toMatch(/^com\.zhipu\.zcode\.server\./);
    expect(descriptor.content).toContain("/bin/zcode'");
    for (const platform of ["linux", "win32"] as const) {
      const launcherPath = await writeStableLauncher(paths, platform);
      expect(launcherPath).toBe(
        join(paths.stableBinDir, platform === "win32" ? "zcode.cmd" : "zcode"),
      );
      const launcher = await readFile(launcherPath, "utf8");
      expect(launcher).toContain("No current Aiscoo Server release");
      expect(launcher).toContain("Invalid current Aiscoo Server release");
      expect(launcher).toContain("server-cli.js");
    }
    expect((await ensureServerInstallOwnership(paths)).product).toBe("zcode-server");
  });

  it("brands proxy diagnostics without writing into the protocol byte stream", async () => {
    const paths = await layout();
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    output.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    await expect(runProxyStdio({ layout: paths, input, output })).rejects.toMatchObject({
      code: "daemon-not-ready",
      message: "Aiscoo Server daemon is not ready for proxy-stdio",
    });
    expect(chunks).toEqual([]);
  });
});

// XCODE: 单 key 资源策略穿过 OS 服务边界；默认描述符和既有 daemon 生命周期保持原样。
const encodedNativeNames = [
  { directoryName: ".aiscoo", systemd: ".aiscoo", launchd: ".aiscoo" },
  { directoryName: ".原生 team'&%h;", systemd: ".原生 team'&%%h;", launchd: ".原生 team'&amp;%h;" },
  { directoryName: ".literal%%n%u", systemd: ".literal%%%%n%%u", launchd: ".literal%%n%u" },
];

describe("Server service native resource directory", () => {
  it.each([undefined, "", "  "])(
    "preserves default descriptors byte for byte for option %j",
    (nativeResourceDirectoryName) => {
      vi.stubEnv("ZCODE_NATIVE_RESOURCE_DIR_NAME", ".unrelated");
      const options = { command: "/synthetic/zcode", nativeResourceDirectoryName };
      expect(createServiceDescriptor({ ...options, platform: "linux" }).content).toBe(
        "[Unit]\nDescription=Aiscoo Server\n[Service]\nExecStart='/synthetic/zcode' 'serve' '--daemon'\nRestart=on-failure\n[Install]\nWantedBy=default.target\n",
      );
      expect(createServiceDescriptor({ ...options, platform: "darwin" }).content).toBe(
        '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>Label</key><string>com.zhipu.zcode.server</string><key>ProgramArguments</key><array><string>/synthetic/zcode</string><string>serve</string><string>--daemon</string></array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict></dict></plist>',
      );
      expect(createServiceDescriptor({ ...options, platform: "win32" }).content).toBe(
        '{"taskName":"com.zhipu.zcode.server","command":"/synthetic/zcode","args":["serve","--daemon"],"trigger":"logon","runLevel":"leastPrivilege"}',
      );
    },
  );

  it.each(encodedNativeNames)(
    "encodes $directoryName as one systemd Environment value with literal percent signs",
    async ({ directoryName, systemd }) => {
      const paths = await layout();
      const baseline = createDaemonServiceDescriptor({ platform: "linux", layout: paths });
      const descriptor = createDaemonServiceDescriptor({
        platform: "linux",
        layout: paths,
        nativeResourceDirectoryName: directoryName,
      });
      const line = `Environment="ZCODE_NATIVE_RESOURCE_DIR_NAME=${systemd}"\n`;
      expect(descriptor.content).toContain(line);
      expect(descriptor.content.match(/^Environment=/gmu)).toHaveLength(1);
      expect(descriptor.content.replace(line, "")).toBe(baseline.content);
      expect(descriptor.name).toBe(baseline.name);
    },
  );

  it.each(encodedNativeNames)(
    "encodes $directoryName as one launchd XML environment value",
    async ({ directoryName, launchd }) => {
      const paths = await layout();
      const baseline = createDaemonServiceDescriptor({ platform: "darwin", layout: paths });
      const descriptor = createDaemonServiceDescriptor({
        platform: "darwin",
        layout: paths,
        nativeResourceDirectoryName: directoryName,
      });
      const entry = `<key>EnvironmentVariables</key><dict><key>ZCODE_NATIVE_RESOURCE_DIR_NAME</key><string>${launchd}</string></dict>`;
      expect(descriptor.content).toContain(entry);
      expect(descriptor.content.replace(entry, "")).toBe(baseline.content);
      expect(descriptor.name).toBe(baseline.name);
    },
  );

  it.skipIf(process.platform !== "darwin")(
    "round-trips the launchd value through the platform plist parser",
    async () => {
      const paths = await layout();
      const directoryName = ".原生 team'&%h;";
      const descriptor = createDaemonServiceDescriptor({
        platform: "darwin",
        layout: paths,
        nativeResourceDirectoryName: directoryName,
      });
      const path = join(paths.serverRoot, "..", "synthetic.plist");
      await writeFile(path, descriptor.content);
      const result = await promisify(execFile)("/usr/bin/plutil", [
        "-extract",
        "EnvironmentVariables",
        "json",
        "-o",
        "-",
        path,
      ]);
      expect(JSON.parse(result.stdout)).toEqual({ ZCODE_NATIVE_RESOURCE_DIR_NAME: directoryName });
    },
  );

  it.each(["linux", "darwin"] as const)(
    "rejects an invalid native directory in %s before descriptor generation",
    (platform) => {
      expect(() =>
        createServiceDescriptor({
          platform,
          command: "/synthetic/zcode",
          nativeResourceDirectoryName: ".bad/path",
        }),
      ).toThrow("ZCODE_NATIVE_RESOURCE_DIR_NAME");
    },
  );

  it.skipIf(!["linux", "darwin"].includes(process.platform))(
    "hands the explicit CLI env to the service descriptor before OS registration",
    async () => {
      const paths = await layout();
      const directoryName = ".原生 team'&%h;";
      vi.stubEnv("ZCODE_NATIVE_RESOURCE_DIR_NAME", directoryName);
      vi.stubEnv("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION", undefined);
      vi.stubEnv("SOURCE_TEST_UNRELATED_SECRET", "synthetic-not-for-service");
      vi.spyOn(serviceManager, "isServiceManagerAvailable").mockResolvedValue(true);
      vi.spyOn(controlClient, "requestControl").mockRejectedValue(new Error("synthetic no daemon"));
      const register = vi
        .spyOn(serviceManager, "registerService")
        .mockRejectedValue(new Error("synthetic registration boundary"));
      let output = "";
      expect(
        await runServerCli(["serve", "--daemon", "--json", "--server-root", paths.serverRoot], {
          stdout: {
            write: (value) => {
              output += value;
            },
          },
        }),
      ).toBe(1);
      expect(JSON.parse(output).error).toBe("synthetic registration boundary");
      expect(register).toHaveBeenCalledTimes(1);
      const [descriptor, descriptorPath] = register.mock.calls[0]!;
      expect(descriptor).toEqual(
        createDaemonServiceDescriptor({
          platform: process.platform as "darwin" | "linux",
          layout: paths,
          nativeResourceDirectoryName: directoryName,
        }),
      );
      expect(await readFile(descriptorPath, "utf8")).toBe(descriptor.content);
      expect(descriptor.content).not.toContain("SOURCE_TEST_UNRELATED_SECRET");
      expect(descriptor.content).not.toContain("synthetic-not-for-service");
      expect(descriptor.content).toContain("--server-root");
    },
  );

  it.skipIf(!["linux", "darwin"].includes(process.platform))(
    "rejects invalid CLI env before writing a launcher or registering a service",
    async () => {
      const paths = await layout();
      vi.stubEnv("ZCODE_NATIVE_RESOURCE_DIR_NAME", ".bad/path");
      vi.stubEnv("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION", undefined);
      vi.spyOn(serviceManager, "isServiceManagerAvailable").mockResolvedValue(true);
      vi.spyOn(controlClient, "requestControl").mockRejectedValue(new Error("synthetic no daemon"));
      const register = vi.spyOn(serviceManager, "registerService").mockResolvedValue(undefined);
      let output = "";
      expect(
        await runServerCli(["serve", "--daemon", "--json", "--server-root", paths.serverRoot], {
          stdout: {
            write: (value) => {
              output += value;
            },
          },
        }),
      ).toBe(1);
      expect(JSON.parse(output).error).toContain("ZCODE_NATIVE_RESOURCE_DIR_NAME");
      await expect(readFile(join(paths.stableBinDir, "zcode"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(register).not.toHaveBeenCalled();
    },
  );

  it.skipIf(!["linux", "darwin"].includes(process.platform))(
    "reuses an existing ready daemon without registering or stopping it for a changed directory",
    async () => {
      const paths = await layout();
      vi.stubEnv("ZCODE_NATIVE_RESOURCE_DIR_NAME", ".changed");
      vi.stubEnv("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION", undefined);
      vi.spyOn(serviceManager, "isServiceManagerAvailable").mockResolvedValue(true);
      const ready = {
        ...createStoppedServerStatus("synthetic"),
        state: "ready",
        pid: process.pid,
        port: 4123,
        host: "127.0.0.1",
      };
      const control = vi.spyOn(controlClient, "requestControl").mockResolvedValue(ready);
      const register = vi.spyOn(serviceManager, "registerService").mockResolvedValue(undefined);
      const unregister = vi.spyOn(serviceManager, "unregisterService").mockResolvedValue(undefined);
      const createDescriptor = vi.spyOn(serviceManager, "createDaemonServiceDescriptor");
      let output = "";
      expect(
        await runServerCli(["serve", "--daemon", "--json", "--server-root", paths.serverRoot], {
          stdout: {
            write: (value) => {
              output += value;
            },
          },
        }),
      ).toBe(0);
      expect(JSON.parse(output)).toEqual(ready);
      expect(control).toHaveBeenCalledExactlyOnceWith(
        paths.controlEndpoint,
        { command: "status" },
        500,
      );
      expect(register).not.toHaveBeenCalled();
      expect(unregister).not.toHaveBeenCalled();
      expect(createDescriptor).not.toHaveBeenCalled();
    },
  );
});
