import { PassThrough } from "node:stream";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Emitter } from "@zcode/rpc";
import type { RemoteTarget } from "@zcode/shared";
import type { IRemoteBackend, StdioStream } from "../src/remote/backend.js";
import { detectRemoteAssetTools } from "../src/remote/remoteAssetPreflight.js";
import { createSourceServerTransportAdapter } from "../src/source-server/transportAdapter.js";
import { describe, expect, it, vi } from "vitest";

function completedStream(output: string, error = "", code = 0): StdioStream {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closed = new Emitter<number>();
  // exec 是异步接口，下一轮事件循环发出关闭，确保调用方已注册流监听。
  setTimeout(() => {
    stdout.end(output);
    stderr.end(error);
    closed.fire(code);
    closed.dispose();
  }, 0);
  return { stdin, stdout, stderr, onClose: closed.event };
}
function backendFor(output: string, error = "", code = 0): IRemoteBackend {
  return {
    detect: async () => ({ platform: "linux", arch: "x64" }),
    upload: async () => {},
    exists: async () => false,
    readFile: async () => "",
    exec: vi.fn(async () => completedStream(output, error, code)),
    dispose() {},
  };
}

describe("Aiscoo server display diagnostics", () => {
  it.each([
    ["download=\ntar=tar\nsha256=sha256sum\n", "无法直接下载 Aiscoo 远程资源"],
    ["download=curl\ntar=\nsha256=sha256sum\n", "无法解压 Aiscoo Source Server"],
    ["download=curl\ntar=tar\nsha256=\n", "无法校验 Aiscoo 远程资源"],
  ])(
    "brands local asset preflight failures without renaming remote tools",
    async (output, message) => {
      const backend = backendFor(output);
      await expect(detectRemoteAssetTools(backend, { log() {} })).rejects.toThrow(message);
      expect(backend.exec).toHaveBeenCalledWith(expect.stringContaining("command -v tar"));
    },
  );

  it("warns with the branded runtime requirement and continues probing older glibc", async () => {
    // XCODE: 新版探测要求 ROOT 段；缺失会先报输出不完整，无法验证 glibc 只告警、不拒连的上游合同。
    const backend = backendFor(
      "__ZCODE_PROBE_PLATFORM__\nLinux\n__ZCODE_PROBE_ARCH__\nx86_64\n" +
        "__ZCODE_PROBE_ROOT__\n/home/alice/.zcode/server\n__ZCODE_PROBE_KERNEL__\nLinux\n" +
        "__ZCODE_PROBE_LIBC__\nglibc 2.17\n__ZCODE_PROBE_INSTALLED__\n0\n__ZCODE_PROBE_END__\n",
    );
    const adapter = createSourceServerTransportAdapter("ssh", {
      createBackend: async () => backend,
    });
    const onLog = vi.fn();
    await expect(
      adapter.probe({ kind: "ssh", host: "example.invalid", username: "alice" }, { onLog }),
    ).resolves.toEqual({
      platform: "linux",
      arch: "x64",
      installPath: "/home/alice/.zcode/server",
      installed: false,
    });
    expect(onLog).toHaveBeenCalledExactlyOnceWith({
      phase: "probe",
      level: "warn",
      message:
        "Remote glibc 2.17 is older than glibc 2.28 required by the bundled Aiscoo Source Server runtime. " +
        "Aiscoo Source Server may fail to start. Continuing installation or connection.",
    });
    expect(backend.exec).toHaveBeenCalledWith(expect.stringContaining('"$HOME/.zcode/server"'));
  });

  it("rejects an incomplete probe before reporting a glibc warning", async () => {
    const backend = backendFor(
      "__ZCODE_PROBE_PLATFORM__\nLinux\n__ZCODE_PROBE_ARCH__\nx86_64\n__ZCODE_PROBE_KERNEL__\nLinux\n" +
        "__ZCODE_PROBE_LIBC__\nglibc 2.17\n__ZCODE_PROBE_INSTALLED__\n0\n__ZCODE_PROBE_END__\n",
    );
    const adapter = createSourceServerTransportAdapter("ssh", {
      createBackend: async () => backend,
    });
    const onLog = vi.fn();
    await expect(
      adapter.probe({ kind: "ssh", host: "example.invalid", username: "alice" }, { onLog }),
    ).rejects.toMatchObject({
      code: "remote-preflight-failed",
      message: "Source Server environment probe returned incomplete or invalid output: ROOT",
    });
    expect(onLog).not.toHaveBeenCalled();
  });

  it("preserves upstream diagnostic text and technical probe markers", async () => {
    const message = "ZCode upstream service: XWork account unavailable";
    const backend = backendFor("", message, 1);
    const adapter = createSourceServerTransportAdapter("ssh", {
      createBackend: async () => backend,
    });
    await expect(
      adapter.probe({ kind: "ssh", host: "example.invalid", username: "alice" }, {}),
    ).rejects.toMatchObject({ message });
    expect(backend.exec).toHaveBeenCalledWith(expect.stringContaining("__ZCODE_PROBE_PLATFORM__"));
  });
});

// XCODE: 扩展现有下游回归，仅用合成 transport 验证目录策略，不连接真实远端或读取用户配置。
const nativeDirectoryTargets: Exclude<RemoteTarget, { kind: "server" }>[] = [
  { kind: "ssh", host: "example.invalid", username: "synthetic" },
  { kind: "wsl", distro: "synthetic" },
  { kind: "docker", container: "synthetic" },
];

describe("Source Server native resource directory startup", () => {
  it.each(nativeDirectoryTargets)(
    "passes only the directory name on $kind startup and restart",
    async (target) => {
      const backend = backendFor('{"state":"ready","port":4123}\n');
      backend.readFile = vi.fn(async () => "synthetic-ingress-token\n");
      const adapter = createSourceServerTransportAdapter(target.kind, {
        createBackend: async () => backend,
        nativeResourceDirectoryName: ".aiscoo",
      });

      await expect(adapter.ensureDaemon(target, {})).resolves.toEqual({
        port: 4123,
        ingressToken: "synthetic-ingress-token",
      });
      await adapter.exec(target, ["restart", "--json"], {});
      const commands = vi.mocked(backend.exec).mock.calls.map(([command]) => command);
      expect(commands).toHaveLength(2);
      for (const command of commands) {
        expect(command).toContain("ZCODE_NATIVE_RESOURCE_DIR_NAME='.aiscoo' ");
        expect(command).toContain('"$HOME/.zcode/server/bin/zcode"');
        expect(command).toContain('--server-root "$HOME/.zcode/server"');
        expect(command.includes("ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1")).toBe(
          target.kind !== "ssh",
        );
      }
      expect(backend.readFile).toHaveBeenCalledExactlyOnceWith("~/.zcode/server/run/ingress-token");

      await adapter.exec(target, ["status", "--json"], {});
      expect(vi.mocked(backend.exec).mock.lastCall?.[0]).not.toContain(
        "ZCODE_NATIVE_RESOURCE_DIR_NAME",
      );
    },
  );

  it.each(nativeDirectoryTargets)(
    "leaves an already running $kind daemon on its own startup policy",
    async (target) => {
      const backend = backendFor("");
      backend.readFile = vi.fn(async () => "synthetic-ingress-token");
      const adapter = createSourceServerTransportAdapter(target.kind, {
        createBackend: async () => backend,
        nativeResourceDirectoryName: ".aiscoo",
      });
      await expect(
        adapter.ensureDaemon(target, {}, { observedStatus: { state: "ready", port: 4123 } }),
      ).resolves.toEqual({
        port: 4123,
        ingressToken: "synthetic-ingress-token",
        reusedProbeStatus: true,
      });
      expect(backend.exec).not.toHaveBeenCalled();
    },
  );

  it.each(nativeDirectoryTargets)(
    "preserves the unconfigured $kind startup command",
    async (target) => {
      const backend = backendFor("");
      const adapter = createSourceServerTransportAdapter(target.kind, {
        createBackend: async () => backend,
      });
      await adapter.exec(target, ["serve", "--daemon", "--json"], {});
      expect(backend.exec).toHaveBeenCalledExactlyOnceWith(
        `${target.kind === "ssh" ? "" : "ZCODE_SERVER_SKIP_SERVICE_REGISTRATION=1 "}"$HOME/.zcode/server/bin/zcode" 'serve' '--daemon' '--json' --server-root "$HOME/.zcode/server"`,
      );
    },
  );

  it.each(["", "  "])(
    "does not invent an override for an empty directory option %j",
    async (nativeResourceDirectoryName) => {
      const backend = backendFor("");
      const target = nativeDirectoryTargets[0]!;
      const adapter = createSourceServerTransportAdapter(target.kind, {
        createBackend: async () => backend,
        nativeResourceDirectoryName,
      });
      await adapter.exec(target, ["restart", "--json"], {});
      expect(vi.mocked(backend.exec).mock.lastCall?.[0]).not.toContain(
        "ZCODE_NATIVE_RESOURCE_DIR_NAME",
      );
    },
  );

  it.each([
    ".",
    "..",
    "/synthetic/.aiscoo",
    ".a/b",
    ".a\\b",
    "C:\\synthetic",
    ".bad\u0000name",
    ".bad:name",
  ])("rejects invalid directory %j before creating a backend", (nativeResourceDirectoryName) => {
    const createBackend = vi.fn(async () => backendFor(""));
    expect(() =>
      createSourceServerTransportAdapter("ssh", { createBackend, nativeResourceDirectoryName }),
    ).toThrow("ZCODE_NATIVE_RESOURCE_DIR_NAME");
    expect(createBackend).not.toHaveBeenCalled();
  });

  it.each(
    nativeDirectoryTargets.flatMap((target) =>
      [undefined, ".aiscoo"].map((nativeResourceDirectoryName) => ({
        target,
        nativeResourceDirectoryName,
      })),
    ),
  )(
    "preserves $target.kind installation paths with directory option $nativeResourceDirectoryName",
    async ({ target, nativeResourceDirectoryName }) => {
      const backend = backendFor("");
      backend.upload = vi.fn(async () => {});
      vi.mocked(backend.exec).mockImplementation(async (command) =>
        completedStream(command.includes("tar_tool=") ? "tar=tar\n" : '{"applied":true}\n'),
      );
      const adapter = createSourceServerTransportAdapter(target.kind, {
        createBackend: async () => backend,
        nativeResourceDirectoryName,
      });
      await adapter.installOrUpdate(
        target,
        {
          localArchivePath: "/synthetic/zcode-server.tar.gz",
          target: "linux-x64",
          version: "3.17.1",
          sha256: "a".repeat(64),
          sizeBytes: 1,
          urls: [],
        },
        {},
      );
      const commands = vi.mocked(backend.exec).mock.calls.map(([command]) => command);
      const installer = commands.find((command) => command.includes("update --from-archive"));
      if (nativeResourceDirectoryName) {
        expect(installer).toContain("ZCODE_NATIVE_RESOURCE_DIR_NAME='.aiscoo' ");
      } else {
        expect(installer).not.toContain("ZCODE_NATIVE_RESOURCE_DIR_NAME");
      }
      expect(installer).toContain('"$HOME/.zcode/server"/.bootstrap-');
      expect(installer).toContain('--server-root "$HOME/.zcode/server"');
      expect(installer).not.toContain(".aiscoo/server");
      expect(backend.upload).toHaveBeenCalledWith(
        "/synthetic/zcode-server.tar.gz",
        expect.stringMatching(/^~\/\.zcode\/server\/\.bootstrap-/u),
        expect.any(Object),
      );
      expect(
        commands.filter((command) => command.includes("ZCODE_NATIVE_RESOURCE_DIR_NAME")),
      ).toHaveLength(nativeResourceDirectoryName ? 1 : 0);
    },
  );

  it.skipIf(process.platform === "win32")(
    "quotes the directory literally and leaves HOME resolution to the target",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "source-native-directory-"));
      try {
        const binDir = join(home, ".zcode", "server", "bin");
        await mkdir(binDir, { recursive: true });
        await writeFile(
          join(binDir, "zcode"),
          '#!/bin/sh\nprintf "%s\\n" "$HOME/$ZCODE_NATIVE_RESOURCE_DIR_NAME" "$@"\n',
          { mode: 0o700 },
        );
        const directoryName = ".team's $HOME;literal";
        const backend = backendFor("");
        const adapter = createSourceServerTransportAdapter("ssh", {
          createBackend: async () => backend,
          nativeResourceDirectoryName: directoryName,
        });
        await adapter.exec(nativeDirectoryTargets[0]!, ["serve", "--daemon", "--json"], {});
        const command = vi.mocked(backend.exec).mock.lastCall![0];
        const result = await promisify(execFile)("/bin/sh", ["-c", command], {
          env: { HOME: home, PATH: "/usr/bin:/bin" },
        });
        expect(result.stderr).toBe("");
        expect(result.stdout.trim().split("\n")).toEqual([
          join(home, directoryName),
          "serve",
          "--daemon",
          "--json",
          "--server-root",
          join(home, ".zcode", "server"),
        ]);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );
});
